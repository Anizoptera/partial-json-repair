// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * `confidence` carries published decision thresholds — below 0.7 consider retrying the model, below
 * 0.5 the output is likely garbled — so its SHAPE is a promise to consumers, not an implementation
 * detail. These cases pin the choices that distinguish it from the rivals it was chosen over; they
 * are not a restatement of the formula.
 *
 * The table's completeness needs no test: `Record<RepairKind, number>` makes a missing kind a
 * compile error, which is stricter than any assertion and cannot be forgotten.
 */
import { describe, expect, it } from "vitest";

import type { Repair, RepairKind } from "../src/types";
import { confidenceOf } from "../src/types";

const repairs = (...kinds: RepairKind[]): Repair[] =>
  kinds.map((kind, i) => ({ kind, at: { offset: i, unit: "utf16" }, path: [], valueIndex: 0 }));

describe("confidence", () => {
  it("is multiplicative, not additive", () => {
    // The discriminator. Two 0.1 repairs leave 0.9 x 0.9 = 0.81; summing the penalties gives 0.80.
    // Both look reasonable and only one matches what the extracted package promised its consumers.
    expect(confidenceOf(repairs("unclosed-object", "unclosed-array"))).toBeCloseTo(0.81, 10);
  });

  it("never reaches zero, however many small repairs accumulate", () => {
    // An additive sum crosses 1.0 after 34 x 0.03 and must clamp, reporting "likely garbled" for a
    // document that was merely verbose. Decay cannot reach zero, so the thresholds keep meaning
    // what they were calibrated to mean.
    const many = confidenceOf(
      repairs(...Array.from({ length: 200 }, () => "missing-comma" as const)),
    );
    expect(many).toBeGreaterThan(0);
    expect(many).toBeLessThan(0.01);
  });

  it("charges nothing for repairs that guessed nothing", () => {
    // Trailing commas, single quotes and comments are spelling, not meaning: the value is exactly
    // what the author wrote, so certainty in it is undiminished. A parser that charged for them
    // would report low confidence for input it understood perfectly.
    expect(
      confidenceOf(repairs("trailing-comma", "single-quote", "comment-removed", "trailing-comma")),
    ).toBe(1);
  });

  it("is unchanged by a free repair sitting beside a costly one", () => {
    // Falsifies an implementation that penalises by repair COUNT rather than by kind — which is what
    // a "number of repairs" heuristic would do, and it would look right on most inputs.
    expect(confidenceOf(repairs("unclosed-string", "trailing-comma"))).toBe(
      confidenceOf(repairs("unclosed-string")),
    );
  });

  it("gives untouched input exactly 1", () => {
    expect(confidenceOf([])).toBe(1);
  });
});
