// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ParserOptions, Span } from "../src/index";
import {
  diagnostics,
  findJsonSpan,
  locations,
  parse,
  parseMany,
  repair,
  STRICT,
} from "../src/index";
import { auto, findJsonSpanAsync, parseAsync, repairAsync, cooperative } from "../src/async";
import { differentialInputs, slices } from "./corpus-population";

/**
 * `parse`, `repair` and `findJsonSpan` return one value. A reply holding two objects used to read
 * exactly like one holding the first, even in a requested report, which hides a loss HLD Purpose
 * requires to stay available. The report's `laterValues` lists the rest, defined as what
 * `parseMany` with the same options delivers after the returned value, so the oracle here is
 * `parseMany` itself rather than a hand-written expectation that could drift from detection.
 */
const manySpans = (text: string, options: ParserOptions): Span[] => {
  const spans: Span[] = [];
  for (const r of parseMany(text, { ...options, locations })) if (r.ok) spans.push(r.span);
  return spans;
};

const INPUTS: readonly (readonly [text: string, options: ParserOptions])[] = [
  ['{"a":1}\n{"b":2}', {}],
  ['{"a":1}{"b":2}\n[3]', {}],
  ["{a:1}\n{b:2", {}],
  ['```json\n{"a":1}\n```\nand\n```json\n{"b":2}\n```', {}],
  // The returned root is not the first one; later values are the ones after it.
  ['[1]\n{"a":1}\n[2]\n{"b":2}', { objectOnly: true }],
];

describe("laterValues", () => {
  it("lists what parseMany delivers after the returned value, on every single-value verb", async () => {
    // Each input is independent, so its async calls run together.
    const checks = INPUTS.map(async ([text, options]) => {
      const all = manySpans(text, options);
      const located = parse(text, { ...options, locations });
      const at = all.findIndex((s) => located.ok && s.start.offset === located.span.start.offset);
      expect(at, text).toBeGreaterThanOrEqual(0);
      const expected = all.slice(at + 1);
      expect(expected.length, text).toBeGreaterThan(0);
      const reported = { ...options, diagnostics };
      const asynchronous = await Promise.all([
        parseAsync(text, { ...reported, execution: auto }),
        repairAsync(text, { ...reported, execution: auto }),
        findJsonSpanAsync(text, { ...reported, execution: auto }),
        parseAsync(text, { ...reported, execution: cooperative }),
      ]);
      for (const result of [
        parse(text, reported),
        repair(text, reported),
        findJsonSpan(text, reported),
        ...asynchronous,
      ]) {
        expect(result.ok, text).toBe(true);
        expect(result.diagnostics?.laterValues, text).toEqual(expected);
        expect(result.diagnostics?.entriesComplete, text).toBe(true);
      }
    });
    await Promise.all(checks);
  });

  // Bytes report byte offsets and take the same whitespace shortcut through `positionAt`.
  it("lists byte spans for UTF-8 input, and nothing when only whitespace follows", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const text = '{"é":1}\n{"b":"ü"}\n';
    const spans: Span[] = [];
    for (const r of parseMany(bytes(text), { locations })) if (r.ok) spans.push(r.span);
    expect(spans[1]?.start).toEqual({ offset: 9, unit: "byte" });
    expect(parse(bytes(text), { diagnostics }).diagnostics.laterValues).toEqual(spans.slice(1));
    expect(parse(bytes('{"é":1}\n \t\r\n'), { diagnostics }).diagnostics.laterValues).toEqual([]);
  });

  it("leaves the returned value and its repaired text unchanged", () => {
    const text = "{a:1}\n{b:2}";
    const r = repair(text, { diagnostics });
    expect(r.ok && r.value).toBe('{"a":1}');
    expect(r.diagnostics.repairs.map((x) => x.kind)).toEqual(["unquoted-key"]);
  });

  it("is empty when the rest is prose, a single value or no value", () => {
    for (const text of ['{"a":1} Hope this helps!', '{"a":1}', "[1] see [2]", "nothing"]) {
      expect(parse(text, { diagnostics }).diagnostics.laterValues, text).toEqual([]);
    }
  });

  it("stores at most maxEntries spans and says the list is incomplete", () => {
    const text = '{"a":1}\n' + '{"b":2}\n'.repeat(5);
    const r = parse(text, { diagnostics: diagnostics({ maxEntries: 2 }) });
    expect(r.diagnostics.laterValues).toHaveLength(2);
    expect(r.diagnostics.entriesComplete).toBe(false);
  });

  // `STRICT` spends its one error on `{c:3}`, so `{"d":4}` is never read by parseMany either. The
  // refused root is a later value (parseMany delivers it, refused); what follows it is unknown.
  it("marks the scan incomplete when the error budget stops it past the returned value", () => {
    const text = '{"a":1}\n{"b":2}\n{c:3}\n{"d":4}';
    const r = parse(text, { ...STRICT, diagnostics });
    expect(r.ok && r.value).toEqual({ a: 1 });
    expect(r.diagnostics.laterValues.map((s) => s.start.offset)).toEqual([8, 16]);
    expect(r.diagnostics.scanComplete).toBe(false);
    expect([...parseMany(text, STRICT)]).toHaveLength(3);
    // A refusal that does not stop the scan leaves it complete, and the refused root listed.
    const depth = parse('{"a":1}\n[[[1]]]\n{"b":2}', { maxDepth: 2, diagnostics });
    expect(depth.diagnostics.laterValues).toHaveLength(2);
    expect(depth.diagnostics.scanComplete).toBe(true);
  });
});

/**
 * HLD P4: without a report, a success still says a later value exists, so a caller reading only the
 * value is not handed the first of two answers as if it were the only one. Two mechanisms produce it:
 * the default path continues the returned value's reader, a requested report lists later values with
 * a second reader. The report's list is this test's oracle for the default path, over every corpus
 * input, prefix and mutation, so the two cannot drift apart.
 */
describe("more", () => {
  let withMore = 0;
  it.each(slices(differentialInputs()).map((s) => [s.range, s.items] as const))(
    "is set exactly when a report would list later values, on every single-value verb (%s)",
    (_range, inputs) => {
      for (const { text, origin } of inputs) {
        const later = parse(text, { diagnostics });
        const expected = later.ok && later.diagnostics.laterValues.length > 0 ? true : undefined;
        for (const [verb, result] of [
          ["parse", parse(text)],
          ["repair", repair(text)],
          ["findJsonSpan", findJsonSpan(text)],
        ] as const) {
          if (!result.ok) continue;
          expect(result.more, `${verb} ${origin}`).toBe(expected);
        }
        if (expected) withMore++;
      }
    },
  );

  // Runs after the slices: a population with no later values would pass them by never testing the field.
  it("found later values in the population", () => {
    expect(withMore).toBeGreaterThan(50);
  });

  it("says a later value exists without a report, and is absent otherwise", () => {
    expect(parse('{"a":1}\n{"b":2}')).toEqual({
      ok: true,
      value: { a: 1 },
      complete: true,
      more: true,
    });
    for (const text of [
      '{"a":1} Hope this helps!',
      '```json\n{"a":1}\n```',
      '{"a":1}\n',
      '{"a":1},{"b":2}',
    ])
      expect(parse(text), text).not.toHaveProperty("more");
  });
});
