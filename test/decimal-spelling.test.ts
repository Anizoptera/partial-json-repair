// SPDX-License-Identifier: Apache-2.0

/** Recover numeric prefixes without rounding digits or accepting a word's numeric prefix. */
import { describe, expect, it } from "vitest";
import { createStreamParser, parse, repair, stringify, diagnostics } from "../src/index";

const cases = [
  ["0", "0", []],
  ["-0", "-0", []],
  ["9007199254740993", "9007199254740993", []],
  ["-9007199254740993", "-9007199254740993", []],
  [".50", "0.50", ["leading-dot-number"]],
  ["-.0", "-0.0", ["leading-dot-number"]],
  ["+5", "5", ["leading-plus-number"]],
  ["+.50E+2", "0.50E+2", ["leading-plus-number", "leading-dot-number"]],
  ["+9007199254740993", "9007199254740993", ["leading-plus-number"]],
  [".1e-400", "0.1e-400", ["leading-dot-number"]],
  ["+0x20000000000001", "9007199254740993", ["leading-plus-number", "hex-number"]],
] as const;

describe("decimal spelling", () => {
  it.each(cases)("preserves %s as a number and changes only its spelling", (raw, json, kinds) => {
    const input = `[ ${raw} ]`;
    const parsed = parse(input, { exactNumbers: true, diagnostics });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(stringify(parsed.value)).toEqual({ ok: true, value: `[${json}]` });
    expect(parsed.diagnostics.repairs.map(({ kind }) => kind)).toEqual(kinds);
    expect(repair(input)).toEqual({ ok: true, complete: true, value: `[ ${json} ]` });
    const root = parse(raw, { exactNumbers: true });
    expect(root.ok && stringify(root.value)).toEqual({ ok: true, value: json });
    for (const kind of kinds) {
      const refused = parse(input, { exactNumbers: true, recover: { [kind]: false } });
      expect(refused).toMatchObject({ ok: false, failure: { kind: "policy-refused" } });
      if (!refused.ok && refused.failure.kind === "policy-refused")
        expect(refused.failure.recovered?.value).toEqual(parsed.value);
    }
  });

  it.each(cases)("settles %s only after the delimiter across every split", (raw, json) => {
    const input = `[${raw}]`;
    for (let split = 0; split <= input.length; split++) {
      const built = createStreamParser({ exactNumbers: true });
      const items = [
        ...built.feed(input.slice(0, split)),
        ...built.feed(input.slice(split)),
        ...built.end(),
      ];
      expect(items).toHaveLength(1);
      for (const item of items) {
        expect(item.ok).toBe(true);
        if (item.ok) expect(stringify(item.value)).toEqual({ ok: true, value: `[${json}]` });
      }
    }
  });

  it("keeps nonnumeric and quoted tokens whole", () => {
    expect(parse('[.word,+word,.5x,+5x,+,. ,+. ,+.e2,".5","+5"]')).toMatchObject({
      ok: true,
      value: [".word", "+word", ".5x", "+5x", "+", ".", "+.", "+.e2", ".5", "+5"],
    });
    expect(parse("[.5,-.0,+5,+.5]")).toMatchObject({ ok: true, value: [0.5, -0, 5, 0.5] });
    const exact = parse("[+9007199254740993,.1e-400]");
    expect(exact.ok && stringify(exact.value)).toEqual({
      ok: true,
      value: "[9007199254740993,0.1e-400]",
    });
  });

  it("preserves the sign and digits after small-buffer compaction", () => {
    const input = "[+.123456789012345678901234567890]";
    const built = createStreamParser({ exactNumbers: true, maxBuffer: 8, maxRetained: 128 });
    const items = [];
    for (const c of input) items.push(...built.feed(c));
    items.push(...built.end());
    expect(items).toHaveLength(1);
    for (const item of items)
      expect(item.ok && stringify(item.value)).toEqual({
        ok: true,
        value: "[0.123456789012345678901234567890]",
      });
  });
});
