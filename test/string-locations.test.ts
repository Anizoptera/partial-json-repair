// SPDX-License-Identifier: Apache-2.0

// String refusals must keep the opening location after streaming releases its source prefix.
import { expect, it } from "vitest";
import { createStreamParser, parse, diagnostics } from "../src/index";

it("keeps string refusal locations through every chunk split", () => {
  const options = { diagnostics, repairBroken: false } as const;
  for (const text of [
    '["a\nb\\tc"]',
    '["long\nprefix\\qtail"]',
    '["long\nprefix without closer',
    '["long\nprefix\',tail" x]',
  ]) {
    const whole = parse(text, options);
    expect(whole.ok).toBe(false);
    const expected = whole.diagnostics.errors.map(({ kind, line, column, refused }) => ({
      kind,
      line,
      column,
      refused,
    }));
    expect(expected.length).toBeGreaterThan(0);
    for (let split = 1; split < text.length; split++) {
      const stream = createStreamParser(options);
      const results = [
        ...stream.feed(text.slice(0, split)),
        ...stream.feed(text.slice(split)),
        ...stream.end(),
      ];
      expect(results.length).toBe(1);
      expect(results[0]?.ok).toBe(false);
      expect(
        results.flatMap((result) =>
          result.diagnostics.errors.map(({ kind, line, column, refused }) => ({
            kind,
            line,
            column,
            refused,
          })),
        ),
        `${text} split at ${split}`,
      ).toEqual(expected);
    }
  }
});
