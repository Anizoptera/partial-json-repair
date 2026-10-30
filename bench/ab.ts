// SPDX-License-Identifier: Apache-2.0

/**
 * Does THIS commit cost anything? Builds nothing and compares one revision's `src/` against the
 * working tree, interleaved in a single process.
 *
 * `bun bench/ab.ts <git-ref>` — e.g. `bun bench/ab.ts HEAD~1`.
 *
 * **A stored baseline cannot answer this.** The drift that cost this package ~2x arrived at a few
 * percent per commit, under the reproducibility floor, so comparing today's run against a figure
 * recorded last week mixes code and machine changes. Interleaving reduces common drift, which is
 * why this screening reports a within-run RATIO rather than comparing stored rates.
 *
 * Clean input controls for machine drift, but shared code and optimizer decisions can affect it
 * too. Similar clean and damaged movements do not identify a cause; independent processes and the
 * packed public route must settle a consequential regression claim (MEASUREMENT.md).
 *
 * Both revisions are imported into ONE process, which makes every shared call site polymorphic for
 * both. Equal exposure does not prove equal JIT effects, so this is a screening comparison; its
 * absolute microseconds are not comparable with another harness.
 *
 * No build and no `node_modules`: the recovery core has zero runtime dependencies, so the revision's
 * `src/` runs straight from a `git archive` extraction.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { LLM_FULL } from "../src/presets";
import { resolveOptions } from "../src/options";
import { scan } from "../src/scan-collect";
import { createStreamParser, diagnostics } from "../src/index";
import { firstDifference } from "./prior-art/same-value";

const ref = process.argv[2];
if (ref === undefined) throw new Error("usage: bun bench/ab.ts <git-ref>");

const ROUNDS = 60;
const BATCH = 20;
/** Floored in INVOCATIONS, not milliseconds: a tiering JIT counts calls, and a duration-based floor
 *  satisfies itself on the first call for a slow subject and times it cold for ever. */
const WARMUP = 200;

const tree = Bun.spawnSync(["git", "rev-parse", "--verify", "--end-of-options", ref + "^{tree}"], {
  cwd: import.meta.dir + "/..",
});
if (tree.exitCode !== 0) throw new Error(`git ref ${ref}: ${tree.stderr.toString()}`);
const treeId = tree.stdout.toString().trim();
let root: string | undefined;
{
  // Register scratch cleanup before allocation; disposal preserves operation and cleanup errors.
  using scratch = {
    [Symbol.dispose]() {
      if (root !== undefined) {
        rmSync(root, { recursive: true });
        if (existsSync(root)) throw new Error(`comparison scratch remains: ${root}`);
      }
    },
  };
  root = mkdtempSync(join(tmpdir(), "pjr-ab-"));
  // Revisions and paths are data, never shell syntax; reject Git failure before extracting.
  const archive = Bun.spawnSync(["git", "archive", treeId, "src"], {
    cwd: import.meta.dir + "/..",
  });
  if (archive.exitCode !== 0) throw new Error(`git archive ${ref}: ${archive.stderr.toString()}`);
  const extract = Bun.spawnSync(["tar", "-x", "-C", root], { stdin: archive.stdout });
  if (extract.exitCode !== 0) throw new Error(`git archive ${ref}: ${extract.stderr.toString()}`);
  // Historical controls may expose the full collector from scan.ts.
  const collector = existsSync(join(root, "src/scan-collect.ts")) ? "scan-collect.ts" : "scan.ts";
  const old = (await import(join(root, "src", collector))) as { scan: typeof scan };
  console.log(`control ${ref}: tree ${treeId}`);
  const oldOptions = (await import(join(root, "src/options.ts"))) as {
    resolveOptions: typeof resolveOptions;
  };
  const oldFeatures = (await import(join(root, "src/index.ts"))) as {
    diagnostics?: typeof diagnostics;
    createStreamParser: typeof createStreamParser;
  };

  const members: string[] = [];
  for (let i = 0; i < 400; i++)
    members.push(
      `${i % 3 === 0 ? `k${i}` : `"k${i}"`}: ${i % 4 === 0 ? `'v${i}'` : `"v${i}"`}${i % 5 === 0 ? " // n\n" : ""}`,
    );
  const damaged = `{${members.join(",")},}`;
  const clean = JSON.stringify(
    Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, `v${i}`])),
  );

  // `builtinParsers: false` keeps every input on the scanner, the code under comparison; a built-in
  // parser route would measure `JSON.parse` on clean input instead.
  const settings = { ...LLM_FULL, builtinParsers: false, diagnostics } as const;
  // A revision without the imported diagnostics feature gets its legacy `true` spelling; each
  // feature-bearing subject must construct reports through its own revision's factory.
  const resolve = (r: typeof resolveOptions, report: typeof diagnostics | undefined) => {
    // Feature factories own implementation state; a current Report cannot serve an old scanner.
    const o =
      report === undefined
        ? r({ ...settings, diagnostics: true } as unknown as typeof settings)
        : r({ ...settings, diagnostics: report });
    if ("kind" in o) throw new Error(`unusable options: ${JSON.stringify(o)}`);
    return o;
  };
  // Resolved ONCE, as a parser does. Resolving inside the timed body charges every parse for work a
  // caller pays per parser, which buries the repair-path cost this exists to see.
  const before = resolve(oldOptions.resolveOptions, oldFeatures.diagnostics);
  const after = resolve(resolveOptions, diagnostics);
  // Public stream projection has costs the scanner alone cannot expose; include default calls.
  const streamInput = Array.from({ length: 40 }, (_, id) =>
    JSON.stringify({ id, value: `v${id}` }),
  ).join("\n");
  const streamResults = (create: typeof createStreamParser) => {
    const parser = create();
    try {
      const items = Array.from(parser.feed(streamInput.slice(0, 128)));
      for (let offset = 128; offset < streamInput.length; offset += 128)
        for (const item of parser.feed(streamInput.slice(offset, offset + 128))) items.push(item);
      for (const item of parser.end()) items.push(item);
      if (items.length !== 40 || items.some((item) => !item.ok || !item.complete))
        throw new Error("public stream did not finish every marked root exactly once");
      return items;
    } finally {
      parser.close();
    }
  };
  const subjects = [
    ["damaged before", () => old.scan(damaged, before)],
    ["damaged after", () => scan(damaged, after)],
    ["clean before", () => old.scan(clean, before)],
    ["clean after", () => scan(clean, after)],
    ["stream before", () => streamResults(oldFeatures.createStreamParser)],
    ["stream after", () => streamResults(createStreamParser)],
  ] as const;

  // Equal results before any timing: a revision that stops early or drops a repair does less work
  // and would read as faster. Strict structural comparison of the whole scan result, never a
  // serialiser, which hides `NaN` and `undefined`.
  for (const [input, text] of [
    ["damaged", damaged],
    ["clean", clean],
  ] as const) {
    const d = firstDifference(old.scan(text, before), scan(text, after));
    if (d !== undefined)
      throw new Error(
        `${input}: ${ref} and the working tree differ at ${d.path.join(".") || "the root"} ` +
          `(${inspect(d.a, { depth: 2 })} vs ${inspect(d.b, { depth: 2 })}); their timings would compare different work`,
      );
  }

  const streamDifference = firstDifference(
    streamResults(oldFeatures.createStreamParser),
    streamResults(createStreamParser),
  );
  if (streamDifference !== undefined)
    throw new Error(
      `public stream: ${ref} and the working tree differ at ${streamDifference.path.join(".")}`,
    );

  // Minimum per subject: everything else on the machine can only ADD time, so the minimum converges
  // on what the code costs uncontended while a median tracks how busy the machine was.
  const best = new Map<string, number>();
  for (let round = 0; round < ROUNDS; round++)
    for (const [name, run] of subjects) {
      if (round === 0) for (let i = 0; i < WARMUP; i++) run();
      const started = Bun.nanoseconds();
      for (let i = 0; i < BATCH; i++) run();
      const each = (Bun.nanoseconds() - started) / BATCH;
      best.set(name, Math.min(best.get(name) ?? Infinity, each));
    }

  const timing = (key: string): number => {
    const value = best.get(key);
    if (value === undefined) throw new Error(`no timing recorded for ${key}`);
    return value;
  };
  const ratio = (subject: string) =>
    (timing(`${subject} after`) / timing(`${subject} before`) - 1) * 100;
  for (const [name, value] of best)
    console.log(`${name.padEnd(15)} ${(value / 1000).toFixed(1)} us`);
  console.log(
    // Whole percent. This rig resolves about 5%, so a tenth of a percent is a digit it cannot
    // support, and printing one invites reading a 0.4% "regression" that is pure machine.
    `\nvs ${ref}: damaged ${Math.round(ratio("damaged"))}%, clean ${Math.round(ratio("clean"))}%, stream ${Math.round(ratio("stream"))}%` +
      `\nclean is the control: it emits no repairs, so a repair-path change cannot move it.` +
      `\nRe-run several times — a difference smaller than the clean spread is this machine, not the commit.`,
  );
}
