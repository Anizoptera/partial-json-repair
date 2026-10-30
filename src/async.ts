// SPDX-License-Identifier: Apache-2.0

import type { Exact, ParserOptions } from "./options";
import type { Input, ParserClosedFailure } from "./types";
import type { Overridden } from "./parser";
import type { AsyncParser } from "./async-configuration";
import type { AsyncParseOutcome } from "./async-operation";
import { runOne } from "./async-operation";
import type { StopSignal } from "./stop-signal";
import type { AutoExecution, CooperativeExecution } from "./same-thread-strategy";
import type { WorkerExecution } from "./worker-strategy";

export { auto, cooperative } from "./same-thread-strategy";
export type { AutoExecution, CooperativeExecution } from "./same-thread-strategy";
export { worker } from "./worker-strategy";
export type { WorkerExecution } from "./worker-strategy";

/**
 * Where async recovery runs, as an imported value, so an app ships only the strategies it names:
 * `auto` runs on the calling thread (proven-small input inline, the rest in slices that yield),
 * `cooperative` yields between slices at every size, `worker` runs in a background worker.
 * Required: a default would be referenced by every verb and ship its engine in every app.
 */
export type AsyncExecution = AutoExecution | CooperativeExecution | WorkerExecution;
export type AsyncOptions = ParserOptions & {
  readonly execution: AsyncExecution;
  readonly signal?: StopSignal;
};
/** Per-call settings for a configured async parser, which already holds its strategy. */
export type AsyncOverrides = ParserOptions & {
  readonly execution?: AsyncExecution;
  readonly signal?: StopSignal;
};

// Imported verbs select projection; configuration recognition imports no task-signal joining.
export { parseManyAsync } from "./async-operation";
export { findJsonSpanAsync } from "./span-async";
export type {
  AbortedFailure,
  AsyncFailure,
  AsyncRepairFailure,
  ExecutionUnavailableFailure,
  SchedulingFailure,
  SignalFailure,
} from "./async-operation";
export { repairAsync } from "./repair-async";
export { initAsyncParser } from "./async-parser";
export type { AsyncParser } from "./async-parser";

/** Invalid options reject the promise with the `configurationError`; nothing is read first. */
export function parseAsync<O extends AsyncOverrides, C extends AsyncOverrides | undefined>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): Promise<AsyncParseOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function parseAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): Promise<AsyncParseOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function parseAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): Promise<AsyncParseOutcome<O>>;
export async function parseAsync(
  input: Input,
  options: AsyncOptions | AsyncParser,
  overrides?: AsyncOverrides,
): Promise<unknown> {
  const outcome = await runOne("parse", input, options, overrides);
  return outcome;
}
