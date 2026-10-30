// SPDX-License-Identifier: Apache-2.0

/** Run whole-input recovery through bounded host-task checkpoints. */

import type { Exact, ResolvedOptions } from "./options";
import type { AsyncParser } from "./async-configuration";
import { AsyncConfiguration, isAsyncParser } from "./async-configuration";
import type { AsyncOptions, AsyncOverrides } from "./async";
export type { AsyncOptions, AsyncOverrides } from "./async";
import { resolveOptions } from "./options";
import {
  resolveSignal,
  configurationError,
  copyOwnOptions,
  isPlainObject,
  ownOption,
} from "./configuration-error";
import type { SameThreadStrategy } from "./same-thread-strategy";
import type { WholeRequest, WholeSingleRequest } from "./whole-operation";
import { manySteps } from "./whole-reader";
import type { ManyOutcome, Overridden, ParseOutcome, RepairOutcome, SpanOutcome } from "./parser";
import { bareFailure, shaped } from "./parser-outcome";
import type { ReportFeature } from "./report";
import type { StopSignal } from "./stop-signal";
import { readStop } from "./stop-signal";
import type {
  CleanupFailure,
  Input,
  ParseFailure,
  ParserClosedFailure,
  RepairFailure,
  Result,
  SchedulingFailure,
  SignalFailure,
  Recovery,
} from "./types";
import type { WorkerFailure } from "./worker-executor";
import type { WorkerParserOptions } from "./worker-message";
import type { WorkerStrategy } from "./worker-strategy";
import type { AbortedFailure } from "./types";

// Part of `AsyncFailure`, so a caller narrowing to it needs the name from the entry it imports.
export type { AbortedFailure, SchedulingFailure, SignalFailure } from "./types";

export type ExecutionUnavailableFailure = {
  readonly kind: "execution-unavailable";
  /** Only a worker can be unavailable: cooperative execution needs nothing from the host. */
  readonly execution: "worker";
  readonly reason: WorkerFailure | "unsupported";
  /** What failed, why, and what to do, in words for a log or a developer; branch on `reason`. */
  readonly message: string;
  readonly recovered?: Recovery;
  // Keep an earlier source refusal inspectable when its result delivery subsequently fails.
  readonly cause?: RepairFailure | AbortedFailure | SignalFailure;
};

// Cleanup must not replace a primary failure or its useful recovery.
type WithCleanupFailure<Failure> = Failure & { readonly cleanupFailure?: CleanupFailure };
export type AsyncFailure = WithCleanupFailure<
  ParseFailure | AbortedFailure | SchedulingFailure | SignalFailure | ExecutionUnavailableFailure
>;
export type AsyncRepairFailure = WithCleanupFailure<
  RepairFailure | AbortedFailure | SchedulingFailure | SignalFailure | ExecutionUnavailableFailure
>;
export type OperationOutcome = Result<
  unknown,
  WithCleanupFailure<AsyncFailure | AsyncRepairFailure | ParserClosedFailure | CleanupFailure>
>;
export type OperationRelease = (outcome?: unknown) => unknown;

// Only the owning wrapper can add its cleanup failure to a library-produced outcome.
export const finishOutcome = (outcome: unknown, release?: OperationRelease): unknown =>
  release?.(outcome) ?? outcome;
// Keep the exact successful operation separate: repaired text and spans are not recovered data.
type CompletedCleanupFailure<Outcome> = CleanupFailure & {
  readonly completed: Extract<Outcome, { readonly ok: true }>;
};
export type AsyncParseOutcome<O extends AsyncOverrides, F = never> = ParseOutcome<
  O,
  AsyncFailure | F | CompletedCleanupFailure<ParseOutcome<O>>
>;
export type AsyncRepairOutcome<O extends AsyncOverrides, F = never> = RepairOutcome<
  O,
  AsyncRepairFailure | F | CompletedCleanupFailure<RepairOutcome<O>>
>;
export type AsyncSpanOutcome<O extends AsyncOverrides, F = never> = SpanOutcome<
  O,
  AsyncFailure | F | CompletedCleanupFailure<SpanOutcome<O>>
>;
export type PlannedSuccess = {
  readonly ok: true;
  readonly options: ResolvedOptions;
  readonly reported: false | ReportFeature;
  // Always an own key, `undefined` included: an absent one is read off `Object.prototype`, so a
  // host that extends it with `signal` would cancel every call.
  readonly signal: StopSignal | undefined;
} & (
  | {
      readonly execution: "worker";
      readonly workerOptions: WorkerParserOptions;
      readonly start: WorkerStrategy["start"];
    }
  // Encoded only for the worker: the encoding builds each selection's wire form, wasted on the
  // same thread.
  | { readonly execution: "auto" | "cooperative"; readonly start: SameThreadStrategy["start"] }
);
export type PlannedWorker = Extract<PlannedSuccess, { readonly execution: "worker" }>;

/**
 * Recognises a strategy by its shape, as `featureOf` recognises a feature, so validation names no
 * strategy and an app ships only those it imports. `execution` is required: an omitted default
 * would be referenced by every verb and ship its executor in every app. A missing value, a string
 * (the old spelling) or a copy that lost its members is refused with a message naming the imports.
 */
const strategyOf = (value: unknown): SameThreadStrategy | WorkerStrategy => {
  if (
    typeof value === "object" &&
    value !== null &&
    ownOption(value, "feature") === "execution" &&
    typeof ownOption(value, "start") === "function"
  ) {
    const kind = ownOption(value, "kind");
    if (kind === "auto" || kind === "cooperative") return value as SameThreadStrategy;
    if (kind === "worker" && typeof ownOption(value, "encode") === "function")
      return value as WorkerStrategy;
  }
  throw configurationError(
    { kind: "invalid-options", field: "execution", reason: "execution" },
    'is required and takes an imported strategy, never a string or a copy: `import { auto } from "partial-json-repair/async"` and pass `{ execution: auto }` to run on this thread, `cooperative` to yield at every size, or `worker` for a background worker',
  );
};

export type Planned =
  | PlannedSuccess
  | {
      readonly ok: false;
      readonly failure: ParserClosedFailure | AbortedFailure | SignalFailure;
      readonly reported: false | ReportFeature;
    };

/** Throws the `configurationError` for invalid options (HLD), before any input is read. */
export const plan = (
  options?: AsyncOverrides,
  capture?: (settings: AsyncOverrides) => void,
): PlannedSuccess => {
  if (options !== undefined && !isPlainObject(options))
    throw configurationError({ kind: "invalid-options", field: "options", reason: "object" });
  // Snapshot own values once; named destructuring would also invoke inherited getters.
  const given = options ?? {};
  const parserOptions = copyOwnOptions(given) as {
    -readonly [Key in keyof AsyncOverrides]: AsyncOverrides[Key];
  };
  const { execution, signal: givenSignal } = parserOptions;
  delete parserOptions.execution;
  delete parserOptions.signal;
  const signal = resolveSignal(givenSignal);
  const strategy = strategyOf(execution);
  let settings = parserOptions;
  const resolved = resolveOptions(
    parserOptions,
    undefined,
    strategy.kind === "worker" || capture !== undefined
      ? (captured) => {
          settings = captured;
        }
      : undefined,
  );
  // The caller's own value, so a configured parser's overrides merge with what was passed.
  capture?.(execution === undefined ? settings : { ...settings, execution });
  const planned = { ok: true as const, options: resolved, reported: resolved.diagnostics, signal };
  return strategy.kind === "worker"
    ? {
        ...planned,
        execution: "worker",
        workerOptions: strategy.encode(settings),
        start: strategy.start,
      }
    : { ...planned, execution: strategy.kind, start: strategy.start };
};

// A finished generator can retain its input and signals. The public handle owns it only while live.
// Forward next's original promise to avoid per-pull observation costs.
export const ownIteration = <Terminal>(
  create: (release: () => void) => AsyncGenerator<unknown, Terminal | undefined, undefined>,
): AsyncGenerator<unknown, Terminal | undefined, undefined> => {
  let iterator: AsyncGenerator<unknown, Terminal | undefined, undefined> | undefined;
  const release = (): void => {
    iterator = undefined;
  };
  iterator = create(release);
  const leaving = (result: Promise<IteratorResult<unknown, Terminal | undefined>>) => {
    // An unstarted generator skips finally; release after its queued return/throw settles too.
    void result.then((item) => {
      if (item.done === true) release();
      return item;
    }, release);
    return result;
  };
  return {
    next(value) {
      // Preserve native iterator-result field order after the private generator is released.
      return iterator?.next(value) ?? Promise.resolve({ value: undefined, done: true });
    },
    return(value) {
      return iterator === undefined
        ? Promise.resolve(value).then((resolved) => ({ value: resolved, done: true as const }))
        : leaving(iterator.return(value));
    },
    throw(cause: unknown) {
      // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Iterator.throw must preserve the caller's value, including non-Errors.
      return iterator === undefined ? Promise.reject(cause) : leaving(iterator.throw(cause));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      await this.return(undefined);
    },
  };
};

export function executePlanned(
  operation: WholeRequest,
  input: Input,
  planned: Planned,
  release?: OperationRelease,
): AsyncGenerator<unknown, unknown, undefined> {
  // Return the strategy's iterator directly: the cooperative one closes its scanner before terminal
  // delivery, without allocating promises to forward every root. Each executor is reached only
  // through its strategy's own `start`, so a verb ships none the app did not import.
  const stopped = planned.ok ? readStop(planned.signal) : undefined;
  if (!planned.ok || stopped !== undefined)
    return refused(
      stopped ?? (planned as Exclude<Planned, PlannedSuccess>).failure,
      planned,
      release,
    );
  return planned.execution === "worker"
    ? planned.start(operation, input, planned, release)
    : planned.start(operation, input, planned, release);
}

/** A plan refused before any work: one terminal outcome, its owner released before it is held. */
// Async by protocol, not by awaiting: callers iterate every plan the same way.
// oxlint-disable-next-line typescript/require-await
async function* refused(
  failure: ParserClosedFailure | AbortedFailure | SignalFailure,
  planned: Planned,
  release?: OperationRelease,
): AsyncGenerator<unknown, void, undefined> {
  try {
    yield finishOutcome(shaped(bareFailure(failure, planned.reported)), release);
  } finally {
    release?.();
  }
}

// Cleanup is secondary to failed recovery; after success it must preserve the completed outcome.
export const cleanupOutcome = (outcome: OperationOutcome, cause: unknown) => {
  if (outcome.ok) {
    // The failed call still owes its requested report; share the completed operation's report.
    return {
      ok: false as const,
      failure: { kind: "cleanup-failed" as const, cause, completed: outcome },
      ...("diagnostics" in outcome &&
        Object.hasOwn(outcome, "diagnostics") && {
          diagnostics: outcome.diagnostics,
        }),
    };
  }
  // Preserve independent cleanup failures in occurrence order, including a thrown undefined.
  const earlier = Object.hasOwn(outcome.failure, "cleanupFailure")
    ? outcome.failure.cleanupFailure
    : undefined;
  const cleanup =
    earlier === undefined
      ? cause
      : new AggregateError([earlier.cause, cause], "Multiple cleanup operations failed", { cause });
  return {
    ...outcome,
    failure: {
      ...outcome.failure,
      cleanupFailure: { kind: "cleanup-failed" as const, cause: cleanup },
    },
  };
};

export const firstOutcome = async (
  operation: WholeSingleRequest,
  sequence: AsyncGenerator<unknown, unknown, undefined>,
): Promise<unknown> => {
  const first = await sequence.next();
  if (first.done === true) {
    // A direct cooperative operation closes before returning its single terminal outcome.
    if (first.value !== undefined) return first.value;
    throw new TypeError(
      `${typeof operation === "string" ? operation : operation.kind} produced no outcome`,
    );
  }
  try {
    await sequence.return(undefined);
  } catch (cause) {
    // This sequence is private and yields operation results, never arbitrary caller values.
    const outcome = first.value as Result<
      unknown,
      AsyncFailure | AsyncRepairFailure | ParserClosedFailure
    >;
    return cleanupOutcome(outcome, cause);
  }
  return first.value;
};

export const runOne = (
  operation: WholeSingleRequest,
  input: Input,
  options: AsyncOverrides | AsyncParser | undefined,
  overrides?: AsyncOverrides,
): Promise<unknown> => {
  if (isAsyncParser(options)) {
    const configuration = AsyncConfiguration.state(options);
    return firstOutcome(
      operation,
      configuration.execute(operation, input, configuration.prepare(overrides)),
    );
  }
  return firstOutcome(operation, executePlanned(operation, input, plan(options)));
};

/**
 * Not a generator function: options are planned at the call, so invalid ones throw there like the
 * synchronous `parseMany`, not on the first pull of an iterator that may be stored for later.
 */
export function parseManyAsync<O extends AsyncOverrides, C extends AsyncOverrides | undefined>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): AsyncGenerator<
  ManyOutcome<Overridden<O, C>, AsyncFailure | CleanupFailure | ParserClosedFailure>,
  void,
  undefined
>;
export function parseManyAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): AsyncGenerator<
  ManyOutcome<Overridden<O, C>, AsyncFailure | CleanupFailure | ParserClosedFailure>,
  void,
  undefined
>;
export function parseManyAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): AsyncGenerator<ManyOutcome<O, AsyncFailure | CleanupFailure>, void, undefined>;
export function parseManyAsync(
  input: Input,
  options: AsyncOptions | AsyncParser,
  overrides?: AsyncOverrides,
): AsyncGenerator<unknown, unknown, undefined> {
  if (isAsyncParser(options)) {
    const configuration = AsyncConfiguration.state(options);
    return ownIteration((release) =>
      configuration.execute(manySteps, input, configuration.prepare(overrides), release),
    );
  }
  const planned = plan(options);
  return ownIteration((release) => executePlanned(manySteps, input, planned, release));
}
