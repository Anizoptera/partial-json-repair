// SPDX-License-Identifier: Apache-2.0

/**
 * The whole prior-art measurement: capability, coverage, speed and memory, over every live
 * alternative, in one pass. Emits the markdown tables that `docs/PRIOR-ART.md` is built from.
 *
 *     bun bench/prior-art/compare.ts       # this runtime
 *     node bench/prior-art/compare.ts      # the other column
 *
 * ONE script, not four, because the four axes share their expensive parts — loading every rival and
 * reading the input corpora — and because a table transcribed by hand from four outputs is a table
 * that drifts from the run that produced it.
 *
 * **The rivals are pinned and live OUTSIDE the package's own lockfile** (`bench/prior-art/`), so
 * measuring them costs a contributor nothing and no third-party parser can reach the published
 * artefact. `bun install` in this directory is what sets it up.
 *
 * **Each library is driven through its OWN best entry point**, not through a lowest common
 * denominator: `jsonrepair` repairs text, so it is measured as repair-then-`JSON.parse`;
 * `partial-json` takes an allow mask, so it gets the most permissive one; `best-effort-json-parser`
 * logs to the console on every recovery, so logging is disabled first — measuring it with that on
 * would price its error reporting and call it parse cost.
 *
 * Never gates. It informs a document and is then evidence for it.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

import simdjson from "simdjson";

import { MEMORY_CALLS, MEMORY_SAMPLE_INTERVAL } from "./memory-method.ts";
import { ABSENT, differences, firstDifference, sameValue } from "./same-value.ts";
// Extension required: node's type stripping does not resolve extensionless TS specifiers, which is
// why every local import across `bench/` carries one.
import { attempt, CASES, DOCS, ours0, records, speed } from "./speed-docs.ts";
import { type Lib, PORTABLE_LIBS } from "./libs.ts";
import { classify, type Pair } from "../../test/rival-differences.ts";

const here = import.meta.dirname;
const root = join(here, "..", "..");

const version = (pkg: string): string =>
  (
    JSON.parse(readFileSync(join(here, "node_modules", pkg, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;

/*
 * Bun ships parsers for two dialects this package also reads. They exist on that runtime only, so
 * these rows are absent from the `node` column — a runtime capability difference, not a library that
 * failed. Nothing equivalent is built into Node, which is why `json5` and `jsonc-parser` are here
 * too: they give the same dialects a row on both runtimes.
 */
type BunNatives = {
  version: string;
  JSONL: { parse: (text: string) => unknown[] };
  JSON5: { parse: (text: string) => unknown };
};
const bunGlobal = (globalThis as { Bun?: BunNatives }).Bun;

const bunNativeLibs: VersionedLib[] = bunGlobal
  ? [
      {
        name: "Bun.JSON5",
        version: `bun ${bunGlobal.version}`,
        parse: (t) => bunGlobal.JSON5.parse(t),
      },
      {
        name: "Bun.JSONL",
        version: `bun ${bunGlobal.version}`,
        // One line is one value, so a single-value document round-trips through the same call.
        parse: (t) => bunGlobal.JSONL.parse(t)[0],
        many: (t) => bunGlobal.JSONL.parse(t),
      },
    ]
  : [];

/** Each library's installed version, for the tables' headers. */
const versionOf = (name: string): string =>
  name === "partial-json-repair"
    ? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version
    : name === "JSON.parse"
      ? "native"
      : version(name);

type VersionedLib = Lib & { readonly version: string };

/*
 * The portable libraries, plus the two this host alone can run: `simdjson`, a native addon, placed
 * among the canonical parsers where the tables have always listed it, and Bun's built-ins.
 */
const portable: VersionedLib[] = PORTABLE_LIBS.map((lib) =>
  Object.assign({}, lib, {
    version: versionOf(lib.name),
  }),
);
const LIBS: VersionedLib[] = [
  ...portable.slice(
    0,
    portable.findIndex((lib) => lib.name === "json5"),
  ),
  { name: "simdjson", version: version("simdjson"), parse: (t) => simdjson.parse(t) },
  ...portable.slice(portable.findIndex((lib) => lib.name === "json5")),
  ...bunNativeLibs,
];

/**
 * Strict structural equality. Never a serialiser: `JSON.stringify` prints `NaN` as `null` and drops
 * `undefined`, so a library answering `{a: NaN}` for `{a: null}` would score as correct.
 */
const same = sameValue;

// ─────────────────────────────────────────────────────────────────────────────
// ① Capability. Each probe states the value a correct answer produces, so a cell is decided by
//    comparison rather than by reading a README's claim.
// ─────────────────────────────────────────────────────────────────────────────

const PROBES: {
  feature: string;
  text: string;
  want: unknown;
  check?: (v: unknown) => boolean;
  /** Which configuration to score this row under. Permissive unless the row is ABOUT the default. */
  use?: "default" | "permissive";
}[] = [
  { feature: "truncated object", text: '{"a":1,"b":', want: { a: 1 } },
  { feature: "truncated string", text: '{"a":"hel', want: { a: "hel" } },
  { feature: "truncated array", text: "[1,2", want: [1, 2] },
  { feature: "trailing comma", text: '{"a":1,}', want: { a: 1 } },
  { feature: "single quotes", text: "{'a':1}", want: { a: 1 } },
  { feature: "unquoted keys", text: "{a:1}", want: { a: 1 } },
  { feature: "comments", text: '{"a":1 /* x */}', want: { a: 1 } },
  // `NaN`, never `null`: a library that reads the literal returns the number, and `null` would be a
  // different value that only a serialiser confuses with it.
  { feature: "JS literals", text: '{"a":NaN}', want: { a: Number.NaN } },
  { feature: "JSON in prose", text: 'here: {"a":1} thanks', want: { a: 1 } },
  { feature: "fenced block", text: '```json\n{"a":1}\n```', want: { a: 1 } },
  { feature: "prose is not JSON", text: "see [1] for the citation", want: undefined },
  {
    feature: "`__proto__` survives as data",
    text: '{"__proto__":{"x":1},"a":2}',
    want: undefined,
    // The DEFAULT configuration, not the permissive one: `LLM_FULL` sets `onDangerousKey: "drop"`,
    // so scoring this row at maximum permissiveness would measure a policy choice rather than what
    // the library does with the key when nobody has told it anything.
    use: "default",
    /**
     * Measured across every library here: NONE of them pollutes a prototype, so "is it safe" does
     * not discriminate and is not the row. What differs is whether the key SURVIVES — `partial-json`
     * silently drops it, and a consumer cannot tell that from a model that never sent it.
     *
     * The check cannot use a serialiser: `JSON.stringify` omits `__proto__` whether it was defined
     * as an own property, dropped, or written through the prototype setter — three outcomes, one
     * rendering, and the dangerous one invisible. Writing `{ __proto__: {x:1} }` as the EXPECTED
     * value fails from the other side, since an object literal sets the prototype instead of adding
     * the key.
     */
    check: (v) =>
      typeof v === "object" &&
      v !== null &&
      Object.hasOwn(v, "__proto__") &&
      Object.getPrototypeOf(v) === Object.prototype &&
      ({} as { x?: unknown }).x === undefined,
  },
];

const capability = (): string[] => {
  const rows = PROBES.map((p) => {
    const cells = LIBS.map((lib) => {
      const run = p.use === "default" ? lib.parse : (lib.permissive ?? lib.parse);
      const got = attempt(() => run(p.text));
      if (p.check) return got.ok && p.check(got.value) ? "✓" : "✗";
      // "Must NOT produce a value" is a capability too — a parser that manufactures an array out of
      // a citation is worse at this row, not better, so the cell is scored against `want`.
      if (p.want === undefined) return got.ok ? "✗" : "✓";
      return got.ok && same(got.value, p.want) ? "✓" : "✗";
    });
    return `| ${p.feature} | ${cells.join(" | ")} |`;
  });
  return [
    `| Capability | ${LIBS.map((l) => l.name).join(" | ")} |`,
    `| --- | ${LIBS.map(() => "---").join(" | ")} |`,
    ...rows,
  ];
};

// ─────────────────────────────────────────────────────────────────────────────
// ② Coverage. The corpus is fixed before this runs and was recorded from the implementation this
//    package replaces — it is not a set of inputs chosen to flatter anything here.
// ─────────────────────────────────────────────────────────────────────────────

/** Every corpus input as whole text, with its record id so a disagreement can be traced back. */
const corpusRecords = (): { id: string; text: string }[] => {
  const out: { id: string; text: string }[] = [];
  for (const line of readFileSync(join(root, "corpus", "corpus.jsonl"), "utf8").split("\n")) {
    if (line === "") continue;
    const rec = JSON.parse(line) as { id: string; text?: string; chunks?: string[] };
    if (typeof rec.text === "string") out.push({ id: rec.id, text: rec.text });
    else if (rec.chunks) out.push({ id: rec.id, text: rec.chunks.join("") });
  }
  return out;
};
const corpusInputs = (): string[] => corpusRecords().map((r) => r.text);

const coverage = (inputs: string[]): string[] => {
  // The reference is OUR answer, and the table says so rather than calling it correctness: this
  // measures agreement and disagreement, and a "differs" cell is a case for a human, not a defect.
  // Computed ONCE for the whole table — recomputing it per library would be six extra passes over
  // the corpus to re-derive the same column.
  const mine = inputs.map((text) => attempt(() => ours0(text)));
  const rows = LIBS.map((lib) => {
    let parsed = 0;
    let differs = 0;
    let failed = 0;
    inputs.forEach((text, i) => {
      const got = attempt(() => lib.parse(text));
      if (got.ok) {
        const ref = mine[i];
        if (ref?.ok && same(got.value, ref.value)) parsed++;
        else differs++;
      } else {
        failed++;
      }
    });
    return `| ${lib.name} | ${parsed} | ${differs} | ${failed} |`;
  });
  return [`| Library | agrees with us | differs | throws |`, `| --- | --- | --- | --- |`, ...rows];
};

// ─────────────────────────────────────────────────────────────────────────────
// ③ JSONTestSuite (nst, MIT). `y_` must be accepted, `n_` must be rejected, `i_` is
//    implementation-defined and only counted, never scored.
// ─────────────────────────────────────────────────────────────────────────────

const suite = (): string[] => {
  const dir = join(here, ".jsontestsuite");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return ["_JSONTestSuite not fetched — run `bun bench/prior-art/fetch-suite.ts`._"];
  }
  const cases = files.map((f) => ({
    name: f,
    // Latin-1 rather than UTF-8: several cases are deliberately invalid UTF-8, and decoding them as
    // UTF-8 would silently replace the bytes under test with U+FFFD, turning a case about encoding
    // into a case about nothing.
    text: readFileSync(join(dir, f), "latin1"),
    expect: f[0] as "y" | "n" | "i",
  }));
  const rows = LIBS.filter((l) => l.strict).map((lib) => {
    const run = lib.strict as (t: string) => unknown;
    let accepted = 0;
    let rejected = 0;
    let wrong = 0;
    for (const c of cases) {
      const got = attempt(() => run(c.text));
      if (c.expect === "y") {
        if (got.ok) accepted++;
        else wrong++;
      } else if (c.expect === "n") {
        if (got.ok) wrong++;
        else rejected++;
      }
    }
    const y = cases.filter((c) => c.expect === "y").length;
    const n = cases.filter((c) => c.expect === "n").length;
    return `| ${lib.name} | ${accepted}/${y} | ${rejected}/${n} | ${wrong} |`;
  });
  return [
    `| Library (strict mode) | accepts valid | rejects invalid | wrong |`,
    `| --- | --- | --- | --- |`,
    ...rows,
  ];
};

// ─────────────────────────────────────────────────────────────────────────────
// ④ Speed and memory, on the same three inputs for every library.
// ─────────────────────────────────────────────────────────────────────────────

/*
 * There is deliberately no speed TABLE here, only the machine-readable emission below.
 *
 * A rate measured in one process carries no error bar — batches inside a process share a JIT
 * profile and a heap, so their agreement says nothing about whether a re-run reproduces. Printing
 * such a rate to four significant figures publishes a precision nothing behind it earned, and a
 * reader anchors on the digits rather than the magnitude. `baseline.ts` forks this script several
 * times, divides by each fork's own `JSON.parse`, and rounds to the spread ACROSS processes; that is
 * the only artefact in this repository allowed to state a speed.
 */

/**
 * Peak resident memory while one library repeatedly parses the clean document, each measured in a
 * DEDICATED process — the script re-invokes itself with `ONLY` naming one library and prints the
 * peak resident set that child sampled.
 *
 * A separate process per library is the whole design, not caution. A peak is a high-water mark for
 * the process, so measuring libraries in sequence makes every reading after the first report the
 * largest peak so far, which is monotonic garbage.
 *
 * Sampling `heapUsed` in one process was tried first and CANNOT answer this question: with a
 * collection at both ends every library reads 0.0 (none of them leak), and with a collected
 * baseline only, Bun reports negative megabytes while Node reports the same 14.7 MB for
 * `JSON.parse` as for this package — a value that obviously is not a library difference. The
 * allocator dominated the signal. Resident set size comes from the OS and is the same number a
 * person watching `top` would see, which is also the number a deployment is actually bounded by;
 * the child below says why it samples `rss` rather than reading `maxRSS`. Every child loads the same
 * comparison adapters and corpus; this is not a standalone consumer's footprint.
 *
 * Coarse and honest about it: it includes the runtime and shared harness, so the interesting quantity
 * is each row's distance from the `JSON.parse` row on the same runtime, never the absolute value.
 */
const memory = (): string[] => {
  const rows = LIBS.map((lib) => {
    const child = spawnSync(process.execPath, [import.meta.filename], {
      env: { ...process.env, ONLY: lib.name },
      encoding: "utf8",
    });
    const output = child.stdout.trim();
    // Number("") is zero, so require a completed measurement before interpreting its payload.
    if (child.status !== 0 || output.length === 0)
      throw new Error(
        `${lib.name}: memory child exited ${String(child.status)} with ${output.length === 0 ? "no result" : "a result"}: ${child.stderr.trim()}`,
        { cause: child.error },
      );
    const mb = Number(output);
    if (output !== "NaN" && (!Number.isFinite(mb) || mb <= 0))
      throw new Error(`${lib.name}: memory child returned invalid RSS: ${output}`);
    // A single-process sample earns no decimal precision. Publish fresh-process ranges with the
    // median; rounding this row alone cannot establish repeatability.
    return `| ${lib.name} | ${Number.isFinite(mb) ? Math.round(mb) : "—"} |`;
  });
  return [`| Library | sampled peak RSS parsing ${MEMORY_CALLS}x, MiB |`, `| --- | --- |`, ...rows];
};

/**
 * Each child exercises one adapter but loads the shared comparison harness and corpus too.
 * Its sampled RSS includes that common working set, not just the selected package.
 */
const only = process.env["ONLY"];
if (only !== undefined && only !== "") {
  const lib = LIBS.find((l) => l.name === only);
  if (lib !== undefined && attempt(() => lib.parse(records)).ok) {
    // Sampled rather than taken from `getrusage`'s `maxRSS`, which carries NO unit of its own —
    // Node normalises it to kilobytes, Bun on macOS returns bytes, and no threshold or same-process
    // invariant separated the two reliably (both a gigabyte table and a 0.1 MB one were published
    // trying). `memoryUsage().rss` is documented in bytes on both, so tracking the maximum here is
    // the same high-water mark with the ambiguity removed. The shared sampling interval keeps its
    // cost far below the parse it is measuring.
    let peak = 0;
    for (let i = 0; i < MEMORY_CALLS - 1; i++) {
      lib.parse(records);
      if (i % MEMORY_SAMPLE_INTERVAL === 0) peak = Math.max(peak, process.memoryUsage().rss);
    }
    const value = lib.parse(records);
    peak = Math.max(peak, process.memoryUsage().rss);
    // Validate after sampling: the oracle traversal must not warm or inflate the measured process.
    if (!same(value, DOCS.clean.want))
      throw new Error(
        `${lib.name}: memory workload returned the wrong value; fix its clean adapter`,
      );
    console.log((peak / 1024 / 1024).toFixed(1));
  } else {
    console.log("NaN");
  }
  process.exit(0);
}

const denoRuntime = (globalThis as { Deno?: { version: { deno: string } } }).Deno;
const bunRuntime = (globalThis as { Bun?: { version: string } }).Bun;
const runtime = denoRuntime
  ? `deno ${denoRuntime.version.deno}`
  : bunRuntime
    ? `bun ${bunRuntime.version}`
    : `node ${process.versions.node}`;

/*
 * Machine-readable half, for `baseline.ts`. Only the speed axis, because that is the one that drifts
 * silently and the one a release has to be checked against; capability and coverage change loudly,
 * in a diff someone is already reading.
 */
if (process.env["EMIT"] === "json") {
  console.log(JSON.stringify({ runtime, rates: Object.fromEntries(speed(LIBS)) }));
  process.exit(0);
}

/*
 * The case documents, for a runner that is not JavaScript.
 *
 * The Rust subjects are measured on the SAME bytes rather than on a generator of their own: a second
 * generator would compare generators as much as parsers, and the difference would be invisible
 * because both would emit plausible JSON. This file already owns the documents, so handing them out
 * is the whole of what is needed to keep one owner.
 */
if (process.env["EMIT"] === "cases") {
  console.log(JSON.stringify(Object.fromEntries(CASES.map((c) => [c, DOCS[c].text]))));
  process.exit(0);
}

/*
 * The expected value of each case, for a runner in another language that has no oracle of its own
 * for the damaged case. Sent as JSON, which is lossless only for plain JSON data — so each value is
 * proved to survive the trip before it is sent, rather than trusting a serialiser that drops
 * `undefined` and prints `NaN` as `null`.
 */
if (process.env["EMIT"] === "wants") {
  const wants = Object.fromEntries(CASES.map((c) => [c, DOCS[c].want]));
  for (const [c, want] of Object.entries(wants))
    if (!sameValue(JSON.parse(JSON.stringify(want)) as unknown, want))
      throw new Error(`${c}: expected value does not survive JSON`);
  console.log(JSON.stringify(wants));
  process.exit(0);
}

/*
 * Every corpus input on which some library's verdict departs from ours, or ours declines: one JSONL
 * record each, for the per-case review the coverage counts cannot give. Values are rendered by
 * `inspect`, never a serialiser, so `NaN`, `undefined` and `-0` stay visible.
 */
const show = (r: { ok: true; value: unknown } | { ok: false }): string =>
  r.ok ? inspect(r.value, { depth: null, breakLength: Infinity }) : "throws";
if (process.env["EMIT"] === "disagreements") {
  for (const { id, text } of corpusRecords()) {
    const mine = attempt(() => ours0(text));
    const rivals: Record<string, unknown> = {};
    for (const lib of LIBS.slice(1)) {
      const got = attempt(() => lib.parse(text));
      // A throw is recorded even when ours declines too, so these records count exactly what the
      // coverage table counts.
      if (!got.ok || !mine.ok) {
        rivals[lib.name] = show(got);
        continue;
      }
      const d = firstDifference(mine.value, got.value);
      if (d === undefined) continue;
      // Where the two first diverge, so the review groups departures by cause, not by shape.
      const leaf = (v: unknown): string =>
        v === ABSENT ? "<absent>" : show({ ok: true, value: v });
      rivals[lib.name] = { got: show(got), at: d.path, ours: leaf(d.a), rival: leaf(d.b) };
    }
    if (!mine.ok || Object.keys(rivals).length > 0)
      console.log(JSON.stringify({ id, text, ours: show(mine), rivals }));
  }
  process.exit(0);
}

/*
 * Every live disagreement, owned by a cause in `test/rival-differences.ts` and compared with the
 * accepted assignment in `differences.json`. A pair no cluster explains is a new cause to judge; a
 * pair that appeared, vanished or changed cluster is a behaviour change on either side to review.
 * Either stops the run. `ACCEPT=1` records the current assignment after that review.
 */
if (process.env["EMIT"] === "differences") {
  const accepted = join(here, "differences.json");
  const live: Record<string, string[]> = {};
  const unmatched: string[] = [];
  for (const { id, text } of corpusRecords()) {
    const mine = attempt(() => ours0(text));
    for (const lib of LIBS.slice(1)) {
      const got = attempt(() => lib.parse(text));
      // Keyed by path too: one input can differ from one rival in several places for unrelated
      // causes, and each needs its own verdict.
      const pairs: [key: string, pair: Pair][] = [];
      if (!got.ok) {
        if (!mine.ok) continue;
        pairs.push([`${id} ${lib.name}`, { lib: lib.name, text, kind: "rival-throws" }]);
      } else if (mine.ok) {
        const leaf = (v: unknown): string =>
          v === ABSENT ? "<absent>" : show({ ok: true, value: v });
        for (const d of differences(mine.value, got.value))
          pairs.push([
            `${id} ${lib.name} ${JSON.stringify(d.path)}`,
            {
              lib: lib.name,
              text,
              kind: "differs",
              at: d.path,
              ours: leaf(d.a),
              rival: leaf(d.b),
              whole: show(mine),
              got: show(got),
            },
          ]);
      } else {
        pairs.push([`${id} ${lib.name}`, { lib: lib.name, text, kind: "ours-declines" }]);
      }
      for (const [key, pair] of pairs) {
        const cluster = classify(pair);
        if (cluster) (live[cluster.id] ??= []).push(key);
        else unmatched.push(`${key}: ${JSON.stringify(pair)}`);
      }
    }
  }
  for (const ids of Object.values(live)) ids.sort();
  if (process.env["ACCEPT"] === "1" && unmatched.length === 0) {
    writeFileSync(accepted, `${JSON.stringify(live, null, 2)}\n`);
    console.log(`accepted ${Object.keys(live).length} clusters into ${accepted}`);
    process.exit(0);
  }
  const before = JSON.parse(readFileSync(accepted, "utf8")) as Record<string, string[]>;
  const owner = (map: Record<string, string[]>): Map<string, string> =>
    new Map(
      Object.entries(map).flatMap(([cluster, ids]) => ids.map((key) => [key, cluster] as const)),
    );
  const was = owner(before);
  const now = owner(live);
  const changes = [
    ...[...now]
      .filter(([key, c]) => was.get(key) !== c)
      .map(([key, c]) => `${key}: ${was.get(key) ?? "new"} -> ${c}`),
    ...[...was].filter(([key]) => !now.has(key)).map(([key, c]) => `${key}: ${c} -> gone`),
  ];
  for (const line of unmatched) console.log(`UNMATCHED ${line}`);
  for (const line of changes) console.log(`CHANGED ${line}`);
  console.log(
    `${now.size} pairs in ${Object.keys(live).length} clusters; ${unmatched.length} unmatched, ${changes.length} changed`,
  );
  if (unmatched.length > 0)
    console.log(
      "Judge each unmatched pair: add or widen a cluster in test/rival-differences.ts with a pinned case, then rerun.",
    );
  if (changes.length > 0)
    console.log(
      "Review each changed pair against its cluster's reason, then rerun with ACCEPT=1 to record it.",
    );
  process.exit(unmatched.length + changes.length === 0 ? 0 : 1);
}

const inputs = corpusInputs();

console.log(`\n## ${runtime}\n`);
console.log(LIBS.map((l) => `${l.name}@${l.version}`).join(" · "));
console.log(`\n### Capability\n\n${capability().join("\n")}`);
console.log(`\n### Coverage over ${inputs.length} corpus inputs\n\n${coverage(inputs).join("\n")}`);
console.log(`\n### JSONTestSuite\n\n${suite().join("\n")}`);
console.log(`\n### Memory\n\n${memory().join("\n")}`);
console.log(
  `\n_Speed: \`bun run bench:baseline\`, which forks this script and can state an error bar._`,
);
