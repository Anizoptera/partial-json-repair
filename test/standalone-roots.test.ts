// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createStreamParser,
  diagnostics,
  locations,
  parse,
  parseMany,
  repair,
  STRICT,
} from "../src/index";

/**
 * A root with no mark of data (`[1]`, `42`, a cut string) is a candidate only because it stands
 * alone: it fills the trimmed input or a fence's content (`src/AGENTS.md`, "Brackets inside prose
 * need a data mark"). Each case here stands alone by that rule and was declined because the check
 * misread what surrounds the value: a CRLF line end, the fence's own opening line, or a chunk
 * boundary inside the value that made a stream forget the fence.
 */
const STANDALONE: ReadonlyArray<readonly [string, unknown]> = [
  // Whole, this one always parsed; split inside `[1]`, a stream lost the fence and declined it.
  ["```json\n[1]\n```", [1]],
  ["```json\r\n[1]\r\n```", [1]],
  ["See:\r\n```json\r\n[1]\r\n```", [1]],
  ["```json [1]\n```", [1]],
  ["```json [1]```", [1]],
  // Trivia and stray closers after the root are not prose; a marked root (`{"a":1}}`) already
  // parsed this way.
  ["[1]/*c*/", [1]],
  ["[1] // c", [1]],
  ["[1]]", [1]],
  ["[1] ]", [1]],
  // A cut string owns the whitespace it ends in, so that whitespace cannot sit after the root.
  ['"abc ', "abc "],
  ['"abc \t', "abc \t"],
];

const streamed = (text: string): unknown[] => {
  const sp = createStreamParser();
  const out: unknown[] = [];
  for (const ch of text)
    for (const item of sp.feed(ch)) if (!("kind" in item) && item.ok) out.push(item.value);
  for (const item of sp.end()) if (!("kind" in item) && item.ok) out.push(item.value);
  return out;
};

/** What a root's tail can change: the verdict under `STRICT`, and the repairs a report lists. */
const tailOutcome = (text: string): unknown[] => {
  const strict = parse(text, STRICT);
  const report = parse(text, { diagnostics });
  return [
    strict.ok || strict.failure.kind,
    report.ok ? report.diagnostics.repairs.map((x) => x.kind) : report.failure.kind,
  ];
};

describe("a root that stands alone", () => {
  it("is found however its surroundings are spelled", () => {
    for (const [text, value] of STANDALONE) {
      const r = parse(text);
      expect(r.ok ? r.value : `failed ${r.failure.kind}`, JSON.stringify(text)).toEqual(value);
      const many = [...parseMany(text)].map((x) => (x.ok ? x.value : `failed ${x.failure.kind}`));
      expect(many, JSON.stringify(text)).toEqual([value]);
      expect(streamed(text), JSON.stringify(text)).toEqual([value]);
    }
  });

  // The tail is read only to prove the root stands alone; a marked root reads it after completing,
  // where it describes no value. Twins differ only in that mark, so any difference is the tail's.
  it("reports its tail exactly as a marked root does", () => {
    for (const tail of [" // c", "/*c*/", "]", " ] /* c */"])
      for (const root of ["[1]", "1"])
        expect(tailOutcome(root + tail), root + tail).toEqual(tailOutcome(`{"a":1}${tail}`));
  });

  it("spans from its opening quote when an apostrophe made the string wait", () => {
    // An apostrophe before a delimiter leaves the string undecided; it once settled with the span
    // the scan started at, so `repair` kept the leading whitespace the built-in route trims.
    for (const text of [` "x',"`, ` "abc'`, ` "x',`]) {
      const quote = text.indexOf('"');
      const whole = parse(text, { locations });
      const many = [...parseMany(text, { locations })];
      const starts = [whole, ...many].map((r) => (r.ok ? r.span.start.offset : r.failure.kind));
      expect(starts, text).toEqual([quote, quote]);
      const repaired = repair(text, { builtinParsers: false });
      expect(repaired.ok && repaired.value.startsWith('"'), text).toBe(true);
    }
  });

  it("waits for its tail before a refusal in that tail stops the scan", () => {
    // Under `STRICT` the comment spends the whole error budget. A chunk ending right after it must
    // not settle the held root: the next chunk's colon makes it a key, as the whole text says.
    for (const text of ['"a"/*c*/:1', "1/*c*/:2"]) {
      const sp = createStreamParser(STRICT);
      const at = text.indexOf("*/") + 2;
      const items = [...sp.feed(text.slice(0, at)), ...sp.feed(text.slice(at)), ...sp.end()];
      const whole = parse(text, STRICT);
      const kinds = items.map((x) => ("kind" in x ? x.kind : x.ok || x.failure.kind));
      expect(kinds, text).toEqual([whole.ok || whole.failure.kind]);
    }
  });

  it("still declines the same value inside prose", () => {
    for (const text of ["see [1] here", "[1] and more", "```json\nsee [1]\n```", "[1]] x"]) {
      const r = parse(text);
      expect(r.ok ? r.value : r.failure.kind, JSON.stringify(text)).toBe("no-json-found");
    }
  });
});
