// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  COMPAT,
  createStreamParser,
  isExactNumber,
  parse,
  repair,
  diagnostics,
} from "../src/index";

/**
 * JavaScript number spellings with exactly one meaning: `0o17` is 15 and `1_000` is 1000 in both
 * JavaScript and Python, the two languages models imitate, so reading them as numbers guesses
 * nothing — the same rule that already reads `0x1f` as 31. A spelling either language rejects
 * (`0_1`, `1__0`, `0x_1`) is not a number in any grammar and keeps its source text.
 */
const read = (text: string, options: Parameters<typeof parse>[1] = {}) => {
  const r = parse(text, { ...options, diagnostics });
  if (!r.ok) throw new Error(`expected ok for ${text}: ${r.failure.kind}`);
  return {
    value: r.value,
    kinds: r.diagnostics.repairs.map((x) => x.kind),
    errors: r.diagnostics.errors.map((x) => x.kind),
  };
};

describe("numeric-looking words", () => {
  const options = {
    diagnostics,
    maxErrors: 1,
    recover: {
      "invalid-number": false,
      "leading-plus-number": false,
      "leading-dot-number": false,
      "numeric-separator": false,
      "hex-number": false,
    },
  } as const;

  it("applies word policy after a numeric prefix, at every chunk split", () => {
    for (const word of [
      "+1x",
      "1e+x",
      "01x",
      "0x1x",
      "1_0x",
      ".1x",
      "1é",
      "1漢",
      "1😀",
      "1\u0301",
      "1\uD800",
    ]) {
      const source = `{"a":${word}}`;
      const bytes = new TextEncoder().encode(source);
      const encodable = new TextDecoder().decode(bytes) === source;
      const expected = { ok: true, value: { a: word }, complete: true };
      const whole = parse(source, options);
      expect(whole, source).toMatchObject(expected);
      expect(whole.diagnostics.errors).toEqual([]);
      expect(parse(source, { ...options, diagnostics: false })).toMatchObject(expected);
      // UTF-8 preserves well-formed words; text input must also preserve lone surrogate units.
      if (encodable) expect(parse(bytes, options)).toMatchObject(expected);
      const repaired = repair(source, options);
      expect(repaired.ok).toBe(true);
      if (repaired.ok) expect(JSON.parse(repaired.value)).toEqual(expected.value);
      const inputs = encodable ? [source, bytes] : [source];
      for (const input of inputs)
        for (let split = 1; split < input.length; split++) {
          const stream = createStreamParser(options);
          try {
            const outcomes = [
              ...stream.feed(input.slice(0, split)),
              ...stream.feed(input.slice(split)),
              ...stream.end(),
            ];
            expect(outcomes, `${source} at ${split}`).toMatchObject([expected]);
            expect(outcomes.flatMap((outcome) => outcome.diagnostics.errors)).toEqual([]);
          } finally {
            stream.close();
          }
        }
    }
  });

  it("still refuses the actual numeric spellings", () => {
    for (const token of ["+1", "1e+", "01", "0x1", "1_0", ".1"]) {
      const result = parse(`{"a":${token}}`, options);
      expect(!result.ok && result.failure.kind, token).toBe("policy-refused");
      expect(result.diagnostics.errors).toHaveLength(1);
    }
  });

  it("preserves an earlier refusal without spending the budget on a later word", () => {
    const result = parse('{"a":1.,"b":+1x}', { ...options, maxErrors: 2 });
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "policy-refused",
        recovered: { value: { a: 1, b: "+1x" }, complete: true },
      },
    });
    expect(result.diagnostics.errors.map((error) => error.refused)).toEqual(["invalid-number"]);
  });
});

describe("octal literals", () => {
  it("reads 0o and 0O as base 8, signed or not", () => {
    expect(read("[0o17, 0O7, -0o10]")).toMatchObject({
      value: [15, 7, -8],
      kinds: ["octal-number", "octal-number", "octal-number"],
    });
  });

  it("keeps an octal literal past 2^53 exact", () => {
    const { value } = read("[0o7777777777777777777777]");
    const [n] = value as unknown[];
    expect(isExactNumber(n) && n.text).toBe(String(0o7777777777777777777777n));
  });

  it("returns the same value with the flag off and reports the refusal", () => {
    const off = parse("[0o17]", { allowJavaScript: false, diagnostics });
    expect(!off.ok && off.failure.kind).toBe("policy-refused");
    if (off.ok || off.failure.kind !== "policy-refused") return;
    expect(off.failure.recovered?.value).toEqual([15]);
  });
});

describe("numeric separators", () => {
  it("drops a single underscore between digits in every part and base", () => {
    expect(read("[1_000, 1_000_000, 1.5_5, 1e1_0, 0x1_f, 0b1_0, 0o1_7]")).toMatchObject({
      value: [1000, 1_000_000, 1.55, 1e10, 31, 2, 15],
    });
    expect(read("[1_000]").kinds).toEqual(["numeric-separator"]);
  });

  it("is a formatting repair: nothing was guessed, so confidence stays 1", () => {
    const r = parse("[1_000]", { diagnostics });
    expect(r.ok && r.diagnostics.confidence).toBe(1);
  });

  it("keeps the exact digits of a separated integer past 2^53", () => {
    const [n] = read("[9_007_199_254_740_993]").value as unknown[];
    expect(isExactNumber(n) && n.text).toBe("9007199254740993");
  });

  it("leaves every spelling JavaScript or Python rejects as its source text", () => {
    for (const bad of ["0_1", "1__0", "1_", "_1", "0x_1", "1_.5", "1._5", "1e_1", "1_e1"]) {
      expect(read(`[${bad}]`).value, bad).toEqual([bad]);
    }
  });

  it("splices the plain spelling into repaired text", () => {
    const r = repair("[1_000, 0o17]");
    expect(r.ok && (JSON.parse(r.value) as unknown)).toEqual([1000, 15]);
  });

  it("drops a separator cut off at the end of input, like any unfinished number", () => {
    expect(parse("[1, 2_")).toMatchObject({ ok: true, value: [1] });
  });

  it("keeps an unfinished separator missing in every radix and chunk split", () => {
    const options = {
      diagnostics,
      maxErrors: 1,
      recover: { "hex-number": false, "numeric-separator": false },
    } as const;
    for (const token of ["1_", "0b1_", "0o1_", "0x1_", "0X1_", "+0x1_", "-0x1_"]) {
      const source = `{"a":${token}`;
      const expected = {
        ok: true,
        value: {},
        complete: false,
        cut: { path: ["a"], kind: "missing", text: token },
      };
      expect(parse(source), token).toMatchObject(expected);
      expect(parse(source, options), token).toMatchObject(expected);
      for (let split = 1; split < source.length; split++) {
        const stream = createStreamParser(options);
        try {
          const outcomes = [
            ...stream.feed(source.slice(0, split)),
            ...stream.feed(source.slice(split)),
            ...stream.end(),
          ];
          expect(outcomes, `${token} at ${split}`).toMatchObject([expected]);
        } finally {
          stream.close();
        }
      }
    }
  });

  it("keeps hexadecimal letter digits as numbers at EOF", () => {
    expect(parse('{"a":0x1e')).toMatchObject({ ok: true, value: { a: 30 } });
    expect(parse('{"a":0x1b')).toMatchObject({ ok: true, value: { a: 27 } });
  });
});

describe("leading zeros", () => {
  // No grammar gives `0123` a decimal value: JavaScript reads it as octal 83 or rejects it, Python
  // rejects it. Dropping the zero would destroy a postal code or an id for good, while the source
  // text loses nothing, so the default keeps the text and `COMPAT` keeps the old decimal reading.
  it("keeps a leading-zero number as the text the source wrote", () => {
    expect(read("[0123, 00042, -012, 007.5]")).toMatchObject({
      value: ["0123", "00042", "-012", "007.5"],
      kinds: ["invalid-number", "invalid-number", "invalid-number", "invalid-number"],
    });
    expect(read("{zip: 02134}").value).toEqual({ zip: "02134" });
  });

  it("splices the text into repaired output", () => {
    const r = repair("[0123]");
    expect(r.ok && (JSON.parse(r.value) as unknown)).toEqual(["0123"]);
  });

  it("reads the old decimal value under COMPAT, as the legacy callers did", () => {
    expect(read("{octal: 0123, zero: 00042}", COMPAT)).toMatchObject({
      value: { octal: 123, zero: 42 },
      kinds: ["unquoted-key", "leading-zero-number", "unquoted-key", "leading-zero-number"],
    });
    expect(read("[0123]", { recover: { "leading-zero-number": true } }).value).toEqual([123]);
  });

  it("leaves every ordinary zero-led number alone", () => {
    expect(read("[0, -0, 0.5, 0e5, 0o17]")).toMatchObject({
      value: [0, -0, 0.5, 0, 15],
      kinds: ["octal-number"],
    });
  });
});
