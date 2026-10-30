// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * The exact-number contract: which tokens become one, what each conversion refuses, and that
 * `stringify` writes them back losslessly while refusing everything JSON cannot spell.
 */
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import type { ExactNumber } from "../src/index";
import { createStreamParser, isExactNumber, parse, repair, stringify } from "../src/index";
import { configurationCause } from "./configuration-error";
import { costRatio } from "./cost-ratio";
import { decompose, needsExact } from "../src/number-fidelity";
import { ownedView } from "../src/index";

const exact = (src: string, options: { exactNumbers?: boolean } = {}): unknown[] => {
  const r = parse(src, options);
  if (!r.ok) throw new Error(r.failure.kind);
  return (r.value as unknown[]).map((v) => (isExactNumber(v) ? { text: v.text } : v));
};

describe("which numbers are exact", () => {
  it.each(["[-]", '{"a": -}'])("keeps a sign without digits as text in exact mode: %s", (text) => {
    const ordinary = parse(text);
    expect(parse(text, { exactNumbers: true })).toEqual(ordinary);
    const repaired = repair(text, { exactNumbers: true });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok || !ordinary.ok) return;
    expect(JSON.parse(repaired.value)).toEqual(ordinary.value);
  });

  it("ignores inherited descriptor values for brands and encoded members", () => {
    const key = Symbol.for("partial-json-repair.exact-number");
    const candidate = {
      get [key]() {
        throw new Error("brand getter ran");
      },
    };
    const valid = parse("9007199254740993");
    if (!valid.ok) throw new Error(valid.failure.kind);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    const member = {
      get g() {
        throw new Error("member getter ran");
      },
    };
    let reads = 0;
    let accepted: boolean | undefined;
    let retained: boolean | undefined;
    let encoded: ReturnType<typeof stringify> | undefined;
    try {
      // eslint-disable-next-line no-extend-native -- This regression injects the polluted descriptor prototype and restores it synchronously.
      Object.defineProperty(Object.prototype, "value", {
        configurable: true,
        get() {
          reads++;
          return true;
        },
      });
      accepted = isExactNumber(candidate);
      retained = isExactNumber(valid.value);
      encoded = stringify(member);
    } finally {
      // Restore before assertions: the runner also constructs property descriptors.
      Reflect.deleteProperty(Object.prototype, "value");
      // eslint-disable-next-line no-extend-native -- Restore any pre-existing descriptor after removing the injected getter.
      if (previous !== undefined) Object.defineProperty(Object.prototype, "value", previous);
    }
    expect(accepted).toBe(false);
    expect(retained).toBe(true);
    expect(encoded).toEqual({ ok: false, failure: { kind: "accessor", path: ["g"] } });
    expect(reads).toBe(0);
  });

  it("does not execute exact-number brand or text accessors", () => {
    let reads = 0;
    const branded = {
      [Symbol.for("partial-json-repair.exact-number")]: true,
      get text() {
        reads++;
        return "1";
      },
    };
    expect(stringify(branded)).toMatchObject({
      ok: false,
      failure: { kind: "accessor", path: ["text"] },
    });
    const brandGetter = {
      get [Symbol.for("partial-json-repair.exact-number")]() {
        reads++;
        return true;
      },
    };
    expect(isExactNumber(brandGetter)).toBe(false);
    stringify(brandGetter);
    expect(reads).toBe(0);
  });
  it("protects integers past 2^53, overflow and nonzero underflow, and nothing else", () => {
    expect(exact("[9007199254740992, 9007199254740993, 1e400, 1e-400, 0.1, -0, 0e999999]")).toEqual(
      [
        9007199254740992,
        { text: "9007199254740993" },
        { text: "1e400" },
        { text: "1e-400" },
        0.1,
        -0,
        0,
      ],
    );
  });

  it("compares long plain integers with the double's mathematical value", () => {
    expect(exact("[1000000000000000100, 1000000000000000128]")).toEqual([
      { text: "1000000000000000100" },
      1000000000000000100,
    ]);
  });

  it("keeps every number under exactNumbers, spelling intact", () => {
    expect(exact("[1, -0, 0.10, 1E2]", { exactNumbers: true })).toEqual([
      { text: "1" },
      { text: "-0" },
      { text: "0.10" },
      { text: "1E2" },
    ]);
  });

  it("is a brand, not a shape", () => {
    expect(isExactNumber({ text: "1e400" })).toBe(false);
    expect(isExactNumber({ text: "1" })).toBe(false);
    expect(isExactNumber(null)).toBe(false);
  });

  it("survives a snapshot and a repair with its digits", () => {
    const built = createStreamParser({ exactNumbers: true, view: ownedView });
    // A number is settled only by the delimiter after it, so the comma is what puts it in the tree.
    void Array.from(built.feed('{"a": 0.1, "b": [1e400, '));
    const seen = built.snapshot();
    if (!seen.ok) throw new Error(seen.failure.kind);
    const copy = seen.value?.value as { a: unknown; b: unknown[] };
    expect(isExactNumber(copy.a) && copy.a.text).toBe("0.1");
    expect(isExactNumber(copy.b[0]) && copy.b[0].text).toBe("1e400");
    // Text is spliced, never re-serialised, so the token is byte-identical; a hex literal is the
    // one rewrite, and it is to exact digits.
    expect(repair("[1e400, 12345678901234567890]")).toEqual({
      ok: true,
      complete: true,
      value: "[1e400, 12345678901234567890]",
    });
    expect(repair("[0x20000000000001]", { allowJavaScript: true })).toEqual({
      ok: true,
      complete: true,
      value: "[9007199254740993]",
    });
  });
});

/** The exact number a bare token parses to. */
const of = (text: string): ExactNumber => {
  const r = parse(text, { exactNumbers: true });
  if (!r.ok || !isExactNumber(r.value)) throw new Error(text);
  return r.value;
};

describe("conversions", () => {
  it("toNumber is exact unless rounding is allowed; overflow and underflow never convert", () => {
    expect(of("0.5").toNumber()).toEqual({ ok: true, value: 0.5 });
    expect(of("-0").toNumber()).toEqual({ ok: true, value: -0 });
    expect(of("1e2").toNumber()).toEqual({ ok: true, value: 100 });
    expect(of("0.1").toNumber()).toEqual({ ok: false, failure: { kind: "inexact" } });
    expect(of("0.1").toNumber({ allowRounding: true })).toEqual({ ok: true, value: 0.1 });
    expect(of("9007199254740993").toNumber()).toEqual({ ok: false, failure: { kind: "inexact" } });
    expect(of("1e400").toNumber({ allowRounding: true })).toEqual({
      ok: false,
      failure: { kind: "overflow" },
    });
    expect(of("1e-400").toNumber({ allowRounding: true })).toEqual({
      ok: false,
      failure: { kind: "underflow" },
    });
    // A denormal is rounding, not underflow: nonzero came back nonzero, so allowing rounding is
    // enough — and `5e-324` IS rounded, being the short spelling of 4.94…e-324.
    expect(of("5e-324").toNumber()).toEqual({ ok: false, failure: { kind: "inexact" } });
    expect(of("5e-324").toNumber({ allowRounding: true })).toEqual({ ok: true, value: 5e-324 });
  });

  it("toBigInt needs an integer and bounds the expansion before doing it", () => {
    expect(of("12345678901234567890").toBigInt({ maxDigits: 20 })).toEqual({
      ok: true,
      value: 12345678901234567890n,
    });
    expect(of("-1.50e1").toBigInt({ maxDigits: 5 })).toEqual({ ok: true, value: -15n });
    expect(of("-0").toBigInt({ maxDigits: 1 })).toEqual({ ok: true, value: 0n });
    expect(of("1.5").toBigInt({ maxDigits: 5 })).toEqual({
      ok: false,
      failure: { kind: "not-integer" },
    });
    expect(of("1e-400").toBigInt({ maxDigits: 5 })).toEqual({
      ok: false,
      failure: { kind: "not-integer" },
    });
    expect(of("1e400").toBigInt({ maxDigits: 100 })).toEqual({
      ok: false,
      failure: { kind: "digits-exceeded", digits: 401, maxDigits: 100 },
    });
    expect(of("1e999999999").toBigInt({ maxDigits: 100 }).ok).toBe(false);
    // Integrality before size: raising `maxDigits`, as `digits-exceeded` advises, must not then
    // reveal that the value was never an integer.
    expect(of("12.5").toBigInt({ maxDigits: 1 })).toEqual({
      ok: false,
      failure: { kind: "not-integer" },
    });
    expect(configurationCause(() => of("1").toBigInt({ maxDigits: 0 }))).toEqual({
      kind: "invalid-options",
      field: "maxDigits",
      reason: "positive-integer",
    });
  });

  it("checks long fractions at the cost of linear decomposition", () => {
    // Compare the fidelity decision with its linear prerequisite: parser route and string-scanner
    // costs differ by runtime and can conceal an unnecessary conversion of every digit to BigInt.
    const digits = "1".repeat(2_000_000);
    const fraction = `1.${digits}`;
    const ratio = costRatio(
      () => needsExact(fraction),
      () => decompose(fraction),
    );
    expect(ratio).toBeLessThan(5);
  });

  it("refuses helper options it cannot honour instead of reading them as the defaults", () => {
    // A misspelt key once fell back silently: `allowRouding` meant exact, `maxOuput` the default bound.
    const refusals = [
      () => of("0.1").toNumber({ allowRouding: true } as never),
      () => of("0.1").toNumber({ allowRounding: "yes" } as never),
      () => of("1").toBigInt(undefined as never),
      () => stringify({}, { maxOuput: 1 } as never),
      () => stringify({}, null as never),
      () => stringify({}, { maxOutput: null } as never),
    ].map((call) => configurationCause(call));
    expect(refusals).toMatchObject([
      { field: "allowRouding", reason: "unknown" },
      { field: "allowRounding", reason: "boolean" },
      { field: "options", reason: "object" },
      { field: "maxOuput", reason: "unknown" },
      { field: "options", reason: "object" },
      { field: "maxOutput", reason: "positive-integer" },
    ]);
  });

  it("converts implicitly only losslessly, and lets native JSON.stringify emit raw digits", () => {
    const n = of("1e400");
    // A number hint would need unchecked rounding; NaN would flow on silently, so it throws.
    expect(() => Number(n)).toThrow(/toNumber\(\) or toBigInt/u);
    expect(() => +of("12345678901234567890")).toThrow(TypeError);
    // String and default hints get the exact source token. Implicit conversion is the subject here,
    // so the lint rules that forbid it on objects are suppressed for these two lines only.
    // oxlint-disable-next-line typescript/restrict-template-expressions
    expect(`${n}`).toBe("1e400");
    expect(String(of("-0"))).toBe("-0");
    // oxlint-disable-next-line typescript/restrict-plus-operands
    expect("id=" + of("12345678901234567890")).toBe("id=12345678901234567890");
    // Every supported runtime has `JSON.rawJSON`; where one did not, `toJSON` throws rather than
    // rounding, quoting or serialising `{ text }`.
    expect(JSON.stringify({ n })).toBe('{"n":1e400}');
  });
});

describe("stringify", () => {
  it("bounds escaped strings, keys and container punctuation at the exact output length", () => {
    for (const value of ["\n", "\uD800", { "\n": "\uD800" }, [true, null], { n: 123 }]) {
      const text = JSON.stringify(value);
      expect(stringify(value, { maxOutput: text.length })).toEqual({ ok: true, value: text });
      expect(stringify(value, { maxOutput: text.length - 1 })).toEqual({
        ok: false,
        failure: { kind: "limit-reached", resource: "output", limit: text.length - 1 },
      });
    }
  });

  it("encodes another realm's exact-number brand without constructor identity", () => {
    const foreign = runInNewContext(`(() => {
      class NumberToken { constructor() { this.text = "1e400"; } }
      Object.defineProperty(NumberToken.prototype,
        Symbol.for("partial-json-repair.exact-number"), { value: true });
      return new NumberToken();
    })()`) as unknown;
    expect(isExactNumber(foreign)).toBe(true);
    expect(stringify({ n: foreign })).toEqual({ ok: true, value: '{"n":1e400}' });
  });

  it("writes exact numbers unquoted and keeps everything else as JSON.stringify would", () => {
    const r = parse('{"a":[1,"s",true,null,{"b":1e400}],"c":-0,"d":0.5}', { exactNumbers: true });
    expect(r.ok && stringify(r.value)).toEqual({
      ok: true,
      value: '{"a":[1,"s",true,null,{"b":1e400}],"c":-0,"d":0.5}',
    });
    expect(stringify({ z: -0, e: 1e21, s: " \uD800" })).toEqual({
      ok: true,
      value: JSON.stringify({ z: -0, e: 1e21, s: " \uD800" }),
    });
    expect(stringify(Object.assign(Object.create(null) as object, { k: [] }))).toEqual({
      ok: true,
      value: '{"k":[]}',
    });
  });

  it("refuses a branded impostor instead of writing its text, and encodes another realm's objects", () => {
    // The brand is a registry symbol anyone can set; its text once went into the output verbatim.
    const brand = Symbol.for("partial-json-repair.exact-number");
    const impostor = { [brand]: true, text: '1,"injected":true' };
    expect(stringify({ n: impostor })).toEqual({
      ok: false,
      failure: { kind: "non-json-value", valueKind: "non-plain-object", path: ["n"] },
    });
    const realm = runInNewContext('({ a: [1, { b: "c" }] })') as unknown;
    expect(stringify(realm)).toEqual({ ok: true, value: JSON.stringify(realm) });
  });

  it("refuses what JSON cannot spell, at the path, instead of dropping or nulling it", () => {
    expect(stringify({ a: [1, undefined] })).toEqual({
      ok: false,
      failure: { kind: "non-json-value", valueKind: "undefined", path: ["a", 1] },
    });
    expect(stringify({ n: Number.NaN }).ok).toBe(false);
    expect(stringify(10n)).toEqual({
      ok: false,
      failure: { kind: "non-json-value", valueKind: "bigint", path: [] },
    });
    expect(stringify({ when: new Date(0) })).toEqual({
      ok: false,
      failure: { kind: "non-json-value", valueKind: "non-plain-object", path: ["when"] },
    });
    const loop: { self?: unknown } = {};
    loop.self = [loop];
    expect(stringify(loop)).toEqual({ ok: false, failure: { kind: "cycle", path: ["self", 0] } });
  });

  it("runs no caller code: getters are refused, toJSON is ignored, a throwing trap is a value", () => {
    let ran = false;
    const spy = {
      get g(): number {
        ran = true;
        return 1;
      },
    };
    expect(stringify({ spy })).toEqual({
      ok: false,
      failure: { kind: "accessor", path: ["spy", "g"] },
    });
    expect(ran).toBe(false);
    // A `toJSON` member is a function, which JSON cannot spell; it is reported, never called.
    expect(stringify({ toJSON: () => "x", v: 1 })).toEqual({
      ok: false,
      failure: { kind: "non-json-value", valueKind: "function", path: ["toJSON"] },
    });
    // Descriptor inspection can still run a proxy trap; its failure belongs to the value's path.
    const trap = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new RangeError("trap");
        },
      },
    );
    expect(stringify({ trap })).toEqual({
      ok: false,
      failure: { kind: "invalid-value", path: ["trap"], cause: expect.any(RangeError) as unknown },
    });
  });
});
