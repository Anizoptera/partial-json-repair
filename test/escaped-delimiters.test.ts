// SPDX-License-Identifier: Apache-2.0

/** Recover escaped structural delimiters without changing backslashes in values. */
import { expect, it } from "vitest";
import { createStreamParser, parse, repair, diagnostics } from "../src/index";

const input = '{"a": "x"\\, "b"\\: "z"}';

it("keeps members and emits valid JSON when delimiters have stray escapes", () => {
  expect(parse(input)).toMatchObject({ ok: true, value: { a: "x", b: "z" } });
  const fixed = repair(input);
  expect(fixed.ok).toBe(true);
  if (fixed.ok) {
    expect(fixed.value).toBe('{"a": "x", "b": "z"}');
    expect(JSON.parse(fixed.value)).toEqual({ a: "x", b: "z" });
  }
});

it("waits for an escaped delimiter across every input split", () => {
  for (const text of [
    input,
    "{a\\:1\\,b\\:true\\}",
    '{"a":\\[1,2\\]\\}',
    "[-Infinity\\,2]",
    "[-Infinityx]",
    "[-Infinity 2]",
  ]) {
    const expected = parse(text);
    for (let split = 0; split <= text.length; split++) {
      const built = createStreamParser();
      expect([
        ...built.feed(text.slice(0, split)),
        ...built.feed(text.slice(split)),
        ...built.end(),
      ]).toMatchObject([expected]);
    }
  }
});

it("refuses disabled delimiter recovery and retains both members", () => {
  for (const report of [false, diagnostics] as const) {
    const options = { diagnostics: report, recover: { "escaped-delimiter": false } };
    expect(parse(input, options)).toMatchObject({
      ok: false,
      failure: { kind: "policy-refused", recovered: { value: { a: "x", b: "z" } } },
    });
    expect(repair(input, options).ok).toBe(false);
  }
});

it("handles escaped openers and closers without inventing members", () => {
  const text = '{"a":\\[1,2\\]\\}';
  expect(repair(text)).toMatchObject({ ok: true, value: '{"a":[1,2]}' });
  expect(parse(text, { diagnostics })).toMatchObject({
    ok: true,
    value: { a: [1, 2] },
    diagnostics: { confidence: 1 },
  });
});

it("keeps negative infinity numeric before escaped delimiters", () => {
  expect(parse("[-Infinity\\,2]")).toMatchObject({ ok: true, value: [-Infinity, 2] });
  expect(parse("[-Infinity 2]")).toMatchObject({ ok: true, value: [-Infinity, 2] });
  expect(parse("[-Infinityx]")).toMatchObject({ ok: true, value: ["-Infinityx"] });
});

it("leaves quoted and bare backslash content intact", () => {
  expect(parse('{"a":"x\\\\,y", "b": C:\\folder}')).toMatchObject({
    ok: true,
    value: { a: "x\\,y", b: "C:\\folder" },
  });
  expect(parse("{a:foo\\:bar}")).toMatchObject({ ok: true, value: { a: "foo\\:bar" } });
});

it("drops a member without retaining its trivia or deleting its neighbor", () => {
  for (const [text, options, value] of [
    ["{\\:}", {}, {}],
    ["{ /*x*/ :}", {}, {}],
    ["{a:1,b:2 c}", {}, { a: 1, b: 2 }],
    ['{"a":"x","b":"z"\\\\}', {}, { a: "x", b: "z" }],
    [input, { customDangerousKeys: ["a"], onDangerousKey: "drop" }, { b: "z" }],
  ] as const) {
    const fixed = repair(text, options);
    expect(fixed.ok).toBe(true);
    if (fixed.ok) expect(JSON.parse(fixed.value)).toEqual(value);
  }
});
