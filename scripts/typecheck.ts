// SPDX-License-Identifier: Apache-2.0

/**
 * Type-checks every project in the repository at once, and reports EVERY failure.
 *
 *     bun run typecheck
 *
 * The projects are independent, so they run CONCURRENTLY and each one's verdict is reported whatever
 * the others did. The `&&` chain this replaces stopped at the first failure, which meant an error in
 * `src` hid every error everywhere else and a developer paid one round trip per project to find them
 * all — the same reasoning `scripts/check.ts` already applies to the lane it owns.
 *
 * The configs cannot be merged. `tsconfig.json` is also the BUILD config, so it cannot carry
 * `allowImportingTsExtensions` (TypeScript permits that only when nothing is emitted) which `bench/`
 * needs, and `bench/prior-art/` has its own dependency tree.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The latest compiler (`typescript`, 7.x), addressed through its PACKAGE MANIFEST rather than by a path.
 *
 * Two installed packages declare the same `tsc` bin name: `typescript` and `typescript-6` are both
 * npm aliases of `typescript`. Which one `node_modules/.bin/tsc` links to is therefore decided by
 * install order and can flip with no file in this repository changing. The 6.x line is kept
 * deliberately — 7.x ships no classic compiler API, which the AST-based checks parse source with, and
 * 6.x is a supported consumer version — so a flip would silently swap the checker.
 *
 * A hardcoded `./node_modules/typescript/bin/tsc` avoided the flip but assumed one layout:
 * it breaks under a different hoisting arrangement, in a workspace, or from any other directory.
 * Resolving the manifest and reading its own `bin` entry is correct under all of them, and it is why
 * this file knows where the compiler is instead of the caller having to.
 */
const tsc = (): string => {
  const manifest = createRequire(import.meta.url).resolve("typescript/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: { tsc: string } };
  return join(dirname(manifest), bin.tsc);
};

const PROJECTS: readonly (readonly string[])[] = [
  // The root config is also the build config; this one adds `noEmit` and resolves the package's
  // own name to source (its comment says why), so it needs no build.
  ["tsconfig.typecheck.json"],
  ["tsconfig.bench.json"],
  ["bench/prior-art/tsconfig.json"],
];

const compiler = tsc();
/**
 * Two checkers. `tsc` is the compiler consumers run, so it is the reference. `bun check` (the Bun
 * binary running this script) is several times faster (measured 0.11 s against 0.47 s on the root
 * project), so the commit hook asks for it alone with `--bun`. A full run uses BOTH, concurrently:
 * Bun's checker is not proven to report what `tsc` does, and a full run is where a disagreement
 * must surface. An error only `tsc` reports would otherwise pass the hook unseen; one only Bun
 * reports would block a commit that the reference accepts. `--no-script` because a `check` script
 * in `package.json` would otherwise run in its place.
 */
const CHECKERS = {
  tsc: (path: string, extra: readonly string[]) => [compiler, "-p", path, ...extra],
  bun: (path: string, extra: readonly string[]) => [
    process.execPath,
    "check",
    "--no-script",
    "-p",
    path,
    ...extra,
  ],
} as const;
type Checker = keyof typeof CHECKERS;
const checkers: readonly Checker[] = process.argv.includes("--bun") ? ["bun"] : ["tsc", "bun"];

const run = (
  checker: Checker,
  project: readonly string[],
): Promise<{ project: string; ok: boolean; out: string }> =>
  new Promise((resolve) => {
    const [path = "", ...extra] = project;
    const [command = "", ...argv] = CHECKERS[checker](path, extra);
    const label = `${path} (${checker})`;
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    // Both streams: tsc reports diagnostics on stdout and its own failures (a missing config, a bad
    // flag) on stderr, and a run that reported neither would look identical to a clean one.
    const collect = (chunk: string): void => {
      out += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      resolve({ project: label, ok: false, out: String(e) });
    });
    child.on("close", (code) => {
      resolve({ project: label, ok: code === 0, out });
    });
  });

// The commit hook names the projects its change reaches; a config it names that is not listed here
// is a typo that would otherwise check nothing and pass.
const named = process.argv.slice(2).filter((arg) => arg !== "--bun");
const unknown = named.filter((name) => !PROJECTS.some(([path]) => path === name));
if (unknown.length > 0) throw new Error(`typecheck: unknown project ${unknown.join(", ")}`);
const selected =
  named.length === 0 ? PROJECTS : PROJECTS.filter(([path = ""]) => named.includes(path));
const results = await Promise.all(
  checkers.flatMap((checker) => selected.map((project) => run(checker, project))),
);
const failed = results.filter((r) => !r.ok);

for (const r of failed) console.log(`--- ${r.project}\n${r.out.trimEnd()}`);
console.log(
  failed.length === 0
    ? `typecheck: ${String(selected.length)} projects passed (${checkers.join(" + ")})`
    : `typecheck: FAILED — ${failed.map((r) => r.project).join(", ")}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
