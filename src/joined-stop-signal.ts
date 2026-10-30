// SPDX-License-Identifier: Apache-2.0

import type { StopSignal } from "./stop-signal";
import { Stopper } from "./stopper";

export interface JoinedStopper extends Stopper {
  detach(primary?: { readonly cause: unknown }): void;
}

// Unused configured parsers must not initialize the relay through subclass evaluation.
const joinedStopperClass = (): new (task: StopSignal, second: StopSignal) => JoinedStopper => {
  class JoinedSignal extends Stopper {
    private second: StopSignal | undefined;
    private readonly secondRelay = (): void => {
      this.observeAbort(this.second);
    };

    constructor(task: StopSignal, second: StopSignal) {
      // Capture a known stop without subscriptions; task wins an already-aborted tie.
      super(task.aborted ? task : second.aborted ? second : task);
      if (super.aborted) return;
      this.second = second;
      try {
        second.addEventListener?.("abort", this.secondRelay, { once: true });
        if (second.aborted) this.secondRelay();
      } catch (error) {
        // The task listener already exists; a failed constructor has no caller to release it.
        try {
          this.detach();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Signal joining and cleanup failed", {
            cause: cleanup,
          });
        }
        throw error;
      }
    }

    override get aborted(): boolean {
      if (super.aborted) return true;
      try {
        if (this.second?.aborted !== true) return false;
        this.secondRelay();
      } catch (cause) {
        this.fail(cause);
      }
      return true;
    }

    override detach(primary?: { readonly cause: unknown }): void {
      if (this.detached) return;
      // Each caller owns a separate listener; failure removing one must not retain the other.
      let failures: unknown[] | undefined;
      try {
        super.detach();
      } catch (error) {
        failures = [error];
      }
      try {
        this.second?.removeEventListener?.("abort", this.secondRelay);
      } catch (error) {
        (failures ??= []).push(error);
      } finally {
        this.second = undefined;
      }
      if (failures === undefined) return;
      const cleanup =
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Both signal listeners failed to detach");
      // Cleanup rejects inside its owner so return() cannot skip it, and throw() keeps both causes.
      if (primary !== undefined)
        throw new AggregateError(
          [primary.cause, cleanup],
          "Consumer throw and signal cleanup failed",
          {
            cause: cleanup,
          },
        );
      throw cleanup;
    }
  }
  return JoinedSignal;
};
export const JoinedStopperConstructor = /* @__PURE__ */ joinedStopperClass();
