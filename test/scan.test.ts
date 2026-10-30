// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * The scanner, attacked rather than confirmed.
 *
 * Cases are chosen for what they would catch if the implementation were wrong in a plausible way —
 * a depth stack that drifts, a span that measures the wrong extent, a repair recorded at the wrong
 * path, a "fix" that quietly invents data. Agreement with `JSON.parse` on clean input is asserted
 * as a PROPERTY over a table rather than case by case, because restating known-good values one at a
 * time tests the test author's typing.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ParserOptions, ResolvedOptions } from "../src/options";
import { MODE_EDITS } from "../src/edit-log";
import { resolveOptions, validateOptions } from "../src/options";
import { configurationCause } from "./configuration-error";
import { isExactNumber } from "../src/exact-number";
import { collectScan, createScanner as createCoreScanner } from "../src/scan";
import { scan as scanWith } from "../src/scan-collect";
import { ScanCursor } from "../src/scan-cursor";
import { diagnostics } from "../src/index";

it("banks decoded strings when a checkpoint ends after a backslash", () => {
  const expected = "\n".repeat(4096);
  const input = '"' + "\\n".repeat(expected.length) + '"';
  const cursor = new ScanCursor(undefined, input);
  const scanner = createScanner(REPORTING, undefined, MODE_EDITS, cursor);
  for (let start = 0; start < input.length; start += 512) {
    scanner.supply(input.slice(start, start + 512));
    while (scanner.pull() !== undefined) {
      // Drain the supplied slice through the actual scanner.
    }
    // Each nonfinal slice ends after a backslash; only that undecided unit may be reread.
    if (start + 512 < input.length) expect(cursor.base + cursor.pos).toBe(start + 511);
  }
  expect(scanner.end()).toEqual(scan(input));
  expect(one(input)).toBe(expected);
});

it("decodes mixed adjacent escapes across checkpoint and constructor boundaries", () => {
  const body = ["\\b", "\\f", "\\n", "\\r", "\\t", '\\"', "\\\\", "\\/"].join("").repeat(257);
  const input = '"' + body + '\\uD800literal\\uDC00"';
  expect(one(input)).toBe(JSON.parse(input));
  for (const width of [511, 512, 513]) {
    const cursor = new ScanCursor(undefined, input);
    const scanner = createScanner(REPORTING, undefined, MODE_EDITS, cursor);
    for (let start = 0; start < input.length; start += width) {
      scanner.supply(input.slice(start, start + width));
      while (scanner.pull() !== undefined) {
        // Exercise real slice boundaries, including a batch followed by a partial Unicode escape.
      }
    }
    expect(scanner.end()).toEqual(scan(input));
  }
});

// Probe tests inspect full final records; production readers consume only the EOF delivery.
const createScanner = (...args: Parameters<typeof createCoreScanner>) => {
  const scanner = createCoreScanner(...args);
  return { ...scanner, end: () => collectScan(scanner, scanner.end()) };
};

/** One chunk the way a stream drain reads it: supplied, pulled dry, then settled. */
const feed = (scanner: ReturnType<typeof createScanner>, chunk: string): unknown[] => {
  scanner.supply(chunk);
  const out: unknown[] = [];
  for (let pulled = scanner.pull(); pulled !== undefined; pulled = scanner.pull()) {
    if (pulled.root !== undefined) out.push(pulled.root.value);
  }
  scanner.finishChunk();
  return out;
};

/**
 * Options resolved for a case, failing loudly rather than silently parsing with the defaults.
 * Reporting is on unless a case turns it off: these cases read the repair and error logs, which
 * the default path deliberately does not keep.
 */
const opts = (o: ParserOptions): ResolvedOptions => {
  const r = resolveOptions({ diagnostics, ...o });
  if ("kind" in r) throw new Error(`options rejected: ${JSON.stringify(r)}`);
  return r;
};

const REPORTING = opts({});

const scan = (src: string, o: ResolvedOptions = REPORTING): ReturnType<typeof scanWith> =>
  scanWith(src, o);

/** The single value of a source that should hold exactly one. Fails loudly if it holds another count. */
const one = (src: string): unknown => {
  const r = scan(src);
  expect(r.values).toHaveLength(1);
  return r.values[0];
};

const kinds = (src: string): string[] => scan(src).repairs.map((r) => r.kind);

const depthOf = (maxDepth: number): ResolvedOptions => opts({ maxDepth });

describe("agrees with JSON.parse on input JSON.parse accepts", () => {
  const CLEAN = [
    "null",
    "true",
    "false",
    "0",
    "-0",
    "12",
    "-3.5",
    "1e3",
    "1E-3",
    '""',
    '"plain"',
    '"esc \\" \\\\ \\/ \\b \\f \\n \\r \\t"',
    '"\\u0041\\u00e9\\ud83d\\ude00"',
    "[]",
    "{}",
    "[1,2,3]",
    '{"a":1}',
    '{"a":{"b":[1,{"c":null}]}}',
    '["\\u0000",1.5e3,{}]',
    '{"":0}',
  ];

  it.each(CLEAN)("%s", (src) => {
    // The oracle is the language's own parser, so this cannot drift with our expectations.
    const expected: unknown = JSON.parse(src);
    const result = scan(src);
    expect(result.values).toEqual([expected]);
    expect(result.repairs).toEqual([]);
  });
});

describe("finds JSON inside prose without truncating it", () => {
  it("keeps a nested object whole, with its siblings", () => {
    // The defect this scanner replaces: a non-greedy regex extracted candidates and stopped at the
    // first closing brace, returning `{"b":{"c":1}}` — a different object, silently.
    expect(one('txt {"a":{"b":{"c":1}},"d":2} txt')).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it("does not end a value at a brace inside a string", () => {
    expect(one('note {"a":"}"} end')).toEqual({ a: "}" });
  });

  it("reports the span that re-parses to the same value", () => {
    // This is what makes "what was ignored" answerable without carrying prefix/suffix strings.
    const src = '   prose {"a":[1,2]} more prose  ';
    const r = scan(src);
    const span = r.spans[0];
    expect(span).toBeDefined();
    expect(JSON.parse(src.slice(span?.start, span?.end)) as unknown).toEqual({ a: [1, 2] });
  });

  it("yields each value of a multi-value source separately", () => {
    expect(scan('{"a":1} then {"b":2}').values).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("closes what the input left open, and says so", () => {
  it("completes a truncated object", () => {
    expect(one('{"a": "unclosed')).toEqual({ a: "unclosed" });
    expect(kinds('{"a": "unclosed')).toEqual(["unclosed-string", "unclosed-object"]);
  });

  it("completes a truncated array", () => {
    expect(one("[1,2")).toEqual([1, 2]);
    expect(kinds("[1,2")).toEqual(["unclosed-array"]);
  });

  it("completes nested truncation innermost first", () => {
    // Order is the evidence that the stack unwound rather than being guessed from the text.
    expect(kinds('{"a":[{"b":1')).toEqual(["unclosed-object", "unclosed-array", "unclosed-object"]);
  });

  it("invents no content for the string it completes", () => {
    // The extracted package appended "..." by default, so a consumer reading the value could not
    // tell three manufactured characters from three the model wrote.
    expect(one('{"a":"hi')).toEqual({ a: "hi" });
  });
});

describe("repairs are located, not merely counted", () => {
  it("records one whole-token edit for an escaped single-quoted string", () => {
    const result = scan(`{'escaped': '\\'quoted\\''}`);
    expect(result.edits.filter((edit) => edit.start === 12 && edit.end === 24)).toEqual([
      { start: 12, end: 24, text: `"'quoted'"` },
    ]);
  });

  it("records the path of the value being written", () => {
    const r = scan('{"outer":{"inner":[0,0,0x1f]}}', opts({ allowJavaScript: true }));
    expect(r.repairs.map((x) => x.kind)).toEqual(["hex-number"]);
    expect(r.repairs[0]?.path).toEqual(["outer", "inner", 2]);
  });

  it("attributes a repair to the top-level value it belongs to", () => {
    // Without valueIndex a streaming UI cannot tell which rendered object was patched.
    const r = scan('{"a":1} {"b":[1,2,');
    expect(r.repairs.length).toBeGreaterThan(0);
    expect(r.repairs.every((x) => x.valueIndex === 1)).toBe(true);
  });

  it("says a key was overwritten, while agreeing with JSON.parse on the value", () => {
    // Last wins is the language's own answer and must not change. The repair is the part a caller
    // cannot get from any other parser: without it, a key the model emitted twice is data that
    // silently disappears.
    expect(one('{"a":1,"a":2}')).toEqual(JSON.parse('{"a":1,"a":2}') as unknown);
    expect(kinds('{"a":1,"a":2}')).toEqual(["duplicate-key"]);
    expect(kinds('{"__proto__":1,"__proto__":2}')).toEqual(["duplicate-key"]);
    expect(kinds('{"constructor":1,"constructor":2}')).toEqual(["duplicate-key"]);
    expect(kinds('{"a":1,"b":2}')).toEqual([]);
    // Not confused by a key of the same name in a DIFFERENT object, which a flat seen-set would be.
    expect(kinds('{"a":{"x":1},"b":{"x":2}}')).toEqual([]);
  });

  it("keeps a malformed number's text rather than turning it into an absence", () => {
    // `Number()` answers NaN for every one of these, and NaN reaches a consumer as `null` through
    // any serialiser — so trusting it turns three different malformed tokens into one
    // indistinguishable absence, with nothing to say anything was there.
    expect(one('{"a":1.2.3}')).toEqual({ a: "1.2.3" });
    expect(one('{"a":1e}')).toEqual({ a: "1e" });
    expect(one('{"a":-}')).toEqual({ a: "-" });
    expect(kinds('{"a":1.2.3}')).toEqual(["invalid-number"]);
    // Not a PRECISION loss: `Number.isSafeInteger(NaN)` is false, so an unguarded check reports a
    // cause that never happened.
    expect(kinds('{"a":-}')).toEqual(["invalid-number"]);
  });

  it("keeps an integer a double cannot hold exact, without calling that a repair", () => {
    // Nothing was changed or lost, so nothing is reported: the value itself carries the digits.
    const texts = (src: string): unknown[] =>
      (scan(src).values[0] as unknown[]).map((v) => (isExactNumber(v) ? v.text : v));
    expect(kinds('{"id":12345678901234567890}')).toEqual([]);
    expect(
      texts("[9007199254740991,9007199254740992,9007199254740992.0,9.007199254740992e15]"),
    ).toEqual([9007199254740991, 9007199254740992, 9007199254740992, 9007199254740992]);
    expect(texts("[9007199254740993.0,9.007199254740993e15,1e400,1e-400,-0,0.1]")).toEqual([
      "9007199254740993.0",
      "9.007199254740993e15",
      "1e400",
      "1e-400",
      -0,
      0.1,
    ]);
    // A hex literal past 2^53 is rewritten to its exact decimal digits, never through `parseInt`.
    const hex = scan("[0x20000000000000,0x20000000000001]", opts({ allowJavaScript: true }));
    expect(hex.repairs.map((repair) => repair.kind)).toEqual(["hex-number", "hex-number"]);
    expect((hex.values[0] as unknown[]).map((v) => (isExactNumber(v) ? v.text : v))).toEqual([
      9007199254740992,
      "9007199254740993",
    ]);
    expect(hex.edits.map((e) => e.text)).toEqual(["9007199254740992", "9007199254740993"]);
  });

  it("charges nothing for a trailing comma, which invented no data", () => {
    expect(one("[1,2,]")).toEqual([1, 2]);
    expect(kinds("[1,2,]")).toEqual(["trailing-comma"]);
    expect(one('{"a":1,}')).toEqual({ a: 1 });
  });

  it("drops a redundant comma rather than reading the gap as a member", () => {
    // The gap between two commas is an empty span, and a scanner that reads it as a key lands
    // `{"a":1,"":2}` — a member the input never wrote, under a key it never named.
    expect(one('{"a":1,,"b":2}')).toEqual({ a: 1, b: 2 });
    expect(kinds('{"a":1,,"b":2}')).toEqual(["trailing-comma"]);
    expect(one("[1,,2]")).toEqual([1, 2]);
  });

  it("keeps an escape JSON does not define, backslash and all", () => {
    // Two ways to destroy data here, and both were shipped before this case existed. Advancing a
    // fixed five characters after `\u` DELETES what followed, because `parseInt` on a four-character
    // slice stops at the first non-hex character and still reports success. Reading the digits that
    // ARE there INVENTS a character the source never spelled — `\u12G5` came back as U+0012 then
    // `G5`. Neither is what the author wrote, so the escape is kept exactly as written.
    expect(one('{"bad":"\\u12G5"}')).toEqual({ bad: String.raw`\u12G5` });
    expect(kinds('{"bad":"\\u12G5"}')).toContain("invalid-escape");

    // The case that makes this matter: a model emitting a regex or a Windows path means the
    // backslash. Dropping it — which this parser and `jsonrepair` both did — turns `\d+\s` into
    // `d+s`, and no consumer can tell that from a model that never wrote one.
    expect(one(String.raw`{"re":"\d+\s"}`)).toEqual({ re: String.raw`\d+\s` });

    // A valid escape still means what JSON says it means, including a surrogate pair.
    expect(one('"\\uD83D\\uDE00"')).toBe("😀");
    expect(one('{"ok":"a\\nb"}')).toEqual({ ok: "a\nb" });

    // A token may escape its own closer in either dialect, and that is not a repair: `single-quote`
    // already reports the spelling, and charging again would drop `confidence` twice for one fact.
    expect(one(String.raw`{'a':'it\'s'}`)).toEqual({ a: "it's" });
    expect(kinds(String.raw`{'a':'it\'s'}`)).not.toContain("invalid-escape");
  });

  it("infers a missing comma and a missing colon", () => {
    expect(one('{"a":1 "b":2}')).toEqual({ a: 1, b: 2 });
    expect(kinds('{"a":1 "b":2}')).toEqual(["missing-comma"]);
    expect(one('{"a" 1}')).toEqual({ a: 1 });
    expect(kinds('{"a" 1}')).toEqual(["missing-colon"]);
  });

  it("keeps an unquoted key and marks it", () => {
    expect(one("{a:1}")).toEqual({ a: 1 });
    expect(kinds("{a:1}")).toEqual(["unquoted-key"]);
  });

  it("drops a key with no value instead of letting it swallow the next member", () => {
    // `{a: 12 34, b: 2}` made a key of `34`, and the missing colon handed it `b: 2` as its value,
    // so the member was destroyed outright. A separator straight after a key proves the source
    // wrote no value for it — the rule the closer case has always applied, at the other delimiter.
    expect(one("{a: 12 34, b: 2}")).toEqual({ a: 12, b: 2 });
    expect(one('{a: b"c", b: 2}')).toEqual({ a: "b", b: 2 });
    // NOT "both the comma and the colon were inferred, so it is junk": that reading drops `"age"`
    // here, an ordinary member missing both marks, every byte of which the source wrote. The
    // corpus caught it; keep this case beside the two above.
    expect(one('{"name": "John"\n"age" 30}')).toEqual({ name: "John", age: 30 });
    // An ordinary forgotten comma still joins two members.
    expect(one('{"a":1 "b":2}')).toEqual({ a: 1, b: 2 });
  });

  it("keeps a damaged number as the text the source wrote, not as the prefix that parsed", () => {
    // `{"a": 1_000}` returned the number 1 and left `_000` to become an invented key whose value
    // swallowed the member after it: `{"a":1,"_000":"b","":2}` for `{"a": 1_000, "b": 2}`. A number
    // is only a number when what follows it could follow a scalar; otherwise the run is one damaged
    // token and comes back as its source text instead of an invented numeric prefix. `1_000` itself
    // is now a JavaScript digit separator and reads as 1000; a doubled one is no number anywhere.
    expect(one('{"a": 1__000}')).toEqual({ a: "1__000" });
    expect(one('{"a": 1__000, "b": 2}')).toEqual({ a: "1__000", b: 2 });
    expect(one("[1__000]")).toEqual(["1__000"]);
    expect(one('{"a": 1_000, "b": 2}')).toEqual({ a: 1000, b: 2 });
    // A comment may still follow a number directly, and a delimiter still ends one.
    expect(one('{"a": 1//c\n}')).toEqual({ a: 1 });
    expect(one('{"a": 1,"b": 2}')).toEqual({ a: 1, b: 2 });
  });

  it("reads a spaced unquoted value whole, rather than inventing a key from its second word", () => {
    // The failure caught: `{a: John Doe, b: 1}` as `{"a":"John","Doe":"b:"}` — the second word
    // becomes a key, its value swallows `b:`, and the member after it is destroyed. Two core
    // violations at once: a key the source never wrote, and silent data loss.
    expect(one("{a: John Doe, b: 1}")).toEqual({ a: "John Doe", b: 1 });
    // A line break still ends one, so a missing comma cannot run one member into the next.
    expect(one("{a: John Doe\n b: 2}")).toEqual({ a: "John Doe", b: 2 });
    // Only where candidacy is settled. At the root a space still ends the word, which is what
    // keeps prose out: two words there are a sentence, not a value.
    expect(scan("not JSON").values).toEqual([]);
  });

  it("keeps a bare word as a string rather than dropping it", () => {
    expect(one("[banana]")).toEqual(["banana"]);
    expect(kinds("[banana]")).toEqual(["unquoted-string"]);
  });
});

describe("leniency the input needed and JSON forbids", () => {
  it("takes a single-quoted key and a single-quoted value alike", () => {
    // One helper decides what a string opener is. Two spellings is how the extracted package came
    // to accept a single-quoted value but not a single-quoted key.
    expect(one("{'a': 'b'}")).toEqual({ a: "b" });
    expect(kinds("{'a': 'b'}")).toEqual(["single-quote", "single-quote"]);
  });

  it("does not end a single-quoted string at an apostrophe's own quote character", () => {
    expect(one(`{"a":"it's"}`)).toEqual({ a: "it's" });
  });

  it("strips comments without reaching inside strings", () => {
    expect(one('{/*c*/"a":1 // note\n,"b":2}')).toEqual({ a: 1, b: 2 });
    // The falsifier for a comment pre-pass: `//` inside a string is data, not a comment, and a
    // stripper that runs before the parse cannot tell the difference without parsing.
    expect(one('{"u":"http://example.test"}')).toEqual({ u: "http://example.test" });
    expect(kinds('{"u":"http://example.test"}')).toEqual([]);
  });

  it("runs an unterminated block comment to the end rather than inventing its closer", () => {
    expect(one('{"a":1/*unterminated')).toEqual({ a: 1 });
    expect(kinds('{"a":1/*unterminated')).toEqual(["comment-removed", "unclosed-object"]);
  });
});

describe("streaming", () => {
  /** Feeds a source in chunks and reports what each chunk emitted, plus the final result. */
  const stream = (chunks: readonly string[], o?: ParserOptions) => {
    // Edits on, so the chop test can hold a chunked scan's edit log against `scan()`'s. Not
    // `stream: true`: that mode charges `maxRetained`, and these tests bound `maxBuffer` alone.
    const s = createScanner(o ? opts(o) : REPORTING, undefined, MODE_EDITS);
    const perChunk = chunks.map((c) => feed(s, c));
    return { perChunk, ...s.end(), failure: s.failure() };
  };

  it("emits the partial object at end of stream, which is the whole point of the package", () => {
    // The extracted package emitted NOTHING here — for this exact input, which is `finalize()`'s own
    // documented example, and for 49 of its 50 recorded stream cases. The completion loop could not
    // run because `feed` had already consumed the buffer, and the `catch` that would have popped the
    // open containers was unreachable because nothing threw.
    const r = stream(['{"key": "val']);
    expect(r.perChunk).toEqual([[]]);
    expect(r.values).toEqual([{ key: "val" }]);
    expect(r.repairs.map((x) => x.kind)).toEqual(["unclosed-string", "unclosed-object"]);
  });

  it.each([
    ["x".repeat(4096), "clean"],
    ["x\\d".repeat(1024), "escaped"],
  ])("bounds retained source while a long %s string is open", (body) => {
    const scanner = createScanner(opts({ maxBuffer: 64 }));
    const source = `{"value":"${body}"}`;
    let highWater = 0;
    for (let at = 0; at < source.length; at += 16) {
      feed(scanner, source.slice(at, at + 16));
      highWater = Math.max(highWater, scanner.buffered());
    }
    const result = scanner.end();
    expect(highWater).toBeLessThanOrEqual(64);
    expect((result.values[0] as { value: string }).value).toBe(body);
    expect(scanner.failure()).toBeUndefined();
  });

  it("never closes a block comment on its own opener's star across chunks", () => {
    // `/*/c*/` is one comment holding `/c`. A chunk ending right after `/*` must not let the next
    // chunk's `/` pair with the opener's `*`, which closed it at once and read `c*/` as a value.
    const r = stream(["[ /*", "/c*/ 1]"]);
    expect(r.values).toEqual([[1]]);
    expect(r.repairs.map((x) => x.kind)).toEqual(["comment-removed"]);
  });

  it("bounds a string whose every chunk ends just after an escape", () => {
    // Model output streams code one line per token, each ending in `\n`. The resume point must move
    // when a chunk ends exactly where an escape does; otherwise every later chunk re-reads the string
    // from the last chunk that ended on plain text, which is quadratic and overruns `maxBuffer`.
    const body = "\\n".repeat(2048);
    const scanner = createScanner(opts({ maxBuffer: 64 }));
    feed(scanner, '{"value":"');
    let highWater = 0;
    for (let at = 0; at < body.length; at += 2) {
      feed(scanner, body.slice(at, at + 2));
      highWater = Math.max(highWater, scanner.buffered());
    }
    feed(scanner, '"}');
    const result = scanner.end();
    expect(highWater).toBeLessThanOrEqual(64);
    expect((result.values[0] as { value: string }).value).toBe("\n".repeat(2048));
    expect(scanner.failure()).toBeUndefined();
  });

  it.each([
    [
      "matching closer",
      (body: string) => `{"a":"v',${body}"}`,
      (body: string) => ({ a: `v',${body}` }),
      [],
    ],
    [
      "mismatched closer",
      (body: string) => `{"a":"v',${body}}`,
      () => ({ a: "v" }),
      ["quote-mismatch", "dropped-member"],
    ],
  ])(
    "preserves ambiguous quote recovery after window compaction through a %s",
    (_name, sourceOf, expectedOf, repairKinds) => {
      const body = "x".repeat(4096);
      const source = sourceOf(body);
      // The window compacts, but replay still owns its raw suffix under the buffer limit.
      const scanner = createScanner(opts({ maxBuffer: source.length }));
      let highWater = 0;
      for (let at = 0; at < source.length; at += 16) {
        feed(scanner, source.slice(at, at + 16));
        highWater = Math.max(highWater, scanner.buffered());
      }
      const result = scanner.end();
      expect(highWater).toBeLessThanOrEqual(64);
      expect(result.values).toEqual([expectedOf(body)]);
      expect(result.repairs.map((repair) => repair.kind)).toEqual(repairKinds);
      expect(scanner.failure()).toBeUndefined();
    },
  );

  it.each([
    [`{"a":1,//${"x".repeat(4096)}\n"b":2}`, "line"],
    [`{"a":1,/*${"x".repeat(4096)}*/"b":2}`, "block"],
  ])("bounds retained source through a long %s comment", (source) => {
    const scanner = createScanner(opts({ maxBuffer: 64 }));
    let highWater = 0;
    for (let at = 0; at < source.length; at += 16) {
      feed(scanner, source.slice(at, at + 16));
      highWater = Math.max(highWater, scanner.buffered());
    }
    const result = scanner.end();
    expect(highWater).toBeLessThanOrEqual(64);
    expect(result.values).toEqual([{ a: 1, b: 2 }]);
    expect(result.repairs.map((entry) => entry.kind)).toEqual(["comment-removed"]);
    expect(scanner.failure()).toBeUndefined();
  });

  it("bounds a continued bare word without losing its source location", () => {
    const body = "x".repeat(4096);
    const source = `{"mark":1,"value":${body}}`;
    const scanner = createScanner(opts({ repairBroken: false, maxBuffer: 64 }));
    let highWater = 0;
    for (let at = 0; at < source.length; at += 16) {
      feed(scanner, source.slice(at, at + 16));
      highWater = Math.max(highWater, scanner.buffered());
    }
    const result = scanner.end();
    expect(highWater).toBeLessThanOrEqual(64);
    expect(result.values).toEqual([{ mark: 1, value: body }]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        kind: "unparsable-span",
        at: { offset: source.indexOf(body), unit: "utf16" },
      }),
    ]);
  });

  it("bounds a continued number while keeping every digit of it", () => {
    const body = "9".repeat(4096);
    const source = `{"mark":1,"value":${body}}`;
    const scanner = createScanner(opts({ maxBuffer: 64 }));
    let highWater = 0;
    for (let at = 0; at < source.length; at += 16) {
      feed(scanner, source.slice(at, at + 16));
      highWater = Math.max(highWater, scanner.buffered());
    }
    const result = scanner.end();
    expect(highWater).toBeLessThanOrEqual(64);
    const held = (result.values[0] as { value: unknown }).value;
    expect(isExactNumber(held) && held.text).toBe(body);
    expect(result.repairs).toEqual([]);
  });

  it.each([
    ["object", (body: string) => `{${body}:1}`, (body: string) => [{ [body]: 1 }]],
    ["array", (body: string) => `[${body}]`, (body: string) => [[body]]],
    ["prose", (body: string) => `text {${body}} tail`, () => []],
  ])("bounds an undecided %s candidate without emitting prose", (_name, sourceOf, expectedOf) => {
    const body = "x".repeat(4096);
    const scanner = createScanner(opts({ maxBuffer: 64 }));
    const source = sourceOf(body);
    let highWater = 0;
    for (let at = 0; at < source.length; at += 16) {
      feed(scanner, source.slice(at, at + 16));
      highWater = Math.max(highWater, scanner.buffered());
    }
    const result = scanner.end();
    expect(highWater).toBeLessThanOrEqual(64);
    expect(result.values).toEqual(expectedOf(body));
    expect(scanner.failure()).toBeUndefined();
  });

  it("holds a trailing bare scalar until the stream ends", () => {
    // `4` then `2` is 42, not 4 and 2 — and neither chunk may emit, because whether the scalar is
    // the whole text is unanswerable until there is no more text.
    const r = stream(["4", "2"]);
    expect(r.perChunk).toEqual([[], []]);
    expect(r.values).toEqual([42]);
  });

  it("releases a held scalar when the stream ends", () => {
    const scanner = createScanner(opts({ maxBuffer: 8 }));
    feed(scanner, "123");
    expect(scanner.buffered()).toBe(3);
    scanner.end();
    expect(scanner.buffered()).toBe(0);
  });

  it("gives the same answer however the source is chopped up", () => {
    // Character delivery exercises resumable token state and rebased positions in these focused
    // cases; it does not enumerate every partition or every rewind path.
    const SOURCES = [
      '{"a":[1,22,333],"b":"x"}',
      '{"a":{"b":[true,false,null]}}',
      'txt {"a":{"b":{"c":1}},"d":2} txt',
      "{'a': 'b', /*c*/ \"d\": 1,}",
      '{"a":"esc \\" \\\\ \\u0041"}',
      '{"a":1} {"b":2} {"c":3}',
      '{"a": "unterminated',
      '{"id":12345678901234567890}',
      '{"n":[0xF,-0b1,0x,0b2,0123,1.2.3,1e+2,1e-,9007199254740993]}',
      // A `_` split from the digit after it must wait for that digit, never end the token.
      '{"n":[1_000,0o17,0x1_f,0b1_0,0o1_7,1.5_5,1e1_0,0_1,1__0,1_,0x_1,1_.5]}',
      "[1_000_000",
      `{"a":"v',xxxx"}`,
      `{"a":"v',xxxx}`,
      `{"a":"v',\nxxxx}`,
      `{'a':'v",xxxx}`,
      '{"emoji":"a😀b"}',
      // Prose whose LAST word reads as a bare literal. Compaction that resets the trim bounds to
      // zero lands the tail exactly at `trimStart` and returns `items` as a lone scalar — one-shot
      // `[]`, streamed `["items"]` — and only a source with a trailing word shows it.
      "we found 3 of 7 items",
      "{} and prose",
      "{}   ",
      '{} {"a":1}',
      "```json\n42\n```",
      "here you go:\n```\n  true  \n```\nhope that helps",
    ];
    for (const src of SOURCES) {
      const whole = scan(src);
      // `split("")`, not `[...src]`: code UNITS, so a surrogate pair is split across two chunks.
      // Code points would keep every emoji intact and never exercise that boundary.
      const byChar = stream(src.split(""));
      expect(byChar.values, src).toEqual(whole.values);
      expect(
        byChar.repairs.map((x) => x.kind),
        src,
      ).toEqual(whole.repairs.map((x) => x.kind));
      expect(
        byChar.errors.map((x) => `${x.kind}@${x.at.offset}`),
        src,
      ).toEqual(whole.errors.map((x) => `${x.kind}@${x.at.offset}`));
      expect(byChar.edits, src).toEqual(whole.edits);
      expect(byChar.spans, src).toEqual(whole.spans);
      // Positions too: compaction rebases the buffer, and an offset that silently became relative
      // would still produce the right VALUES on every one of these.
      expect(
        byChar.repairs.map((x) => x.at.offset),
        src,
      ).toEqual(whole.repairs.map((x) => x.at.offset));
    }
  });

  it("keeps inherited text recovery stable across chunking", () => {
    // Compare inherited text cases without duplicating parser state. Character chunks exercise
    // one partition, not every possible placement of boundaries.
    const CORPUS = [
      ...new Set(
        readFileSync(new URL("../corpus/corpus.jsonl", import.meta.url), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { text?: unknown }).text)
          .filter((t): t is string => typeof t === "string"),
      ),
    ];
    expect(CORPUS.length).toBeGreaterThan(0);
    for (const src of CORPUS) {
      const whole = scan(src);
      // Bound work on longer inputs with fixed-width chunks; omitted partitions remain unproved.
      const chunks: string[] = [];
      if (src.length <= 400) chunks.push(...src.split(""));
      else for (let i = 0; i < src.length; i += 64) chunks.push(src.slice(i, i + 64));
      const s = createScanner(REPORTING);
      for (const c of chunks) feed(s, c);
      const r = s.end();
      expect(r.values, src).toEqual(whole.values);
      expect(
        r.repairs.map((x) => `${x.kind}@${x.at.offset}`),
        src,
      ).toEqual(whole.repairs.map((x) => `${x.kind}@${x.at.offset}`));
    }
  });

  it("gives the whole-input answer when one retained source is scanned in bounded slices", () => {
    const corpus = [
      ...new Set(
        readFileSync(new URL("../corpus/corpus.jsonl", import.meta.url), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { text?: unknown }).text)
          .filter((text): text is string => typeof text === "string"),
      ),
    ];
    expect(corpus.length).toBeGreaterThan(0);
    for (const source of corpus) {
      const cursor = new ScanCursor(undefined, source);
      const scanner = createScanner(REPORTING, undefined, MODE_EDITS, cursor);
      const step = source.length <= 400 ? 1 : 64;
      for (let start = 0; start < source.length; start += step) {
        scanner.supply(source.slice(start, start + step));
        while (scanner.pull() !== undefined) {
          // Pulling advances only through the source supplied so far.
        }
      }
      expect(scanner.end(), source).toEqual(scan(source));
    }
  });

  it("reports positions against the whole stream, not the buffer it still holds", () => {
    // The direct falsifier for compaction: the third value's repair must be far into the source,
    // and a scanner that forgot to rebase reports a small number that looks entirely plausible.
    const r = stream(['{"a":1} {"b":2} {"c":', "[1,2"]);
    expect(r.repairs.length).toBeGreaterThan(0);
    expect(r.repairs.every((x) => x.at.offset > 15)).toBe(true);
    expect(r.values).toEqual([{ a: 1 }, { b: 2 }, { c: [1, 2] }]);
  });

  it("fails a scalar that outgrows its hold rather than buffering forever", () => {
    // Nothing in the grammar ends a run of digits, so without a bound the candidate grows until the
    // process does. Bounded by the TOKEN, not by the stream.
    const r = stream(["7".repeat(50)], { maxScalar: 8 });
    expect(r.values).toEqual([]);
    expect(r.failure).toEqual({
      kind: "limit-reached",
      resource: "scalar",
      limit: 8,
      at: { offset: 0, unit: "utf16" },
    });
  });

  it("does not resume or reinterpret input after a scalar-limit failure", () => {
    for (const [head, tail] of [
      ["1234", "5"],
      ["abcd", "e"],
    ] as const) {
      const scanner = createScanner(opts({ maxScalar: 3 }));
      feed(scanner, head);
      feed(scanner, tail);
      expect(scanner.end().values, head + tail).toEqual([]);
      expect(scanner.failure()?.resource, head + tail).toBe("scalar");
    }

    const followed = createScanner(opts({ maxScalar: 3 }));
    feed(followed, "1234");
    feed(followed, ' {"a":1}');
    expect(followed.end().values).toEqual([]);
    expect(followed.failure()?.resource).toBe("scalar");
  });

  it("does not apply the bare-scalar budget to a quoted string", () => {
    const scanner = createScanner(opts({ maxScalar: 3 }));
    feed(scanner, '"abcdef');
    feed(scanner, 'gh"');
    expect(scanner.end().values).toEqual(["abcdefgh"]);
  });
});

const values = (t: string): unknown[] => scan(t).values;

describe("leniency flags change the diagnostics, never the tree", () => {
  // Each row: a source, the flag that governs it, and the repair it is reported as when allowed.
  // One table rather than five pairs of cases, because the PROPERTY is what matters and stating it
  // per-axis would let an implementation satisfy four axes and quietly diverge on the fifth.
  const AXES: readonly [string, keyof ParserOptions, string][] = [
    ["{'a':'b'}", "allowSingleQuotes", "single-quote"],
    ["{a:1}", "allowUnquotedKeys", "unquoted-key"],
    ["[1,2,]", "allowTrailingComma", "trailing-comma"],
    ["[1,,2]", "allowTrailingComma", "trailing-comma"],
    ['{/*c*/"a":1}', "allowComments", "comment-removed"],
    ['{//c\n"a":1}', "allowComments", "comment-removed"],
    ['{"a":"open', "repairBroken", "unclosed-string"],
    ['{"a":"x\\a"}', "repairBroken", "invalid-escape"],
    ['{"a":1 "b":2}', "repairBroken", "missing-comma"],
    ['{"a" 1}', "repairBroken", "missing-colon"],
    ['{"a": @#$}', "repairBroken", "unquoted-string"],
    ['{"a":1.2.3}', "repairBroken", "invalid-number"],
  ];
  // `allowJavaScript` is deliberately absent, and its absence is the finding: it is the one axis
  // that decides whether a value EXISTS rather than how an existing one was spelled, so `undefined`
  // and `"undefined"` are different values and no implementation can produce both. Its own case
  // below pins each side. Every other axis is a spelling, and a spelling cannot change a tree.

  it("builds the same value whether the construct is allowed or refused", () => {
    for (const [src, flag, kind] of AXES) {
      // A high budget, or the refusal would stop the scan and the trees could not be compared at all.
      const on = scan(src, opts({ [flag]: true, maxErrors: 1000 }));
      const off = scan(src, opts({ [flag]: false, maxErrors: 1000 }));
      expect(off.values, src).toEqual(on.values);
      expect(
        on.repairs.map((r) => r.kind),
        src,
      ).toContain(kind);
      expect(on.errors, src).toEqual([]);
      // Refused: reported through the OTHER channel, at the same place, and never silently.
      expect(
        off.errors.map((e) => e.kind),
        src,
      ).toContain("unparsable-span");
      expect(
        off.repairs.map((r) => r.kind),
        src,
      ).not.toContain(kind);
    }
  });

  it("stops at the first policy refusal when the error budget is spent", () => {
    const options = opts({ allowSingleQuotes: false, maxErrors: 1 });
    const scanner = createScanner(options);
    scanner.supply("{'a':1} {'b':2}");
    const r = scanner.end();
    expect(r.errors.map((e) => e.kind)).toEqual(["unparsable-span"]);
    expect(scanner.tallyAt?.(0).errors).toBe(1);
    expect(scanner.scanCompleteAt(0)).toBe(false);
    // The refusal is the verdict, not the budget it spent: the caller asked to hear about the
    // construct, and a budget of one stops at that first refusal.
    expect(scanner.verdictAt(0)?.kind).toBe("policy-refused");
    // Stopped, not merely quieter: the second document was never reached.
    expect(r.values.length).toBe(1);
    expect(scan('{"a":1} {"b":2}', options).values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("gives JavaScript literals their JavaScript values, or the words they were spelled with", () => {
    const js = opts({ allowJavaScript: true });
    expect(scan("[undefined,NaN,Infinity]", js).values[0]).toEqual([
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]);
    // Refused, they are the words the source spelled -- nothing invented, nothing lost. Named
    // explicitly rather than left to the default, which recognises them: this case pins the OFF
    // side, and a test that reads a default cannot say which side it is testing.
    expect(scan("[undefined,NaN,Infinity]", opts({ allowJavaScript: false })).values[0]).toEqual([
      "undefined",
      "NaN",
      "Infinity",
    ]);
  });

  it("counts refusals against the budget even when it is not storing them", () => {
    // `diagnostics: false` must not raise every limit by making the count unobservable, and the
    // refusal must still decide the value's outcome with nothing stored to derive it from.
    const scanner = createScanner(
      opts({ allowSingleQuotes: false, diagnostics: false, maxErrors: 1 }),
    );
    scanner.supply("{'a':1} {'b':2}");
    const r = scanner.end();
    expect(r.errors).toEqual([]);
    expect(scanner.scanCompleteAt(0)).toBe(false);
    expect(scanner.verdictAt(0)?.kind).toBe("policy-refused");
    expect(r.values.length).toBe(1);
  });

  it("attributes errors to the value being recovered", () => {
    const scanner = createScanner(opts({ allowUnquotedKeys: false }));
    scanner.supply('{"clean":1} {broken:2}');
    const r = scanner.end();
    expect(r.errors.map((error) => error.valueIndex)).toEqual([1]);
    expect([scanner.tallyAt?.(0).errors, scanner.tallyAt?.(1).errors]).toEqual([0, 1]);
    expect(scanner.verdictAt(0)).toBeUndefined();
    expect(scanner.verdictAt(1)?.kind).toBe("policy-refused");
    expect(scanner.scanCompleteAt(1)).toBe(true);
  });

  it("keeps source order when a clean chunk follows one still queued in malformed pieces", () => {
    // The first chunk's text after its replacement character waits outside the window until the
    // scan reaches it. A second chunk supplied before any read must wait behind it; appended at
    // once, `["d"]` landed ahead of `["b`.
    const scanner = createScanner(opts({}));
    scanner.supply('["a�"] ["b"] ', [3]);
    scanner.supply('["d"]');
    expect(scanner.end().values).toEqual([["a�"], ["b"], ["d"]]);
  });
});

describe("a bare scalar is a value only when it stands alone or fills a fence", () => {
  it("takes a scalar that is the whole content of a fenced block", () => {
    expect(values("```\n42\n```")).toEqual([42]);
    expect(values("```json\n42\n```")).toEqual([42]);
    expect(values("```\n  true  \n```")).toEqual([true]);
    expect(values("here you go:\n```json\n42\n```\nhope that helps")).toEqual([42]);
    // A truncated response never sends the closing marker, which is the case this package is for.
    expect(values("```\n42")).toEqual([42]);
    expect(values("```\n42\n```\n```\n7\n```")).toEqual([42, 7]);
  });

  it("stops the info string at the word, not at the end of the line", () => {
    // Markdown runs the info string to end of line, and an LLM writes the value on the marker line
    // often enough that following Markdown here loses it outright. Caught by a corpus stream case,
    // where consuming the line swallowed `{ a: 1,` and left an unparsable remainder.
    expect(values('```js{ a: 1,\n"total":2}```')).toEqual([{ a: 1, total: 2 }]);
    expect(values('```json{"a":1}```')).toEqual([{ a: 1 }]);
    // The word must still be skipped, or `json` is read as a bare literal inside the block.
    expect(values("```json 42\n```")).toEqual([42]);
  });

  it("takes nothing from a fence holding more than the scalar", () => {
    // The falsifiers. Each differs from an accepted case by one fact, so a rule that merely notices
    // backticks somewhere passes the block above and fails every line here.
    expect(values("```\n42 and prose\n```")).toEqual([]);
    expect(values("```\nprose then 42\n```")).toEqual([]);
    // Two backticks are prose; three open a block.
    expect(values("``\n42\n``")).toEqual([]);
    // A marker is a marker only at the head of a line.
    expect(values("text ``` 42 ``` text")).toEqual([]);
    // Outside every fence the ordinary rule still applies, so the trailing scalar is prose.
    expect(values("```\n{}\n```\nand 42 more")).toEqual([{}]);
  });

  it("holds a fenced scalar until the text can answer whether it stands alone", () => {
    // Mid-stream, "nothing follows" is unanswerable: the next chunk may append prose. A scanner that
    // emitted on the first plausible answer returns 42 from the second feed on BOTH of these.
    const sp = createScanner(REPORTING);
    expect(feed(sp, "```\n42")).toEqual([]);
    expect(feed(sp, " and prose\n```")).toEqual([]);
    expect(sp.end().values).toEqual([]);

    // The closing marker ANSWERS the question, so the value arrives from `feed` like any other
    // completed one. A bare scalar waits for `end()` because "is this the whole text?" cannot be
    // answered until the text ends — a fence ends before the text does, so the reason does not apply.
    const ok = createScanner(REPORTING);
    expect(feed(ok, "```\n42")).toEqual([]);
    expect(feed(ok, "\n```")).toEqual([42]);
    expect(ok.end().values).toEqual([42]);
  });

  it("abandons a fenced candidate that outgrows its hold", () => {
    // Same bound as the unfenced scalar, and it needs its own case: the fence path has its own exit,
    // so a bound applied only to the trimmed-text path leaves this one growing forever.
    const sp = createScanner(opts({ maxScalar: 8 }));
    feed(sp, "```\n" + "7".repeat(50));
    expect(sp.end().values).toEqual([]);
  });
});

describe("the key policy, applied at one insertion point", () => {
  const P = '{"__proto__":{"polluted":1},"safe":2}';

  it("keeps a dangerous key as data without touching any prototype", () => {
    const value = one(P) as Record<string, unknown>;
    // The falsifier for a guard that checks the key and then writes with `obj[key] = v`: that
    // assignment walks `__proto__`'s setter, so every check around it reads as correct and the
    // prototype is polluted anyway.
    expect("polluted" in ({} as object)).toBe(false);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    // Nothing was altered, so nothing is reported. Charging a repair here would drop `confidence`
    // for a document that parsed exactly as written.
    expect(kinds(P)).toEqual([]);
  });

  it("defines data over any inherited setter", () => {
    let calls = 0;
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "inheritedSetter");
    // eslint-disable-next-line no-extend-native -- the inherited setter is the production failure being reproduced
    Object.defineProperty(Object.prototype, "inheritedSetter", {
      configurable: true,
      // A setter with no getter IS the hostile prototype being reproduced; adding a getter would
      // test a shape the production failure never had.
      // eslint-disable-next-line accessor-pairs
      set: () => {
        calls++;
      },
    });
    try {
      const value = one('{"inheritedSetter":1}') as Record<string, unknown>;
      expect(calls).toBe(0);
      expect(Object.hasOwn(value, "inheritedSetter")).toBe(true);
      expect(value.inheritedSetter).toBe(1);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, "inheritedSetter");
      // eslint-disable-next-line no-extend-native -- Restore the original host descriptor.
      else Object.defineProperty(Object.prototype, "inheritedSetter", previous);
    }
  });

  it("drops the key and keeps its siblings", () => {
    // The extracted package returned `{}` for this input on both its paths, destroying `safe` and
    // leaving a consumer unable to tell the result from empty input.
    const r = scan(P, opts({ onDangerousKey: "drop" }));
    expect(r.values[0]).toEqual({ safe: 2 });
    expect(r.repairs.map((x) => x.kind)).toEqual(["dangerous-key"]);
    expect(r.repairs[0]?.path).toEqual(["__proto__"]);
  });

  it("refuses the whole object under reject, and does not let it refill", () => {
    // A refusal is an ERROR, not a repair: nothing was fixed. The second assertion is the falsifier
    // for a naive implementation that empties the object and then keeps parsing into it.
    const r = scan('{"safe":1,"__proto__":1,"after":2}', opts({ onDangerousKey: "reject" }));
    expect(r.values[0]).toEqual({});
    expect(r.errors.map((e) => e.kind)).toEqual(["dangerous-key"]);
    expect(r.repairs).toEqual([]);
  });

  it("catches a dangerous key spelled with escapes", () => {
    // Falsifies a pre-scan for the literal six substrings, which the escaped spelling walks past.
    // The guard sees the DECODED key because decoding happens before the key exists.
    const r = scan(
      '{"\\u005f\\u005fproto\\u005f\\u005f":1,"safe":2}',
      opts({ onDangerousKey: "drop" }),
    );
    expect(r.values[0]).toEqual({ safe: 2 });
    expect(r.repairs.map((x) => x.kind)).toEqual(["dangerous-key"]);
  });

  it("names the key and its position, nested", () => {
    const r = scan('{"a":{"b":{"__proto__":1,"k":9}}}', opts({ onDangerousKey: "drop" }));
    expect(r.values[0]).toEqual({ a: { b: { k: 9 } } });
    expect(r.repairs[0]?.path).toEqual(["a", "b", "__proto__"]);
  });

  it("actually wires customDangerousKeys to the insertion point", () => {
    // The extracted package advertised this option and connected it to nothing: the validator that
    // consumed it was dead code whose only occurrence was its own definition.
    const r = scan(
      '{"team":"x","ok":1}',
      opts({ customDangerousKeys: ["team"], onDangerousKey: "drop" }),
    );
    expect(r.values[0]).toEqual({ ok: 1 });
  });

  it("gives a prototype-less object only when asked", () => {
    expect(Object.getPrototypeOf(scan('{"a":1}', opts({ nullPrototype: true })).values[0])).toBe(
      null,
    );
    expect(Object.getPrototypeOf(scan('{"a":1}').values[0])).toBe(Object.prototype);
  });

  it("validates to a value, and resolves by throwing that value as the TypeError's cause", () => {
    const refused = { kind: "invalid-options", field: "maxDepth", reason: "positive-integer" };
    expect(validateOptions({ maxDepth: 0 })).toEqual(refused);
    expect(configurationCause(() => resolveOptions({ maxDepth: 0 }))).toEqual(refused);
  });

  it.each([
    [null, "options"],
    [{ allowComments: "yes" }, "allowComments"],
    [{ onDangerousKey: "erase" }, "onDangerousKey"],
    [{ customDangerousKeys: 1 }, "customDangerousKeys"],
    [{ customDangerousKeys: ["ok", 1] }, "customDangerousKeys"],
    [{ maxBuffer: Number.MAX_SAFE_INTEGER + 1 }, "maxBuffer"],
    [{ typoOption: true }, "typoOption"],
  ])("rejects the runtime option shape %j at %s", (input, field) => {
    expect(() => resolveOptions(input as never)).toThrow(TypeError);
    const result = validateOptions(input);
    expect("kind" in result && result.kind).toBe("invalid-options");
    expect("field" in result && result.field).toBe(field);
  });
});

describe("hostile input", () => {
  it("does not throw or recurse away on nesting past the budget", () => {
    // 5000 levels would overflow a recursive-descent parser's call stack outright.
    const deep = "[".repeat(5000) + "1" + "]".repeat(5000);
    expect(scan(deep).errors.map((e) => e.kind)).toEqual(["depth-budget"]);
    expect(scan(deep, depthOf(64)).errors.map((e) => e.kind)).toEqual(["depth-budget"]);
  });

  it("keeps the budget a resource bound, not a notification", () => {
    // Falsifies the tempting non-fix — report the budget, then carry on building anyway, which
    // leaves attacker-controlled nesting bounded by nothing at all.
    const r = scan(`[${"[".repeat(40)}1${"]".repeat(40)},2]`, depthOf(4));
    let node: unknown = r.values[0];
    let depth = 0;
    while (Array.isArray(node) && node.length > 0) {
      node = node[0];
      depth++;
    }
    // Four levels were built and the fifth is the empty marker the budget put in place of the
    // subtree it refused, so nothing below it exists to traverse.
    expect(depth).toBe(4);
    // The siblings AFTER the refused container still arrive: the skip consumed exactly that
    // container, so the parent kept its place in the source.
    expect(r.values[0]).toEqual([[[[[]]]], 2]);
  });

  it("does not end a refused container at a brace inside one of its strings", () => {
    // The skip counts delimiters and skips strings whole; a regex could not, which is the defect
    // this scanner exists to remove.
    const r = scan('{"a":{"b":"]}"},"c":1}', depthOf(1));
    expect(r.values[0]).toEqual({ a: {}, c: 1 });
    expect(r.errors.map((e) => e.kind)).toEqual(["depth-budget"]);
  });

  it("skips a refused container identically at every chunk boundary", () => {
    const source = '{"a":{"quoted":"}",/* } */"nested":[1,{"x":2}]},"b":3}';
    const expected = [{ a: {}, b: 3 }];
    for (let cut = 1; cut < source.length; cut++) {
      const scanner = createScanner(opts({ maxDepth: 1 }));
      feed(scanner, source.slice(0, cut));
      feed(scanner, source.slice(cut));
      const r = scanner.end();
      expect(r.values, `cut at ${cut}`).toEqual(expected);
      expect(
        r.errors.map((error) => error.kind),
        `cut at ${cut}`,
      ).toEqual(["depth-budget"]);
    }
  });

  it("does not allocate the declared depth before the input reaches it", () => {
    expect(scan("[]", depthOf(Number.MAX_SAFE_INTEGER)).values).toEqual([[]]);
  });

  it("does not leak the final byte of an unclosed refused subtree into its parent", () => {
    expect(scan('{"a":{"x":/', depthOf(1)).values).toEqual([{ a: {} }]);
  });

  it("locates a budget error in the source, for a human and for a program", () => {
    const r = scan('{\n  "a": [1]\n}', depthOf(1));
    expect(r.errors[0]?.line).toBe(2);
    expect(r.errors[0]?.column).toBe(8);
  });

  it("keeps diagnostic coordinates absolute after releasing a completed prefix", () => {
    const scanner = createScanner(depthOf(1));
    feed(scanner, '{"ok":1}\n');
    feed(scanner, '{\n"a":[]}');
    const error = scanner.end().errors[0];
    expect(error).toMatchObject({
      kind: "depth-budget",
      at: { offset: 15, unit: "utf16" },
      line: 3,
      column: 5,
    });
  });

  it("terminates on input that opens nothing", () => {
    expect(scan("}}]],,::").values).toEqual([]);
    expect(scan("").values).toEqual([]);
    expect(scan("   ").values).toEqual([]);
  });

  it("terminates on a lone backslash at end of input", () => {
    expect(one('"abc\\')).toBe("abc");
  });

  it("reads signed Infinity as one JavaScript literal", () => {
    const r = scan('[-Infinity,{"x":-Infinity}]', opts({ allowJavaScript: true }));
    expect(r.values).toEqual([[Number.NEGATIVE_INFINITY, { x: Number.NEGATIVE_INFINITY }]]);
    expect(r.repairs.map((repair) => repair.kind)).toEqual(["js-literal", "js-literal"]);
  });

  it("does not terminate a bare object value at its colon", () => {
    expect(one('{"url":https://example.test/}')).toEqual({ url: "https://example.test/" });
  });
});
