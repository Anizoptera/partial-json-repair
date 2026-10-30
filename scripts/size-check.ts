// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer-graph proof (docs/CONSUMER-GRAPH.md): what a real consumer of the PACKED package retains,
 * removes and loads, in every bundler the HLD supports, and whether the bundle still behaves like the package.
 *
 * Per fixture row (scripts/consumer-fixtures.ts) × bundler it builds three variants:
 * - `optimised`: the packed package as published;
 * - `no-field`: the same package with `"sideEffects"` deleted from its package.json, so a module is
 *   removable only when its own top level does no work. Absence must hold here too: the module shape,
 *   not the metadata, has to make unused features removable;
 * - `conservative`: PURE annotations and `sideEffects` ignored by the bundler.
 * and for each it:
 * - reads the bundler's own module report and fails when a declared-absent module is emitted,
 *   or a declared-present / lazy module is missing or loads at startup (optimised and no-field);
 * - requires unused imports to emit no package code in any optimised chunk, even unreachable ones;
 * - imports the bundle and compares `describe(await run())` with the unbundled package's (all three);
 * - records raw/gzip/brotli/zstd bytes per chunk, initial (static closure of the entry) and total,
 *   chunk count, and modules duplicated across chunks; plus the tarball's own size;
 * - fails when bundlers disagree on startup feature modules; inlined root-wrapper attribution may differ;
 * - names, for every module that ships only without the field, the top-level code that keeps it.
 *
 * Runs against `dist/` as it is: a gate step declares `needs: "build"` (scripts/AGENTS.md).
 */

import { probeArguments } from "./probe-arguments";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import type { Built, Bundler, Consumer, Mode } from "./consumer-bundlers";
import {
  BUNDLERS,
  PKG,
  packConsumer,
  retainedTopLevel,
  withoutSideEffectsField,
  workerRecipe,
} from "./consumer-bundlers";
import type { Fixture } from "./consumer-fixtures";
import type { BuildJob, BuildReply } from "./size-build-worker";
import { FIXTURES } from "./consumer-fixtures";
import { describe, firstDifference } from "../test/consumer-outcomes";

const ROOT = process.env.PJR_ROOT ?? path.resolve(import.meta.dir, "..");
// Refuse unknown arguments and missing values before packing.
const { flag, option } = probeArguments(process.argv.slice(2), {
  usage:
    "bun scripts/size-check.ts [--fixture <id>] [--bundler <name>] [--baseline <file>] [--write-baseline] [--keep] [--json <file>]",
  flags: ["--write-baseline", "--keep"],
  options: ["--fixture", "--bundler", "--baseline", "--json"],
});

// Narrow probes use the same packed judge; they must never replace the full release matrix.
const selected = <T>(
  name: string,
  values: readonly T[],
  key: (value: T) => string,
): readonly T[] => {
  if (!flag(name)) return values;
  const value = option(name);
  const found = values.filter((item) => key(item) === value);
  if (found.length === 0)
    throw new Error(`${name} requires one of: ${values.map((item) => key(item)).join(", ")}`);
  return found;
};
const fixtures = selected("--fixture", FIXTURES, (fixture) => fixture.id);
// A misspelt module is never emitted, so its absence rule would pass forever. Each dist module
// comes from one source file of the same name.
const srcDir = path.join(import.meta.dir, "..", "src");
for (const f of FIXTURES)
  for (const m of [...f.absent, ...(f.present ?? []), ...(f.notAtStartup ?? []), ...(f.lazy ?? [])])
    if (!existsSync(path.join(srcDir, `${m}.ts`)))
      throw new Error(`${f.id}: module "${m}" names no src/${m}.ts`);
const bundlers = selected("--bundler", BUNDLERS, (bundler) => bundler.name);
const partial = flag("--fixture") || flag("--bundler");
if (partial && flag("--write-baseline"))
  throw new Error("Filtered probes cannot write a baseline; run the complete matrix instead.");

/** Pinned maximum levels, as a CDN or server would plausibly serve; byte counts are exact, never sampled. */
const GZIP_LEVEL = 9;
const BROTLI_QUALITY = 11;
const ZSTD_LEVEL = 19;
/**
 * A per-fixture size regression above this fraction of the baseline fails. `docs/CONSUMER-GRAPH.md` asks
 * to fail a "meaningful" regression. Repeated runs differ only where a chunk name carries a hash, by
 * a few bytes, so a 2% move is a real change, never noise.
 */
const REGRESSION = 0.02;

type Variant = "optimised" | "no-field" | "conservative";
const VARIANTS: readonly Variant[] = ["optimised", "no-field", "conservative"];

/**
 * Residue a bundler keeps only when the `sideEffects` field is gone, measured and explained,
 * so the `no-field` variant judges every other module. The published package carries the field, and
 * these modules are absent from every `optimised` build. Printed on every run; remove an entry the
 * moment its bundler stops keeping the module, or the exception hides a real leak.
 */
const explainedFor = (bundler: string, v: Variant): readonly string[] =>
  v === "no-field" ? (NO_FIELD_EXPLAINED[bundler]?.modules ?? []) : [];
// The worker asset and the modules only it holds, emitted (never loaded at startup) by an app using `/async` without `worker`.
const WORKER_ASSET = [
  "async-worker",
  "worker-executor",
  "worker-output",
  "worker-receive",
  "worker-unavailable",
  "report",
  "selector",
  "picks",
  "span-operation",
];
const WORKER_ASSET_WHY =
  'Without the field the bundler counts the worker client\'s lazy `import.meta.glob` as a side effect (webpack stats: "Dependency (import.meta.glob lazy) with side effects"), keeps `worker-strategy` and emits its worker asset; the published package carries the field and every optimised build drops it';
const NO_FIELD_EXPLAINED: Readonly<Record<string, { modules: readonly string[]; why: string }>> = {
  rspack: {
    modules: WORKER_ASSET,
    why:
      "a few hundred bytes of the startup chunk map to report.js; Rspack reports no side-effect bailout, and its optimised build drops the module. " +
      WORKER_ASSET_WHY,
  },
  webpack: { modules: WORKER_ASSET, why: WORKER_ASSET_WHY },
};
const modeOf = (v: Variant): Mode => (v === "conservative" ? "conservative" : "optimised");

const failures: string[] = [];
const fail = (message: string): void => {
  failures.push(message);
};

type Sizes = { raw: number; gzip: number; brotli: number; zstd: number };
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
/**
 * Compression at these levels costs ~30 ms a chunk and was most of the run: ~300 chunk sizings, one
 * after another on the main thread. Each distinct chunk is compressed once (same bytes, same sizes),
 * off the main thread, and all of them concurrently before the judge runs.
 */
const sized = new Map<bigint | number, Promise<Sizes>>();
const markersByFile = new Map<string, ReadonlySet<string>>();
const sizeOf = (
  file: string,
  markers?: Readonly<Record<string, "present" | "absent">>,
): Promise<Sizes> => {
  const bytes = readFileSync(file);
  if (markers !== undefined) {
    // Reuse the compression read; checking code must not reread every emitted chunk.
    const code = bytes.toString("utf8");
    markersByFile.set(
      file,
      new Set(Object.keys(markers).filter((marker) => code.includes(marker))),
    );
  }
  const key = Bun.hash(bytes);
  const known = sized.get(key);
  if (known !== undefined) return known;
  const sizes = Promise.all([
    gzipAsync(bytes, { level: GZIP_LEVEL }),
    brotliAsync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }),
    Bun.zstdCompress(bytes, { level: ZSTD_LEVEL }),
  ]).then(([g, br, z]) => ({
    raw: bytes.byteLength,
    gzip: g.byteLength,
    brotli: br.byteLength,
    zstd: z.byteLength,
  }));
  sized.set(key, sizes);
  return sizes;
};
const add = (a: Sizes, b: Sizes): Sizes => ({
  raw: a.raw + b.raw,
  gzip: a.gzip + b.gzip,
  brotli: a.brotli + b.brotli,
  zstd: a.zstd + b.zstd,
});
const ZERO: Sizes = { raw: 0, gzip: 0, brotli: 0, zstd: 0 };
const show = (x: Sizes): string => `${x.raw}/${x.gzip}/${x.brotli}/${x.zstd}`;

/** The entry chunk plus every chunk reachable from it through static imports: what loads before `run()`. */
const initialChunks = (built: Built): Set<string> => {
  const byFile = new Map(built.chunks.map((c) => [c.file, c]));
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of byFile.get(file)?.staticImports ?? []) visit(next);
  };
  for (const c of built.chunks) if (c.entry) visit(c.file);
  return seen;
};

type Behaviour = "same" | "differs" | "threw" | "unbuilt" | "browser";
type Row = {
  fixture: string;
  bundler: string;
  shipped: Record<Variant, string[]>;
  /** Modules in the chunks that load at startup: what the app pays for (`absent`, `empty`, disagreement). */
  loaded: Record<Variant, string[]>;
  initial: Sizes;
  total: Sizes;
  noFieldTotal: Sizes;
  chunks: { file: string; initial: boolean; sizes: Sizes; modules: string[] }[];
  duplicated: string[];
  /** Non-chunk files the bundler emitted (a worker copied as an asset shows here). */
  assets: string[];
  behaviour: Record<Variant, Behaviour>;
};

const started = performance.now();
/** Seconds since start at each phase end, and when each bundler finished its last build: the line a
 * slow run is diagnosed from, since builds overlap and only finishing times show who holds the wall. */
const marks: string[] = [];
const mark = (name: string): void => {
  marks.push(`${name} ${((performance.now() - started) / 1000).toFixed(1)}`);
};
const packed = packConsumer(ROOT, "pjr-size-");
const builders = new Set<Worker>();
// Setup and compression can throw too; their extracted inputs and live builders share this scope.
using cleanup = {
  [Symbol.dispose]() {
    try {
      for (const builder of builders) builder.terminate();
    } finally {
      if (!flag("--keep")) rmSync(packed.work, { recursive: true });
    }
  },
};
mark("packed");

const fixtureFile = (consumer: Consumer, f: Fixture): string =>
  path.join(consumer.dir, "fixtures", `${f.id}.mjs`);
for (const f of fixtures) writeFileSync(fixtureFile(packed.consumer, f), f.source);
const noFieldConsumer = withoutSideEffectsField(
  packed.consumer,
  path.join(packed.work, "consumer-no-field"),
);
const consumerOf = (v: Variant): Consumer => (v === "no-field" ? noFieldConsumer : packed.consumer);

const runModule = async (
  file: string,
  f: Fixture,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> => {
  try {
    const module = (await import(pathToFileURL(file).href)) as {
      run?: () => Promise<unknown>;
      keep?: unknown;
    };
    if (f.empty === true) return { ok: true, value: describe(module.keep) };
    if (typeof module.run !== "function")
      return { ok: false, error: "bundle does not export run()" };
    return { ok: true, value: describe(await module.run()) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
};

// The reference: the unbundled package, resolved from the consumer's node_modules.
const reference = new Map<string, unknown>();
// Fixture runs stay sequential here and below: the async fixtures time-slice and start workers, so
// concurrent runs would share one event loop and move where an abort lands.
for (const f of fixtures) {
  // oxlint-disable-next-line eslint/no-await-in-loop
  const result = await runModule(fixtureFile(packed.consumer, f), f);
  if (result.ok) {
    reference.set(f.id, result.value);
  } else {
    fail(`${f.id}: the unbundled package threw: ${result.error}`);
  }
}

// Build every fixture × bundler × variant on a pool of threads, one build per thread at a time.
// Not one thread with every build in flight: webpack's compiler is JavaScript, so ~40 concurrent
// compilations queued on one thread and each started its own minifier pool (34 s of a 44 s run).
type Job = { f: Fixture; b: Bundler; v: Variant; built: Built | undefined };
const finished = new Map<string, number>();
mark("reference");
const POOL = Math.min(
  fixtures.length * bundlers.length * VARIANTS.length,
  Math.max(1, Math.floor(navigator.hardwareConcurrency / 2)),
);
type Settle = (reply: BuildReply) => void;
const queued: { job: BuildJob; settle: Settle }[] = [];
const running = new Map<Worker, Settle>();
const idle: Worker[] = [];
const pump = (): void => {
  for (let thread = idle.pop(); thread !== undefined; thread = idle.pop()) {
    const next = queued.shift();
    if (next === undefined) {
      idle.push(thread);
      return;
    }
    running.set(thread, next.settle);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage has no target origin
    thread.postMessage(next.job);
  }
};
const release = (thread: Worker, reply: BuildReply, crashed: boolean): void => {
  running.get(thread)?.(reply);
  running.delete(thread);
  if (crashed) {
    // A crashed thread never answers again; reusing it would leave its next job pending forever.
    thread.terminate();
    builders.delete(thread);
    idle.push(spawnBuilder());
  } else idle.push(thread);
  pump();
};
const spawnBuilder = (): Worker => {
  const thread = new Worker(new URL("size-build-worker.ts", import.meta.url).href);
  builders.add(thread);
  thread.addEventListener("message", (event: MessageEvent<BuildReply>) => {
    release(thread, event.data, false);
  });
  thread.addEventListener("error", (event) => {
    release(thread, { ok: false, error: `build thread crashed: ${event.message}` }, true);
  });
  return thread;
};
for (let i = 0; i < POOL; i++) idle.push(spawnBuilder());
const buildOnPool = (job: BuildJob): Promise<BuildReply> =>
  new Promise((settle) => {
    queued.push({ job, settle });
    pump();
  });
const builds: Job[] = await Promise.all(
  fixtures.flatMap((f) =>
    bundlers.flatMap((b) =>
      VARIANTS.map(async (v): Promise<Job> => {
        const consumer = consumerOf(v);
        const reply = await buildOnPool({
          bundler: b.name,
          entry: fixtureFile(consumer, f),
          dir: path.join(packed.work, "out", b.name, v, f.id),
          mode: modeOf(v),
          extra: f.worker === true && b.takesExtraEntries ? workerRecipe(consumer) : undefined,
        });
        finished.set(b.name, performance.now() - started);
        if (reply.ok) return { f, b, v, built: reply.built };
        fail(`${f.id} × ${b.name} (${v}): build failed: ${reply.error.slice(0, 600)}`);
        return { f, b, v, built: undefined };
      }),
    ),
  ),
);
for (const worker of idle) worker.terminate();
builders.clear();
const buildEnd = performance.now();
mark(
  `built (${[...finished].map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}`).join(", ")})`,
);
const builtOf = (f: Fixture, b: Bundler, v: Variant): Built | undefined =>
  builds.find((x) => x.f === f && x.b === b && x.v === v)?.built;
const shippedOf = (built: Built | undefined): Set<string> =>
  new Set(built?.chunks.flatMap((c) => Object.keys(c.modules)) ?? []);
const loadedOf = (built: Built | undefined): Set<string> => {
  if (built === undefined) return new Set();
  const initial = initialChunks(built);
  return new Set(
    built.chunks.filter((c) => initial.has(c.file)).flatMap((c) => Object.keys(c.modules)),
  );
};

// Size every chunk the judge reads, all at once, so the judge below reads sizes without waiting.
const sizes = new Map<string, Sizes>();
await Promise.all(
  builds.flatMap(({ f, v, built }) =>
    built === undefined || v === "conservative"
      ? []
      : built.chunks.map(async (c) => {
          const file = path.join(built.dir, c.file);
          sizes.set(file, await sizeOf(file, f.markers));
        }),
  ),
);
const sizedOf = (dir: string, chunk: string): Sizes => {
  const known = sizes.get(path.join(dir, chunk));
  if (known === undefined) throw new Error(`chunk ${chunk} in ${dir} was never sized`);
  return known;
};

// Judge each build.
const rows: Row[] = [];
for (const f of fixtures) {
  for (const b of bundlers) {
    const opt = builtOf(f, b, "optimised");
    if (opt === undefined) continue;
    const behaviour = {} as Record<Variant, Behaviour>;
    const shipped = {} as Record<Variant, string[]>;
    const loaded = {} as Record<Variant, string[]>;
    for (const v of VARIANTS) {
      const built = builtOf(f, b, v);
      const tag = `${f.id} × ${b.name} (${v})`;
      shipped[v] = [...shippedOf(built)].toSorted();
      loaded[v] = [...loadedOf(built)].toSorted();
      if (built === undefined) {
        behaviour[v] = "unbuilt";
        continue;
      }
      if (v !== "conservative") {
        const all = shippedOf(built);
        for (const [marker, expected] of Object.entries(f.markers ?? {})) {
          const present = built.chunks.some(
            (chunk) => markersByFile.get(path.join(built.dir, chunk.file))?.has(marker) === true,
          );
          if (present !== (expected === "present"))
            fail(
              `${tag}: feature marker ${JSON.stringify(marker)} is ${present ? "present" : "absent"}, expected ${expected}`,
            );
        }
        const explained = explainedFor(b.name, v);
        const atStartup = new Set(loaded[v].filter((m) => !explained.includes(m)));
        // Outside D5's generic-worker exception, unused features must disappear from every chunk.
        for (const m of f.absent)
          if (all.has(m) && !explained.includes(m))
            fail(`${tag}: ${m} is emitted but the fixture does not use it`);
        for (const m of f.notAtStartup ?? [])
          if (atStartup.has(m))
            fail(`${tag}: ${m} loads at startup but the fixture does not use it`);
        for (const m of f.present ?? [])
          if (!all.has(m)) fail(`${tag}: ${m} is required but absent from the output`);
        for (const m of f.lazy ?? []) {
          if (atStartup.has(m))
            fail(`${tag}: ${m} loads at startup; it must load only on first use`);
          else if (!all.has(m)) fail(`${tag}: ${m} is lazy but emitted nowhere`);
        }
        // An unused import must emit no package code, including unreachable lazy chunks.
        // The metadata-removal control separately judges startup residue and its known exceptions.
        const importResidue = v === "optimised" ? all : atStartup;
        if (f.empty === true && importResidue.size > 0)
          fail(
            `${tag}: import-only bundle ${v === "optimised" ? "emits" : "loads at startup"} ${[...importResidue].toSorted().join(", ")}`,
          );
      }
      if (f.worker === true) {
        behaviour[v] = "browser";
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      const ran = await runModule(built.entryFile, f);
      if (!ran.ok) {
        fail(`${tag}: bundle threw: ${ran.error.slice(0, 400)}`);
        behaviour[v] = "threw";
        continue;
      }
      const where = firstDifference(reference.get(f.id), ran.value);
      if (where !== undefined)
        fail(`${tag}: output differs from the unbundled package at ${where.slice(0, 300)}`);
      behaviour[v] = where === undefined ? "same" : "differs";
    }

    // A worker runs in its own realm and must carry its own copy of the scanner, so the chunk that
    // holds `async-worker` is no duplicate of the main graph.
    const owners = new Map<string, number>();
    for (const c of opt.chunks.filter((chunk) => !("async-worker" in chunk.modules)))
      for (const m of Object.keys(c.modules)) owners.set(m, (owners.get(m) ?? 0) + 1);
    const duplicated = [...owners].filter(([, n]) => n > 1).map(([m]) => m);
    if (duplicated.length > 0)
      fail(`${f.id} × ${b.name}: modules duplicated across chunks: ${duplicated.join(", ")}`);
    const initial = initialChunks(opt);
    const chunkRows = opt.chunks.map((c) => ({
      file: c.file,
      initial: initial.has(c.file),
      sizes: sizedOf(opt.dir, c.file),
      modules: Object.keys(c.modules).toSorted(),
    }));
    const sum = (list: readonly { sizes: Sizes }[]): Sizes =>
      list.reduce((acc, c) => add(acc, c.sizes), ZERO);
    const chunkFiles = new Set(opt.chunks.map((c) => c.file));
    const noField = builtOf(f, b, "no-field");
    rows.push({
      fixture: f.id,
      bundler: b.name,
      shipped,
      loaded,
      initial: sum(chunkRows.filter((c) => c.initial)),
      total: sum(chunkRows),
      noFieldTotal:
        noField === undefined
          ? ZERO
          : sum(noField.chunks.map((c) => ({ sizes: sizedOf(noField.dir, c.file) }))),
      chunks: chunkRows,
      duplicated,
      assets: opt.emitted.filter((e) => !chunkFiles.has(e) && !e.endsWith(".map")),
      behaviour,
    });
  }
}

// Compare the published graph. Without package metadata, multi-entry recipes may share worker
// modules with startup even when published builds remove them. That variant still proves behavior
// and every fixture's explicit presence/absence contract; identical private placement adds no proof.
for (const f of fixtures) {
  const per = rows.filter((r) => r.fixture === f.id);
  for (const m of [...new Set(per.flatMap((r) => r.loaded.optimised))].toSorted()) {
    // Rspack inlines default-call entry wrappers into consumer code without attributing index bytes.
    // Compare feature owners; explicit absence contracts still judge every module, including index.
    if (m === "index") continue;
    const has = per.filter((r) => r.loaded.optimised.includes(m)).map((r) => r.bundler);
    const lacks = per.filter((r) => !r.loaded.optimised.includes(m)).map((r) => r.bundler);
    if (lacks.length > 0)
      fail(
        `${f.id} (optimised): bundlers disagree on ${m}: loaded at startup by ${has.join(", ")}; not by ${lacks.join(", ")}`,
      );
  }
}

mark("judged");
// Modules kept only because the field is gone: name the top-level code that keeps each one.
const survivors = new Map<string, Set<string>>(); // module → bundlers
for (const r of rows)
  for (const m of r.shipped["no-field"])
    if (!r.shipped.optimised.includes(m))
      survivors.set(m, (survivors.get(m) ?? new Set()).add(r.bundler));
const retained: { module: string; bundlers: string[]; esbuild: string; rolldown: string }[] =
  await Promise.all(
    [...survivors]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(async ([m, by]) => {
        const file = path.join(noFieldConsumer.installed, "dist", `${m}.js`);
        const scratch = path.join(packed.work, "retained", m);
        const [esbuildKept, rolldownKept] = await Promise.all([
          retainedTopLevel("esbuild", file, path.join(scratch, "esbuild")),
          retainedTopLevel("rolldown", file, path.join(scratch, "rolldown")),
        ]);
        return {
          module: m,
          bundlers: [...by].toSorted(),
          esbuild: esbuildKept,
          rolldown: rolldownKept,
        };
      }),
  );

// Size baseline.
const baselinePath = option("--baseline") ?? path.join(ROOT, "bench", "size-baseline.json");
type Baseline = { tarball: number; rows: Record<string, { initial: Sizes; total: Sizes }> };
const current: Baseline = {
  tarball: packed.tarballBytes,
  rows: Object.fromEntries(
    rows.map((r) => [`${r.fixture} × ${r.bundler}`, { initial: r.initial, total: r.total }]),
  ),
};
if (flag("--write-baseline") && failures.length > 0) {
  fail("Refusing to write a size baseline for a candidate with graph or behavior failures.");
} else if (flag("--write-baseline")) {
  const tools = Object.fromEntries(BUNDLERS.map((b) => [b.name, b.version]));
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ tools, compression: { gzip: GZIP_LEVEL, brotli: BROTLI_QUALITY, zstd: ZSTD_LEVEL }, ...current }, null, 2)}\n`,
  );
} else {
  let base: Baseline | undefined;
  try {
    base = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  } catch {
    fail(
      `no size baseline at ${baselinePath}; run with --write-baseline in a commit that states why`,
    );
  }
  if (base !== undefined) {
    if (current.tarball > base.tarball * (1 + REGRESSION))
      fail(`tarball ${base.tarball} → ${current.tarball} bytes (> ${REGRESSION * 100}%)`);
    for (const [key, now] of Object.entries(current.rows)) {
      const was = base.rows[key];
      if (was === undefined) {
        fail(`${key}: no baseline row`);
        continue;
      }
      for (const scope of ["initial", "total"] as const)
        for (const metric of ["raw", "gzip", "brotli", "zstd"] as const)
          if (now[scope][metric] > was[scope][metric] * (1 + REGRESSION))
            fail(
              `${key}: ${scope} ${metric} ${was[scope][metric]} → ${now[scope][metric]} (> ${REGRESSION * 100}%)`,
            );
    }
    // A row that stopped being measured would otherwise vanish from the judgement unseen.
    const selectedKeys = new Set(
      fixtures.flatMap((f) => bundlers.map((b) => `${f.id} × ${b.name}`)),
    );
    for (const key of Object.keys(base.rows))
      if ((!partial || selectedKeys.has(key)) && current.rows[key] === undefined)
        fail(
          `${key}: baseline row no longer measured; rewrite the baseline in a commit that says why`,
        );
  }
}

mark("checked");
// Report.
const wall = performance.now() - started;
const pad = (s: string | number, n: number): string => String(s).padEnd(n);
console.log(
  `scope: ${partial ? "filtered probe, not release verification" : "complete matrix"}; fixtures: ${fixtures.map((f) => f.id).join(", ")}; bundlers: ${bundlers.map((b) => b.name).join(", ")}`,
);
console.log(
  `tarball ${path.basename(packed.tarballPath)}: ${packed.tarballBytes} bytes (tar+gzip as npm ships it)`,
);
console.log(
  `tools: ${bundlers.map((b) => `${b.name} ${b.version}`).join(", ")}; compression gzip-${GZIP_LEVEL} brotli-${BROTLI_QUALITY} zstd-${ZSTD_LEVEL}`,
);
console.log(
  `${pad("fixture", 26)}${pad("bundler", 10)}${pad("chunks", 7)}${pad("initial raw/gz/br/zst", 28)}${pad("total raw/gz/br/zst", 28)}${pad("no-field raw", 13)}behaviour opt/nofield/cons`,
);
for (const r of rows)
  console.log(
    `${pad(r.fixture, 26)}${pad(r.bundler, 10)}${pad(r.chunks.length, 7)}${pad(show(r.initial), 28)}${pad(show(r.total), 28)}${pad(r.noFieldTotal.raw, 13)}${VARIANTS.map((v) => r.behaviour[v]).join("/")}${r.assets.length > 0 ? `  assets: ${r.assets.join(" ")}` : ""}`,
  );
console.log("\nexplained no-field startup residue (not judged):");
for (const [bundler, { modules, why }] of Object.entries(NO_FIELD_EXPLAINED))
  console.log(`  ${pad(bundler, 10)}${modules.join(", ")}: ${why}`);
console.log("\nshipped package modules (optimised):");
for (const r of rows)
  console.log(
    `  ${pad(r.fixture, 26)}${pad(r.bundler, 10)}${r.shipped.optimised.join(" ") || "(none)"}`,
  );
/** The first lines of retained code; the full text is in the --json report. */
const clip = (code: string, lines = 6): string => {
  // Empty: the module does no top-level work of its own; it ships because a kept module imports it.
  if (code.trim() === "") return "(nothing of its own: kept as a dependency)";
  const all = code.split("\n");
  const more = all.length > lines ? `\n              … ${all.length - lines} more line(s)` : "";
  return all.slice(0, lines).join("\n              ") + more;
};
if (retained.length > 0) {
  console.log(
    "\nmodules that ship only WITHOUT the sideEffects field, and the top-level code each bundler keeps:",
  );
  for (const r of retained)
    console.log(
      `  ${r.module} [kept by ${r.bundlers.join(", ")}]\n    esbuild : ${clip(r.esbuild)}\n    rolldown: ${clip(r.rolldown)}`,
    );
}
const jsonOut = option("--json");
if (jsonOut !== undefined)
  writeFileSync(
    jsonOut,
    `${JSON.stringify({ scope: partial ? "filtered" : "complete", tarball: packed.tarballBytes, rows, retained, failures }, null, 2)}\n`,
  );
console.log(
  `\nbuilds ${((buildEnd - started) / 1000).toFixed(1)} s, wall ${(wall / 1000).toFixed(1)} s; package ${PKG}`,
);
console.log(`phases at s: ${marks.join("; ")}`);
if (flag("--keep")) {
  console.log(`kept ${packed.work}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exitCode = 1;
}
