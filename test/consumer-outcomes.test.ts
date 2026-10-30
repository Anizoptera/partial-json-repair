// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { describe, firstDifference, sameDescription } from "./consumer-outcomes";

it("rejects missing array data without rejecting an equivalent consumer result", () => {
  const missing: number[] = [];
  missing.length = 1;
  const trailing = [1];
  trailing.length = 2;
  // Empty slots change consumer-visible length without changing enumerable keys.
  for (const [expected, actual] of [
    [[], missing],
    [[1], trailing],
    [[undefined], missing],
  ]) {
    const reference = describe(expected);
    const candidate = describe(actual);
    expect(sameDescription(reference, candidate)).toBe(false);
    expect(firstDifference(reference, candidate)).toBeDefined();
  }
  expect(sameDescription(describe([1]), describe([1]))).toBe(true);
  expect(firstDifference(describe([1]), describe([1]))).toBeUndefined();
});
