// SPDX-License-Identifier: Apache-2.0

/**
 * Drives one local native artifact through every supported Node, Bun, and Deno loader route.
 * The same contract program runs in each host, so adapter differences cannot hide behind separate
 * assertions.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, join, resolve } from "node:path";
import {
  runtimeIsConfigured,
  supportedBunRuntimes,
  supportedDenoRuntime,
  supportedNodeRuntimes,
} from "../../bench/prior-art/runtimes";
import { installedNativePackages } from "../../src/native-route";
import { NATIVE_TARGETS } from "../../src/native-targets";
import { contract as recordedContract } from "../../scripts/corpus/record";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};

const targetId = argument("--target");
const recordPath = argument("--record");
if ((targetId === undefined) !== (recordPath === undefined))
  throw new Error("--target and --record must be provided together");
const target =
  targetId === undefined
    ? undefined
    : NATIVE_TARGETS.find((candidate) => candidate.id === targetId);
if (targetId !== undefined && target === undefined)
  throw new Error(`unsupported native target: ${targetId}`);
const passedRoutes: string[] = [];

const packageWork = mkdtempSync(join(tmpdir(), "partial-json-repair-native-package-"));
const packaged = Bun.spawnSync({
  cmd: [
    process.execPath,
    "scripts/rust/package-native.ts",
    packageWork,
    ...(target === undefined ? [] : [target.id]),
  ],
  stdout: "pipe",
  stderr: "pipe",
});
if (packaged.exitCode !== 0) throw new Error(packaged.stderr.toString());
const tarball = packaged.stdout.toString().trim();
const extracted = Bun.spawnSync({ cmd: ["tar", "-xzf", tarball, "-C", packageWork] });
if (extracted.exitCode !== 0) throw new Error("native target package extraction failed");
const [inferredPackage] = installedNativePackages();
const packageName = target?.package ?? inferredPackage;
if (packageName === undefined) throw new Error("current host has no native target package");
const packageRoot = resolve(packageWork, "package");
const packageFiles = readdirSync(packageRoot).toSorted();
if (
  packageFiles.length !== 3 ||
  packageFiles[0] !== "LICENSE" ||
  packageFiles[1] !== "package.json" ||
  packageFiles[2] !== "partial-json-repair.node"
)
  throw new Error(`native target package has unexpected files: ${packageFiles.join(", ")}`);
const nativeManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as null | Record<string, unknown>;
if (
  nativeManifest === null ||
  Array.isArray(nativeManifest) ||
  nativeManifest.name !== packageName ||
  nativeManifest.exports !== "./partial-json-repair.node" ||
  Object.hasOwn(nativeManifest, "dependencies") ||
  Object.hasOwn(nativeManifest, "devDependencies") ||
  Object.hasOwn(nativeManifest, "optionalDependencies")
)
  throw new Error("native target package manifest does not describe one standalone library");
const installed = resolve(packageWork, "consumer/node_modules", packageName);
mkdirSync(resolve(installed, ".."), { recursive: true });
renameSync(packageRoot, installed);
writeFileSync(
  resolve(packageWork, "consumer/package.json"),
  `${JSON.stringify({ type: "module", dependencies: { [packageName]: "0.1.0" } })}\n`,
);
const corpus = resolve(packageWork, "consumer/contract.jsonl");
writeFileSync(corpus, recordedContract);
const corpusPath = realpathSync(corpus);
const addon = resolve(installed, "partial-json-repair.node");
const bundled = await Bun.build({
  entrypoints: [
    "src/native-engine.ts",
    "src/native-route.ts",
    "src/bun-ffi.ts",
    "src/node-ffi.ts",
    "src/deno-ffi.ts",
    "src/async.ts",
    "scripts/corpus/canonical.ts",
    "scripts/corpus/selectors.ts",
  ],
  target: "node",
  format: "esm",
  splitting: true,
  outdir: resolve(packageWork, "consumer"),
});
if (!bundled.success) throw new Error("native adapter bundle failed");

const adapter = (name: string): string => {
  const output = bundled.outputs.find((candidate) => basename(candidate.path) === `${name}.js`);
  if (output === undefined) throw new Error(`native adapter build omitted ${name}`);
  return output.path;
};

const corpusContract = String.raw`
const { readFileSync } = await import("node:fs");
const { canonical } = await import(${JSON.stringify(pathToFileURL(adapter("canonical")).href)});
const { decodeWildcards } = await import(${JSON.stringify(pathToFileURL(adapter("selectors")).href)});
const corpusLines = readFileSync(${JSON.stringify(corpusPath)}, "utf8").split("\n").filter(Boolean);
const corpusHeader = JSON.parse(corpusLines[0], decodeWildcards);
let corpusRows = 0;
for (const line of corpusLines.slice(1)) {
  const row = JSON.parse(line);
  if (row.chunks !== undefined) continue;
  const options = corpusHeader.profiles[row.p];
  const parser = loaded.value.configure(options);
  if (!parser.ok) throw new Error(row.id + " native corpus configuration failed");
  const input = row.bytes === undefined
    ? (row.text ?? "")
    : Uint8Array.from({ length: row.bytes.length / 2 }, (_, index) =>
        Number.parseInt(row.bytes.slice(index * 2, index * 2 + 2), 16));
  const actual = {
    parse: parser.value.parse(input),
    repair: parser.value.repair(input),
    span: parser.value.findJsonSpan(input),
    many: parser.value.parseMany(input),
  };
  for (const [surface, value] of Object.entries(actual)) {
    const expected = row.observed[surface];
    const observed = canonical(value);
    if (expected !== undefined && observed !== expected)
      throw new Error(
        row.id + " native corpus " + surface + " moved\nexpected: " + expected + "\nactual: " + observed,
      );
  }
  if (!parser.value.close()) throw new Error(row.id + " native corpus parser did not close");
  corpusRows++;
}
if (corpusRows === 0) throw new Error("native corpus route checked no whole-input rows");
`;

const contract = (load: string, expectedAsync: boolean, includeCorpus = false) => String.raw`
const loaded = ${load};
if (!loaded.ok) throw new Error(loaded.failure.reason);
const streamOf = (result, name) => {
  if (!result.ok) throw new Error(name + ": " + JSON.stringify(result.failure));
  return result.value;
};
const exact = loaded.value.parse("[9007199254740993]");
if (!exact.ok || exact.value[0]?.text !== "9007199254740993")
  throw new Error("native boundary lost an exact number");
const surrogate = loaded.value.parse("\ud800");
if (!surrogate.ok || surrogate.value !== "\ud800")
  throw new Error("native boundary lost a lone surrogate");
const absent = loaded.value.parse("");
if (absent.ok || absent.failure.kind !== "no-json-found")
  throw new Error("native boundary lost a typed parse failure");
const many = loaded.value.parseMany('{"a":1}\n{"b":2}');
if (many.length !== 2 || !many[0]?.ok || !many[1]?.ok)
  throw new Error("native boundary did not return both roots from one call");
const repaired = loaded.value.repair('before {"a":1,} after');
if (!repaired.ok || repaired.value !== '{"a":1}')
  throw new Error("native boundary lost repaired text");
const span = loaded.value.findJsonSpan('before {"a":1} after');
if (!span.ok || span.value.start.offset !== 7 || span.value.end.offset !== 14)
  throw new Error("native boundary lost the source span");
const configured = loaded.value.configure({
  select: [["\ud800"]],
  locations: true,
  diagnostics: true,
  recover: { "single-quote": false },
});
if (!configured.ok)
  throw new Error("native boundary rejected validated configuration: " + JSON.stringify(configured.failure));
const selected = configured.value.parse('{"\\ud800":1,"other":2,}');
if (
  !selected.ok ||
  selected.value.length !== 1 ||
  selected.value[0]?.path[0] !== "\ud800" ||
  selected.value[0]?.value !== 1 ||
  selected.span?.end.offset !== 23 ||
  selected.diagnostics?.repairs[0]?.kind !== "trailing-comma"
)
  throw new Error("native configured parser lost selection, location, or diagnostics: " + JSON.stringify(selected));
const refused = configured.value.parse('{"\\ud800":\'x\'}');
if (
  refused.ok ||
  refused.failure.kind !== "policy-refused" ||
  refused.diagnostics?.errors[0]?.refused !== "single-quote"
)
  throw new Error("native configured parser lost refusal diagnostics");
const supportsAsync = configured.value.supportsAsync();
if (supportsAsync !== ${expectedAsync})
  throw new Error("native route reported the wrong background capability");
if (supportsAsync) {
  const asyncParsed = await configured.value.executeAsync("parse", '{"\\ud800":1}');
  const asyncRepaired = await configured.value.executeAsync("repair", '{"\\ud800":1,}');
  const asyncSpan = await configured.value.executeAsync("findJsonSpan", 'x {"\\ud800":1} y');
  const asyncMany = await configured.value.executeAsync("parseMany", '{"\\ud800":1} [2]');
  if (
    !asyncParsed.ok ||
    !asyncRepaired.ok ||
    !asyncSpan.ok ||
    asyncMany.length !== 1 ||
    asyncMany.some((item) => !item.ok)
  )
    throw new Error(
      "native background execution lost a whole-input projection: " +
        JSON.stringify({ asyncParsed, asyncRepaired, asyncSpan, asyncMany }),
    );
}
configured.value.close();
const occurrenceParser = loaded.value.configure({ select: [["a", "x"]], occurrences: true });
if (!occurrenceParser.ok) throw new Error("native boundary rejected occurrence configuration");
const occurrenceStream = streamOf(occurrenceParser.value.createStream(), "occurrence stream");
const firstOccurrence = occurrenceStream.feed('{"a":{"x":1},');
const secondOccurrence = occurrenceStream.feed('"a":{"x":2}}');
if (
  !firstOccurrence[0]?.ok ||
  firstOccurrence[0].value.value !== 1 ||
  !secondOccurrence[0]?.ok ||
  secondOccurrence[0].value.value !== 2
)
  throw new Error("native configured stream lost source occurrences");
occurrenceStream.close();
const summaryStream = streamOf(occurrenceParser.value.createStream({ summary: true }), "summary stream");
summaryStream.feed('{"a":{"x":3}}');
const pendingSummary = summaryStream.summary?.();
if (
  pendingSummary?.kind !== "summary" ||
  pendingSummary.complete ||
  pendingSummary.roots !== 1 ||
  pendingSummary.matches !== 1
)
  throw new Error("native configured stream advanced while reading its current summary");
const summary = summaryStream.end()[0];
if (
  summary?.kind !== "summary" ||
  !summary.complete ||
  summary.roots !== 1 ||
  summary.matches !== 1 ||
  summary.unmatched.length !== 0
)
  throw new Error("native configured stream lost its terminal summary");
summaryStream.close();
occurrenceParser.value.close();
const fragmentParser = loaded.value.configure({ select: [["a"]] });
if (!fragmentParser.ok) throw new Error("native boundary rejected fragment configuration");
const fragmentStream = streamOf(fragmentParser.value.createStream({ fragments: true }), "fragment stream");
const fragments = fragmentStream.feed('{"a":"hello"}');
if (
  fragments.length !== 3 ||
  !fragments[0]?.ok ||
  fragments[0].value.kind !== "start" ||
  !fragments[1]?.ok ||
  fragments[1].value.kind !== "data" ||
  fragments[1].value.text !== "hello" ||
  !fragments[2]?.ok ||
  fragments[2].value.kind !== "end"
)
  throw new Error("native configured stream lost scalar fragments");
fragmentStream.close();
fragmentParser.value.close();
const viewParser = loaded.value.configure({});
if (!viewParser.ok) throw new Error("native boundary rejected view configuration");
const viewStream = streamOf(viewParser.value.createStream({ view: "owned" }), "owned view");
viewStream.feed('{"a":"par');
const snapshot = viewStream.snapshot?.();
if (
  snapshot?.ok !== true ||
  typeof snapshot.value?.value !== "object" ||
  snapshot.value.value === null ||
  snapshot.value.value.a !== "par" ||
  snapshot.value.complete ||
  snapshot.value.partialPath?.[0] !== "a"
)
  throw new Error("native configured stream lost its owned snapshot");
viewStream.close();
const sharedStream = streamOf(
  viewParser.value.createStream({ view: "shared", summary: true }),
  "shared view",
);
sharedStream.feed('{"stable":{"x":1},"open":[');
const sharedFirst = sharedStream.snapshot?.();
sharedStream.feed("2");
const sharedSecond = sharedStream.snapshot?.();
if (
  sharedFirst?.ok !== true ||
  sharedSecond?.ok !== true ||
  !Object.isFrozen(sharedSecond.value?.value) ||
  sharedFirst.value?.value.stable !== sharedSecond.value?.value.stable
)
  throw new Error("native shared snapshots lost protection or stable branch identity");
const sharedTail = sharedStream.end();
if (sharedTail.at(-1)?.kind !== "summary")
  throw new Error("native view stream lost its terminal summary");
sharedStream.close();
viewParser.value.close();
const stoppedParser = loaded.value.configure({ select: [["a"]], recover: { "unquoted-key": false } });
if (!stoppedParser.ok) throw new Error("native boundary rejected stopped-view configuration");
const stoppedStream = streamOf(stoppedParser.value.createStream({ view: "owned" }), "stopped view");
stoppedStream.feed('{"a":1,b:2}');
const stoppedView = stoppedStream.snapshot?.();
if (
  stoppedView?.ok !== false ||
  stoppedView.failure.kind !== "policy-refused" ||
  !Array.isArray(stoppedView.failure.recovered?.value) ||
  stoppedView.failure.recovered.value[0]?.value !== 1
)
  throw new Error("native selected view lost recovery on terminal failure");
stoppedStream.close();
stoppedParser.value.close();
const rawFragments = loaded.value.createStream({ fragments: true });
if (rawFragments.ok || rawFragments.failure.reason !== "requires-select")
  throw new Error("native raw stream hid an invalid fragment configuration");
const rawView = streamOf(loaded.value.createStream({ view: "owned" }), "raw view");
rawView.feed('{"a":1');
if (rawView.snapshot?.().ok !== true)
  throw new Error("native raw stream ignored its requested view");
rawView.close();
const slicedParser = loaded.value.configure({ diagnostics: true });
if (!slicedParser.ok) throw new Error("native boundary rejected sliced stream configuration");
const sliced = streamOf(slicedParser.value.createStream(), "sliced stream");
const large = '{"padding":"' + 'x'.repeat(20000) + '","value":1,}';
if (sliced.feedSlice(large.slice(0, 16384), 0, false).length !== 0)
  throw new Error("native sliced stream completed a value before its logical chunk ended");
const slicedItems = sliced.feedSlice(large.slice(16384), 16384, true);
if (
  slicedItems.length !== 1 ||
  !slicedItems[0]?.ok ||
  slicedItems[0].diagnostics?.repairs[0]?.at.chunk !== 0 ||
  slicedItems[0].diagnostics.repairs[0].at.offset !== large.length - 2
)
  throw new Error("native sliced stream lost logical chunk coordinates");
sliced.close();
slicedParser.value.close();
${includeCorpus ? corpusContract : ""}
const stream = streamOf(loaded.value.createStream(), "default stream");
if (!loaded.value.close() || !loaded.value.close())
  throw new Error("native engine release was not idempotent");
if (stream.feed('{"a":').length !== 0)
  throw new Error("native stream completed a value before its chunk arrived");
const delta = stream.feed('1}');
if (
  delta.length !== 1 ||
  delta[0]?.ok !== true ||
  typeof delta[0].value !== "object" ||
  delta[0].value === null ||
  Array.isArray(delta[0].value) ||
  delta[0].value.a !== 1
)
  throw new Error("native stream lost its completed chunk delta");
if (stream.end().length !== 0)
  throw new Error("native stream repeated an already delivered value at end");
const ended = stream.end();
if (ended.length !== 1 || ended[0]?.ok || ended[0]?.failure.kind !== "stream-closed")
  throw new Error("native stream hid its terminal state");
stream.close();
stream.close();
const afterClose = loaded.value.parse("null");
if (afterClose.ok || afterClose.failure.kind !== "engine-protocol-failed")
  throw new Error("closed native engine called a released library");
`;

const asyncContract = String.raw`
const api = await import(${JSON.stringify(pathToFileURL(adapter("async")).href)});
const options = { engine: "native", diagnostics: true };
const parsed = await api.parseAsync('{a:1,}', options);
const repaired = await api.repairAsync('{a:1,}', options);
const span = await api.findJsonSpanAsync('x {a:1,} y', options);
const many = [];
for await (const item of api.parseManyAsync('{a:1,} {b:2}', options)) many.push(item);
if (
  !parsed.ok ||
  parsed.diagnostics?.repairs[0]?.kind !== "unquoted-key" ||
  !repaired.ok ||
  repaired.value !== '{"a":1}' ||
  !span.ok ||
  span.value.start.offset !== 2 ||
  many.length !== 2 ||
  many.some((item) => !item.ok)
)
  throw new Error(
    "public async entry lost a native whole-input projection: " +
      JSON.stringify({ parsed, repaired, span, many }),
  );
const initialized = await api.initAsyncParser(options);
if (!initialized.ok)
  throw new Error("public async entry rejected native parser configuration");
const configuredParsed = await initialized.value.parseAsync('{a:1,}');
const configuredRepaired = await initialized.value.repairAsync('{a:1,}');
const configuredSpan = await initialized.value.findJsonSpanAsync('x {a:1,} y');
const configuredMany = [];
for await (const item of initialized.value.parseManyAsync('{a:1,} {b:2}'))
  configuredMany.push(item);
if (
  !configuredParsed.ok ||
  !configuredRepaired.ok ||
  !configuredSpan.ok ||
  configuredMany.length !== 2 ||
  configuredMany.some((item) => !item.ok)
)
  throw new Error("configured public async parser lost a native projection");
const firstClose = initialized.value.close();
if (!firstClose.ok || initialized.value.close() !== firstClose)
  throw new Error("configured public async parser release was not idempotent");
const closedCall = await initialized.value.parseAsync('{}');
if (closedCall.ok || closedCall.failure.kind !== "parser-closed")
  throw new Error("configured public async parser accepted work after release");
const beforeStartController = new AbortController();
const beforeStart = api.parseAsync("{a:1}", { ...options, signal: beforeStartController.signal });
beforeStartController.abort("before-start-stop");
const beforeStartResult = await beforeStart;
if (
  beforeStartResult.ok ||
  beforeStartResult.failure.kind !== "aborted" ||
  beforeStartResult.failure.reason !== "before-start-stop"
)
  throw new Error(
    "native background work lost cancellation before submission: " +
      JSON.stringify(beforeStartResult),
  );
const runningController = new AbortController();
const running = api.findJsonSpanAsync("[" + "0,".repeat(1_000_000) + "0]", {
  ...options,
  signal: runningController.signal,
});
setTimeout(() => runningController.abort("running-stop"), 0);
const runningResult = await running;
if (
  runningResult.ok ||
  runningResult.failure.kind !== "aborted" ||
  runningResult.failure.reason !== "running-stop"
)
  throw new Error(
    "native background work did not observe cancellation after submission: " +
      JSON.stringify(runningResult),
  );
`;

try {
  const node = supportedNodeRuntimes("Node");
  const bun = supportedBunRuntimes("Bun");
  if (node.length === 0 || bun.length === 0)
    throw new Error("native host check requires installed Node and Bun matrices");
  const routes = [
    ...node.flatMap((runtime, runtimeIndex) => [
      {
        ...runtime,
        program: contract(
          `(await import(${JSON.stringify(pathToFileURL(adapter("native-engine")).href)})).NativeEngine.load(${JSON.stringify(addon)})`,
          true,
          runtimeIndex === 0,
        ),
      },
      { ...runtime, label: `${runtime.label} public async native`, program: asyncContract },
      {
        ...runtime,
        label: `${runtime.label} selected route`,
        program: contract(
          `(await import(${JSON.stringify(pathToFileURL(adapter("native-route")).href)})).loadNative()`,
          true,
        ),
      },
    ]),
    ...bun.flatMap((runtime, runtimeIndex) => [
      {
        ...runtime,
        label: `${runtime.label} N-API`,
        program: contract(
          `(await import(${JSON.stringify(pathToFileURL(adapter("native-engine")).href)})).NativeEngine.load(${JSON.stringify(addon)})`,
          true,
          runtimeIndex === 0,
        ),
      },
      { ...runtime, label: `${runtime.label} public async native`, program: asyncContract },
      {
        ...runtime,
        label: `${runtime.label} FFI`,
        program: contract(
          `(await import(${JSON.stringify(pathToFileURL(adapter("bun-ffi")).href)})).loadBunFfi(${JSON.stringify(addon)})`,
          false,
          runtimeIndex === 0,
        ),
      },
      {
        ...runtime,
        label: `${runtime.label} selected route`,
        program: contract(
          `(await import(${JSON.stringify(pathToFileURL(adapter("native-route")).href)})).loadNative()`,
          false,
        ),
      },
    ]),
  ];
  let nodeFfiCorpus = true;
  for (const runtime of node) {
    const supported = Bun.spawnSync({
      cmd: [
        ...runtime.argv,
        "--experimental-ffi",
        "-e",
        'process.exit(process.getBuiltinModule?.("node:ffi") ? 0 : 1)',
      ],
      stderr: "ignore",
    });
    if (supported.exitCode === 0) {
      routes.push({
        ...runtime,
        label: `${runtime.label} FFI`,
        argv: [...runtime.argv, "--experimental-ffi"],
        program: contract(
          `(await import(${JSON.stringify(pathToFileURL(adapter("node-ffi")).href)})).loadNodeFfi(${JSON.stringify(addon)})`,
          false,
          nodeFfiCorpus,
        ),
      });
      nodeFfiCorpus = false;
    }
  }
  const hostCommands: {
    readonly cmd: string[];
    readonly env: NodeJS.ProcessEnv;
    readonly label: string;
  }[] = routes.map((route) => ({
    label: route.label,
    cmd: [...route.argv, "--input-type=module", "-e", route.program],
    env: { ...process.env, UV_THREADPOOL_SIZE: "1" },
  }));
  if (runtimeIsConfigured("deno")) {
    const deno = supportedDenoRuntime("Deno").argv[0];
    if (deno === undefined) throw new Error("native host check lost the Deno executable");
    const denoExecutable = realpathSync(deno);
    const denoAddon = realpathSync(addon);
    const consumer = realpathSync(resolve(packageWork, "consumer"));
    const denoPermissionProgram = resolve(consumer, "deno-permission.mjs");
    writeFileSync(
      denoPermissionProgram,
      `const loaded = (await import(${JSON.stringify(pathToFileURL(adapter("deno-ffi")).href)})).loadDenoFfi(${JSON.stringify(denoAddon)});\n` +
        `if (loaded.ok || loaded.failure.reason !== "permission") throw new Error("Deno FFI permission refusal was not typed");\n`,
    );
    hostCommands.push({
      label: "Deno FFI permission refusal",
      cmd: [
        denoExecutable,
        "run",
        "--node-modules-dir=manual",
        `--allow-read=${consumer}`,
        denoPermissionProgram,
      ],
      env: process.env,
    });
    let denoIndex = 0;
    for (const [label, load, includeCorpus] of [
      [
        "Deno FFI",
        `(await import(${JSON.stringify(pathToFileURL(adapter("deno-ffi")).href)})).loadDenoFfi(${JSON.stringify(denoAddon)})`,
        true,
      ],
      [
        "Deno Node-API",
        `(await import(${JSON.stringify(pathToFileURL(adapter("native-engine")).href)})).NativeEngine.load(${JSON.stringify(denoAddon)})`,
        true,
      ],
      [
        "Deno selected route",
        `(await import(${JSON.stringify(pathToFileURL(adapter("native-route")).href)})).loadNative()`,
        false,
      ],
    ] as const) {
      const program = resolve(consumer, `deno-native-${String(denoIndex++)}.mjs`);
      writeFileSync(program, contract(load, true, includeCorpus));
      hostCommands.push({
        label,
        cmd: [
          denoExecutable,
          "run",
          "--node-modules-dir=manual",
          `--allow-read=${consumer}`,
          "--allow-ffi",
          "--allow-sys",
          program,
        ],
        env: process.env,
      });
    }
    const denoAsyncProgram = resolve(consumer, "deno-async.mjs");
    writeFileSync(denoAsyncProgram, asyncContract);
    hostCommands.push({
      label: "Deno public async native",
      cmd: [
        denoExecutable,
        "run",
        "--node-modules-dir=manual",
        `--allow-read=${consumer}`,
        "--allow-ffi",
        "--allow-sys",
        denoAsyncProgram,
      ],
      env: { ...process.env, UV_THREADPOOL_SIZE: "1" },
    });
  }
  const routeResults = await Promise.all(
    hostCommands.map(async ({ cmd, env, label }) => {
      const result = Bun.spawn({
        cmd,
        env,
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(result.stderr).text(),
        result.exited,
      ]);
      return exitCode === 0 ? { label, ok: true as const } : { label, ok: false as const, stderr };
    }),
  );
  const failedRoutes = routeResults.filter((result) => !result.ok);
  if (failedRoutes.length > 0)
    throw new Error(
      failedRoutes
        .map((result) => `${result.label} native boundary failed:\n${result.stderr}`)
        .join("\n"),
    );
  passedRoutes.push(...routeResults.map((result) => result.label));
} finally {
  rmSync(packageWork, { recursive: true, force: true });
}

if (target !== undefined && recordPath !== undefined) {
  mkdirSync(resolve(recordPath, ".."), { recursive: true });
  writeFileSync(
    recordPath,
    `${JSON.stringify({ schema: 1, target: target.id, routes: passedRoutes })}\n`,
  );
}

console.log(`native boundary: ${String(passedRoutes.length)} eligible loader routes passed`);
