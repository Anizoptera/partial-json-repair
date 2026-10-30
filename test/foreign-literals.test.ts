// SPDX-License-Identifier: Apache-2.0

/** Recognize complete foreign literals without converting quoted content or word prefixes. */
import { describe, expect, it } from "vitest";
import { createStreamParser, parse, repair, diagnostics } from "../src/index";

const cases = [
  ["True", true, "literal-case"],
  ["FALSE", false, "literal-case"],
  ["nUlL", null, "literal-case"],
  ["None", null, "null-alias"],
  ["NIL", null, "null-alias"],
] as const;

describe("foreign literals", () => {
  it.each(cases)("recovers %s and repairs only its spelling", (word, value, kind) => {
    const text = `[ ${word} ]`;
    expect(parse(text, { diagnostics })).toMatchObject({
      ok: true,
      value: [value],
      diagnostics: { repairs: [{ kind }] },
    });
    expect(repair(text)).toMatchObject({ ok: true, value: `[ ${String(value)} ]` });
  });

  it.each(cases)(
    "refuses %s without silently recovering a different value",
    (word, value, kind) => {
      expect(parse(`[${word}]`, { diagnostics, recover: { [kind]: false } })).toMatchObject({
        ok: false,
        failure: { kind: "policy-refused", recovered: { value: [value] } },
        diagnostics: { errors: [{ refused: kind }] },
      });
    },
  );

  it.each(cases)("keeps %s intact across every split", (word, value) => {
    const text = `[${word}]`;
    for (let split = 0; split <= text.length; split++) {
      const built = createStreamParser();
      const items = [
        ...built.feed(text.slice(0, split)),
        ...built.feed(text.slice(split)),
        ...built.end(),
      ];
      expect(items).toMatchObject([{ ok: true, value: [value] }]);
    }
  });

  it("preserves quoted words, keys, prefixes and longer unquoted text", () => {
    expect(repair("[ words ]")).toMatchObject({ ok: true, value: '[ "words" ]' });
    expect(parse('{True:"False",None:"nil",words:[Trueish,nilsson,None left]}')).toMatchObject({
      ok: true,
      value: { True: "False", None: "nil", words: ["Trueish", "nilsson", "None left"] },
    });
    expect(parse("[true,false,null]", { diagnostics })).toMatchObject({
      ok: true,
      value: [true, false, null],
      diagnostics: { repairs: [] },
    });
  });
});
