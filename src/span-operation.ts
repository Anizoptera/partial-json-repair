// SPDX-License-Identifier: Apache-2.0

import { spanOutcome, spanSteps } from "./whole-reader";
import type { ReaderResult } from "./whole-reader";
import type { WholeInputSource } from "./whole-source";

// Span callers carry projection into the shared executor; parse-only consumers can omit it.
// The direct branch avoids scheduling state for one span; selected batches keep checkpoints.
export const spanOperation = /* @__PURE__ */ Object.freeze({
  kind: "findJsonSpan" as const,
  direct: spanOutcome,
  project: (_source: WholeInputSource, result: ReaderResult, units: number) =>
    spanSteps(result, units),
});
