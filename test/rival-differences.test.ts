// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parse } from "../src/index";
import { CLUSTERS } from "./rival-differences";

// Each case pins OUR answer where a rival library answers differently. A red case means a change
// moved that answer: if it now matches the rival, the cluster's verdict below is what changed, so
// update the verdict and reason in `rival-differences.ts` rather than the expected value alone.
describe.each(CLUSTERS)("$id ($verdict)", ({ id, verdict, reason, cases }) => {
  it.each(cases)("%j", (input, expected) => {
    const result = parse(input);
    const context = `${id} [${verdict}]: ${reason}`;
    if ("fails" in expected) {
      expect(result.ok ? result.value : result.failure.kind, context).toBe(expected.fails);
      return;
    }
    expect(result.ok, context).toBe(true);
    if (!result.ok) return;
    // toEqual compares NaN as equal to NaN, which is the comparison these literal cases need.
    expect(result.value, context).toEqual(expected.value);
    expect(result.complete, context).toBe(expected.complete ?? true);
  });
});
