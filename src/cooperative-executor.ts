// SPDX-License-Identifier: Apache-2.0

/** Drain whole operations with a shared host-task budget at bounded checkpoints. */

import type { ResolvedOptions } from "./options";
import type { StopSignal } from "./stop-signal";
import { readStop } from "./stop-signal";
import { takeOutcome } from "./parser-outcome";
import { byteLength, isBytes, yieldToHost } from "./transport";
import type { AbortedFailure, Cut, Input, SchedulingFailure, SignalFailure } from "./types";
import { wholeOperation, type WholeRequest, type WholeOperationStep } from "./whole-operation";

const INLINE_INPUT_UNITS = 2048;
const WORK_UNITS = 512;
/**
 * Leave room under the HLD's 4 ms target for checkpoint overshoot and resumed callers.
 * A larger per-call target was measured and rejected (2026-10-04, M4 Max, load ~29, 2 MB inputs, 7 rounds):
 * from 1 to 4 ms, settle time stayed within noise on Bun (~39 ms) and Node (~70 ms), because a
 * `setImmediate` yield costs almost nothing, while the longest host gap grew. Node went from 5.4 ms at
 * 1 ms to 10.2 ms at 4 ms, past the 8 ms warning line. Thinner slices cost settle time only where each
 * yield is expensive, such as a repaint; this one is not.
 */
const TARGET_MILLISECONDS = 1;
// Count parser work only: consumer suspension must not spend another call's host budget.
let spent = 0;
let pendingAdmission: Promise<void> | undefined;
let hostTurn: Promise<SchedulingFailure | undefined> | undefined;
let turnFailure: SchedulingFailure | undefined;

function waitForHostTurn(): Promise<SchedulingFailure | undefined> {
  const requestedTurn = hostTurn;
  // Serial admission lets each resumed caller charge work before the next caller takes its slice.
  const admitted = (pendingAdmission ?? Promise.resolve()).then(async () => {
    if (hostTurn === requestedTurn || spent >= TARGET_MILLISECONDS) {
      try {
        hostTurn = yieldToHost();
        turnFailure = await hostTurn;
      } catch (cause) {
        turnFailure = { kind: "scheduling-failed", cause };
      }
      spent = 0;
    }
    return turnFailure;
  });
  // This bridge queues the caller's continuation before the next admission's continuation.
  const released: Promise<void> = admitted.then(() => {
    if (pendingAdmission === released) {
      pendingAdmission = undefined;
      hostTurn = undefined;
      turnFailure = undefined;
    }
    return undefined;
  });
  pendingAdmission = released;
  return admitted;
}

/**
 * Whether a call runs on the yield schedule. `auto` may keep proven-small input inline (HLD); a caller
 * who forces `"cooperative"` gets scanner checkpoints at every size, because a slower host can spend
 * a whole slice on input this small: 2048 units with every report feature on took 0.15-0.25 ms at
 * the median but 0.7-2.1 ms at the 99th percentile (Bun 1.4.2, M4 Max, load ~14). Input shorter
 * than one `WORK_UNITS` slice still finishes before its first checkpoint, and the built-in route in
 * `wholeOperation` has none: its own size bound keeps it inside a slice.
 */
export const isSliced = (execution: "auto" | "cooperative", inputUnits: number): boolean =>
  execution === "cooperative" || inputUnits > INLINE_INPUT_UNITS;

export async function* executeCooperatively(
  operation: WholeRequest,
  input: Input,
  options: ResolvedOptions,
  execution: "auto" | "cooperative",
  signal?: StopSignal,
  retain?: (value: unknown, cut: Cut | undefined) => void,
  finish?: (outcome?: unknown) => unknown,
): AsyncGenerator<Extract<WholeOperationStep, { kind: "item" }>["value"], unknown, undefined> {
  const inputUnits =
    typeof input === "string" ? input.length : isBytes(input) ? byteLength(input) : 0;
  const cooperative = isSliced(execution, inputUnits);
  // Forward recovery capture so message-driven projection cancellation never needs a second parse.
  const steps = wholeOperation(
    operation,
    input,
    options,
    signal,
    cooperative ? WORK_UNITS : INLINE_INPUT_UNITS,
    retain,
  );
  let deliveries = 0;
  let stopped: AbortedFailure | SchedulingFailure | SignalFailure | undefined;
  let terminal: unknown;
  // A manual next() loop must close its owned operation when the consumer leaves at a delivery.
  try {
    try {
      while (true) {
        if (
          cooperative &&
          stopped === undefined &&
          (spent >= TARGET_MILLISECONDS || deliveries >= WORK_UNITS)
        ) {
          // Resume only the callers that fit this turn; failures preserve the stopped recovery path.
          try {
            // An observed stop needs recovery, never another fallible host wait or signal read.
            // eslint-disable-next-line no-await-in-loop
            stopped = readStop(signal) ?? (await waitForHostTurn());
          } catch (cause) {
            // Resume only stopped recovery; a broken scheduler cannot run another source slice.
            stopped = { kind: "scheduling-failed", cause };
          }
          deliveries = 0;
        }
        const started = cooperative ? performance.now() : 0;
        const step = steps.next(stopped);
        if (cooperative) spent += performance.now() - started;
        if (step.done === true) {
          terminal = step.value;
          break;
        }
        if (step.value.kind === "item") {
          if (step.value.terminal) {
            terminal = takeOutcome(step.value);
            break;
          }
          deliveries++;
          yield takeOutcome(step.value);
        }
      }
    } finally {
      steps.return(undefined);
    }
    if (finish !== undefined) {
      // Public iteration releases its owner before terminal delivery; worker drivers instead take
      // the return value. Keep both protocols here so neither needs a per-root forwarding wrapper.
      const delivered = finish(terminal) ?? terminal;
      finish = undefined;
      if (terminal !== undefined) yield delivered;
      return undefined;
    }
    return terminal;
  } finally {
    // Early return, throw and scanner failure must release the caller's owner too.
    finish?.();
  }
}
