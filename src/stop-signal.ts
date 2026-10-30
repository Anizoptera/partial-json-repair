// SPDX-License-Identifier: Apache-2.0

import type { AbortedFailure, SignalFailure } from "./types";

// Caller proxies can fabricate even private symbol properties; identity storage cannot invoke them.
// Weak keys keep failure state from extending a signal's lifetime or importing listener ownership.
export const signalFailures = /* @__PURE__ */ new WeakMap<StopSignal, SignalFailure>();

/**
 * Structural rather than `AbortSignal`, so no DOM lib is pulled into an entry that must type-check
 * for every runtime. Event methods are optional: when present they wake a stalled read; polling
 * still serves smaller runtimes.
 */
export type StopSignal = {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(type: "abort", listener: () => void, options: { once: true }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
};

/** Signal access is host code; a broken getter must stop work without losing its recovery. */
export const readStop = (signal?: StopSignal): AbortedFailure | SignalFailure | undefined => {
  try {
    if (signal?.aborted !== true) return undefined;
    return signalFailures.get(signal) ?? { kind: "aborted", reason: signal.reason };
  } catch (cause) {
    return { kind: "signal-failed", cause };
  }
};
