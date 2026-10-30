// SPDX-License-Identifier: Apache-2.0

import type { StopSignal } from "./stop-signal";
import { readStop, signalFailures } from "./stop-signal";

/**
 * The caller's signal and `close()` joined into one stop, so a read stalled on either wakes the
 * same way. `closing` tells the two apart afterwards: an abort yields a final `aborted` item, a
 * close yields nothing more.
 */
export class Stopper implements StopSignal {
  private stopped = false;
  protected detached = false;
  reason: unknown;
  closing = false;
  private readonly listeners = new Set<() => void>();
  private readonly relay = (): void => {
    this.observeAbort(this.outer);
  };

  constructor(private outer: StopSignal | undefined) {
    try {
      // A known stop needs no host subscription; setup must not replace cancellation with failure.
      const stopped = readStop(outer);
      if (stopped !== undefined) {
        if (stopped.kind === "signal-failed") this.fail(stopped.cause);
        else this.stop(stopped.reason);
        this.outer = undefined;
        return;
      }
      outer?.addEventListener?.("abort", this.relay, { once: true });
      if (this.outer?.aborted === true) this.relay();
    } catch (error) {
      // Failed construction has no owner; subclass fields are not initialized yet.
      try {
        Stopper.prototype.detach.call(this);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Signal setup and cleanup failed", {
          cause: cleanup,
        });
      }
      throw error;
    }
  }

  get aborted(): boolean {
    // Structural signals may only support polling, so event subscription alone is insufficient.
    try {
      if (!this.stopped && this.outer?.aborted === true) this.relay();
    } catch (cause) {
      this.fail(cause);
    }
    return this.stopped;
  }

  protected observeAbort(signal?: StopSignal): void {
    if (this.stopped) return;
    let reason: unknown;
    try {
      reason = signal?.reason;
    } catch (cause) {
      this.fail(cause);
      return;
    }
    this.stop(reason);
  }

  protected fail(cause: unknown): void {
    // A broken host signal still wakes pending reads, but must not masquerade as cancellation.
    if (this.stopped) return;
    signalFailures.set(this, { kind: "signal-failed", cause });
    this.stop(undefined);
  }

  stop(reason: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  addEventListener(_type: "abort", listener: () => void): void {
    if (this.aborted) listener();
    else this.listeners.add(listener);
  }

  removeEventListener(_type: "abort", listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** Unhooks from the caller's signal, so a long-lived signal does not keep a finished stream alive. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    try {
      this.outer?.removeEventListener?.("abort", this.relay);
    } finally {
      // Release local ownership even if the caller's host cannot remove its listener.
      this.outer = undefined;
      this.listeners.clear();
    }
  }
}
