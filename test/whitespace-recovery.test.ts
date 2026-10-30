// SPDX-License-Identifier: Apache-2.0

/** Repair token spacing without changing whitespace that belongs to a value. */
import { expect, it } from "vitest";
import { createStreamParser, parse, repair, STRICT, diagnostics } from "../src/index";

const spaces = [
  "\u000B",
  "\u000C",
  "\u00A0",
  "\u1680",
  "\u2000",
  "\u2002",
  "\u2028",
  "\u2029",
  "\u202F",
  "\u205F",
  "\u3000",
  "\uFEFF",
];

it("repairs non-JSON spacing around tokens while preserving string contents", () => {
  for (const space of spaces) {
    const input = `{${space}"a"${space}:${space}"x${space}y"${space},${space}"b":1${space}}`;
    const value = { a: `x${space}y`, b: 1 };
    expect(parse(input)).toMatchObject({ ok: true, value });
    const fixed = repair(input);
    expect(fixed.ok).toBe(true);
    if (fixed.ok) expect(JSON.parse(fixed.value)).toEqual(value);
  }
});

it("keeps trailing-space locations after releasing earlier source chunks", () => {
  const body = `x${"\u2000".repeat(40)}y`;
  const text = `{a:${body}\u3000${" ".repeat(40)}}`;
  for (const source of [text, new TextEncoder().encode(text)]) {
    const built = createStreamParser({ maxBuffer: 8, maxRetained: 1024, diagnostics });
    const items = [];
    for (let i = 0; i < source.length; i++) items.push(...built.feed(source.slice(i, i + 1)));
    items.push(...built.end());
    expect(items).toHaveLength(1);
    for (const item of items) {
      expect(item).toMatchObject({ ok: true, value: { a: body } });
      expect(
        item.diagnostics.repairs.filter((r) => r.kind === "non-json-whitespace"),
      ).toMatchObject([
        {
          at: {
            offset: 0,
            chunk:
              typeof source === "string"
                ? text.indexOf("\u3000")
                : new TextEncoder().encode(`{a:${body}`).length,
          },
        },
      ]);
    }
  }
});

it("keeps the root token and its refusal when leading trivia spends the error budget", () => {
  for (const prefix of ["/*x*/", "\u2000"]) {
    for (const suffix of ["", " ", "\u3000"]) {
      expect(parse(`${prefix}42${suffix}`, STRICT)).toMatchObject({
        ok: false,
        failure: { kind: "policy-refused", recovered: { value: 42 } },
      });
    }
  }
});

it("does not treat other Unicode characters as spacing or prose brackets as data", () => {
  expect(parse("{a:foo\u0085}")).toMatchObject({ ok: true, value: { a: "foo\u0085" } });
  for (const input of ["[1]\u2000citation", "see\u2000[1]", "42\u2000words"]) {
    expect(parse(input)).toMatchObject({ ok: false, failure: { kind: "no-json-found" } });
    const built = createStreamParser();
    const items = [];
    for (const c of input) items.push(...built.feed(c));
    items.push(...built.end());
    expect(items).toEqual([{ ok: false, failure: { kind: "no-json-found" } }]);
  }
});

it("retracts a held prose token's confidence before delivering later JSON", () => {
  const built = createStreamParser({ diagnostics });
  expect([...built.feed("prefix ")]).toEqual([]);
  expect([...built.feed("[1,2]"), ...built.end()]).toMatchObject([
    { ok: true, value: [1, 2], diagnostics: { confidence: 1, repairs: [] } },
  ]);
});

it("repairs trailing bare-token spacing without splitting the value", () => {
  for (const space of spaces) {
    for (const [input, value] of [
      [`{a:foo${space}bar${space}}`, { a: `foo${space}bar` }],
      [`{a:true${space}}`, { a: true }],
      [`{a${space}:1}`, { a: 1 }],
      [`${space}42${space}`, 42],
      [`${space}[1]${space}`, [1]],
      [`{a:foo${space}// note\n,b:2}`, { a: "foo", b: 2 }],
    ] as const) {
      expect(parse(input)).toMatchObject({ ok: true, value });
      const fixed = repair(input);
      expect(fixed.ok).toBe(true);
      if (fixed.ok) expect(JSON.parse(fixed.value)).toEqual(value);
    }
  }
});

it("refuses whitespace recovery independently and locates the source character", () => {
  const text = "{a:foo\u2000bar\u3000}";
  const offset = text.indexOf("\u3000");
  for (const input of [text, new TextEncoder().encode(text)]) {
    for (const report of [false, diagnostics] as const) {
      const result = parse(input, {
        diagnostics: report,
        recover: { "non-json-whitespace": false },
      });
      expect(result).toMatchObject({
        ok: false,
        failure: {
          kind: "policy-refused",
          recovered: { value: { a: "foo\u2000bar" } },
          issue: {
            refused: "non-json-whitespace",
            at: {
              offset:
                typeof input === "string"
                  ? offset
                  : new TextEncoder().encode(text.slice(0, offset)).length,
              unit: typeof input === "string" ? "utf16" : "byte",
            },
          },
        },
      });
      expect(repair(input, { recover: { "non-json-whitespace": false } }).ok).toBe(false);
    }
  }
});

it("keeps token spacing behavior across text and UTF-8 chunk boundaries", () => {
  const input = '{\u00A0"a":foo\u2000bar\u3000,"b":true\uFEFF}';
  const expected = { ok: true, value: { a: "foo\u2000bar", b: true } };
  for (const source of [input, new TextEncoder().encode(input)]) {
    for (let split = 0; split <= source.length; split++) {
      const built = createStreamParser();
      expect([
        ...built.feed(source.slice(0, split)),
        ...built.feed(source.slice(split)),
        ...built.end(),
      ]).toMatchObject([expected]);
    }
  }
});
