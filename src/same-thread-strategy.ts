// SPDX-License-Identifier: Apache-2.0

/**
 * The same-thread execution strategies, `auto` and `cooperative`. Each value carries its own
 * executor, as `worker` does, so the async verbs reference none and an app that imports only
 * `worker` never ships the same-thread engine (HLD D5).
 */

import type { Input } from "./types";
import type { WholeRequest } from "./whole-operation";
import type { OperationRelease, PlannedSuccess } from "./async-operation";
import { executeCooperatively } from "./cooperative-executor";

/** Runs on the calling thread: input proven small finishes inline, the rest yields between slices. */
export type AutoExecution = { readonly feature: "execution"; readonly kind: "auto" };
/** Runs on the calling thread and yields between slices at every size. */
export type CooperativeExecution = { readonly feature: "execution"; readonly kind: "cooperative" };

type SameThreadPlan = Extract<PlannedSuccess, { readonly execution: "auto" | "cooperative" }>;
/** Read by the planner once it has recognised the value; never part of the public type. */
type Started = { readonly start: typeof startSameThread };
export type SameThreadStrategy = (AutoExecution | CooperativeExecution) & Started;

const startSameThread = (
  operation: WholeRequest,
  input: Input,
  planned: SameThreadPlan,
  release?: OperationRelease,
): AsyncGenerator<unknown, unknown, undefined> =>
  executeCooperatively(
    operation,
    input,
    planned.options,
    planned.execution,
    planned.signal,
    undefined,
    release,
  );

export const auto: AutoExecution = /* @__PURE__ */ Object.freeze<AutoExecution & Started>({
  feature: "execution",
  kind: "auto",
  start: startSameThread,
});
export const cooperative: CooperativeExecution = /* @__PURE__ */ Object.freeze<
  CooperativeExecution & Started
>({
  feature: "execution",
  kind: "cooperative",
  start: startSameThread,
});
