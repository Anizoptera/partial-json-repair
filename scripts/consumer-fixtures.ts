// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer fixtures for `size-check.ts` and `platform-check.ts`, as data rows.
 *
 * Each row is the source of one consumer module that imports the PACKED package by its public name and
 * exports `run()`. A new feature needs a row edit, never harness code. Every row runs: a row naming an
 * export the package lacks fails its build, because a skipped row would read as a pass.
 *
 */
import { FEATURE_MARKERS } from "./consumer-markers";

/** A dist module, named by its basename without `.js` (e.g. `report` for `dist/report.js`). */
export type DistModule = string;

export type Fixture = {
  readonly id: string;
  /** What the row proves, one line, for the report. */
  readonly job: string;
  /** Module text. Must `export async function run()` unless `empty` is set. */
  readonly source: string;
  /** Dist modules that must contribute zero bytes anywhere, including unused lazy chunks. */
  readonly absent: readonly DistModule[];
  /** Controlled literals distinguish optional code from shared helpers attributed to one module. */
  readonly markers?: Readonly<Record<string, "present" | "absent">>;
  /** Execution machinery may remain reachable, but must contribute zero bytes to startup. */
  readonly notAtStartup?: readonly DistModule[];
  /** Dist modules that must contribute bytes somewhere in the output (survival of required code). */
  readonly present?: readonly DistModule[];
  /** Dist modules that must stay out of the initial (statically loaded) chunks yet be emitted. */
  readonly lazy?: readonly DistModule[];
  /** No package module may contribute bytes at all: the `sideEffects: false` and unused-import proof. */
  readonly empty?: true;
  /**
   * The row runs the async worker, which changes two things:
   * - A bundler that does not emit `new Worker(new URL(...))` builds it with the README recipe (the
   *   worker and receiver as named extra entries), because that is what such an app ships.
   * - Behaviour is judged in browsers only (`platform-check.ts`). The size check runs bundles in
   *   Bun, where `process` sends the package down its Node branch, so the worker result there
   *   measures the host, not the bundle: Vite stubs `node:worker_threads`, and webpack inlines the
   *   source file's `import.meta.url`, which happens to work.
   */
  readonly worker?: true;
};

const PKG = "partial-json-repair";

// Each async strategy is its own import cost (HLD D5): a consumer that never runs a worker ships no
// worker code, one that forces the worker ships no cooperative executor, and a synchronous consumer
// ships neither. Listing every module of a strategy, not a sample, is what makes retention of any
// one of them fail.
const WORKER_MODULES: readonly DistModule[] = [
  "async-worker",
  "worker-executor",
  "worker-host",
  "worker-message",
  "worker-output",
  "worker-receive",
  "worker-unavailable",
];
const COOPERATIVE_MODULES: readonly DistModule[] = ["cooperative-executor", "same-thread-strategy"];
const ASYNC_MODULES: readonly DistModule[] = [
  ...WORKER_MODULES,
  ...COOPERATIVE_MODULES,
  "async",
  "async-configuration",
  "async-operation",
  "async-parser",
  "joined-stop-signal",
  "repair-async",
  // Not `repair-operation`: synchronous `repair` drains the same resumable projection.
  "span-async",
  "span-operation",
  "whole-operation",
];

/**
 * Shared inputs. Damaged on purpose: a truncation, a trailing comma, a single-quoted key, a comment, a
 * non-finite number and a lone surrogate exercise recovery paths whose values `JSON.stringify` would hide.
 */
export const INPUTS: readonly string[] = [
  '{"a":[1,2,',
  "{'k': 'v', n: NaN, i: -Infinity, z: -0,}",
  '// lead\n{"x": "\\ud800", "y": [true, null, undefined]}',
  'reply: ```json\n{"tool":"run","args":{"id":7}}\n``` done',
  "[1e400, 9007199254740993, 0x1F]",
  "",
];

const inputs = `const INPUTS = ${JSON.stringify(INPUTS)};`;

// Platform case names map to these same packed-consumer rows; missing rows fail at lookup.
export const PLATFORM_PARTS = {
  parse: "parse",
  stream: "stream-view",
  cooperative: "async-cooperative-abort",
  worker: "forced-worker",
  decodedFragments: "decoded-fragments",
  sourceFragments: "source-fragments",
} as const;

const ROWS: readonly Fixture[] = [
  {
    id: "configured-parse",
    job: "a reusable parser used only for parsing must not retain other operations",
    source: `import { initParser, parse } from "${PKG}";
${inputs}
export async function run() {
  const parser = initParser();
  try { return INPUTS.map((text) => parse(text, parser)); }
  finally { parser.close(); }
}
`,
    absent: [
      "edit-log",
      "whole-iteration",
      "repair-splice",
      "stream",
      "stream-scalars",
      "snapshot",
    ],
    markers: { [FEATURE_MARKERS.transport]: "absent" },
  },
  {
    id: "parse",
    job: "one root export: parse only",
    source: `import { parse } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => parse(t)); }\n`,
    // `positions` and `scan-diagnostics` are core: a default refusal still reports its verdict,
    // line and column (src/AGENTS.md). `report` and `picks` hold only what a report or a selection adds.
    absent: [
      "edit-log",
      "whole-iteration",
      "stream-scalars",
      "parser-stream",
      "report",
      "selector",
      "picks",
      "stringify",
      "metrics",
      "try-parsers",
      "snapshot",
    ],
  },
  {
    id: "parse-many",
    job: "one root export: synchronous iteration without stream or async machinery",
    source: `import { parseMany } from "${PKG}";
${inputs}
export async function run() {
  return [...INPUTS, '{"a":1} {"b":2}'].map((text) => [...parseMany(text)]);
}
`,
    absent: [
      "edit-log",
      "stream-scalars",
      "report",
      "selector",
      "picks",
      "stringify",
      "metrics",
      "try-parsers",
      "snapshot",
      "async",
      "async-worker",
      "worker-executor",
      "cooperative-executor",
    ],
  },
  {
    id: "repair",
    job: "one root export: repair text without iteration, stream, report or async machinery",
    source: `import { repair } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => repair(t)); }\n`,
    absent: [
      "whole-iteration",
      "stream-scalars",
      "report",
      "selector",
      "picks",
      "stringify",
      "metrics",
      "try-parsers",
      "snapshot",
      "async",
      "async-worker",
      "worker-executor",
      "cooperative-executor",
    ],
  },
  {
    id: "find-json-span",
    // Span finding builds no output text, so the repair edit machinery must not ride along.
    job: "one root export: locate JSON without repair, iteration, stream, report or async machinery",
    source: `import { findJsonSpan } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => findJsonSpan(t)); }\n`,
    absent: [
      "edit-log",
      "repair-splice",
      "repair-operation",
      "whole-iteration",
      "stream-scalars",
      "report",
      "selector",
      "picks",
      "stringify",
      "metrics",
      "try-parsers",
      "snapshot",
      "async",
      "async-worker",
      "worker-executor",
      "cooperative-executor",
    ],
  },
  {
    id: "stream",
    job: "stream values without snapshots or scalar fragments",
    source: `import { parseStream } from "${PKG}";
export async function run() {
  const out = [];
  for await (const value of parseStream(['{"a":[1,', '2]}'])) out.push(value);
  return out;
}
`,
    // A stream never reads input whole: the whole-input route (pre-scan, built-in parser) is parse's.
    absent: [
      "snapshot",
      "snapshot-owned",
      "snapshot-shared",
      "source-fragments",
      "source-picks",
      "picks",
      "report",
      "metrics",
      "whole-reader",
      "whole-source",
      "whole-input",
      "pre-scan",
      "builtin-route",
    ],
  },
  {
    id: "stream-view",
    job: "parseStream with independent owned snapshots between chunks",
    source: `import { ownedView, parseStream } from "${PKG}";
const CHUNKS = ['{"a":[1,', '2],"b":"x', 'y"} [3', ',4]', ' {"c":tr'];
export async function run() {
  const out = [];
  let stream;
  async function* source() {
    for (const chunk of CHUNKS) { yield chunk; out.push({ snapshot: stream.snapshot() }); }
  }
  stream = parseStream(source(), { view: ownedView, summary: true });
  for await (const item of stream) out.push({ item });
  return out;
}
`,
    absent: [
      "snapshot-shared",
      "edit-log",
      "report",
      "selector",
      "picks",
      "stringify",
      "metrics",
      "try-parsers",
      "async-worker",
      "worker-executor",
    ],
    present: ["snapshot", "snapshot-owned"],
    markers: { [FEATURE_MARKERS.transport]: "present" },
  },
  {
    id: "stream-shared-view",
    job: "shared snapshots preserve identity without importing full-tree snapshot copying",
    source: `import { createStreamParser, sharedView } from "${PKG}";
export async function run() {
  const parser = createStreamParser({ view: sharedView });
  // for-of, not a discarded [...feed()]: Terser 5.51.2 rewrites that spread into a call that never
  // iterates, for any generator, so the check would measure Terser instead of this package.
  try {
    for (const _ of parser.feed('{"left":[1,2],"right":"a'));
    const before = parser.snapshot();
    if (parser.snapshot() !== before) throw new Error("shared snapshot changed without input");
    for (const _ of parser.feed('b"}'));
    const after = parser.snapshot();
    if (!before.ok || !after.ok || before.value === undefined || after.value === undefined ||
      before.value.value.left !== after.value.value.left)
      throw new Error("shared snapshot lost its completed branch");
    return [before, after, [...parser.end()]];
  } finally { parser.close(); }
}
`,
    absent: ["snapshot-owned", "source-fragments", "source-picks", "picks", "report", "metrics"],
    present: ["snapshot", "snapshot-shared"],
  },
  {
    id: "forced-worker",
    job: "/async with execution worker: worker code outside the initial chunk, works after the first call",
    source: `import { parseAsync, parseManyAsync, worker } from "${PKG}/async";
${inputs}
export async function run() {
  const out = [];
  for (const t of INPUTS) out.push(await parseAsync(t, { execution: worker }));
  // Too large to cross in one message, so it crosses in pieces; summarised to keep the output small.
  const wide = await parseAsync("[" + '{"a":1,"b":"xy"},'.repeat(20000) + "0]", { execution: worker });
  out.push(wide.ok ? [wide.value.length, Object.keys(wide.value[7]), wide.value[19999], wide.value[20000]] : wide);
  const many = [];
  for await (const v of parseManyAsync('{"a":1} [2,3,] "s', { execution: worker })) many.push(v);
  out.push(many);
  return out;
}
`,
    // The worker runs the same-thread executor; the app's thread reaches it only through `auto`
    // or `cooperative`, so it must not load at startup.
    absent: ["stringify", "metrics", "try-parsers"],
    notAtStartup: COOPERATIVE_MODULES,
    present: ["async-worker"],
    worker: true,
    // Generic workers rebuild requested features; D5 permits this code only outside startup.
    lazy: ["worker-executor", "async-worker", "worker-output", "report", "selector", "picks"],
  },
  {
    id: "async-cooperative-abort",
    job: "/async cooperative with an abort mid-input; auto on a small input",
    source: `import { parseAsync, cooperative } from "${PKG}/async";
const BIG = "[" + "1,".repeat(300000) + "1]";
export async function run() {
  const controller = new AbortController();
  const pending = parseAsync(BIG, { execution: cooperative, signal: controller.signal });
  controller.abort("stop");
  const stopped = await pending;
  // Where the abort lands is time-sliced, so only the outcome's shape is comparable across hosts.
  const aborted = stopped.ok
    ? { ok: true }
    : { ok: false, kind: stopped.failure.kind, reason: stopped.failure.reason, recovered: Array.isArray(stopped.failure.recovered?.value) };
  return [aborted, await parseAsync('{"a":[1,', { execution: cooperative })];
}
`,
    // A named strategy ships alone (HLD D5): no worker byte, and no feature only a worker rebuilds.
    absent: [
      "stringify",
      "metrics",
      "try-parsers",
      "span-async",
      "joined-stop-signal",
      ...WORKER_MODULES,
      "report",
      "selector",
      "picks",
      "repair-splice",
      "repair-operation",
      "span-operation",
    ],
  },
  {
    id: "configured-async-parse",
    job: "reusable async parsing without unrelated operation projections at startup",
    source: `import { cooperative, initAsyncParser, parseAsync } from "${PKG}/async";
export async function run() {
  const parser = initAsyncParser({ execution: cooperative });
  try { return await parseAsync('{"a":[1,', parser); }
  finally { parser.close(); }
}
`,
    absent: [
      "repair-async",
      "span-async",
      "metrics",
      "stringify",
      "try-parsers",
      ...WORKER_MODULES,
      "repair-operation",
      "repair-splice",
      "span-operation",
    ],
  },
  {
    id: "import-named-unused",
    job: "import-only: a named import that is never called",
    source: `import { parse, parseStream } from "${PKG}";\nimport { parseAsync } from "${PKG}/async";\nexport const keep = 0;\n`,
    absent: [],
    empty: true,
  },
  {
    id: "import-bare",
    job: "import-only: bare side-effect import of the root and /async, nothing called",
    source: `import "${PKG}";\nimport "${PKG}/async";\nexport const keep = 0;\n`,
    absent: [],
    empty: true,
  },
  {
    id: "stringify",
    job: "stringify alone: no parser code",
    source: `import { stringify } from "${PKG}";\nexport async function run() { return [stringify({ a: [1, "x"], b: null }), stringify([NaN, -0, "\\ud800"])]; }\n`,
    absent: [
      "scan",
      "builder",
      "parser",
      "scan-diagnostics",
      "report",
      "selector",
      "picks",
      "positions",
      "metrics",
      "try-parsers",
      "async-worker",
      "worker-executor",
    ],
    present: ["stringify"],
  },
  {
    id: "metrics",
    job: "parse counted by a createMetrics scope",
    source: `import { createMetrics, parse } from "${PKG}";\n${inputs}\nexport async function run() { const m = createMetrics(); return INPUTS.map((t) => parse(t, m)); }\n`,
    absent: [
      "selector",
      "picks",
      "stringify",
      "try-parsers",
      "async-worker",
      "worker-executor",
      "snapshot",
      "stream-scalars",
    ],
    present: ["metrics"],
    markers: { [FEATURE_MARKERS.transport]: "absent" },
  },
  {
    id: "try-parsers",
    job: "tryParsers over a caller's parser chain: no recovery core",
    source: `import { tryParsers } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => tryParsers(t, [JSON.parse])); }\n`,
    absent: [
      "scan",
      "builder",
      "scan-diagnostics",
      "report",
      "selector",
      "picks",
      "positions",
      "stringify",
      "metrics",
      "async-worker",
      "worker-executor",
    ],
    present: ["try-parsers"],
  },
  // A feature is passed as the imported value, e.g. `{ diagnostics }`: one root, no feature subpaths.
  // `locations` has no module of its own: span arithmetic is the position code every refusal needs.
  {
    id: "diagnostics-feature",
    job: "parse + diagnostics feature value; heaviest sibling selector absent",
    source: `import { parse, diagnostics } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => parse(t, { diagnostics })); }\n`,
    absent: [
      "selector",
      "picks",
      "stringify",
      "metrics",
      "try-parsers",
      "async-worker",
      "worker-executor",
    ],
    present: ["report"],
  },
  {
    id: "locations-feature",
    job: "parse + locations feature value; diagnostics and selector absent",
    source: `import { parse, locations } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => parse(t, { locations })); }\n`,
    absent: [
      "report",
      "selector",
      "picks",
      "stringify",
      "metrics",
      "try-parsers",
      "async-worker",
      "worker-executor",
    ],
    present: ["positions"],
  },
  {
    id: "select-feature",
    job: "selected values without decoded scalar-fragment delivery",
    source: `import { parse, select, ANY_DEPTH } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => parse(t, { select: select([[ANY_DEPTH, "id"]]) })); }\n`,
    absent: [
      "decoded-fragments",
      "decoded-picks",
      "source-fragments",
      "source-picks",
      "report",
      "snapshot",
      "stringify",
      "metrics",
      "try-parsers",
      "async-worker",
      "worker-executor",
    ],
    present: ["selector", "picks"],
    markers: { [FEATURE_MARKERS["scalar fragments"]]: "absent" },
  },
  {
    id: "decoded-fragments",
    job: "decoded scalar fragments without the source-copying implementation",
    source: `import { createStreamParser, decodedFragments, select } from "${PKG}";
export async function run() {
  const parser = createStreamParser({ select: select([["x"]], { fragments: decodedFragments }) });
  try { return [...parser.feed('{"x":"a\\\\u0062'), ...parser.feed('"}'), ...parser.end()]; }
  finally { parser.close(); }
}
`,
    absent: ["source-fragments", "source-picks", "report", "metrics", "worker-executor"],
    present: ["stream-scalars", "picks", "decoded-picks"],
    markers: { [FEATURE_MARKERS["scalar fragments"]]: "present" },
  },
  {
    id: "source-fragments",
    job: "bounded source copying of selected quoted, numeric and literal-candidate scalars",
    source: `import { createStreamParser, select, sourceFragments } from "${PKG}";
export async function run() {
  const results = [];
  for (const token of ['"a\\\\u0062"', '0x' + 'f'.repeat(8192), '123' + 'a'.repeat(8192), 'true']) {
    const parser = createStreamParser({ select: select([["x"]], { fragments: sourceFragments }), maxRetained: 128 });
    let copied = '', completion;
    const take = (items) => { for (const item of items) {
      if (!item.ok) throw new Error('source fragments refused bounded copying');
      if (item.value.kind === 'data') copied += item.value.text;
      if (item.value.kind === 'end') completion = item.value;
    } };
    try {
      take(parser.feed('{"x":'));
      for (let at = 0; at < token.length; at += 64) take(parser.feed(token.slice(at, at + 64)));
      take(parser.feed('}')); take(parser.end());
      if (copied !== token || !completion?.complete) throw new Error('source fragments lost scalar spelling');
      results.push({ length: copied.length, scalar: completion.scalar });
    } finally { parser.close(); }
  }
  return results;
}
`,
    absent: ["report", "metrics", "worker-executor"],
    present: ["source-fragments", "source-picks"],
  },
  {
    id: "skip-feature",
    job: "parse + skip without selected delivery, fragments or snapshots",
    source: `import { parse, skip, ANY_DEPTH } from "${PKG}";\n${inputs}\nexport async function run() { return INPUTS.map((t) => parse(t, { skip: skip([[ANY_DEPTH, "id"]]) })); }\n`,
    absent: [
      "report",
      "snapshot",
      "selection-copy",
      "stringify",
      "metrics",
      "try-parsers",
      "async-worker",
      "worker-executor",
    ],
    present: ["selector", "path-filter"],
  },
];

/** A consumer that never imports `/async` ships no async or worker byte; one rule, so no row forgets it. */
export const FIXTURES: readonly Fixture[] = ROWS.map((row) =>
  row.source.includes(`"${PKG}/async"`)
    ? row
    : // ROWS is private to this module, so completing a row in place copies nothing.
      Object.assign(row, { absent: [...row.absent, ...ASYNC_MODULES] }),
);
