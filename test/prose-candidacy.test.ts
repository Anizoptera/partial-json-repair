// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ParserOptions, StreamItem } from "../src/index";
import {
  STRICT,
  createStreamParser,
  diagnostics,
  ownedView,
  parse,
  parseMany,
  repair,
} from "../src/index";

/**
 * Detection must not depend on which repairs are enabled (root `AGENTS.md`, "Detection is
 * conservative, recovery is forgiving"). The candidate reader tries prose words and bracketed prose
 * as roots before rejecting them, and whatever that attempt RECORDED must leave with it: a refusal
 * kept from a rejected attempt fails a clean document, and under `STRICT` (`maxErrors: 1`) it also
 * stopped the scan, so `Answer:` before a fenced block came back as `no-json-found`.
 */
const PROSE: ReadonlyArray<readonly [string, unknown[]]> = [
  ['Here: {"a": 1}', [{ a: 1 }]],
  ['Answer:\n```json\n{"b": 1}\n```', [{ b: 1 }]],
  ['note {"a": 1}', [{ a: 1 }]],
  ['x\n{"b": 1}', [{ b: 1 }]],
  ['Some text [1, 2, 3] more text {"name": "John"} end', [[1, 2, 3], { name: "John" }]],
  ['see {a} then {"b": 1}', [{ b: 1 }]],
  ['use [x] or {"b": 1}', [{ b: 1 }]],
  ['tl;dr {"b": 1}', [{ b: 1 }]],
];

/** Every switch that could decide a prose attempt, off, with the budget left at its default. */
const STRICTEST: ParserOptions = { ...STRICT, maxErrors: 1000 };
const POLICIES: ReadonlyArray<readonly [string, ParserOptions]> = [
  ["default", {}],
  ["STRICT", STRICT],
  ["every leniency off", STRICTEST],
  ["unquoted-string off", { recover: { "unquoted-string": false } }],
];

const streamed = (text: string, options: ParserOptions): unknown[] => {
  const sp = createStreamParser(options);
  const items: StreamItem[] = [];
  for (const ch of text) items.push(...sp.feed(ch));
  items.push(...sp.end());
  return items.map((item) =>
    "kind" in item ? `item ${item.kind}` : item.ok ? item.value : `failed ${item.failure.kind}`,
  );
};

describe("a refusal made before a rejected quoted root", () => {
  // `STRICT` spends its one error on the comment; the stop waits for a candidate with a mark. The
  // quoted `"x"` is rejected as prose, but kept its quote as a mark, so the stop landed before
  // `{"a":1}` was read: `no-json-found` whole, `policy-refused` per character.
  it("keeps the same verdict whole and per character", () => {
    for (const text of ['//\n"x" {"a":1}', '//\n"x"y {"a":1}', '//\n```\n"x" y\n```\n{"a":1}']) {
      const whole = parse(text, STRICT);
      const many = [...parseMany(text, STRICT)];
      const verdicts = [whole, ...many].map((r) => (r.ok ? r.value : r.failure.kind));
      expect(verdicts, text).toEqual(["policy-refused", "policy-refused"]);
      // The refusal ends the stream; each later character answers `stream-closed`.
      expect(streamed(text, STRICT)[0], text).toBe("failed policy-refused");
    }
  });
});

describe("prose in front of JSON", () => {
  for (const [name, options] of POLICIES) {
    it(`finds the same clean roots under ${name}, with nothing reported`, () => {
      for (const [text, roots] of PROSE) {
        const one = parse(text, { ...options, diagnostics });
        expect(one.ok ? one.value : `failed ${one.failure.kind}`, text).toEqual(roots[0]);
        if (one.ok) expect(one.diagnostics.errors, text).toEqual([]);
        const many = [...parseMany(text, options)].map((r) =>
          r.ok ? r.value : `failed ${r.failure.kind}`,
        );
        expect(many, text).toEqual(roots);
        expect(streamed(text, options), text).toEqual(roots);
      }
    });
  }
});

/**
 * An input made only of values holds no prose, so every root is read even when none carries a mark
 * of data. Each run sits beside the nearest text that must stay prose: the separator rule decides
 * both, so a rule too loose fails a control and one too strict fails a run.
 */
const RUNS: ReadonlyArray<readonly [string, unknown[]]> = [
  ["[1]\n[2]", [[1], [2]]],
  ["[1],", [[1]]],
  ["1\n2", [1, 2]],
  ["1\r\n2", [1, 2]],
  ['"x"\n"y"', ["x", "y"]],
  ["true\nfalse\nnull", [true, false, null]],
  ["-1\n-2", [-1, -2]],
  ['{"a":1}\n[2]', [{ a: 1 }, [2]]],
  ['{"a":1}\n3', [{ a: 1 }, 3]],
  ["[]\n{}", [[], {}]],
  ["1 // note\n2", [1, 2]],
  ["```jsonl\n1\n2\n```", [1, 2]],
  ["```jsonl\n[1]\n[2]\n```", [[1], [2]]],
  ["1\n2 apples", [1]],
];
const NOT_RUNS: ReadonlyArray<readonly [string, unknown[]]> = [
  ["[1] [2]", []],
  ["[1][2]", []],
  ["1 2 3 go", []],
  ["1, 2 and 3", []],
  ["2024\n- did stuff", []],
  ["1\ntruex", []],
  ["1\nTrue", []],
  ['[0] {"kind":"first"}', [{ kind: "first" }]],
  ['[1] {"n":1}\n[2] {"n":2}', [{ n: 1 }, { n: 2 }]],
  ['{"a":1} 3', [{ a: 1 }]],
  ['x\n{"b": 1}', [{ b: 1 }]],
  ['txt {"a":1} txt', [{ a: 1 }]],
  ['{"a":1} then {"b":2}', [{ a: 1 }, { b: 2 }]],
];

describe("an input made only of values", () => {
  for (const [name, options] of POLICIES) {
    it(`reads every root, and only those, under ${name}`, () => {
      for (const [text, roots] of [...RUNS, ...NOT_RUNS]) {
        const many = [...parseMany(text, options)].map((r) =>
          r.ok ? r.value : `failed ${r.failure.kind}`,
        );
        const want = roots.length === 0 ? ["failed no-json-found"] : roots;
        expect(many, text).toEqual(want);
        expect(streamed(text, options), text).toEqual(want);
        const one = parse(text, options);
        expect(one.ok ? one.value : `failed ${one.failure.kind}`, text).toEqual(want[0]);
      }
    });
  }

  it("reads the JavaScript literals its policy reads, and no others", () => {
    expect([...parseMany("1\nNaN\n-Infinity")].map((r) => r.ok && r.value)).toEqual([
      1,
      Number.NaN,
      -Infinity,
    ]);
    expect(verdict(parse("1\nNaN", STRICT))).toBe("no-json-found");
  });
});

/**
 * Values joined by commas are one array the source forgot to bracket (`missing-brackets`). Each row
 * gives every root `parseMany` reads, then the repaired text of the first. Beside them sit the
 * nearest texts that must not become a list: a comma that does not touch the value, prose after
 * the comma, and a list led by a value with no mark of data that does not stand alone.
 */
const LISTS: ReadonlyArray<readonly [string, unknown[], string]> = [
  ["1,2,3", [[1, 2, 3]], "[1,2,3]"],
  ['"a", "b"', [["a", "b"]], '["a", "b"]'],
  ["true,false", [[true, false]], "[true,false]"],
  ['{"a":1},{"b":2}', [[{ a: 1 }, { b: 2 }]], '[{"a":1},{"b":2}]'],
  ["[1],[2]", [[[1], [2]]], "[[1],[2]]"],
  ["/* 1 */\n{},\n/* 2 */\n{}", [[{}, {}]], "[{},\n\n{}]"],
  ["1,2,3,", [[1, 2, 3]], "[1,2,3]"],
  ['{"a":1},{"b":2} and more', [[{ a: 1 }, { b: 2 }]], '[{"a":1},{"b":2}]'],
  ['{"a":1},{"b":2}\n{"c":3}', [[{ a: 1 }, { b: 2 }], { c: 3 }], '[{"a":1},{"b":2}]'],
  ["1,2\n3", [[1, 2], 3], "[1,2]"],
];
const NOT_LISTS: ReadonlyArray<readonly [string, unknown[]]> = [
  ['{"a":1},', [{ a: 1 }]],
  ["[1],", [[1]]],
  ['{"a":1}, and more', [{ a: 1 }]],
  ['{"a":1} ,{"b":2}', [{ a: 1 }, { b: 2 }]],
  ["1 , 2", []],
  ["1, 2 and 3", []],
  ["1, and so on", []],
  ['"a", "b" or "c"', []],
  // Only JSON's own spellings lead a list, as they continue a run of roots.
  ["'a','b'", []],
];

describe("values joined by commas", () => {
  it("are one array, whole, per character and repaired, and only those", () => {
    for (const [text, roots, repaired] of [
      ...LISTS,
      ...NOT_LISTS.map(([t, r]) => [t, r, ""] as const),
    ]) {
      const want = roots.length === 0 ? ["failed no-json-found"] : roots;
      const many = [...parseMany(text)].map((r) => (r.ok ? r.value : `failed ${r.failure.kind}`));
      expect(many, text).toEqual(want);
      expect(streamed(text, {}), text).toEqual(want);
      if (repaired === "") continue;
      const fixed = repair(text);
      expect(fixed.ok && fixed.value, text).toBe(repaired);
      expect(JSON.parse(repaired), text).toEqual(want[0]);
    }
  });

  it("reports the brackets once, and every other path inside the list", () => {
    const one = parse("1,{'b':2}", { diagnostics });
    expect(one.ok && one.diagnostics.repairs.map((r) => [r.kind, r.path])).toEqual([
      ["missing-brackets", []],
      // A key's repair names the member it opens, before the key is known.
      ["single-quote", [1]],
    ]);
    // A list of one is its root again, with its own paths.
    const single = parse("{'a':1},", { diagnostics });
    expect(single.ok && single.diagnostics.repairs.map((r) => [r.kind, r.path])).toEqual([
      ["single-quote", []],
    ]);
    // Paths recorded before the comma showed a list are moved inside it.
    const first = parse("{'a':1},2", { diagnostics });
    expect(first.ok && first.diagnostics.repairs.map((r) => [r.kind, r.path])).toEqual([
      ["single-quote", [0]],
      ["missing-brackets", []],
    ]);
  });

  it("shows a list in a stream's view only once its second value begins", () => {
    // A preview must never show `[root]` and then take the brackets back: the comma alone makes no
    // list (`{"a":1},` reads `{"a":1}`), so the view stays the root until a value follows it.
    const sp = createStreamParser({ view: ownedView });
    const views: unknown[] = [];
    for (const ch of '{"a":1}, {"b":2}') {
      void [...sp.feed(ch)];
      const r = sp.snapshot();
      views.push(r.ok ? r.value?.value : r.failure.kind);
    }
    const listFrom = views.findIndex((v) => Array.isArray(v));
    expect(listFrom).toBe('{"a":1}, {'.length - 1);
    expect(views.slice(0, listFrom).every((v) => !Array.isArray(v))).toBe(true);
    expect(views.slice(listFrom).every((v) => Array.isArray(v))).toBe(true);
    expect(views.at(-1)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("refuses the brackets when the policy does, keeping the list as recovery", () => {
    const strict = parse("1,2", STRICT);
    expect(strict).toMatchObject({
      ok: false,
      failure: {
        kind: "policy-refused",
        issue: { refused: "missing-brackets", path: [] },
        recovered: { value: [1, 2], complete: true },
      },
    });
  });
});

const LIMITED: ParserOptions = { maxDepth: 2 };

/** `found`, or the failure kind. */
const verdict = (r: { ok: boolean; failure?: { kind: string } }): string =>
  r.ok ? "found" : (r.failure?.kind ?? "");

describe("a mark of data past the depth limit", () => {
  // A depth stop leaves the refused subtree unread, which says nothing about whether the source is
  // JSON. So a prose candidate whose only mark lies past the limit must still be found, and fail as
  // `limit-reached`, exactly when the same text without the limit is found.
  it.each([
    "[[[1]]]",
    "[[[1,2]]]",
    '[[["a"]]]',
    "[[['a']]]",
    "[[{a:1}]]",
    "[[[a:1]]]",
    "[[{}]]",
    "[[[],[]]]",
    "[1,[[2]]]",
    "[[[it's]]]",
  ])("finds see %s here exactly when the unlimited parse does", (inner) => {
    const text = `see ${inner} here`;
    const found = verdict(parse(text)) === "found";
    const want = found ? "limit-reached" : "no-json-found";
    expect(verdict(parse(text, LIMITED)), text).toBe(want);
    expect(streamed(text, LIMITED), text).toEqual([`failed ${want}`]);
  });
});
