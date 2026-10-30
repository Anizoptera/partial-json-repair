// SPDX-License-Identifier: Apache-2.0

// Restore caller-side values and stop causes after structured clone has crossed the worker boundary.
import type { ExactNumber } from "./exact-number";
import type { WorkerEnvelope } from "./worker-message";
import type { Outcome } from "./parser-outcome";
import { recovered } from "./parser-outcome";
import type { AbortedFailure, Cut, RepairFailure, SignalFailure } from "./types";

export const restoreWorkerStop = (
  value: unknown,
  stopped: AbortedFailure | SignalFailure | undefined,
): unknown => {
  if (stopped === undefined) return value;
  // Only library-produced outcomes reach this seam. Projected success must request the worker's
  // retained source recovery before reaching it; text and spans are not recovered source values.
  const result = value as Outcome<
    unknown,
    RepairFailure | AbortedFailure | SignalFailure,
    { cut?: Cut }
  >;
  if (result.ok)
    return {
      ok: false,
      failure: { ...stopped, recovered: recovered(result.value, result.cut) },
      ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
    };
  if (result.failure.kind !== "aborted") return value;
  // The first observed host failure is owned locally; rereading the provider could lose it.
  return { ...result, failure: { ...result.failure, ...stopped } };
};

export const restoreWorkerValue = (
  envelope: WorkerEnvelope,
  numberType: typeof ExactNumber,
  deferred?: object[],
): unknown => {
  // Use the caller's constructor to initialize its brand even in a fresh receiver. One instance
  // supplies the prototype for this envelope; restoring clones avoids key slots and per-leaf copies.
  const first = envelope.exact[0];
  if (first !== undefined) {
    const prototype = Object.getPrototypeOf(new numberType(first.text)) as object;
    for (const number of envelope.exact) {
      Object.setPrototypeOf(number, prototype);
      Object.freeze(number);
    }
  }
  for (const container of envelope.nullPrototype) Object.setPrototypeOf(container, null);
  // Freezing is shallow; leaf prototypes are restored, so container depth does not set the order.
  for (const container of envelope.frozen) {
    if (deferred === undefined) Object.freeze(container);
    else deferred.push(container);
  }
  return envelope.value;
};
