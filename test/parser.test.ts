// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { decodedFragments } from "../src/index";

/**
 * The public surface, attacked at the points where it makes a PROMISE the types cannot check:
 * laziness, snapshot ownership, sharing, the claim that a shared parser holds no state, and that a
 * refusal or a limit is never dressed as success.
 */
import { readFileSync } from "node:fs";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import type { Parser, StreamItem, StreamParser } from "../src/parser";
import type { Exact, ParserOptions, StreamParserOptions } from "../src/options";
import type { Snapshot, ViewFeature, ViewMode } from "../src/types";
import { isExactNumber } from "../src/exact-number";
import {
  COMPAT,
  LLM_BALANCED,
  LLM_FULL,
  STRICT,
  createStreamParser,
  findJsonSpan,
  initParser,
  parse,
  parseMany,
  repair,
  diagnostics,
  locations,
  select,
} from "../src/index";
import { builtinRead } from "../src/builtin-route";
import { readMany, createWholeInputReader } from "../src/whole-reader";
import { wholeInputSource } from "../src/whole-source";
import { resolveOptions } from "../src/options";
import { configurationCause } from "./configuration-error";
import { costRatio } from "./cost-ratio";
import { sharedView, ownedView } from "../src/index";

/** Reporting on, as a literal so the result TYPE carries `diagnostics` rather than making it optional. */
const REPORT = { diagnostics } as const;

const parser = <O extends ParserOptions>(options?: Exact<O, ParserOptions>): Parser<O> =>
  initParser<O>(options);

const stream = <O extends StreamParserOptions>(
  options?: Exact<O, StreamParserOptions>,
): StreamParser<O> => createStreamParser<O>(options);

/** Every item a stream yields for these chunks, in order: each chunk's completions, then the tail. */
const drain = <O extends StreamParserOptions>(
  sp: StreamParser<O>,
  ...chunks: readonly (string | Uint8Array)[]
): StreamItem<O>[] => [...chunks.flatMap((chunk) => Array.from(sp.feed(chunk))), ...sp.end()];

const values = (items: Iterable<StreamItem>): unknown[] =>
  [...items].map((item) => {
    if ("kind" in item || !item.ok) throw new Error(inspect(item));
    return item.value;
  });

const valueOf = (result: { ok: true; value: unknown } | { ok: false }): unknown => {
  if (!result.ok) throw new Error(inspect(result));
  return result.value;
};

const failed = <F>(r: { ok: true } | { ok: false; failure: F }): F | undefined =>
  r.ok ? undefined : r.failure;

/**
 * The same item without its positions, which the `drain` cut moves and nothing else does. A walk,
 * not a JSON round trip: that would turn `NaN` into `null` and drop `undefined` members, erasing
 * exactly the differences the comparison exists to catch.
 */
const unplaced = (item: unknown): unknown => {
  if (Array.isArray(item)) return item.map((v) => unplaced(v));
  if (item === null || typeof item !== "object" || isExactNumber(item)) return item;
  // Same prototype, so a null-prototype record stays one and `toStrictEqual` compares like with like.
  const proto = Object.getPrototypeOf(item) as object | null;
  const out = Object.create(proto) as Record<string, unknown>;
  for (const [k, v] of Object.entries(item))
    if (k !== "at" && k !== "span")
      Object.defineProperty(out, k, {
        // Payload keys may themselves be named at or span; only metadata positions may differ.
        value: k === "value" ? v : unplaced(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  return out;
};

// `Omit<..., "select">` and not `ParserOptions`: under `select` the verb returns matches, so a
// helper promising text has to say it never selects.
const repairText = (text: string, options?: Omit<ParserOptions, "select">): string => {
  const result = options === undefined ? repair(text) : repair(text, options);
  if (!result.ok) throw new Error(inspect(result.failure));
  return result.value;
};

// What `parse` reads back from repaired text: JSON has no NaN, infinity or undefined, so repair
// writes each as null in place. `Object.fromEntries` defines keys, so `__proto__` stays data.
const writtenAsJson = (value: unknown): unknown => {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return null;
  if (Array.isArray(value)) return value.map((item) => writtenAsJson(item));
  if (typeof value !== "object" || value === null || isExactNumber(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, writtenAsJson(v)]));
};

const manyValues = (text: string, options?: ParserOptions): unknown[] =>
  values(options === undefined ? parseMany(text) : parseMany(text, options));

describe("parse", () => {
  it("agrees with JSON.parse on clean input and reports nothing", () => {
    const src = '{"a":[1,2],"b":"x"}';
    const r = parse(src, REPORT);
    expect(valueOf(r)).toEqual(JSON.parse(src) as unknown);
    expect(r.diagnostics.repairs).toEqual([]);
    expect(r.diagnostics.confidence).toBe(1);
    // Reporting is opt-in: the default result carries no report at all, not an empty one.
    expect("diagnostics" in parse(src)).toBe(false);
  });

  it("distinguishes a null VALUE from finding nothing", () => {
    // Both would read as "no value" through an optional `value`, which is why `ok` exists.
    const nul = parse("null");
    expect(nul).toEqual({ ok: true, complete: true, value: null });
    expect(failed(parse("we found 3 of 7 items"))?.kind).toBe("no-json-found");
  });

  it("hands back a span that re-parses to the same value, when asked for one", () => {
    const src = '  prose {"a":[1,2]} more  ';
    const r = parse(src, { locations });
    if (!r.ok) throw new Error("expected a value");
    expect(JSON.parse(src.slice(r.span.start.offset, r.span.end.offset)) as unknown).toEqual({
      a: [1, 2],
    });
    expect("span" in parse(src)).toBe(false);
  });

  it("throws invalid options at the call, with the typed reason as cause", () => {
    expect(configurationCause(() => parse("{}", { maxDepth: 0 }))).toEqual({
      kind: "invalid-options",
      field: "maxDepth",
      reason: "positive-integer",
    });
    expect(configurationCause(() => initParser({ maxErrors: -1 }))).toEqual({
      kind: "invalid-options",
      field: "maxErrors",
      reason: "positive-integer",
    });
  });

  it("keeps an integer past 2^53 exact, even on the native path", () => {
    // The ⚑ case, and the native path is what makes it hard: `JSON.parse` drops those digits
    // silently and a reviver only ever sees the already-rounded value, so the fast path has to
    // DECLINE the input rather than notice afterwards. Nothing is reported: the value itself is
    // the source digits, and a report is for what changed.
    const r = parse('{"id":12345678901234567890}', REPORT);
    expect(r.ok && isExactNumber((r.value as { id: unknown }).id)).toBe(true);
    expect(r.diagnostics.repairs).toEqual([]);
    // A number that survives exactly must stay a `number` on either implementation path.
    expect(parse('{"a":123456}')).toEqual({ ok: true, complete: true, value: { a: 123456 } });
    for (const losing of ['{"id":12345678901234567890}', '{"id":9007199254740993}', "[1e-400]"]) {
      expect(parse(losing), losing).toStrictEqual(parse(losing, { builtinParsers: false }));
    }
  });

  it("keeps a double for exactly represented long fractions", () => {
    /**
     * `0.3333333333333333` is sixteen digits and is ALREADY the shortest spelling of its double, so
     * it stays a `number`. Any float `JSON.stringify` emits at full precision looks the same to a
     * digit counter, which made ordinary computed data — measured, `i / 3` in a 400-record document
     * — give up the fast path for a hazard that never existed: 0.52 ms against 0.19 ms, on Bun
     * 1.3.14.
     */
    const exact = '{"a":0.3333333333333333,"b":1.2345678901234567}';
    expect(parse(exact, REPORT)).toEqual({
      ok: true,
      complete: true,
      value: JSON.parse(exact) as unknown,
      diagnostics: expect.objectContaining({ repairs: [] }) as unknown,
    });

    // A long digit run inside a STRING is not a number at all. The screen cannot see quoting, so it
    // declines conservatively — asserted for the VALUE, since a wrong answer here would be silent.
    const quoted = '{"a":"12345678901234567890"}';
    expect(valueOf(parse(quoted))).toEqual(JSON.parse(quoted) as unknown);
    // The report above declines the built-in route, so the value cannot show that it stayed open.
    expect(builtinRead(exact, resolveOptions({}))).toBeDefined();
  });

  it("the native path's cheap acquittal never disagrees with the scanner", () => {
    // The native path skips the expensive integer-fidelity check for tokens that provably cannot
    // lose one, because running it on every number cost 1.4x on ordinary data. A wrong acquittal is
    // SILENT — the fast path keeps a rounded number where the scanner keeps an `ExactNumber` — so
    // the two paths are compared whole, and WITHOUT a report, since asking for one turns the fast
    // path off and would make both sides the scanner.
    //
    // Swept across the three edges the shortcut is drawn on: 15 digits against 16, a zero fraction
    // against a non-zero one, and an exponent that turns either back into a large integer.
    const tokens = [
      "9007199254740992",
      "9007199254740992.0",
      "9.007199254740992e15",
      "0.1",
      "1e-999999999",
      "0e999999999",
      "9007199254740993",
      "9007199254740993.0",
      "9.007199254740993e15",
      "1e400",
      "1.0",
      "0.0",
      "-0.0",
      "-1e400",
    ];
    for (let d = 1; d <= 20; d++) {
      const nines = "9".repeat(d);
      tokens.push(nines, `-${nines}`, `${nines}.0`, `${nines}.5`, `${nines}e2`, `0.${nines}`);
    }
    // Overflow reached through a LONG integer part rather than an exponent. `JSON.parse` returns
    // Infinity for these, so a shortcut that cleared them on their fraction would hand back a value
    // the document never held and report nothing.
    // Underflow reached through a LONG fraction rather than an exponent, likewise: the 299-zero
    // fraction is a normal double, the 400-zero one rounds to zero, and the shortcut is drawn
    // between them.
    tokens.push(
      `${"9".repeat(400)}.5`,
      `-${"9".repeat(400)}.5`,
      "9".repeat(400),
      `0.${"0".repeat(299)}1`,
      `0.${"0".repeat(400)}1`,
      `-0.${"0".repeat(400)}1`,
    );
    for (const raw of tokens) {
      expect(parse(`[${raw}]`), raw).toEqual(parse(`[${raw}]`, { builtinParsers: false }));
    }
  });

  it("takes the native path without changing the answer", () => {
    // The fast path must be invisible. Same text with it off must give the same result, or the
    // package has two parsers that disagree — which is the defect this whole rewrite removes.
    // No report: asking for one declines the built-in route and both sides would be the scanner.
    const src = '{"a":1,"b":[true,null,"\\u0041"]}';
    expect(builtinRead(src, resolveOptions({}))).toBeDefined();
    expect(parse(src)).toStrictEqual(parse(src, { builtinParsers: false }));
    // ...and it must not be taken when it would defeat a key policy, which it cannot honour.
    expect(valueOf(parse('{"__proto__":{"x":1},"safe":2}', LLM_FULL))).toEqual({ safe: 2 });
  });

  it("does not let the native path answer for a repair the caller refused", () => {
    // A duplicate key is the one repair VALID JSON can produce that `JSON.parse` performs SILENTLY,
    // collapsing it before any reviver runs. So refusing it is the one policy the fast path can
    // break without any syntax error to fall back on: measured, `auto` answered `ok: true` for a
    // document the scanner refuses. Diagnostics stay OFF here on purpose — a report already
    // declines the fast path, so asking for one would test the wrong guard.
    const source = '{"a":1,"a":2}';
    const refuse = { recover: { "duplicate-key": false } } as const;
    expect(parse(source, refuse)).toEqual(parse(source, { ...refuse, builtinParsers: false }));
    expect(parse(source, refuse).ok).toBe(false);
    // ...and the guard must not cost the fast path where nothing was refused.
    expect(parse(source)).toEqual({ ok: true, complete: true, value: { a: 2 } });
  });

  it("does not let the native path bypass the depth budget", () => {
    // No report, so the built-in route is open to the default call and only the budget can stop it.
    const source = '{"a":{"x":1},"b":2}';
    expect(builtinRead(source, resolveOptions({}))).toBeDefined();
    expect(parse(source, { maxDepth: 1 })).toStrictEqual(
      parse(source, { maxDepth: 1, builtinParsers: false }),
    );
    expect(parse(source, { maxDepth: 1 }).ok).toBe(false);
  });

  it("keeps valid strings dominant over quote-mismatch recovery on every path", () => {
    const source = `["'','','"]`;
    const expected = JSON.parse(source) as unknown;
    expect(valueOf(parse(source, { builtinParsers: false }))).toEqual(expected);
    for (let cut = 1; cut < source.length; cut++) {
      expect(
        values(drain(stream(), source.slice(0, cut), source.slice(cut))),
        `cut at ${cut}`,
      ).toEqual([expected]);
    }
  });

  it("reads a long whitespace run inside a container in linear time", () => {
    // Whole input is scanned in slices; the root's trailing-whitespace end was recomputed per slice,
    // walking back over the whole run each time. Against a string of the same length, which the
    // scanner reads in one pass. This input still rejects per-window rescanning in both runners,
    // while avoiding multi-megabyte work on every commit.
    const spaces = `[1,${" ".repeat(800_000)}2]`;
    const string = `["${"x".repeat(800_000)}"]`;
    expect(parse(spaces, { builtinParsers: false })).toMatchObject({ value: [1, 2] });
    const ratio = costRatio(
      () => parse(spaces, { builtinParsers: false }),
      () => parse(string, { builtinParsers: false }),
    );
    expect(ratio).toBeLessThan(8);
  });
});

const deepFrozen = (value: unknown): boolean =>
  typeof value !== "object" ||
  value === null ||
  (Object.isFrozen(value) && Object.values(value).every((member) => deepFrozen(member)));

describe("presets", () => {
  it("STRICT refuses what RFC 8259 forbids, keeps what it read, and stops there", () => {
    expect(parse('{"a":1}', STRICT)).toEqual({ ok: true, complete: true, value: { a: 1 } });
    const r = parse("{a:1}", { ...STRICT, ...REPORT });
    // A refusal is a failure with the data attached, never a success with a note. The scan stopped
    // at the first refusal, so the report says it did not reach the end.
    expect(failed(r)).toEqual({
      kind: "policy-refused",
      issue: expect.objectContaining({ kind: "unparsable-span" }) as unknown,
      // Stopped with `a` named and its value never read: the recovery says so.
      recovered: { value: {}, complete: false, cut: { path: ["a"], kind: "missing" } },
    });
    expect(r.diagnostics.errors.map((e) => e.kind)).toEqual(["unparsable-span"]);
    expect(r.diagnostics.scanComplete).toBe(false);
    // The same verdict through every entry point, with reports off too.
    expect(failed(parse("{a:1}", STRICT))?.kind).toBe("policy-refused");
    expect(failed(repair("{a:1}", STRICT))?.kind).toBe("policy-refused");
  });

  it("COMPAT recovers with JS literals allowed and no report", () => {
    expect(parse("{'a':1}", COMPAT)).toEqual({ ok: true, complete: true, value: { a: 1 } });
    expect(valueOf(parse("[NaN]", COMPAT))).toEqual([Number.NaN]);
  });

  it("are frozen all the way down, so one caller cannot change a preset for the realm", () => {
    const presets = [STRICT, COMPAT, LLM_BALANCED, LLM_FULL];
    expect(presets.map((preset) => deepFrozen(preset))).toEqual([true, true, true, true]);
  });
});

describe("parseMany", () => {
  it("throws invalid shortcut options at the call, before an iterator exists", () => {
    // Thrown by `parseMany` itself, not by the first pull, so an iterator stored for later never
    // carries a latent configuration bug.
    expect(configurationCause(() => parseMany("1", { maxDepth: 0 }))).toEqual({
      kind: "invalid-options",
      field: "maxDepth",
      reason: "positive-integer",
    });
  });

  it("keeps each value's diagnostics with that value", () => {
    const results = [...parseMany('{"a":1} then {"b":[1,2,}', REPORT)];
    expect(results.map((r) => valueOf(r))).toEqual([{ a: 1 }, { b: [1, 2] }]);
    expect(results.map((r) => r.diagnostics.repairs.map((entry) => entry.kind))).toEqual([
      [],
      ["bracket-mismatch", "trailing-comma", "unclosed-object"],
    ]);
  });

  it("obeys the scalar rule, so it agrees with parse on every input", () => {
    for (const src of ["42", "  true  ", "we found 3 of 7 items", '{"a":1} 3', "```\n42\n```"]) {
      expect([...parseMany(src)], src).toEqual([parse(src)]);
    }
  });

  it("has not parsed the rest when only the first value is taken", () => {
    // The promise a lazy signature makes and an eager implementation silently breaks. Asserted on
    // the reader `parseMany` iterates, because its scanner is where "position never passed it" is
    // observable: the second document is damaged, so an eager pass would already have logged its
    // repair.
    const opts = resolveOptions(REPORT);
    const source = wholeInputSource('{"a":1} {"b":[1,2');
    if ("kind" in source) throw new Error(source.kind);
    const reader = createWholeInputReader(source, opts);
    const items = readMany(reader);
    const first: unknown = items.next().value;
    expect(first).toMatchObject({ ok: true, value: { a: 1 } });
    expect(reader.scanner.repairs).toEqual([]);
    const remaining = [...items];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.diagnostics?.repairs.map((r) => r.kind)).toEqual([
      "unclosed-array",
      "unclosed-object",
    ]);
  });
});

/** The source text under the span `findJsonSpan` reports, or the failure. */
const sliced = (src: string): unknown => {
  const result = findJsonSpan(src);
  return result.ok ? src.slice(result.value.start.offset, result.value.end.offset) : result;
};

describe("findJsonSpan", () => {
  it("gives the extent of the first candidate, or nothing", () => {
    expect(sliced("noise [1,2,3] noise")).toBe("[1,2,3]");
    expect(sliced("no json here")).toEqual({ ok: false, failure: { kind: "no-json-found" } });
  });

  it("excludes JSON whitespace on the native path", () => {
    expect(sliced(' \t\n {"a":1}\r ')).toBe('{"a":1}');
  });
});

/**
 * `maxBuffer` is the one resource bound a caller trips without doing anything wrong, and nothing
 * asserted either half of its contract. The one-shot half is the dangerous one: refusing to parse the
 * second half of a string the caller already handed over is truncation dressed as a resource bound,
 * and this package is not allowed to lose data it was given.
 */
describe("maxBuffer", () => {
  it("does not bound a one-shot parse, which already holds the whole text", () => {
    const big = `{"a":"${"x".repeat(4096)}"}`;
    const r = parse(big, { maxBuffer: 64 });
    expect(r.ok).toBe(true);
    expect((valueOf(r) as { a: string }).a).toHaveLength(4096);
  });

  it("keeps a long stream of small values inside the bound", () => {
    // Prefix compaction is what makes this true. A rewrite that dropped it would trip the limit here
    // while every value still parsed, so the damage would read as a resource problem rather than as
    // the missing mechanism it is.
    const sp = stream({ maxBuffer: 512 });
    let fed = 0;
    for (let i = 0; i < 200; i++) fed += values(sp.feed(`{"i":${i}} `)).length;
    expect(fed).toBe(200);
    // `end()` is the TAIL, not a replay: everything was delivered by `feed`, so nothing is left.
    expect([...sp.end()]).toEqual([]);
  });

  it("compacts completed members while their container remains open", () => {
    // `maxRetained` defaults to `maxBuffer`, and the sixty strings being built are far past 128
    // units — a bound on the VALUE, which is not what this case is about. The source window is.
    const sp = stream({ maxBuffer: 128, maxRetained: 4096 });
    void Array.from(sp.feed("["));
    for (let i = 0; i < 60; i++) void Array.from(sp.feed(`"item${i}",`));
    const items = [...sp.end()];
    expect(items.map((item) => item.ok)).toEqual([true]);
    expect(values(items)[0]).toHaveLength(60);
  });

  it("fails terminally instead of retaining an over-budget source window", () => {
    const sp = stream({ maxBuffer: 1 });
    expect([...sp.feed("```")]).toEqual([
      {
        ok: false,
        failure: {
          kind: "limit-reached",
          resource: "buffer",
          limit: 1,
          at: { offset: 0, unit: "utf16", chunk: 0 },
        },
      },
    ]);
    // Terminal means closed: the stream answers every later call the same way and reads nothing.
    const closed = [{ ok: false, failure: { kind: "stream-closed" } }];
    expect([...sp.feed('{"a":1}')]).toEqual(closed);
    expect([...sp.end()]).toEqual(closed);
  });

  it("charges malformed bytes in an unfinished key to the error budget immediately", () => {
    // Sixty-four bad bytes under a budget of one: charged as they arrive, the first exhausts the
    // budget and the scan stops with one error counted. Charged when the key finishes, all sixty-four
    // would be counted — and the count is the only thing that tells the two apart. The budget is the
    // verdict here: malformed bytes are recovered, not refused, so nothing else explains the stop.
    const sp = stream({ maxErrors: 1, ...REPORT });
    const [item] = drain(
      sp,
      Uint8Array.from([0x7b, 0x22, ...Array.from({ length: 64 }, () => 0xff)]),
    );
    if (item === undefined || item.ok) throw new Error("expected a stopped root");
    expect(item.failure).toMatchObject({ kind: "limit-reached", resource: "errors", limit: 1 });
    expect(item.diagnostics.counts.errors).toBe(1);
    expect(item.diagnostics.scanComplete).toBe(false);
  });

  it("reports an oversized root scalar through every public result surface", () => {
    const options = { maxScalar: 3 } as const;
    const scalar = { kind: "limit-reached", resource: "scalar", limit: 3 };
    expect(failed(parse("1234", options))).toMatchObject(scalar);
    expect([...parseMany("1234", options)].map((r) => failed(r))).toEqual([
      expect.objectContaining(scalar),
    ]);
    expect(failed(repair("1234", options))).toMatchObject(scalar);
  });
});

describe("manual stream delivery", () => {
  it("delivers each value once, with its own report and span, and then closes", () => {
    const sp = stream({ locations, ...REPORT });
    // The line break settles the root inside this chunk; ending on `}` waits for a possible comma.
    const [done, ...rest] = sp.feed("{'a':1}\n");
    expect(rest).toEqual([]);
    expect(done).toMatchObject({
      ok: true,
      value: { a: 1 },
      span: { start: { offset: 0, unit: "utf16" }, end: { offset: 7, unit: "utf16" } },
    });
    expect(done?.diagnostics.repairs.map((entry) => entry.kind)).toEqual(["single-quote"]);
    expect(done?.diagnostics.confidence).toBe(1);
    // `feed` delivered it, so the tail is empty; after that the stream is closed and says so.
    expect([...sp.end()]).toEqual([]);
    expect([...sp.end()].map((r) => failed(r))).toEqual([{ kind: "stream-closed" }]);
    expect([...sp.feed("[2]")].map((r) => failed(r))).toEqual([{ kind: "stream-closed" }]);
  });

  it("distinguishes an empty stream from a successful empty value", () => {
    expect([...stream().end()]).toEqual([{ ok: false, failure: { kind: "no-json-found" } }]);
    expect(values(drain(stream(), "[]"))).toEqual([[]]);
  });
});

describe("byte input", () => {
  // Every split point of a document holding 2-, 3- and 4-byte characters, because the defect is a
  // boundary defect: one hand-picked split proves nothing about the other three lengths, and a
  // decoder that mangles a straddling character is silent — the value still parses, wrongly.
  const doc = '{"a":"é€𝄞x","b":"ü"}';
  const bytes = new TextEncoder().encode(doc);

  it("survives a multi-byte character split at every byte boundary", () => {
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(
        values(drain(stream(), bytes.subarray(0, cut), bytes.subarray(cut))),
        `cut at ${cut}`,
      ).toEqual([JSON.parse(doc) as unknown]);
    }
  });

  it("feeds one byte at a time without losing a character", () => {
    expect(values(drain(stream(), ...[...bytes].map((b) => new Uint8Array([b]))))).toEqual([
      JSON.parse(doc) as unknown,
    ]);
  });

  it("strips a BOM and does not treat it as prose", () => {
    expect(values(drain(stream(), new TextEncoder().encode('﻿{"a":1}')))).toEqual([{ a: 1 }]);
  });

  it("keeps a BOM from a later byte chunk as string data", () => {
    const encoder = new TextEncoder();
    expect(values(drain(stream(), encoder.encode('{"a":"x'), encoder.encode('﻿y"}')))).toEqual([
      { a: "x﻿y" },
    ]);
  });

  it("does not silently drop bytes that ended mid-character", () => {
    // The last character is truncated by the input, not by us. It must arrive as U+FFFD rather than
    // vanish — an implementation holding the tail for a continuation that never comes loses it.
    expect(values(drain(stream(), new TextEncoder().encode('{"a":"x€"}').subarray(0, 9)))).toEqual([
      { a: "x�" },
    ]);
  });

  it("distinguishes every malformed UTF-8 sequence class from genuine U+FFFD", () => {
    // Malformed bytes are recovered with U+FFFD and the value succeeds; the report is what tells a
    // U+FFFD the decoder wrote from one the source wrote, so its positions are asserted exactly.
    const encoder = new TextEncoder();
    const prefix = encoder.encode('{"a":"');
    const suffix = encoder.encode('"}');
    const cases = [
      { bytes: [0x80], value: "�", errors: [0] },
      { bytes: [0xc0, 0xaf], value: "��", errors: [0, 1] },
      { bytes: [0xe2, 0x28, 0xa1], value: "�(�", errors: [0, 2] },
      { bytes: [0xed, 0xa0, 0x80], value: "���", errors: [0, 1, 2] },
      { bytes: [0xf4, 0x90, 0x80, 0x80], value: "����", errors: [0, 1, 2, 3] },
      { bytes: [0xe2, 0x82], value: "�", errors: [0] },
    ] as const;
    for (const sample of cases) {
      const sp = stream(REPORT);
      const [item] = drain(
        sp,
        prefix,
        ...sample.bytes.map((byte) => new Uint8Array([byte])),
        suffix,
      );
      expect(item).toMatchObject({ ok: true, value: { a: sample.value } });
      expect(item?.diagnostics.errors).toEqual(
        // `expect.objectContaining` is typed `any`, so the matcher is pinned to `unknown` here
        // rather than letting `any` spread into the expected array.
        // Each byte is its own chunk after the text prefix, so a replacement sits at byte 0 of
        // the chunk holding the byte that caused it, counted in that chunk's unit.
        sample.errors.map(
          (byte) =>
            expect.objectContaining({
              kind: "invalid-utf8",
              at: { offset: 0, unit: "byte", chunk: 1 + byte },
              path: ["a"],
              valueIndex: 0,
            }) as unknown,
        ),
      );
    }

    expect(drain(stream(), encoder.encode('{"a":"�"}'))).toEqual([
      { ok: true, complete: true, value: { a: "�" } },
    ]);

    const [keyed] = drain(
      stream(REPORT),
      encoder.encode('{"'),
      new Uint8Array([0x80]),
      encoder.encode('":1}'),
    );
    expect(keyed).toMatchObject({ ok: true, value: { "�": 1 } });
    expect(keyed?.diagnostics.errors[0]).toEqual(
      expect.objectContaining({
        kind: "invalid-utf8",
        at: { offset: 0, unit: "byte", chunk: 1 },
        path: ["�"],
        valueIndex: 0,
      }),
    );
  });
});

type Viewed = StreamParser<{ view: ViewFeature }>;
const viewed = (view: ViewMode, options: ParserOptions = {}): Viewed =>
  stream({ ...options, view: view === "owned" ? ownedView : sharedView });
/** The snapshot's payload, with a failed or empty view thrown as the test's own failure. */
const seen = (sp: Viewed): Snapshot => {
  const r = sp.snapshot();
  if (!r.ok) throw new Error(inspect(r.failure));
  if (r.value === undefined) throw new Error("no root to view");
  return r.value;
};
/** The viewed value, from the success or from the recovery of a refused root. */
const view = (sp: Viewed): unknown => {
  const r = sp.snapshot();
  return r.ok ? r.value?.value : r.failure.recovered?.value;
};
const summaries = (items: Iterable<StreamItem<{ summary: true }>>): unknown[] =>
  [...items].filter((item) => "kind" in item);

describe("snapshots", () => {
  /** Both views of one parse, taken in the same state. */
  const both = (text: string, options: ParserOptions = {}): [unknown, unknown] => {
    const shared = viewed("shared", options);
    const owned = viewed("owned", options);
    void Array.from(shared.feed(text));
    void Array.from(owned.feed(text));
    return [view(owned), view(shared)];
  };

  it("has no view, and no snapshot, until one is configured", () => {
    // A stream built without `view` carries no method: the type says so, and the value agrees.
    expect("snapshot" in stream()).toBe(false);
    expect(viewed("shared").snapshot()).toEqual({ ok: true, value: undefined });
  });

  it("names the root, its finality and the point still being written", () => {
    const sp = viewed("owned");
    void Array.from(sp.feed('{"a":{"b":"par'));
    expect(seen(sp)).toEqual({
      value: { a: { b: "par" } },
      valueIndex: 0,
      complete: false,
      cut: { path: ["a", "b"], kind: "string" },
    });
    // A string arriving into an array is at the index it will occupy.
    const list = viewed("owned");
    void Array.from(list.feed('{"a":[1,"tw'));
    expect(seen(list).cut).toEqual({ path: ["a", 1], kind: "string" });
    // No token in flight: the deepest open container is where the cursor goes.
    void Array.from(list.feed('o",'));
    expect(seen(list).cut).toEqual({ path: ["a"], kind: "between" });
    // A number still arriving is held back, so its item is missing and its digits are the text.
    void Array.from(list.feed(" 12"));
    expect(seen(list).cut).toEqual({ path: ["a", 2], kind: "missing", text: "12" });
    // A finished root stays viewable, complete, until the next one begins.
    void Array.from(sp.feed('t"}}'));
    expect(seen(sp)).toEqual({ value: { a: { b: "part" } }, valueIndex: 0, complete: true });
    void Array.from(sp.feed(' ["ne'));
    expect(seen(sp)).toMatchObject({ value: ["ne"], valueIndex: 1, complete: false });
    // Ended by the source inside the string: the delivered root is final, and still cut.
    void Array.from(sp.end());
    expect(seen(sp)).toEqual({
      value: ["ne"],
      valueIndex: 1,
      complete: false,
      cut: { path: [0], kind: "string" },
    });
  });

  it("fails the view of a refused or stopped root, with the view as recovery", () => {
    // Under STRICT the first refusal stops the scan with the root still open, so the view is what
    // was read before it: an empty object, and the refusal standing against it.
    const refused = viewed("owned", STRICT);
    void Array.from(refused.feed("{a:1}"));
    expect(refused.snapshot()).toMatchObject({
      ok: false,
      failure: { kind: "policy-refused", recovered: { value: {} } },
    });
    const stopped = viewed("shared", { maxDepth: 2 });
    void Array.from(stopped.feed('{"a":[[1'));
    expect(stopped.snapshot()).toMatchObject({
      ok: false,
      failure: { kind: "limit-reached", resource: "depth", recovered: { value: { a: [[]] } } },
    });
  });

  it("preserves null prototypes and pending dangerous keys", () => {
    for (const snapshot of both('{"__proto__":"val', { nullPrototype: true })) {
      expect(Object.getPrototypeOf(snapshot)).toBeNull();
      expect(Object.hasOwn(snapshot as object, "__proto__")).toBe(true);
      expect((snapshot as Record<string, unknown>).__proto__).toBe("val");
    }
  });

  it("gives the owned view an owner who may modify it", () => {
    const sp = viewed("owned");
    void Array.from(sp.feed('{"a":[1,'));
    const mine = view(sp) as { a: number[] };
    mine.a.push(99);
    expect((view(sp) as { a: number[] }).a).toEqual([1]);
  });

  it("freezes every finished branch of a shared view, at every level", () => {
    // THREE levels, because two is exactly what an earlier version checked and exactly what the
    // implementation happened to do: it froze the direct children of each spine frame, so a
    // GRANDCHILD came back writable — and writing to it changed the parser's own tree, which the
    // write assertion here is what actually catches. Finished branches are SHARED with every later
    // snapshot, so they must be immutable.
    const sp = viewed("shared");
    void Array.from(sp.feed('{"a":{"b":{"c":1}},"open":['));
    const s = view(sp) as { a: { b: { c: number } }; open: unknown[]; extra?: number };
    expect(Object.isFrozen(s.a)).toBe(true);
    expect(Object.isFrozen(s.a.b)).toBe(true);
    expect(() => {
      s.a.b.c = 999;
    }).toThrow();
    // The open path is this snapshot's private copy and is NOT frozen (src/snapshot.ts explains the
    // ruling). Writing to it must still never reach the parser or a later snapshot.
    expect(Object.isFrozen(s)).toBe(false);
    expect(Object.isFrozen(s.open)).toBe(false);
    s.open.push("caller");
    s.extra = 1;
    void Array.from(sp.feed("2"));
    expect(view(sp)).toEqual({ a: { b: { c: 1 } }, open: [] });
    expect(values(drain(sp, "]}"))).toEqual([{ a: { b: { c: 1 } }, open: [2] }]);
  });

  it("hands back the same shared snapshot until the stream moves, and a fresh owned one each time", () => {
    // A reactive store compares snapshots by identity: React's useSyncExternalStore re-renders
    // forever when every call returns a new object.
    const shared = viewed("shared");
    void Array.from(shared.feed('{"a":[1,'));
    const first = shared.snapshot();
    expect(shared.snapshot()).toBe(first);
    void Array.from(shared.feed(" "));
    expect(shared.snapshot()).not.toBe(first);
    const owned = viewed("owned");
    void Array.from(owned.feed('{"a":[1,'));
    expect(owned.snapshot()).not.toBe(owned.snapshot());
  });

  it("copies a member named __proto__ as data under both prototype modes", () => {
    // The open path is copied by spread or Object.assign, which define own properties; a plain
    // assignment would call the __proto__ setter and replace the copy's prototype instead.
    for (const nullPrototype of [false, true]) {
      for (const text of ['{"__proto__":{"x":1},"open":[1,', '{"__proto__":[1,']) {
        const sp = viewed("shared", { nullPrototype });
        void Array.from(sp.feed(text));
        const s = view(sp) as Record<string, unknown>;
        expect(Object.getPrototypeOf(s)).toBe(nullPrototype ? null : Object.prototype);
        expect(Object.hasOwn(s, "__proto__")).toBe(true);
        expect(s["__proto__"]).toEqual(text.includes("x") ? { x: 1 } : [1]);
      }
    }
  });

  it("reports the same tree from both views, mid-parse", () => {
    /**
     * One parse cannot have two partial values. The views differ in COST and in who owns the
     * result, never in content — so this is the invariant that catches a spine copy which links,
     * drops or resurrects something the deep copy does not.
     *
     * The `reject` case is the one that found a real defect: an open container is placed through the
     * same path as any other value, so a refused parent leaves it on the spine labelled with a slot
     * the parent no longer has, and a copy that trusted the label re-added the refused member.
     */
    const cases: [string, ParserOptions][] = [
      ['{"a":{"b":{"c":1}},"d":[1,', {}],
      ['{"__proto__":1,"b":{"c":', { onDangerousKey: "reject" }],
      ['{"__proto__":1,"b":{"c":', { onDangerousKey: "drop" }],
      ["[[1,[2,[3,", {}],
      ['{"a":[{"b":[', {}],
    ];
    for (const [text, options] of cases) {
      const [owned, shared] = both(text, options);
      expect(owned, text).toEqual(shared);
    }
  });

  /**
   * A string past the lookahead window is no longer re-read from its opening quote on every chunk —
   * the scanner banks the part it has already decided. That banked part is where a wrong reading
   * would hide, and nothing about the resulting VALUE looks unusual, so the guard splits a
   * lookahead-hostile document at every offset and demands the one-shot answer.
   */
  describe("a string resumed across a chunk boundary", () => {
    // Every reading that looks past the character it is deciding, packed together: a four-digit `\u`,
    // an escape JSON does not define, an apostrophe that must NOT close the string because a letter
    // follows it, and one that must because a separator does.
    const doc = String.raw`{"a":"pad é it's \d ok","b":"x','y","c":"tail","at":{"span":1},"span":2}`;
    const want = parse(doc, REPORT);

    it("agrees with the one-shot parse at every split point", () => {
      // Positions are the one legitimate difference — a stream names the chunk and counts inside
      // it — so they are removed before the whole item, report included, is compared: `dirty` and
      // `badEscape` are carried across the boundary, and they change what is REPORTED long before
      // they change what is returned.
      for (let cut = 1; cut < doc.length; cut++) {
        expect(
          drain(stream(REPORT), doc.slice(0, cut), doc.slice(cut)).map((i) => unplaced(i)),
          `cut at ${cut}`,
        ).toStrictEqual([unplaced(want)]);
      }
    });
  });

  /**
   * The string still arriving. Rendering text as the model types it is the headline reason a UI
   * parses partial JSON at all, and without this a snapshot and `end()` gave two different answers
   * about the same bytes — the emptier one to the caller who most needed the fuller.
   */
  describe("a string still being read", () => {
    const snap = (text: string): unknown => {
      const sp = viewed("owned", LLM_FULL);
      void Array.from(sp.feed(text));
      return sp.snapshot().ok ? view(sp) : undefined;
    };

    it.each<[string, unknown, string]>([
      ['{"key": "val', { key: "val" }, "at the root"],
      ['{"a":"x","b":"par', { a: "x", b: "par" }, "beside a finished member"],
      ['["one", "tw', ["one", "tw"], "appended to an array"],
      ['{"a": [1, "he', { a: [1, "he"] }, "inside a nested array"],
      ['{"a":{"b":{"c":"de', { a: { b: { c: "de" } } }, "three levels down"],
      ['["\\u00e9l', ["él"], "decoded, not the raw source"],
      ['["ab\\', ["ab"], "without the backslash of an escape still arriving"],
      ['["ab\\u0', ["ab"], "without the digits of a unicode escape still arriving"],
      ['["ab\\u00', ["ab"], "without a half escape that would read as source text"],
      ['["ab\\ud83d', ["ab"], "without a high surrogate whose partner may still arrive"],
    ])("shows %j as %j — %s", (text, want) => {
      expect(snap(text)).toEqual(want);
      // The two views must never disagree about one parse.
      const [owned, shared] = both(text, LLM_FULL);
      expect(owned).toEqual(shared);
    });

    it.each([
      ['{"a": 12', "a number prefix is a DIFFERENT number, not a partial one"],
      ['{"a": tr', "and a word prefix is no value at all"],
      ['{"ke', "a half-read key would name a member whose name then changes"],
      ['{"a":', "a key with no value yet is not a member"],
    ])("shows nothing for %j — %s", (text) => {
      expect(snap(text)).toEqual({});
    });

    it("cuts between members at a half-read key, short or long", () => {
      // A key read across chunks is banked like a value string, but it names no member yet: the
      // cut is `between`, with the key's text so far, never a `string` at the object's own path.
      for (const key of ["k", "information"]) {
        const sp = viewed("shared");
        for (const ch of `{"a":1,"${key}`) void Array.from(sp.feed(ch));
        expect(seen(sp).cut, key).toEqual({ path: [], kind: "between", text: `"${key}` });
      }
    });

    it("shows a top-level string too, but never a quote inside prose", () => {
      // A root string counts only where it stands alone — at the start, or filling a fence — so the
      // view shows exactly what `end()` would return now, and a quote in a sentence is no data.
      // Prose AFTER the closing quote (`"top" today`) can still retract it, as it retracts a root
      // `[1` shown the same way: a view is provisional, which `complete: false` says. Hiding the
      // string instead gave the view and `end()` two answers about the same bytes.
      expect(snap('"hello wor')).toBe("hello wor");
      expect(snap('```json\n"ab')).toBe("ab");
      for (const prose of ['see "abc', 'Sure: "abc', '[1] "abc', '"abc" "de']) {
        expect(snap(prose), prose).toBeUndefined();
      }
      const [owned, shared] = both('"hello wor', LLM_FULL);
      expect(owned).toEqual(shared);
      // A finished root held to see what follows stays in view: `end()` would return it now, and
      // hiding it made the data vanish at the moment it closed. Under `select` too.
      for (const [text, value] of [
        ['"top"', "top"],
        ["[1]", [1]],
        ["42 ", 42],
      ] as const) {
        const sp = viewed("shared");
        void Array.from(sp.feed(text));
        expect(view(sp), text).toEqual(value);
      }
      const selected = stream({ select: select([[0]]), view: sharedView });
      void Array.from(selected.feed("[1]"));
      const matched = selected.snapshot();
      expect(matched.ok && matched.value?.value.map((m) => [m.value, m.path])).toEqual([[1, [0]]]);
      // Retraction: prose after the closing quote withdraws the string, as the whole parse does.
      const retracted = viewed("shared");
      void Array.from(retracted.feed('"top"'));
      expect(view(retracted)).toBe("top");
      void Array.from(retracted.feed(" today"));
      expect(view(retracted)).toBeUndefined();
      expect(parse('"top" today').ok).toBe(false);
      const sp = stream({ select: select([[]]), view: sharedView });
      void Array.from(sp.feed('"hel'));
      const r = sp.snapshot();
      expect(r.ok && r.value?.value.map((m) => [m.value, m.path])).toEqual([["hel", []]]);
    });

    it("grows one character at a time and places the finished string exactly once", () => {
      const sp = viewed("owned", LLM_FULL);
      const seenValues: unknown[] = [];
      const delivered: unknown[] = [];
      for (const ch of '{"m":"hi"}') {
        delivered.push(...values(sp.feed(ch)));
        const r = sp.snapshot();
        seenValues.push(r.ok ? r.value?.value : undefined);
      }
      expect(seenValues).toContainEqual({ m: "h" });
      expect(seenValues).toContainEqual({ m: "hi" });
      // The graft goes onto the COPY. Landing in the live tree would place the string twice.
      expect([...delivered, ...values(sp.end())]).toEqual([{ m: "hi" }]);
    });

    it("grafts onto the copy, never into the parser's own tree", () => {
      const sp = viewed("shared", LLM_FULL);
      void Array.from(sp.feed('{"a":{"b":"par'));
      const held = view(sp) as { a: { b: string } };
      expect(held.a.b).toBe("par");
      // The handed-out copy must not move under the caller, a caller's write to it must not reach
      // the parser, and the parse must complete normally.
      held.a.b = "caller";
      expect(values(drain(sp, 't"}'))).toEqual([{ a: { b: "part" } }]);
      expect(held.a.b).toBe("caller");
    });

    it("does not graft into a container the key policy refused", () => {
      // The refused container stays on the spine with a label naming a slot its parent no longer
      // has, so a graft that trusted the label would reintroduce a member the policy removed — and
      // the two views would then disagree about one parse.
      const [owned, shared] = both('{"__proto__":{"a":"par', {
        ...LLM_FULL,
        onDangerousKey: "reject",
      });
      expect(owned).toEqual(shared);
      // Own keys and prototype, never `JSON.stringify`: a graft through `__proto__` would land on
      // the prototype, where serialisation cannot see it.
      expect(Reflect.ownKeys(owned as object)).toEqual([]);
      expect(Object.getPrototypeOf(owned)).toBe(Object.prototype);
    });

    it("never grafts a pending value onto the prototype through a removed dangerous key", () => {
      // The snapshot walked its own path with plain reads, so `copy["__proto__"]` answered with
      // `Object.prototype` exactly when the policy had REMOVED the member — and the string still
      // arriving was then defined on it. The safest-sounding policies were the vulnerable ones;
      // `keep` was never affected, because a kept member is a real own slot to graft into.
      //
      // A per-file-isolated runner cannot see this: the damage is global and outlives the test.
      // Assert the global directly, over the whole policy and view matrix rather than the one
      // combination that happened to break.
      for (const onDangerousKey of ["reject", "drop", "keep"] as const) {
        for (const mode of ["owned", "shared"] as const) {
          const sp = viewed(mode, { ...LLM_FULL, onDangerousKey });
          void Array.from(sp.feed('{"__proto__":{"probe":"par'));
          sp.snapshot();
          expect(Object.hasOwn(Object.prototype, "probe")).toBe(false);
          expect("probe" in {}).toBe(false);
        }
      }
    });
  });

  it("keeps parsing after a shared view, into containers it must not have frozen", () => {
    // Freezing on close is one wrong line away from freezing the OPEN container the scanner is
    // filling, which would make the next feed throw. Feeding across the snapshot is the only thing
    // that catches it, and every other case here stops at the snapshot.
    const sp = viewed("shared");
    void Array.from(sp.feed('{"a":[1,'));
    view(sp);
    expect(values(drain(sp, '2],"b":{"c":3}}'))).toEqual([{ a: [1, 2], b: { c: 3 } }]);
  });

  it("shares finished branches and copies only the spine", () => {
    // This is the whole reason the shared view exists: finished branches are shared, not copied. A deep copy would
    // pass every other assertion here and fail this one.
    const sp = viewed("shared");
    void Array.from(sp.feed('{"done":{"x":1},"open":[1,'));
    const first = view(sp) as { done: object };
    void Array.from(sp.feed(" "));
    const second = view(sp) as { done: object };
    expect(first.done).toBe(second.done);
    expect(first).not.toBe(second);
    // Every value a shared-view stream delivers is one of those frozen branches.
    const [item] = drain(sp, "2]}");
    expect(item?.ok === true && Object.isFrozen(item.value)).toBe(true);
  });

  it("does not mutate a snapshot already handed out", () => {
    // The case that makes freeze-on-close load-bearing: the parser keeps writing after the handover.
    const sp = viewed("shared");
    void Array.from(sp.feed('{"a":[1,'));
    const held = view(sp);
    expect(values(drain(sp, '2],"b":9}'))).toEqual([{ a: [1, 2], b: 9 }]);
    expect(held).toEqual({ a: [1] });
  });
});

describe("drains own the stream", () => {
  it("keeps queued values in order while feeds and old drains interleave", () => {
    const sp = stream();
    void sp.feed(Array.from({ length: 20 }, (_, a) => `{"a":${a}} `).join(""));
    const pending = sp.feed('{"a":20} ');
    for (let a = 0; a < 20; a++) {
      expect(pending.next().value).toMatchObject({ ok: true, value: { a } });
      void sp.feed(`{"a":${a + 21}} `);
    }
    expect(values(sp.end())).toEqual(Array.from({ length: 21 }, (_, a) => ({ a: a + 20 })));
  });

  it("scans as the drain is pulled, not when the chunk is handed over", () => {
    // One root per pull keeps the work a reader triggers bounded. An unread drain is settled only
    // when the stream next has to move: by `feed`, `end` or `snapshot`.
    const sp = stream({ view: ownedView });
    // Each root is followed by a character, which settles it: a touching comma would start a list.
    const pending = sp.feed('{"a":1} {"b":2} ');
    expect(pending.next().value).toMatchObject({ ok: true, value: { a: 1 } });
    expect(sp.snapshot()).toMatchObject({ ok: true, value: { value: { b: 2 }, complete: true } });
    expect(values(pending)).toEqual([{ b: 2 }]);
  });

  it("delivers the values of an unread feed() first, in the next iteration, exactly once", () => {
    // The HLD rule: skipping the iterator of one feed() must never lose its values or its chunk.
    const sp = stream();
    void sp.feed('{"a":1} {"b":');
    expect(values(sp.feed("2} "))).toEqual([{ a: 1 }, { b: 2 }]);
    void sp.feed('{"c":3} {"d":4}');
    expect(values(sp.end())).toEqual([{ c: 3 }, { d: 4 }]);
    expect([...sp.end()]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
  });

  it("delivers the rest of a half-read feed() exactly once", () => {
    const sp = stream();
    const first = sp.feed('{"a":1} {"b":2} {"c":3}');
    expect(first.next().value).toMatchObject({ ok: true, value: { a: 1 } });
    expect(values(sp.feed('{"d":4} '))).toEqual([{ b: 2 }, { c: 3 }, { d: 4 }]);
    expect(values(first)).toEqual([]);
  });

  it("shows the current value to snapshot() after an unread feed()", () => {
    const sp = stream({ view: ownedView });
    void sp.feed('{"a":1} {"b":"x');
    expect(sp.snapshot()).toMatchObject({
      ok: true,
      value: { value: { b: "x" }, valueIndex: 1, complete: false },
    });
    expect(values(sp.end())).toEqual([{ a: 1 }, { b: "x" }]);
  });

  it("fails with a typed reason, after every unread value, when unread values pass maxRetained", () => {
    // A view-only caller over endless NDJSON never reads feed(). Holding its values without a
    // bound would grow forever; dropping them would lose data. The stream stops instead, delivers
    // everything it held, and names the unread-results bound.
    const sp = stream({ maxRetained: 64 });
    for (let i = 0; i < 20; i++) void sp.feed(`{"k":"${String(i).padStart(10, "0")}"}\n`);
    const items = [...sp.end()];
    const last = items.at(-1);
    expect(last).toEqual({
      ok: false,
      failure: { kind: "limit-reached", resource: "unread", limit: 64 },
    });
    const delivered = values(items.slice(0, -1));
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered).toEqual(delivered.map((_v, i) => ({ k: String(i).padStart(10, "0") })));
    expect([...sp.end()]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
  });

  it.each(["x", "\\n", "\\u0061", "\\q"])(
    "bounds decoded string retention across chunk sizes: %s",
    (spelling) => {
      const source = '{"a":1,"b":"' + spelling.repeat(8192);
      let expected: unknown;
      for (const width of [1, 7, source.length]) {
        const sp = stream({ view: ownedView, maxRetained: 16, maxBuffer: 128 });
        let stopped = false;
        for (let at = 0; at < source.length && !stopped; at += width)
          for (const item of sp.feed(source.slice(at, at + width)))
            if ("ok" in item && !item.ok) stopped = true;
        expect(stopped).toBe(true);
        const snapshot = sp.snapshot();
        expect(snapshot).toMatchObject({
          ok: false,
          failure: { kind: "limit-reached", resource: "retained", limit: 16 },
        });
        if (!snapshot.ok && snapshot.failure.kind === "limit-reached") {
          const recovered = snapshot.failure.recovered?.value as { a: number; b: string };
          expect(recovered.a).toBe(1);
          expect(recovered.b.length).toBeLessThanOrEqual(16);
          const position = snapshot.failure.at;
          const observation = {
            at:
              position === undefined ? undefined : position.offset + (position.chunk ?? 0) * width,
            value: recovered,
          };
          if (expected === undefined) expected = observation;
          else expect(observation).toEqual(expected);
        }
        sp.close();
      }
    },
  );

  it.each(["x", "\\u0061", "\\uZZZZ", "\\uD83D\\uDE00"])(
    "bounds quoted keys before retaining a caller-sized chunk: %s",
    (spelling) => {
      const source = '{"a":1,"' + spelling.repeat(8192) + '":2}';
      let expected: unknown;
      for (const width of [1, 7, source.length]) {
        const sp = stream({ view: ownedView, maxRetained: 16, maxBuffer: 128 });
        let stopped = false;
        for (let offset = 0; offset < source.length && !stopped; offset += width)
          for (const item of sp.feed(source.slice(offset, offset + width)))
            if ("ok" in item && !item.ok) stopped = true;
        const snapshot = sp.snapshot();
        expect(snapshot).toMatchObject({
          ok: false,
          failure: {
            kind: "limit-reached",
            resource: "retained",
            recovered: { value: { a: 1 }, cut: { kind: "between" } },
          },
        });
        if (!snapshot.ok && snapshot.failure.kind === "limit-reached") {
          // Cut keys use JSON spelling, whose escapes can be longer than their decoded units.
          const keyPrefix: unknown = JSON.parse(
            (snapshot.failure.recovered?.cut?.text ?? '"') + '"',
          );
          expect(typeof keyPrefix).toBe("string");
          if (typeof keyPrefix === "string") expect(keyPrefix.length).toBeLessThanOrEqual(13);
          const position = snapshot.failure.at;
          const observation = {
            at:
              position === undefined ? undefined : position.offset + (position.chunk ?? 0) * width,
            cut: snapshot.failure.recovered?.cut,
          };
          if (expected === undefined) expected = observation;
          else expect(observation).toEqual(expected);
        }
        sp.close();
      }
    },
  );

  it.each(["plain", "final", "occurrences"] as const)(
    "attaches stopped string recovery without publishing a successful prefix: %s",
    (route) => {
      const sp = stream({
        select:
          route === "plain"
            ? false
            : select([["a"], ["b"]], { occurrences: route === "occurrences" }),
        maxRetained: 16,
        maxBuffer: 128,
      });
      const items = [...sp.feed('{"a":1,"b":"' + "x".repeat(8192))];
      const failures = items.filter((item) => "ok" in item && !item.ok);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        ok: false,
        failure: {
          kind: "limit-reached",
          resource: "retained",
          recovered: {
            value:
              route === "plain"
                ? { a: 1, b: "x".repeat(12) }
                : route === "final"
                  ? [
                      { value: 1, path: ["a"] },
                      { value: "x".repeat(15), path: ["b"] },
                    ]
                  : [{ value: "x".repeat(16), path: ["b"] }],
            complete: false,
            cut: { kind: "string", path: ["b"] },
          },
        },
      });
      expect(items.filter((item) => "ok" in item && item.ok)).toHaveLength(
        route === "occurrences" ? 1 : 0,
      );
      sp.close();
    },
  );

  it.each(["2", "word", "0x2"])(
    "bounds pending bare-token storage across chunk sizes: %s",
    (token) => {
      for (const selected of [false, true]) {
        const head = '{"a":1,"b":';
        const source = head + (token === "0x2" ? "0x" + "2".repeat(8192) : token.repeat(8192));
        let expected: unknown;
        for (const width of [1, 7, source.length]) {
          const sp = stream({
            select: selected ? select([["a"]]) : false,
            view: ownedView,
            maxRetained: 16,
            maxBuffer: 128,
          });
          const items = [...sp.feed(source.slice(0, width))];
          for (
            let offset = width;
            offset < source.length && !items.some((item) => "ok" in item && !item.ok);
            offset += width
          )
            for (const item of sp.feed(source.slice(offset, offset + width))) items.push(item);
          const snapshot = sp.snapshot();
          expect(snapshot).toMatchObject({
            ok: false,
            failure: {
              kind: "limit-reached",
              resource: "retained",
              recovered: { cut: { path: ["b"], kind: "missing" } },
            },
          });
          if (!snapshot.ok && snapshot.failure.kind === "limit-reached") {
            const cut = snapshot.failure.recovered?.cut;
            expect(cut?.text).toBe(source.slice(head.length, head.length + (selected ? 15 : 12)));
            const position = snapshot.failure.at;
            const observation = {
              at:
                position === undefined
                  ? undefined
                  : position.offset + (position.chunk ?? 0) * width,
              cut,
            };
            if (expected === undefined) expected = observation;
            else expect(observation).toEqual(expected);
          }
          sp.close();
        }
      }
    },
  );

  it("charges an unfinished word or number to maxRetained, as it does a string", () => {
    // A token still being read keeps the text the buffer releases in its own parts, out of
    // `maxBuffer`'s sight, exactly as a long string's banked prefix is. Uncharged, one endless
    // token grew without limit while the stream reported nothing.
    for (const [head, more] of [
      ['{"k" word', " word"],
      ["[1, 2", "3"],
    ] as const) {
      const sp = stream({ maxBuffer: 4096 });
      let failure: unknown;
      for (const text of [head, ...Array.from({ length: 30 }, () => more.repeat(200))])
        for (const item of sp.feed(text)) if (!item.ok) failure ??= item.failure;
      expect(failure, head).toMatchObject({
        kind: "limit-reached",
        resource: "retained",
        limit: 4096,
      });
    }
  });

  it("closes the stream when a drain is left early", () => {
    const sp = stream();
    for (const item of sp.feed('{"a":1} {"b":2}')) {
      expect(item).toMatchObject({ ok: true, value: { a: 1 } });
      break;
    }
    expect([...sp.end()]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
  });

  it("close() is idempotent, releases the input and needs no cleanup of its own", () => {
    const sp = stream();
    void Array.from(sp.feed('{"a":[1,'));
    expect(sp.close()).toEqual({ ok: true, value: undefined });
    expect(sp.close()).toEqual({ ok: true, value: undefined });
    expect([...sp.feed("2]}")]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
    expect([...sp.end()]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
  });

  it("discards abandoned deliveries and preserves the first explicit close result", () => {
    const sp = createStreamParser();
    sp.feed('{"a":1} {"b":2}');
    const deliveries = sp.feed('{"c":3}');
    expect(deliveries.next()).toMatchObject({ value: { ok: true, value: { a: 1 } } });
    const first = sp.close();
    expect(sp.close()).toBe(first);
    expect(deliveries.next()).toEqual({ done: true, value: undefined });
    expect([...sp.end()]).toMatchObject([{ ok: false, failure: { kind: "stream-closed" } }]);
  });

  it("keeps the view after close(), so an abandoned stream is still readable", () => {
    // A caller who leaves early — a timeout, a user navigating away — still wants what arrived.
    // Nothing about closing invalidates the recorded root, and refusing would lose data for nothing.
    const sp = createStreamParser({ view: sharedView });
    void Array.from(sp.feed('{"a":1,"b":"he'));
    const open = sp.snapshot();
    sp.close();
    expect(sp.snapshot()).toEqual(open);
    expect([...sp.feed("llo")]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
  });

  it("stops a drain that is open when close() is called", () => {
    const sp = stream();
    const pending = sp.feed('{"a":1} {"b":2}');
    expect(pending.next().value).toMatchObject({ ok: true, value: { a: 1 } });
    sp.close();
    expect(values(pending)).toEqual([]);
  });

  it.each([false, true])(
    "keeps independent owned views after disposal, selected=%s",
    (selected) => {
      const sp = createStreamParser({
        view: ownedView,
        select: selected ? select([["a"]]) : false,
      });
      Array.from(sp.feed('{"a":{"items":[1,2],"tail":"prefix'));
      const before = sp.snapshot();
      sp.close();
      const first = sp.snapshot();
      expect(first).toEqual(before);
      if (first.ok && first.value !== undefined) {
        const value: unknown = first.value.value;
        if (Array.isArray(value)) value.length = 0;
        else if (typeof value === "object" && value !== null)
          Object.assign(value, { a: "changed" });
      }
      expect(sp.snapshot()).toEqual(before);
      expect(sp.snapshot()).not.toBe(first);
    },
  );

  it.each([
    ["shared", false],
    ["shared", true],
    ["owned", false],
    ["owned", true],
  ] as const)(
    "preserves a stopped %s view and its queued summary, selected=%s",
    (snapshotMode, selected) => {
      const sp = createStreamParser({
        view: snapshotMode === "owned" ? ownedView : sharedView,
        select: selected ? select([["a"], ["b"]]) : false,
        maxRetained: 16,
        maxBuffer: 128,
        summary: true,
      });
      const pending = sp.feed('{"a":1,"b":"body\',' + "x".repeat(64));
      expect(pending.next().value).toMatchObject({
        ok: false,
        failure: { kind: "limit-reached", resource: "retained" },
      });
      const before = sp.snapshot();
      expect(before).toMatchObject({
        ok: false,
        failure: {
          kind: "limit-reached",
          recovered: {
            value: selected
              ? [
                  { value: 1, path: ["a"] },
                  { value: "body'," + "x".repeat(9), path: ["b"] },
                ]
              : { a: 1, b: "body'," + "x".repeat(6) },
            complete: false,
            cut: { path: ["b"], kind: "string" },
          },
        },
      });
      expect(pending.next().value).toMatchObject({ kind: "summary", complete: false, roots: 1 });
      expect(pending.next().done).toBe(true);
      expect([...sp.end()]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
      expect(sp.close()).toEqual({ ok: true, value: undefined });
      expect(sp.snapshot()).toEqual(before);
      const first = sp.snapshot();
      if (snapshotMode === "owned" && !first.ok && first.failure.kind === "limit-reached") {
        const value = first.failure.recovered?.value;
        if (Array.isArray(value)) value.length = 0;
        else if (typeof value === "object" && value !== null)
          Object.assign(value, { a: "changed" });
        expect(sp.snapshot()).toEqual(before);
        expect(sp.snapshot()).not.toBe(first);
      } else expect(sp.snapshot()).toBe(first);
    },
  );

  describe("summary", () => {
    it("follows the tail: every recognised root counted, the source examined in full", () => {
      // `[1,2` and not `[1,`: after another root a bracket needs a mark of data to be a candidate.
      const sp = stream({ summary: true });
      expect(summaries(sp.feed('{"a":1} [1,2'))).toEqual([]);
      expect([...sp.end()]).toEqual([
        { ok: true, value: [1, 2], complete: false, cut: { path: [1], kind: "number" } },
        { kind: "summary", complete: true, roots: 2, matches: 0, unmatched: [] },
      ]);
    });

    it("counts a refused root and one a bound cut short, and says the source was not all read", () => {
      // STRICT stops the scan at the first refusal, so the source past it was never examined.
      const refused = stream({ ...STRICT, summary: true });
      expect([...refused.feed("{a:1} "), ...refused.end()].filter((i) => "kind" in i)).toEqual([
        { kind: "summary", complete: false, roots: 1, matches: 0, unmatched: [] },
      ]);
      // A depth bound fails ONE root and the stream goes on; a buffer bound ends the stream.
      const deep = stream({ maxDepth: 1, summary: true });
      expect([...deep.feed('{"a":1} {"b":[1]} {"c":2}'), ...deep.end()]).toMatchObject([
        { ok: true, value: { a: 1 } },
        { ok: false, failure: { kind: "limit-reached", resource: "depth" } },
        { ok: true, value: { c: 2 } },
        { kind: "summary", complete: true, roots: 3, matches: 0, unmatched: [] },
      ]);
      // A held fence opener is the one thing the window must retain, so it is what trips the bound.
      const stopped = stream({ maxBuffer: 1, summary: true });
      expect([...stopped.feed("```")]).toMatchObject([
        { ok: false, failure: { kind: "limit-reached", resource: "buffer" } },
        { kind: "summary", complete: false, roots: 0, matches: 0, unmatched: [] },
      ]);
    });

    it("is written even when nothing was found, and never after a drain was left", () => {
      const empty = stream({ summary: true });
      expect([...empty.end()]).toEqual([
        { ok: false, failure: { kind: "no-json-found" } },
        { kind: "summary", complete: true, roots: 0, matches: 0, unmatched: [] },
      ]);
      const left = stream({ summary: true });
      for (const _ of left.feed('{"a":1} {"b":2}')) break;
      expect([...left.end()]).toEqual([{ ok: false, failure: { kind: "stream-closed" } }]);
    });
  });
});

describe("repair", () => {
  const CORPUS = ["corpus.jsonl", "seeds.jsonl"]
    .flatMap((file) =>
      readFileSync(new URL(`../corpus/${file}`, import.meta.url), "utf8").split("\n"),
    )
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((r) => r["text"])
    .filter((t): t is string => typeof t === "string");

  it("returns a value that needed no repair byte-identical", () => {
    for (const src of ['{"a":1}', "[1,2,3]", '{"a":1.50,"b":[true,null]}', '{ "x" : "y" }']) {
      expect(repairText(src), src).toBe(src);
    }
    // The VALUE, on every path: whitespace around it is outside the value like any other prose,
    // and the fast path must cut it the same way the scanner does or one text gets two answers.
    expect(repairText('  {"x":"y"}  ')).toBe('{"x":"y"}');
  });

  it("returns the candidate's coordinates and report with the repaired text", () => {
    const result = repair("prefix {'a':1,} suffix", { locations, ...REPORT });
    expect(result).toMatchObject({
      ok: true,
      value: '{"a":1}',
      span: { start: { offset: 7, unit: "utf16" }, end: { offset: 15, unit: "utf16" } },
    });
    expect(result.diagnostics.repairs.map((entry) => entry.kind)).toEqual([
      "single-quote",
      "trailing-comma",
    ]);
  });

  it("returns a typed failure when text holds no candidate", () => {
    for (const src of ["we found 3 of 7 items", "", "no json here at all"]) {
      expect(repair(src), src).toEqual({ ok: false, failure: { kind: "no-json-found" } });
    }
  });

  it.each([
    ["undefined", "undefined", undefined],
    ["NaN", "nan", NaN],
    ["Infinity", "infinity", Infinity],
    ["-Infinity", "infinity", -Infinity],
  ] as const)("writes the root value %s as a reported null", (src, _kind, value) => {
    for (const options of [
      COMPAT,
      { ...COMPAT, allowJavaScript: false, recover: { "js-literal": true } },
    ]) {
      expect(parse(src, options)).toMatchObject({ ok: true, value });
      const result = repair(src, { ...options, ...REPORT });
      expect(result).toMatchObject({ ok: true, value: "null", complete: true });
      expect(result.diagnostics?.repairs.map((entry) => [entry.kind, entry.path])).toEqual([
        ["js-literal", []],
      ]);
    }
  });

  it.each([false, true])(
    "writes a cut selection's NaN as null beside its neighbour with reports %s",
    (report) => {
      const input = '{"bad":NaN,"good":[1,';
      const options = {
        ...COMPAT,
        allowJavaScript: false,
        recover: { "js-literal": true },
        select: select([["bad"], ["good"]]),
        diagnostics: report ? diagnostics : false,
      } as const;
      const expected = parse(input, options);
      expect(expected).toMatchObject({ ok: true, complete: false });
      if (!expected.ok) throw new Error("recovery control failed");
      const attempt = repair(input, options);
      expect(attempt).toMatchObject({ ok: true, complete: false, cut: expected.cut });
      if (!attempt.ok) throw new Error("repair refused recoverable selection");
      expect(attempt.value.map((match) => [match.path, match.value])).toEqual([
        [["bad"], "null"],
        [["good"], "[1]"],
      ]);
      if (report) expect(attempt.diagnostics).toEqual(expected.diagnostics);
    },
  );

  it.each(["undefined", "NaN", "Infinity"])(
    "writes %s as null at its source path in a later selected value",
    (literal) => {
      const input = `{"rows":[{"payload":[1]},{"payload":[2,${literal},3]}]}`;
      const options = {
        ...COMPAT,
        ...REPORT,
        select: select([
          ["rows", 0, "payload"],
          ["rows", 1, "payload"],
        ]),
      };
      const result = repair(input, options);
      expect(result).toMatchObject({ ok: true, complete: true });
      if (!result.ok) throw new Error("repair refused recoverable selection");
      expect(result.value.map((match) => match.value)).toEqual(["[1]", "[2,null,3]"]);
      expect(result.diagnostics.repairs.map((entry) => [entry.kind, entry.path])).toEqual([
        ["js-literal", ["rows", 1, "payload", 1]],
      ]);
    },
  );

  it("keeps key order and number formatting a repair did not touch", () => {
    // The reason this splices rather than re-serialising: `JSON.stringify` of the parsed tree
    // returns 1.5, reorders nothing here but would elsewhere, and drops the surrounding prose.
    expect(repairText('{"z":1.50,"a":2,}')).toBe('{"z":1.50,"a":2}');
  });

  it.each([
    ['{"__proto__":1,"keep":2,}', { keep: 2 }, undefined],
    ['{"keep":1,"__proto__":{"nested":2},"after":3,}', { keep: 1, after: 3 }, undefined],
    ['{"keep":1,"\\u005f\\u005fproto__":2,}', { keep: 1 }, undefined],
    ['{"keep":1,"secret":2}', { keep: 1 }, ["secret"]],
  ])("removes a dropped dangerous member from %s", (source, expected, customDangerousKeys) => {
    const repaired = repairText(source, {
      onDangerousKey: "drop",
      ...(customDangerousKeys === undefined ? {} : { customDangerousKeys }),
    });
    expect(JSON.parse(repaired) as unknown).toEqual(expected);
  });

  it.each([
    ["a/b", '{"a\\/b":1,"c":2}'],
    ['a"b', '{"a\\"b":1,"c":2}'],
    ["a\nb", '{"a\\nb":1,"c":2}'],
  ])("governs custom key %j spelled with an escape on clean JSON", (key, source) => {
    // Clean text goes to `JSON.parse`, which honours no key policy: the route must decline any text
    // where an escape could spell a governed key, not only `\u`.
    const custom = { customDangerousKeys: [key] };
    expect(parse(source, { ...custom, onDangerousKey: "drop" })).toMatchObject({ value: { c: 2 } });
    expect(parse(source, { ...custom, onDangerousKey: "reject" })).toMatchObject({ ok: false });
    expect(
      JSON.parse(repairText(source, { ...custom, onDangerousKey: "drop" })) as unknown,
    ).toEqual({
      c: 2,
    });
  });

  /**
   * One case per root cause found by running the alternatives' own test inputs through this
   * package's invariants (`bench/prior-art/harvest.ts`). The corpus contained none of these shapes,
   * so nothing here was reachable from the recorded contract — which is precisely why they are
   * written down: each pins a distinct mechanism that produced text no strict parser accepts.
   *
   * The expected strings are OUR contract, not the alternatives'. Their assertions encode their
   * own semantics and several of them disagree with rulings this package has taken.
   */
  it.each([
    [
      '```json\n{"a":"b"}\n```',
      '{"a":"b"}',
      "a fenced block: the fences are not part of the value",
    ],
    ['text {"a":1} more', '{"a":1}', "prose on both sides"],
    ['[{"b":2]', '[{"b":2}]', "a closer of the wrong shape still closes"],
    ['{"a":2,]', '{"a":2}', "a wrong-shaped closer must not be read as the start of a key"],
    ["[2,}", "[2]", "a stray character inside a container leaves the text too"],
    ["[1,2,3,", "[1,2,3]", "a comma the input never followed"],
    ["[2.]", "[2]", "JSON needs a digit on each side of the point"],
    ["-.3", "-0.3", "and on the other side of it"],
    [
      "[https://example.test/]",
      '["https://example.test/"]',
      "a colon inside an array is an ordinary character",
    ],
    [
      '{"name":"John","age":unknown',
      '{"name":"John","age":"unknown"}',
      "a word spanning feed and end remains a value",
    ],
  ])("repairs %j to %j — %s", (src, expected) => {
    expect(repairText(src)).toBe(expected);
  });

  // Every dangerous-key disposition, because only `keep` leaves the text alone. `drop` deletes a
  // whole member and `reject` empties an object, and a deletion is the one edit that can CONTAIN
  // another: MEASURED under the default `keep` alone, `{"__proto__":[1,2,],"ok":2}` repaired to
  // `{],"ok"` and reported success, the trailing-comma edit inside the deleted span having made two
  // splices overlap. A default-only property cannot see a policy the default never selects.
  it.each(["keep", "drop", "reject"] as const)(
    "produces text that re-parses to the same value, over every corpus input (%s)",
    (onDangerousKey) => {
      // The property no hand-written case set reaches: hundreds of recorded inputs, each one a shape
      // some model actually emitted. A splice that overlaps, or lands at the wrong offset, or orders
      // two closers wrongly, breaks this on inputs nobody would think to write down.
      let checked = 0;
      for (const src of CORPUS) {
        const before = parse(src, { onDangerousKey });
        if (!before.ok) continue;
        // `repair` fails exactly when `parse` fails: it writes the same candidate as text, and a value
        // JSON cannot spell becomes `null` rather than a refusal of the whole document.
        const attempt = repair(src, { onDangerousKey });
        expect(attempt.ok, src).toBe(true);
        if (!attempt.ok) continue;
        // The repair reports the source's completion; the repaired text itself is finished JSON.
        expect(attempt.complete, src).toBe(before.complete);
        expect(attempt.cut, src).toEqual(before.cut);
        expect(attempt.more, src).toBe(before.more);
        const repaired = attempt.value;
        // The repaired text holds only the returned value, so nothing follows it.
        expect(parse(repaired, { onDangerousKey }), src).toEqual({
          ...before,
          value: writtenAsJson(before.value),
          complete: true,
          cut: undefined,
          more: undefined,
        });
        // ...and the WHOLE of it must be REAL JSON now, not merely something this parser still
        // accepts. Emphatically not `JSON.parse(repaired.slice(findJsonSpan(repaired)))`: that was
        // the assertion here until a harvest of the alternatives' suites falsified it, and it cuts
        // away precisely the fences and prose it is supposed to convict. An instrument that locates
        // the JSON in its own subject before judging it can only ever report that JSON is JSON.
        expect(() => JSON.parse(repaired) as unknown, src).not.toThrow();
        checked++;
      }
      // A silently empty corpus would make every assertion above vacuous.
      expect(checked).toBeGreaterThan(0);
    },
  );
});

/**
 * Detection: is there JSON in this text at all. Conservative by contract, and separate from
 * recovery — see the design invariant in `AGENTS.md`. Each case here is one a permissive reading
 * gets WRONG, so a rule that stopped binding turns these red rather than leaving them vacuous.
 */
describe("brackets in prose are not JSON", () => {
  const NONE = { ok: false, failure: { kind: "no-json-found" } };

  it.each([
    ["see [1] for the citation", "a citation marker"],
    ["array notation is arr[i]", "an index expression"],
    ["Hello {name}, welcome", "a template placeholder"],
    ["The {x} and {y} placeholders", "two placeholders"],
    ["use {} for empty", "an empty pair named in prose"],
    ["malformed {", "a stray brace"],
    ["text {{a}} more", "a doubled placeholder"],
  ])("refuses %j — %s", (text) => {
    expect(parse(text)).toEqual(NONE);
    // `repair` is defined as "no candidate means unchanged", so it must agree rather than invent.
    expect(repair(text)).toEqual(NONE);
    expect(findJsonSpan(text)).toEqual(NONE);
  });

  it.each([
    ["here's the list: [1,2,3]", [1, 2, 3]],
    ['prose {"a":1} prose', { a: 1 }],
    ["JSON is written as {key: value} in JS", { key: "value" }],
    ["txt [[1,2,3]] txt", [[1, 2, 3]]],
    ["config: {'a': 1}", { a: 1 }],
  ])("still finds real data in %j", (text, want) => {
    expect(valueOf(parse(text))).toEqual(want);
  });

  it.each(["{}", "[]", "[1]", "  [1]  ", "{}\n"])(
    "keeps %j, which is valid JSON standing alone",
    (text) => {
      expect(parse(text)).toEqual({ ok: true, complete: true, value: JSON.parse(text) as unknown });
    },
  );

  it("keeps a trivial container that fills a fenced block", () => {
    expect(valueOf(parse("here you go:\n```json\n[1]\n```\n"))).toEqual([1]);
  });

  /**
   * `{{name}}` is Mustache, Handlebars, Jinja and Vue, and it arrives constantly in LLM output. It
   * is also not JSON under any reading: an object's first token must be `}` or a key, and no
   * leniency here makes a `{` into a key.
   *
   * That test is exact, and it is why this rule can be narrow. `[[` is ordinary valid JSON, so the
   * rule is about braces; a container opener where a KEY belongs is the whole condition.
   */
  it.each([
    ["{{invalid}}", "a template placeholder standing alone"],
    ["{{ user.name }}", "the spacing Handlebars actually writes"],
    ['{{"a":1}}', "a whole member inside does not rescue it: the outer brace has no key"],
    ["{[1,2]}", "an array cannot be a key either"],
    ['{ {"a":1} }', "nor a spaced-out object"],
  ])("refuses %j — %s", (text) => {
    const p = parser(LLM_FULL);
    expect(parse(text, p)).toEqual(NONE);
    expect(repair(text, p)).toEqual(NONE);
    // `findJsonSpan` uses the same candidate rule, so the three can never disagree about
    // whether a text holds a value.
    expect(findJsonSpan(text, p)).toEqual(NONE);
    expect([...parseMany(text, LLM_FULL)]).toEqual([NONE]);
  });

  it.each(["[[]]", "[[1]]", '[{"a":1}]', "[[[1]]]", "{}", '{"a":1}'])(
    "keeps %j, where a container in first position is legal JSON",
    (text) => {
      expect(valueOf(parse(text, LLM_FULL))).toEqual(JSON.parse(text) as unknown);
    },
  );

  it("keeps a document where an opener reaches key position only after members were placed", () => {
    // The rule is about the FIRST key. Once members exist, an opener where a key belongs is the
    // reader having landed with the wrong expectation, not a template — and treating it as one
    // retracts the whole candidate, so the repairs and errors explaining the mess go with it.
    //
    // Here the unquoted value `John Doe` splits, which shifts every later pair by one, so the `[`
    // of `tags:` five lines down arrives in key position. Recovering something mangled and saying
    // so beats `no-json-found` on a document that is plainly an object.
    const text = [
      "{",
      "  name: John Doe,",
      "  age: 30",
      '  email: "john@example.com"',
      "  tags: ['user', 'admin',]",
      "}",
    ].join("\n");
    const r = parse(text, { ...LLM_FULL, ...REPORT });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.repairs.length).toBeGreaterThan(0);
    expect(Object.values(valueOf(r) as Record<string, unknown>)).toContainEqual(["user", "admin"]);
  });

  it.each(["{{invalid}}", "{[1,2]}", '{{"a":1}}'])(
    "refuses %j under STRICT too, where a spent budget stops the scan early",
    (text) => {
      // A stopped scan cannot supply the MISSING marks of data, which is why they are exempt from
      // it. This mark is not missing — it was already seen — and reading further cannot unmake it.
      // Before this exemption the leniency budget made `STRICT` accept the text and return `{}`.
      expect(parse(text, STRICT)).toEqual(NONE);
    },
  );

  it("judges the candidate's own root, never a container nested inside one", () => {
    // Detection is conservative and looks at the whole text; once detection has said yes,
    // recovery is maximally forgiving. An unsubstituted placeholder deep inside real JSON must not
    // discard the members around it.
    expect(valueOf(parse('{"a": {{b}}, "id": 1}', LLM_FULL))).toHaveProperty("id", 1);
    // And the rule must not swallow a document that merely follows a placeholder. Both orders, and
    // adjacent as well as separated: the mark has to be cleared per candidate, not per text.
    expect(valueOf(parse('{{header}}\n{"a":1}', LLM_FULL))).toEqual({ a: 1 });
    expect(manyValues('{{b}}{"a":1}', LLM_FULL)).toEqual([{ a: 1 }]);
    expect(manyValues('{"a":1}{{b}}', LLM_FULL)).toEqual([{ a: 1 }]);
  });

  it("refuses a placeholder that fills a fenced block", () => {
    // The fence exemption and this rule both answer `judge`, and only their ORDER decides this
    // case: a fenced container is otherwise always a candidate. Fencing prose does not make it JSON.
    expect(parse("```json\n{{a}}\n```", LLM_FULL)).toEqual(NONE);
    expect(parse('```json\n{{"a":1}}\n```', LLM_FULL)).toEqual(NONE);
    // The exemption itself must survive, or this test would pass for the wrong reason.
    expect(valueOf(parse("```json\n{}\n```", LLM_FULL))).toEqual({});
  });

  it("answers the same whether the text arrives whole or in pieces", () => {
    // The standalone test needs the END of the text, which a stream cannot know yet — so the
    // scanner defers rather than guessing. Guessing would make these two disagree.
    for (const text of ["{}", "{} and prose", "{} ", "[1]", "[1] is the answer", "{a}", "{a:1}"]) {
      expect(
        drain(stream(), ...text.split("")).map((item) => unplaced(item)),
        text,
      ).toEqual([...parseMany(text)].map((item) => unplaced(item)));
    }
  });

  it("does not read a stopped scan as an absent candidate", () => {
    // `STRICT` has `maxErrors: 1`, so the scan stops at the unquoted key and never reaches the colon
    // that proves this is data. A budget stopping the scan says nothing about the input: the
    // answer is a refusal carrying what was read, not `no-json-found`.
    const r = parse("{a:1}", { ...STRICT, ...REPORT });
    expect(failed(r)).toMatchObject({ kind: "policy-refused", recovered: { value: {} } });
    expect(r.diagnostics.errors.map((e) => e.kind)).toEqual(["unparsable-span"]);
  });
});

describe("a dropped member is reported", () => {
  it("names the member it lost, and costs confidence", () => {
    const r = parse('{"a":1, b}', REPORT);
    expect(valueOf(r)).toEqual({ a: 1 });
    const dropped = r.diagnostics.repairs.filter((x) => x.kind === "dropped-member");
    expect(dropped.map((x) => x.path)).toEqual([["b"]]);
    expect(r.diagnostics.confidence).toBeLessThan(1);
  });

  it.each([
    ['{"a":1, b}', { a: 1 }],
    ['{"a":}', {}],
    ['{"a":1,"b":', { a: 1 }],
    ["[1, {x}, 2]", [1, {}, 2]],
  ])("reports the loss in %j rather than returning a clean-looking result", (text, want) => {
    const r = parse(text, REPORT);
    expect(valueOf(r)).toEqual(want);
    expect(r.diagnostics.repairs.some((x) => x.kind === "dropped-member")).toBe(true);
  });

  it("repairs the TEXT to match the value it dropped the member from", () => {
    for (const text of ['{"a":1, b}', '{"a":}', "[1, {x}, 2]"]) {
      expect(JSON.parse(repairText(text)) as unknown).toEqual(valueOf(parse(text)));
    }
  });
});

describe("a token the input cut off", () => {
  // A literal or number the source never finished is no value: `tru` read as the string "tru"
  // or `1e` as anything would change the type or invent the value. A finished number is real
  // and stays, even if more digits might have followed.
  const whole = (text: string): unknown => valueOf(parse(text));
  const ended = (text: string): unknown[] => values(drain(stream(), text));

  it.each(["tru", "nul", "fals", "-", "1.", "1e", "1e+", "-Inf", "Na", "und"])(
    "drops an unfinished %j at the end of the input and reports it",
    (token) => {
      for (const [text, want] of [
        [`[1, ${token}`, [1]],
        [`{"a":1,"b": ${token}`, { a: 1 }],
      ] as const) {
        expect(whole(text)).toEqual(want);
        expect(ended(text)).toEqual([want]);
        const r = parse(text, REPORT);
        expect(r.diagnostics.repairs.some((x) => x.kind === "dropped-member")).toBe(true);
        expect(JSON.parse(repairText(text)) as unknown).toEqual(want);
      }
    },
  );

  it.each([
    ["12", 12],
    ["-1", -1],
    ["1.5", 1.5],
    ["1e5", 1e5],
    ["true", true],
    ["null", null],
  ])("keeps a finished %j at the end of the input", (token, value) => {
    expect(whole(`[1, ${token}`)).toEqual([1, value]);
    expect(ended(`[1, ${token}`)).toEqual([[1, value]]);
  });

  it.each(["tru", "-", "1e", "-1.", "-Inf"])(
    "finds no JSON in a lone unfinished %j rather than a value read from its tail",
    (text) => {
      expect(parse(text)).toEqual({ ok: false, failure: { kind: "no-json-found" } });
    },
  );

  it("keeps a word that is no literal's prefix as the text it is", () => {
    expect(whole('{"a": hello')).toEqual({ a: "hello" });
  });

  it("does not cut a token that whitespace finished", () => {
    expect(whole("[1, tru ")).toEqual([1, "tru"]);
  });

  it.each([
    ['{"a":"x\\u00e9', { a: "xé" }, "a complete escape is the string's last content"],
    ['{"a":"x\\', { a: "x" }, "a lone backslash"],
    ['{"a":"x\\u0', { a: "x" }, "one hex digit"],
    ['{"a":"x\\u00', { a: "x" }, "two hex digits"],
    ['{"a":"x\\ud83d', { a: "x\uD83D" }, "a high surrogate the end left lone"],
  ])("keeps the member of a string cut after %j as %j — %s", (text, want) => {
    expect(whole(text)).toEqual(want);
    expect(ended(text)).toEqual([want]);
    expect(JSON.parse(repairText(text)) as unknown).toEqual(want);
  });
});

describe("root acceptance", () => {
  const input = 'prefix [0] then {"kind":"skip"} then {kind:"take", id: 7} suffix';
  const options = { requiredKeys: ["id"] } as const;
  it("treats duplicate required keys as presence requirements on every route", () => {
    for (const builtinParsers of [true, false]) {
      expect(parse('{"id":1}', { requiredKeys: ["id", "id"], builtinParsers })).toMatchObject({
        ok: true,
        value: { id: 1 },
      });
      expect(parse('{"other":1}', { requiredKeys: ["id", "id"], builtinParsers }).ok).toBe(false);
    }
  });

  it("returns the first object with every required own key", () => {
    expect(valueOf(parse(input, options))).toEqual({ kind: "take", id: 7 });
    expect(manyValues(input, options)).toEqual([{ kind: "take", id: 7 }]);
    expect(parse("{}", { requiredKeys: ["toString"] })).toEqual({
      ok: false,
      failure: {
        kind: "no-match",
        expected: "object",
        requiredKeys: ["toString"],
        recovered: { value: {}, complete: true },
      },
    });
  });

  it("uses the accepted root's source span and edits", () => {
    const located = findJsonSpan(input, options);
    if (!located.ok) throw new Error("expected a matching root");
    expect(input.slice(located.value.start.offset, located.value.end.offset)).toBe(
      '{kind:"take", id: 7}',
    );
    expect(repair(input, options)).toMatchObject({ ok: true, value: '{"kind":"take", "id": 7}' });
  });

  it("keeps the first compatible object when no object satisfies the keys", () => {
    expect(parse('[0] {"kind":"first"} {"kind":"second"}', options)).toEqual({
      ok: false,
      failure: {
        kind: "no-match",
        expected: "object",
        requiredKeys: ["id"],
        recovered: { value: { kind: "first" }, complete: true },
      },
    });
  });

  it("does not let filtering hide a parser refusal", () => {
    expect(failed(parse("[] {id:1}", { ...STRICT, objectOnly: true }))?.kind).toBe(
      "policy-refused",
    );
  });

  it("filters completed stream roots without retaining rejected arrays", () => {
    const items = drain(stream(options), '[0] {"kind":"skip"} ', '{"id":7}');
    expect(values(items)).toEqual([{ id: 7 }]);
    const rejected = drain(stream(options), '[0] {"kind":"skip"}');
    expect(rejected).toMatchObject([{ ok: false, failure: { kind: "no-match" } }]);
  });

  it("refuses eager selections whose items would escape before root acceptance", () => {
    expect(
      configurationCause(() =>
        createStreamParser({ select: select([["id"]], { occurrences: true }), objectOnly: true }),
      ),
    ).toEqual({ kind: "invalid-options", field: "select", reason: "root-filter" });
    expect(
      configurationCause(() =>
        createStreamParser({
          select: select([["id"]], { fragments: decodedFragments }),
          objectOnly: true,
        }),
      ),
    ).toEqual({ kind: "invalid-options", field: "select", reason: "root-filter" });
    // Every verb, since each delivers occurrences as they close; the message names the setting,
    // because `select` with final matches combines with root filters.
    const eager = { select: select([["id"]], { occurrences: true }), requiredKeys: ["id"] };
    expect(configurationCause(() => parse('{"id":1}', eager))).toEqual({
      kind: "invalid-options",
      field: "select",
      reason: "root-filter",
    });
    expect(() => parse('{"id":1}', eager)).toThrow("`occurrences` or `fragments`");
    expect(parse('{"id":1}', { select: select([["id"]]), requiredKeys: ["id"] })).toMatchObject({
      ok: true,
      value: [{ value: 1, path: ["id"] }],
    });
  });
});
