// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ParserOptions, StreamItem } from "../src/index";
import {
  ANY,
  createStreamParser,
  decodedFragments,
  diagnostics,
  parse,
  repair,
  select,
} from "../src/index";

/**
 * A string whose closing quote is missing can end at a raw line break that structure follows. Two
 * kinds split that by evidence. `missing-quote`, on by default, applies when a quote of the string's
 * own kind follows the break (a key, or a comma and a value): the literal reading would close the
 * string at that quote and invent a member from the word after it. `guessed-string-end`, opt-in,
 * applies to the rest (a closer, a lone comma, a bare-word key), where the literal reading is also
 * coherent and right for a cut multi-line value such as code. The hard part is streaming: a delivered
 * fragment cannot be taken back, so the break is held unread until the next line shows what it is,
 * and a later quote that fits proves the break was content. Every split of every input must
 * therefore give the whole-input answer, and the decoded fragments of a selected string must join to
 * exactly its value.
 */
const recover = { "guessed-string-end": true } as const;

type Ended = "missing-quote" | "guessed-string-end" | undefined;

// Read with `recover`. `ended`: the kind reported for the break that ended the string, if any.
const CASES: readonly (readonly [text: string, value: unknown, ended: Ended])[] = [
  ['{"d": "unclosed\n      }', { d: "unclosed" }, "missing-quote"],
  ["{a: 1, d: 'unclosed\n  b: 2\n}", { a: 1, d: "unclosed", b: 2 }, "guessed-string-end"],
  // A later quote that does not fit (`"b` is followed by a word) proves the break ended the string.
  ['{"a": "x\n, "b": "y"}', { a: "x", b: "y" }, "missing-quote"],
  // A later quote that fits (followed by a comma) proves the break was content.
  ['{"a": "line1\n}, said he", "b": 1}', { a: "line1\n}, said he", b: 1 }, undefined],
  // Text after a break is the string's own next line; a later break that structure follows ends it.
  ['{"code": "f() {\n  return 1;\n}', { code: "f() {\n  return 1;" }, "guessed-string-end"],
  ['{"a": "x\nhello world', { a: "x\nhello world" }, undefined],
  ['["a\n]', ["a"], "missing-quote"],
  ['["a\n, 2]', ["a", 2], "guessed-string-end"],
  // A comma the input ends after is structure already; only a quote after it was still unknown.
  ['["a\n,', ["a"], "guessed-string-end"],
  ['{"a": "x\n "k": 1}', { a: "x", k: 1 }, "missing-quote"],
  ['{"a": "x\n "k\\"y": 1}', { a: "x", 'k"y': 1 }, "missing-quote"],
  // A key quoted with the other kind would not close this string, so it is no evidence.
  ['{"a": "x\n \'k\': 1}', { a: "x", k: 1 }, "guessed-string-end"],
  ['{"a": "x\n\n   \n}', { a: "x" }, "missing-quote"],
  // CR LF and a lone CR are breaks too, as in JavaScript, and neither joins the string.
  ['{"d": "x\r\n}', { d: "x" }, "missing-quote"],
  ['{"d": "x\r}', { d: "x" }, "missing-quote"],
  // Comments are trivia between members, so a member after them is still structure.
  ['{"a": "x\n  // note\n  "b": 1}', { a: "x", b: 1 }, "missing-quote"],
  ['{"a": "x\n /* c */ "b": 1}', { a: "x", b: 1 }, "missing-quote"],
  // The same structure on one line: closers, a comma and a quoted key with its colon.
  ['{"a": "x, "b": 1}', { a: "x", b: 1 }, "missing-quote"],
];

// Read with the defaults: a quote after the break ends the string there, and so do closers the input
// ends with, unless the string opened the bracket they close.
const DEFAULT_CASES: readonly (readonly [text: string, value: unknown])[] = [
  ['{"a": "x\n "b": 1}', { a: "x", b: 1 }],
  ['{"msg": "see\n"quoted": words"}', { msg: "see", quoted: "words" }],
  ['["a\n, "b"]', ["a", "b"]],
  // A graph or code value cut before its quote keeps its closing line: the string opened that `{`.
  ['{"g": "digraph {\n  a -> b\n}', { g: "digraph {\n  a -> b\n}" }],
  ['{"code": "f([1]) {\n  return 1;\n}', { code: "f([1]) {\n  return 1;\n}" }],
  // A string that opened nothing, or closed what it opened, leaves the closers to the JSON.
  ['{"d": "unclosed\n      }', { d: "unclosed" }],
  ['{"a": {"d": "x {y}\n }\n}', { a: { d: "x {y}" } }],
  ['["x", "unclosed\n]', ["x", "unclosed"]],
  // Text after the closers makes them the string's own line again.
  ['{"d": "a\n}b', { d: "a\n}b" }],
  // A bare-word key after an earlier break's quoted key must not inherit that key's quote. The space
  // before its colon matters: a colon touching the word is judged without reading the quote.
  ['{"a": "x\n "k": "y\n b : 2\n}', { a: "x", k: "y\n b : 2" }],
  // On one line the literal reading closes the string at the key's quote and invents members from
  // the rest (`b: ":1,"`). A quoted key and its colon after closers and a comma end it before them.
  ['{"a":"x,"b":1,"c":2}', { a: "x", b: 1, c: 2 }],
  ['{"a": "x, "b": "y"}', { a: "x", b: "y" }],
  ['[{"n":"a},{"n":"b"}]', [{ n: "a" }, { n: "b" }]],
  // Closers the string opened stay its own; only the comma after them is structure.
  ['{"c": "f(){}, "k": 1}', { c: "f(){}", k: 1 }],
  // Without the key's colon, or with a key of the other quote kind, nothing shows the string ended.
  ['{"a": "x, y", "b": 1}', { a: "x, y", b: 1 }],
  ['{"a": "x, \'b\': 1"}', { a: "x, 'b': 1" }],
];

const streamed = (chunks: readonly string[], options: ParserOptions): StreamItem[] => {
  const sp = createStreamParser(options);
  const items: StreamItem[] = [];
  for (const chunk of chunks) items.push(...sp.feed(chunk));
  items.push(...sp.end());
  return items;
};

const fragmentTexts = (chunks: readonly string[], options: ParserOptions): string[] => {
  const sp = createStreamParser({
    ...options,
    select: select([[ANY]], { fragments: decodedFragments }),
  });
  const texts: string[] = [];
  const take = (items: ReturnType<typeof sp.end>): void => {
    for (const item of items) {
      if (!item.ok || !("kind" in item.value)) continue;
      if (item.value.kind === "start") texts.push("");
      else if (item.value.kind === "data") texts[texts.length - 1] += item.value.text;
    }
  };
  for (const chunk of chunks) take(sp.feed(chunk));
  take(sp.end());
  return texts;
};

const splits = (text: string): string[][] => {
  const out = [text.split("")];
  for (let at = 1; at < text.length; at++) out.push([text.slice(0, at), text.slice(at)]);
  return out;
};

describe("missing-quote", () => {
  it("reads each case whole, reports the repair, and repairs to JSON with the same value", () => {
    for (const [text, value, ended] of CASES) {
      const r = parse(text, { recover, diagnostics });
      expect(r.ok && r.value, text).toEqual(value);
      const kinds = r.diagnostics.repairs
        .map((x) => x.kind)
        .filter((k) => k === "missing-quote" || k === "guessed-string-end");
      expect(kinds, text).toEqual(ended === undefined ? [] : [ended]);
      const fixed = repair(text, { recover });
      expect(fixed.ok && (JSON.parse(fixed.value) as unknown), text).toEqual(value);
    }
  });

  it("ends a string by default only where a quote after the break shows it ended", () => {
    for (const [text, value] of DEFAULT_CASES) {
      expect(parse(text), text).toMatchObject({ ok: true, value });
    }
  });

  // Off, `missing-quote` is refused like any switched-off kind: same value, failed outcome. The
  // literal reading (`b: ": 1}"`) is no alternative a caller could want.
  it("refuses rather than reads literally when missing-quote is off", () => {
    const r = parse('{"a": "x\n "b": 1}', { recover: { "missing-quote": false } });
    expect(r).toMatchObject({
      ok: false,
      failure: { kind: "policy-refused", recovered: { value: { a: "x", b: 1 } } },
    });
  });

  it("gives the whole-input value over every split, and never delivers a fragment it must retract", () => {
    const runs = [
      ...CASES.map(([text, value]) => [text, value, { recover }] as const),
      ...DEFAULT_CASES.map(([text, value]) => [text, value, {}] as const),
    ];
    for (const [text, value, options] of runs) {
      const strings = Object.values(value as object).filter((v) => typeof v === "string");
      for (const chunks of splits(text)) {
        const last = streamed(chunks, options).at(-1);
        const label = JSON.stringify(chunks);
        expect(last !== undefined && "ok" in last && last.ok && last.value, label).toEqual(value);
        const texts = fragmentTexts(chunks, options);
        for (const s of strings) expect(texts, label).toContain(s);
      }
    }
  });

  // A stream holds the break until the next line shows what it is. Re-reading that line from the
  // break on every feed made a long pending line quadratic; the probe resumes instead. Counted reads,
  // not time: the reference is the same input with a space for the break, which never probes.
  it("reads a long pending line once, however small the chunks", () => {
    const line = (gap: string): string => `{"a": "x${gap}"${"y".repeat(4096)}": 1}`;
    const reads = (text: string): number => {
      // eslint-disable-next-line typescript/unbound-method -- The counter supplies the original receiver.
      const nativeRead = String.prototype.charCodeAt;
      let count = 0;
      try {
        // eslint-disable-next-line no-extend-native -- Count native reads synchronously, then restore in finally.
        String.prototype.charCodeAt = function (this: string, index: number): number {
          count++;
          return nativeRead.call(this, index);
        };
        const sp = createStreamParser();
        for (let at = 0; at < text.length; at += 4) sp.feed(text.slice(at, at + 4));
        sp.end();
      } finally {
        // eslint-disable-next-line no-extend-native -- Release the counter before another test can run.
        String.prototype.charCodeAt = nativeRead;
      }
      return count;
    };
    expect(reads(line("\n"))).toBeLessThan(reads(line(" ")) * 3);
  });
});
