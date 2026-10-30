// SPDX-License-Identifier: Apache-2.0
import type { CleanupFailure } from "./types";
import type { WorkerChannel, WorkerLike } from "./worker-message";

// Startup, active calls and termination share one lifetime; failed release retains ownership.
export type OwnedWorker = {
  readonly worker: WorkerLike;
  reference?: (referenced: boolean) => void;
  release?: () => unknown[] | undefined;
  state: "running" | "failed" | "ended";
};
export type Host = {
  readonly kind: "ready";
  active: number;
  /** Calls waiting for a worker response; the worker keeps the process alive only while any is. */
  waiting: number;
  readonly channel: () => WorkerChannel;
  readonly directMessages: boolean;
  readonly failures: Set<() => void>;
  readonly thread: OwnedWorker;
};
export type WorkerFailure = "failed" | "unsupported";
export type StartupResult = Host | WorkerFailure | CleanupFailure;
export type Startup = {
  readonly kind: "starting";
  readonly result: Promise<StartupResult>;
  readonly waiters: Set<(result: StartupResult | undefined) => void>;
  state: "starting" | "ready" | "stopped";
  cancel(): void;
};
export type Termination = {
  readonly kind: "terminating";
  readonly thread: OwnedWorker;
  readonly result: Promise<CleanupFailure | undefined>;
  pending: boolean;
};
