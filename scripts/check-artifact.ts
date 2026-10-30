/**
 * Asserts the distributable artefact against the PACKED BYTES rather than the working tree.
 *
 * Everything here is checkable only after a pack: `files` is an allowlist, so what ships is decided
 * by the packer and not by anything a source-level scan can see. The tarball's own listing is used
 * as the index, because it cannot disagree with what a consumer receives.
 *
 * Shape borrowed from `@anizoptera/uuid-slug`, whose version of this file records the failures that
 * shaped it. Adapted, not copied: this package ships a root and an async entry and no Node build,
 * and its repository carries a conformance corpus, far larger than the package, that must never
 * leave it.
 */
import { run, runHostProbes } from "./consumer-host-probes";
import type { HostProbe } from "./consumer-host-probes";
import {
  pendingStartupProbe,
  startupListenerFailureProbe,
  startupReleaseProbe,
} from "../test/worker-startup-probe";
import { workerTerminationProbe } from "../test/worker-termination-probe";
import { workerExitMarker, workerExitProbe } from "../test/worker-exit-probe";
import { workerMessageCancellationProbe } from "../test/worker-message-cancellation-probe";
import { workerInputProbe } from "../test/worker-input-probe";
import { workerHostStartProbes } from "../test/worker-host-start-probe";
import { denoWorkerProbes } from "../test/deno-worker-probe";
import { packedRuntimeProbe } from "../test/packed-runtime-probe";
import { nativeStreamProbe } from "../test/native-stream-probe";
import { transportSchedulingProbe } from "../test/transport-scheduling-probe";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkEditor } from "./consumer-editor";
import { checkConsumerMemory } from "./consumer-memory";
import { preparePackages, requireArchiveIdentity } from "./package-artifacts";
import { TYPESCRIPT_PACKAGES } from "./typescript-compilers";
import { verifyApi } from "./api";
import {
  assertReadmeLinksResolve,
  DOCUMENTED,
  NOT_COMPILED,
  readArtifactDocument,
} from "./artifact-docs";

/**
 * A build-machine path in a shipped file is the leak this package can actually produce: a sourcemap
 * that inlines `/Users/someone/...` or `/home/runner/...` publishes the layout of the machine that
 * built it, and nothing else in the pipeline looks. This package ships `src/` and sourcemaps, so
 * there are two ways for one to arrive.
 */
const BUILD_PATH_LEAK = /(?:\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\)/u;

/**
 * `corpus/` is where this package could lose the most bytes, and a reader would misread it as part
 * of the library: it is the conformance record the parked Rust port must meet, not code the package
 * runs.
 */
const FORBIDDEN_PATHS = [
  "corpus/",
  "bench/",
  "test/",
  ".github/",
  "scripts/",
  "AGENTS.md",
  "CLAUDE.md",
  "vitest.config",
  "tsconfig",
  "cliff.toml",
];

/**
 * The one AGENTS.md that ships: the guide for consumers' coding agents, copied from
 * CONSUMER-AGENTS.md by the build. Every other AGENTS.md steers contributors and must not leak.
 */
const CONSUMER_AGENTS = "dist/AGENTS.md";

/**
 * Compile the reader's own examples against shipped declarations; handwritten copies can drift.
 * Free names an example leans on (`text`, `render`) come from one ambient prelude, so a block reads
 * like real code instead of carrying setup noise. Uses the latest compiler only: declaration support
 * across versions is the bare consumer's job above.
 */
const compileDocExamples = (
  consumer: string,
  packedReadme: ReturnType<typeof readArtifactDocument>,
): void => {
  const examples = path.join(consumer, "examples");
  mkdirSync(examples, { recursive: true });
  const files: string[] = [];
  let skipped = 0;
  for (const document of DOCUMENTED) {
    // A retained archive can differ from this checkout; compile what its README actually ships.
    const parsed =
      document === "README.md"
        ? packedReadme
        : readArtifactDocument(readFileSync(document, "utf8"));
    for (const example of parsed.examples) {
      if (example.compile) {
        // The line number in the file name is what a failing diagnostic points the reader back to.
        const name = `${document.replaceAll(/[/.]/gu, "_")}-L${example.line}.ts`;
        writeFileSync(path.join(examples, name), `${example.source}\nexport {};\n`);
        files.push(`examples/${name}`);
      } else {
        skipped++;
      }
    }
  }
  // Compiling the prelude alone passes, so a parser that found nothing would read as a green check.
  if (files.length === 0)
    throw new Error(`docs: no TypeScript examples found in ${DOCUMENTED.join(", ")}`);
  writeFileSync(
    path.join(consumer, "examples-tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["es2022", "dom", "esnext.disposable"],
        module: "nodenext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "es2022",
        // README carries a Node-stream recipe; the bare consumer above stays free of Node types.
        types: ["node"],
      },
      files: ["doc-prelude.d.ts", ...files],
    }),
  );
  writeFileSync(
    path.join(consumer, "doc-prelude.d.ts"),
    readFileSync("scripts/doc-prelude.d.ts", "utf8"),
  );
  // `@types/node` imports `undici-types`, so both travel together.
  for (const types of ["@types/node", "undici-types"])
    cpSync(path.join("node_modules", types), path.join(consumer, "node_modules", types), {
      recursive: true,
    });
  run("node", [
    path.resolve("node_modules/typescript/bin/tsc"),
    "-p",
    path.join(consumer, "examples-tsconfig.json"),
  ]);
  console.log(`docs: ${files.length} examples compile; ${skipped} marked ${NOT_COMPILED}`);
};

async function main(): Promise<void> {
  const cliArguments = process.argv.slice(2);
  const aliasOnly = cliArguments[0] === "--alias";
  const supplied = aliasOnly ? cliArguments[1] : cliArguments[0];
  if (cliArguments.length > (aliasOnly ? 2 : 1))
    throw new Error("Usage: check-artifact.ts [--alias] [cleaned.tgz]");
  // Publish-clean invokes this hook from the package directory, including the alias directory.
  process.chdir(path.resolve(import.meta.dir, ".."));
  if (supplied === undefined) {
    const work = mkdtempSync(path.join(tmpdir(), "pjr-cleaned-artifacts-"));
    try {
      await preparePackages(work, "working-tree");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    console.log("artifact: both cleaned packages passed their consumer checks");
    return;
  }
  // The credentialed repack must be identical; preparation already tested these exact bytes.
  const expected = process.env.PJR_EXPECTED_ARCHIVE;
  if (expected !== undefined) return requireArchiveIdentity(supplied, expected);
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    devDependencies?: Record<string, string>;
    license?: string;
    version?: string;
  };
  if (manifest.license !== "Apache-2.0") throw new Error("package license must be Apache-2.0");
  if (typeof manifest.version !== "string") throw new Error("package version must be a string");
  // The alias is generated from the main manifest (package-artifacts.ts), so its contents are right
  // by construction; only publication's byte identity above needs checking.
  if (aliasOnly) return;
  const notice = readFileSync("NOTICE", "utf8");
  if (!notice.includes("JSONTestSuite") || !notice.includes("MIT License"))
    throw new Error("NOTICE must retain the borrowed JSONTestSuite attribution and MIT terms");
  // Derived, never listed: a hardcoded set of forbidden dev dependencies goes stale the moment one
  // is added, and the one nobody remembered to add is exactly the one that leaks.
  const devDeps = Object.keys(manifest.devDependencies ?? {});

  // The destination is a directory this script owns, so cleanup never depends on parsing
  // human-facing pack output.
  const root = mkdtempSync(path.join(tmpdir(), "partial-json-repair-artifact-"));
  try {
    const tarball = path.resolve(supplied);
    run("tar", ["xzf", tarball, "-C", root]);
    const extracted = path.join(root, "package");
    const api = await verifyApi(extracted);
    const files = run("tar", ["tzf", tarball])
      .trim()
      .split("\n")
      .filter((line) => line.length > 0 && !line.endsWith("/"))
      .map((line) => line.replace(/^package\//u, ""));

    const leaked = files.find(
      (file) =>
        file !== CONSUMER_AGENTS &&
        FORBIDDEN_PATHS.some((prefix) => file.startsWith(prefix) || file.includes(`/${prefix}`)),
    );
    if (leaked !== undefined) throw new Error(`Forbidden path leaked into the artefact: ${leaked}`);
    if (!files.includes(CONSUMER_AGENTS))
      throw new Error(
        `${CONSUMER_AGENTS} is missing: the build copies CONSUMER-AGENTS.md there for consumers' coding agents.`,
      );

    // `files` is an allowlist, so a missing entry is silently omitted from the tarball. These two
    // are npm's own surface -- the page it renders and the licence it displays -- so the pair is
    // closed rather than a list that grows.
    for (const required of ["README.md", "LICENSE"]) {
      if (!files.includes(required))
        throw new Error(`${required} is promised by \`files\`, absent`);
    }
    if (files.includes("NOTICE"))
      throw new Error("Test-only borrowed notices must not burden the published package");
    const packedLicense = readFileSync(path.join(extracted, "LICENSE"), "utf8");
    if (!packedLicense.includes("Apache License") || !packedLicense.includes("Version 2.0"))
      throw new Error("Packed LICENSE is not the Apache License 2.0 text");

    const packedReadme = readArtifactDocument(
      readFileSync(path.join(extracted, "README.md"), "utf8"),
    );
    assertReadmeLinksResolve(files, packedReadme);

    const packedManifest = JSON.parse(
      readFileSync(path.join(extracted, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const runtimeDeps = Object.keys(
      (packedManifest.dependencies as Record<string, unknown> | undefined) ?? {},
    );
    if (runtimeDeps.length > 0) {
      throw new Error(
        `Runtime dependencies leaked: ${runtimeDeps.join(", ")}. This package has none.`,
      );
    }

    // EVERY shipped file is read, and an unreadable one FAILS rather than being skipped: an
    // extension allowlist or a swallowed read error reports clean for a reason other than
    // cleanliness.
    for (const file of files) {
      const text = readFileSync(path.join(extracted, file), "utf8");
      for (const dep of devDeps) {
        // Bare specifier, subpath, `require` and dynamic `import` alike -- three spellings of one
        // leak, in a check whose whole job is that this package ships nothing it built with.
        const escaped = dep.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
        const specifier = String.raw`["']${escaped}(?:/[^"']*)?["']`;
        const pattern = String.raw`(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)${specifier}`;
        if (new RegExp(pattern, "u").test(text)) {
          throw new Error(`Dev dependency import leaked in ${file}: ${dep}`);
        }
      }
      if (BUILD_PATH_LEAK.test(text)) throw new Error(`A build-machine path leaked in ${file}`);
    }

    const mapped = files.filter((file) => file.endsWith(".js") || file.endsWith(".d.ts"));
    if (!mapped.some((file) => file.endsWith(".d.ts")))
      throw new Error("No TypeScript declarations shipped");
    for (const file of mapped) {
      const mapFile = `${file}.map`;
      if (!files.includes(mapFile)) throw new Error(`${file} ships without ${mapFile}`);
      const source = readFileSync(path.join(extracted, file), "utf8");
      if (!source.includes(`//# sourceMappingURL=${path.basename(mapFile)}`))
        throw new Error(`${file} does not reference its shipped source map`);
      const map = JSON.parse(readFileSync(path.join(extracted, mapFile), "utf8")) as {
        file?: string;
        sources?: unknown[];
        sourcesContent?: unknown[];
      };
      if (
        map.file !== path.basename(file) ||
        !Array.isArray(map.sources) ||
        map.sources.length === 0
      )
        throw new Error(`${mapFile} does not map ${file} to source`);
      if (map.sourcesContent?.some((content) => typeof content === "string") === true)
        throw new Error(`${mapFile} embeds source text already shipped as original files`);
      // External map sources must remain available after installation, not just in the workspace.
      for (const original of map.sources) {
        if (typeof original !== "string")
          throw new Error(`${mapFile} contains a malformed source path`);
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(mapFile), original),
        );
        if (!files.includes(resolved))
          throw new Error(`${mapFile} refers to source ${original} missing from the package`);
      }
    }
    for (const file of files.filter((candidate) => candidate.endsWith(".js"))) {
      const external = new Bun.Transpiler({ loader: "js" })
        .scan(readFileSync(path.join(extracted, file), "utf8"))
        .imports.find(
          ({ path: specifier }) => !specifier.startsWith(".") && !specifier.startsWith("node:"),
        );
      if (external !== undefined)
        throw new Error(`${file} imports undeclared runtime tool ${external.path}`);
    }

    /**
     * Build the two portable entries as a browser consumer does. The core must contain no Node
     * adapter; the async entry may retain its guarded Node fallback, but it must still bundle for a
     * host where the standard Worker capability is the only route.
     */
    const portableEntries = ["dist/index.js", "dist/async.js"] as const;
    await Promise.all(
      portableEntries.map(async (portable) => {
        const bundled = await Bun.build({
          entrypoints: [path.join(extracted, portable)],
          target: "browser",
        });
        if (!bundled.success) throw new Error(`${portable} does not bundle for browsers`);
        if (portable === "dist/index.js") {
          const [output] = bundled.outputs;
          if (output === undefined || /["']node:[a-z_/]+["']/u.test(await output.text()))
            throw new Error("The core browser bundle reaches a Node adapter");
        }
      }),
    );

    // Executed, not merely read: a build can be well-formed, dependency-free and still dead, and an
    // entry that throws at import time passes every textual check above.
    await Promise.all(
      api.map(async (contract) => {
        const runtime = (await import(path.join(extracted, contract.runtime))) as Record<
          string,
          unknown
        >;
        const actualValues = Object.keys(runtime).toSorted();
        if (actualValues.join("\n") !== contract.values.join("\n"))
          throw new Error(
            `Runtime exports for ${contract.entry} disagree with shipped declarations: expected ${contract.values.join(", ")}; received ${actualValues.join(", ")}`,
          );
      }),
    );

    const probes: HostProbe[] = [];
    const queueProbe = (
      command: string,
      args: string[],
      cwd = extracted,
      expectedOutput?: string,
    ): void => {
      // Eval programs end with their source argument; its final marker follows top-level awaits
      // and cleanup. A lifecycle marker alone can precede unfinished disposal or be omitted.
      const program = args.at(-1);
      if (program === undefined) throw new Error("Packed host probes require an eval program");
      const completed = "packed host program completed";
      probes.push({
        command,
        args: [...args.slice(0, -1), `${program}\nconsole.log(${JSON.stringify(completed)});`],
        cwd,
        expectedOutput: expectedOutput === undefined ? [completed] : [expectedOutput, completed],
      });
    };
    // A transient host startup failure must not poison every later call in this realm.
    const startupRetry = [
      'import { parseAsync, worker } from "partial-json-repair/async";',
      "const NativeURL = globalThis.URL; let denied = false;",
      "globalThis.URL = class extends NativeURL { constructor(input, base) {",
      '  if (input === "./async-worker.js") { denied = true; throw new Error("startup-denied"); }',
      "  super(input, base);",
      "} };",
      "let first;",
      'try { first = await parseAsync("{safe:1}", { execution: worker }); }',
      "finally { globalThis.URL = NativeURL; }",
      'const next = await parseAsync("{safe:2}", { execution: worker });',
      'if (!denied || first.ok || first.failure.kind !== "execution-unavailable" || first.failure.reason !== "failed" || !next.ok || next.value.safe !== 2) throw new Error("worker startup failure poisoned retry: " + first.failure?.reason + "/" + next.failure?.reason);',
    ].join("\n");
    queueProbe("node", ["--input-type=module", "--eval", startupRetry]);
    queueProbe("bun", ["--eval", startupRetry]);
    queueProbe("deno", ["eval", "--allow-read", startupRetry]);

    for (const probe of workerHostStartProbes()) {
      queueProbe("node", ["--input-type=module", "--eval", probe]);
      queueProbe("bun", ["--eval", probe]);
      queueProbe("deno", ["eval", "--allow-read", probe]);
    }

    for (const terminationFails of [false, true]) {
      const startupRelease = startupReleaseProbe(terminationFails);
      queueProbe("node", ["--input-type=module", "--eval", startupRelease]);
      queueProbe("bun", ["--eval", startupRelease]);
      queueProbe("deno", ["eval", "--allow-read", startupRelease]);
    }

    for (const phase of ["startup", "startup-unref", "idle"] as const) {
      for (const rejection of [false, true]) {
        const probe = workerTerminationProbe("partial-json-repair/async", phase, rejection);
        queueProbe("node", ["--input-type=module", "--eval", probe]);
        queueProbe("bun", ["--eval", probe]);
        queueProbe("deno", ["eval", "--allow-read", probe]);
      }
    }

    const idleExit = workerExitProbe("partial-json-repair/async");
    queueProbe("node", ["--input-type=module", "--eval", idleExit], extracted, workerExitMarker);
    queueProbe("bun", ["--eval", idleExit], extracted, workerExitMarker);
    queueProbe("deno", ["eval", "--allow-read", idleExit], extracted, workerExitMarker);

    const messageCancellation = workerMessageCancellationProbe(
      "partial-json-repair/async",
      "partial-json-repair",
    );
    queueProbe("node", ["--input-type=module", "--eval", messageCancellation]);
    queueProbe("bun", ["--eval", messageCancellation]);
    queueProbe("deno", ["eval", "--allow-read", messageCancellation]);

    // Reuse the source regression through installed imports; workspace success cannot prove packing.
    for (const sibling of [false, true]) {
      const probe = pendingStartupProbe(sibling, "partial-json-repair/async");
      queueProbe("node", ["--input-type=module", "--eval", probe]);
      queueProbe("bun", ["--eval", probe]);
      queueProbe("deno", ["eval", "--allow-read", probe]);
    }

    const listenerFailure = startupListenerFailureProbe("partial-json-repair/async");
    queueProbe("node", ["--input-type=module", "--eval", listenerFailure]);
    queueProbe("bun", ["--eval", listenerFailure]);
    queueProbe("deno", ["eval", "--allow-read", listenerFailure]);
    const inputWindow = workerInputProbe("partial-json-repair/async", "partial-json-repair");
    queueProbe("node", ["--input-type=module", "--eval", inputWindow]);
    queueProbe("bun", ["--eval", inputWindow]);
    queueProbe("deno", ["eval", "--allow-read", inputWindow]);
    for (const probe of denoWorkerProbes("partial-json-repair/async"))
      queueProbe("deno", ["eval", "--allow-read", probe]);
    checkConsumerMemory(queueProbe, extracted);
    const transportScheduling = transportSchedulingProbe("partial-json-repair");
    queueProbe("node", ["--input-type=module", "--eval", transportScheduling]);
    queueProbe("bun", ["--eval", transportScheduling]);
    queueProbe("deno", ["eval", "--allow-read", transportScheduling]);
    const asyncSmoke = packedRuntimeProbe();
    const nativeStreams = nativeStreamProbe();
    queueProbe("node", ["--input-type=module", "--eval", nativeStreams]);
    queueProbe("bun", ["--eval", nativeStreams]);
    queueProbe("deno", ["eval", "--allow-read", nativeStreams]);
    queueProbe(
      "node",
      ["--input-type=module", "--eval", asyncSmoke],
      extracted,
      "packed async smoke completed",
    );
    queueProbe("bun", ["--eval", asyncSmoke], extracted, "packed async smoke completed");
    queueProbe(
      "deno",
      ["eval", "--allow-read", asyncSmoke],
      extracted,
      "packed async smoke completed",
    );
    await runHostProbes(probes.splice(0));

    // A missing client must fail through the public outcome before worker construction begins.
    const clientPath = path.join(extracted, "dist/worker-executor.js");
    const clientBackup = `${clientPath}.backup`;
    renameSync(clientPath, clientBackup);
    try {
      const missingClient = [
        'import { parseAsync, worker } from "partial-json-repair/async";',
        'const result = await parseAsync("{}", { execution: worker });',
        'if (result.ok || result.failure.kind !== "execution-unavailable" || result.failure.reason !== "failed" || !result.failure.message.includes("worker file")) throw new Error("missing worker client was not typed or explained");',
        'console.log("packed missing-client assertions completed");',
      ].join("\n");
      // Exit zero is insufficient when an awaited worker failure has not settled.
      queueProbe(
        "node",
        ["--input-type=module", "--eval", missingClient],
        extracted,
        "packed missing-client assertions completed",
      );
      queueProbe(
        "bun",
        ["--eval", missingClient],
        extracted,
        "packed missing-client assertions completed",
      );
      queueProbe(
        "deno",
        ["eval", "--allow-read", missingClient],
        extracted,
        "packed missing-client assertions completed",
      );
      await runHostProbes(probes.splice(0));
    } finally {
      renameSync(clientBackup, clientPath);
    }

    const workerPath = path.join(extracted, "dist/async-worker.js");
    const workerSource = readFileSync(workerPath, "utf8");
    writeFileSync(workerPath, "");
    try {
      const failedWorker = [
        'import { parseAsync, worker } from "partial-json-repair/async";',
        'const result = await parseAsync("{}", { execution: worker });',
        'if (result.ok || result.failure.kind !== "execution-unavailable" || result.failure.reason !== "failed") throw new Error("worker exit was not typed");',
        'console.log("packed failed-worker assertions completed");',
      ].join("\n");
      queueProbe(
        "node",
        ["--input-type=module", "--eval", failedWorker],
        extracted,
        "packed failed-worker assertions completed",
      );
      queueProbe(
        "bun",
        ["--eval", failedWorker],
        extracted,
        "packed failed-worker assertions completed",
      );
      queueProbe(
        "deno",
        ["eval", "--allow-read", failedWorker],
        extracted,
        "packed failed-worker assertions completed",
      );
      // Restore the worker only after every child has observed this cohort's installed fault.
      await runHostProbes(probes.splice(0));
    } finally {
      writeFileSync(workerPath, workerSource);
    }

    /**
     * Compile a consumer against the SHIPPED declarations, with nothing ambient: `types: []` keeps
     * `@types/node` out, because its `esnext.disposable` reference would hide a declaration that
     * needs a lib the consumer never asked for. `skipLibCheck: false` makes the package's own `.d.ts`
     * part of the check. HLD: declarations support TypeScript 6 and the latest major, so both compile it.
     */
    const consumer = path.join(root, "types-consumer");
    mkdirSync(path.join(consumer, "node_modules"), { recursive: true });
    // Both consumers read the same immutable packed files; copying the package proves no more.
    symlinkSync(extracted, path.join(consumer, "node_modules/partial-json-repair"), "dir");
    writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["es2022"],
          module: "nodenext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "es2022",
          types: [],
        },
        files: ["index.ts", "options.types.ts", "envelope.types.ts"],
      }),
    );
    writeFileSync(
      path.join(consumer, "index.ts"),
      [
        'import { createStreamParser, parse } from "partial-json-repair";',
        'import { auto, parseAsync, worker } from "partial-json-repair/async";',
        'export const value: unknown = parse("{}");',
        "export const stream: unknown = createStreamParser();",
        'export const pending: Promise<unknown> = parseAsync("{}", { execution: auto });',
      ].join("\n"),
    );
    // Reuse the source contract through package imports; do not maintain a weaker consumer copy.
    for (const fixture of ["options.types.ts", "envelope.types.ts"])
      writeFileSync(
        path.join(consumer, fixture),
        readFileSync(path.join("test", fixture), "utf8")
          .replaceAll('"../src/index"', '"partial-json-repair"')
          .replaceAll('"../src/metrics"', '"partial-json-repair"')
          .replaceAll('"../src/async"', '"partial-json-repair/async"'),
      );
    // These CLIs read immutable packed files; join them before docs add ambient consumer types.
    // Unlike eval probes, their process exit is the result, so they need no in-program marker.
    await runHostProbes([
      ...TYPESCRIPT_PACKAGES.map((compiler) => ({
        command: "node",
        args: [path.resolve("node_modules", compiler, "bin/tsc"), "-p", consumer],
        cwd: process.cwd(),
        expectedOutput: [],
      })),
      {
        command: "./node_modules/.bin/publint",
        args: ["run", extracted, "--pack", "false"],
        cwd: process.cwd(),
        expectedOutput: [],
      },
      // ESM-only on Node >= 22 intentionally requires dynamic import from CommonJS consumers.
      {
        command: "./node_modules/.bin/attw",
        args: [tarball, "--profile", "esm-only"],
        cwd: process.cwd(),
        expectedOutput: [],
      },
    ]);

    compileDocExamples(consumer, packedReadme);
    checkEditor(consumer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("artifact: supplied cleaned bytes are complete, licensed and dependency-clean");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
