// SPDX-License-Identifier: Apache-2.0

/**
 * The speed documents and the timing kernel, host-neutral: no `node:` import, no file read and no
 * native module, so the same code measures on Node, Bun and Deno (`compare.ts`) and inside a
 * browser page or a workerd isolate (`web.ts`). One owner keeps every host measuring the same bytes
 * with the same estimator, so their rows compare.
 */
import { parse as ours } from "../../dist/index.js";
import { estimate, type EstimateOptions } from "../estimator.ts";
import { sameValue } from "./same-value.ts";

/** One library's entry points as the speed table calls them. */
export type SpeedLib = {
  readonly name: string;
  readonly parse: (text: string) => unknown;
  /** Every value in the text, for the JSONL column; the ordinary parse where absent. */
  readonly many?: (text: string) => unknown;
};

export const ours0 = (text: string): unknown => {
  const r = ours(text);
  if (!r.ok) throw new Error(r.failure.kind);
  return r.value;
};

export const attempt = (fn: () => unknown): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
};

/** The value every speed document below encodes, in whichever dialect that document is written. */
export const payload = Array.from({ length: 400 }, (_, i) => ({
  id: i,
  name: `item-${i}`,
  tags: [`a${i}`, `b${i}`],
  nested: { deep: { ok: i % 2 === 0 } },
}));
export const records = JSON.stringify(payload);
const messy = records.replaceAll('"name"', "name").slice(0, -200);
const jsonl = payload.map((r) => JSON.stringify({ id: r.id, v: `r${r.id}` })).join("\n");

/*
 * THE SAME 400 ROWS IN EVERY DIALECT THIS PACKAGE READS.
 *
 * A dialect parser measured on plain JSON reports its fallback path, which is not the thing it
 * exists for — `json5` and `jsonc-parser` are in this table because they own a dialect, so scoring
 * them on a document without one measures nothing anybody would install them for.
 *
 * One value across every column is what makes the columns comparable: each document decodes to
 * `rows`, so a cell compares parsers rather than documents. The JSON5 form is spelled out rather
 * than produced by a serialiser deliberately — it MIRRORS the object literal above, and a mirror
 * that drifts stops matching the expected value and blanks its whole column, where a serialiser
 * would agree with itself and hide the drift.
 */
const jsonc = `[\n${payload.map((r) => `  // row ${r.id}\n  ${JSON.stringify(r)},`).join("\n")}\n]`;
const json5 = `[\n${payload
  .map(
    (r) =>
      `  // row ${r.id}\n  {id:${r.id},name:'item-${r.id}',tags:['a${r.id}','b${r.id}'],nested:{deep:{ok:${r.id % 2 === 0}}},},`,
  )
  .join("\n")}\n]`;

/** The documents every library is measured on. Named once; the tables and `baseline.ts` follow. */
export const CASES = ["clean", "malformed", "jsonl", "jsonc", "json5"] as const;
export type Case = (typeof CASES)[number];

/** Per-byte rates in MB/s. Absent where the library did not produce the correct value. */
export type Rates = Partial<Record<Case, number | undefined>>;

/**
 * Exactly what `EMIT=json` prints. `baseline.ts` reads this type, so the wire format has one owner.
 *
 * Cells are keyed by any case name, not only {@link Case}: other runners (`stream.ts`, the native
 * and Python runners) emit workloads of their own beside the shared `clean` reference.
 */
export type Emitted = {
  readonly runtime: string;
  readonly rates: Readonly<Record<string, Readonly<Record<string, number | undefined>>>>;
};

/**
 * Each case's document, the value a correct parse yields, and which entry point reads it.
 *
 * The expected value is stated here, not taken from whichever library ran first. WITHOUT it the
 * table was nonsense in the most flattering direction available: `partial-json` "read" the 400-row
 * JSONL document at 19 600 MB/s because it stops at the first value and returns, and dividing the
 * WHOLE document's length by the time to read 1/400th of it reports a rate for work nobody did. A
 * parser that gives up early is not fast, and a throughput column that cannot tell the two apart is
 * measuring the wrong thing entirely.
 */
export const DOCS: Record<Case, { text: string; want: unknown; entry?: "many" }> = {
  clean: { text: records, want: payload },
  // Truncated, so its correct answer is what OUR parser recovers — the one case with no answer
  // independent of a parser. A library disagreeing with it gets a dash here and a line in the
  // coverage table, not a rate.
  malformed: { text: messy, want: ours0(messy) },
  // Each library's multi-value API where it has one and its ORDINARY parse otherwise: the column
  // asks whether a library returns all 400 values, not how. Two do, by quite different routes —
  // `parseMany` by design, and `jsonrepair` because repairing newline-delimited objects into one
  // array happens to yield them. Skipping the libraries without a multi-value API instead of falling
  // back would silently retire that second row as though the library had stopped answering.
  jsonl: {
    text: jsonl,
    want: jsonl.split("\n").map((line) => JSON.parse(line) as unknown),
    entry: "many",
  },
  jsonc: { text: jsonc, want: payload },
  json5: { text: json5, want: payload },
};

/*
 * One kernel for every timing in the repository, so a number here is comparable with a number
 * anywhere else; `bench/estimator.ts` holds the reasoning and the measurements behind it.
 *
 * It batches up to a duration floor, which a per-document loop here could not: the clean document is
 * ~34 KB, so one `JSON.parse` of it takes about 0.08 ms and a single-parse sample reads the clock as
 * much as the code. The rivals span more than an order of magnitude, so the batch size has to be
 * calibrated per library rather than fixed, and the same file floors the WARM-UP in invocations —
 * without which the slowest rivals here were timed before their JIT had finished with them.
 *
 * This process's own numbers carry NO error bar — repeated batches inside one process share a JIT
 * profile and a heap, and their agreement says nothing about whether a re-run reproduces. That is
 * `baseline.ts`'s job, which forks this script and takes the spread ACROSS processes.
 */
const timed = (bytes: number, run: () => void, options?: EstimateOptions): number =>
  bytes / 1024 / 1024 / (estimate(run, options) / 1e9);

/**
 * Each library's rate per case. `options` widens the estimator's batches on a host whose clock is
 * coarse (a browser or workerd); the default suits a microsecond clock.
 */
export const speed = (libs: readonly SpeedLib[], options?: EstimateOptions): Map<string, Rates> =>
  new Map(
    libs.map((lib) => {
      const rates: Rates = {};
      for (const c of CASES) {
        const doc = DOCS[c];
        const run = doc.entry === "many" ? (lib.many ?? lib.parse) : lib.parse;
        const got = attempt(() => run(doc.text));
        // A rate is reported only for a library that produced the right value, so an early return
        // or a partial read cannot appear here as throughput.
        if (!got.ok || !sameValue(got.value, doc.want)) continue;
        rates[c] = timed(
          doc.text.length,
          () => {
            run(doc.text);
          },
          options,
        );
      }
      return [lib.name, rates];
    }),
  );
