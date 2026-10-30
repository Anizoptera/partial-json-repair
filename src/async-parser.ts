// SPDX-License-Identifier: Apache-2.0

import type { Exact } from "./options";
import type { CleanupFailure, Input, Result } from "./types";
import type { AsyncParser } from "./async-configuration";
import { AsyncConfiguration } from "./async-configuration";
export type { AsyncParser } from "./async-configuration";
import type { StopSignal } from "./stop-signal";
import { readStop } from "./stop-signal";
import type { JoinedStopper } from "./joined-stop-signal";
import { JoinedStopperConstructor } from "./joined-stop-signal";
import { resolveSignal, copyOwnOptions, isPlainObject, ownOption } from "./configuration-error";
import { bareFailure, RELEASED, shaped } from "./parser-outcome";
import type { WholeRequest } from "./whole-operation";
import { cleanupOutcome, executePlanned, plan } from "./async-operation";
import type {
  AsyncOptions,
  AsyncOverrides,
  Planned,
  PlannedSuccess,
  OperationOutcome,
} from "./async-operation";

async function* execute(
  operation: WholeRequest,
  input: Input,
  planned: Planned,
  task?: StopSignal,
  release?: () => void,
): AsyncGenerator<unknown, void, undefined> {
  // Subscribe only while the iterator runs; an unstarted call owns no listeners.
  let joined: JoinedStopper | undefined;
  let primary: { readonly cause: unknown } | undefined;
  try {
    try {
      joined =
        planned.ok && task !== undefined && planned.signal !== undefined && task !== planned.signal
          ? new JoinedStopperConstructor(task, planned.signal)
          : undefined;
    } catch (cause) {
      // The constructor releases partial subscriptions; no input has reached the operation yet.
      release?.();
      yield shaped(bareFailure({ kind: "signal-failed", cause }, planned.reported));
      return;
    }
    const effective =
      planned.ok && task !== undefined ? { ...planned, signal: joined ?? task } : planned;
    // Terminal results may be held without another pull; finish this wrapper's ownership first.
    const finalize =
      release === undefined
        ? undefined
        : (outcome?: unknown) => {
            if (outcome === undefined) return undefined;
            try {
              joined?.detach();
              return outcome;
            } catch (cause) {
              // Whole-operation projections share an opaque iterator payload; only this failure
              // boundary inspects the library-produced result to attach a cleanup cause.
              return cleanupOutcome(outcome as OperationOutcome, cause);
            } finally {
              joined = undefined;
              release();
            }
          };
    const terminal = yield* executePlanned(operation, input, effective, finalize);
    if (terminal !== undefined) {
      // Only calls without a release callback return their terminal value; firstOutcome closes
      // this wrapper before returning that value, including joined-signal cleanup.
      yield terminal;
    }
    // Natural exhaustion owes a typed cleanup failure; consumer return/throw skip this path.
    let cleanup: CleanupFailure | undefined;
    try {
      joined?.detach();
    } catch (cause) {
      cleanup = { kind: "cleanup-failed", cause };
    } finally {
      joined = undefined;
    }
    if (cleanup !== undefined) {
      release?.();
      yield shaped(bareFailure(cleanup, planned.reported));
    }
  } catch (cause) {
    // Even thrown undefined is a primary cause; listener cleanup must not replace it.
    primary = { cause };
    throw cause;
  } finally {
    try {
      joined?.detach(primary);
    } finally {
      release?.();
    }
  }
}

/**
 * Binds options once. Invalid options throw the `configurationError` here, before any input exists
 * (HLD); per-call overrides are validated at each call the same way.
 */
export function initAsyncParser<O extends AsyncOptions>(
  options: Exact<O, AsyncOptions>,
): AsyncParser<O>;
export function initAsyncParser(options: AsyncOptions): AsyncParser {
  let inherited: AsyncOverrides = {};
  const planned = plan(options, (settings) => {
    inherited = settings;
  });
  return buildAsyncParser({ ...planned, signal: undefined }, inherited, {
    closed: false,
    signal: planned.signal,
  });
}

// Keep execution closures away from caller options and the original plan, which both hold the signal.
// Closures own a mutable record rather than a constructor signal argument; close clears its edge.
const buildAsyncParser = (
  basePlan: PlannedSuccess,
  inherited: AsyncOverrides,
  state: { closed: boolean; signal: StopSignal | undefined },
): AsyncParser => {
  // Validated before the closed check, like the synchronous parser: a bad override is a bug at its
  // call site, and answering `parser-closed` would hide it until the call reaches an open parser.
  // A signal-only call reuses the bound plan; anything else is planned whole against `inherited`.
  const planFor = (call?: AsyncOverrides): PlannedSuccess => {
    if (call === undefined) return basePlan;
    if (!isPlainObject(call)) return plan(call); // refused as `object`; a spread would hide it
    const names = Object.getOwnPropertyNames(call);
    if (names.some((name) => name !== "signal")) {
      // An own `undefined` keeps the parser's setting, as on the synchronous parser; a spread would
      // let it reset `execution` or a limit to the package default.
      const settings = configuration.settings;
      const merged: Record<string, unknown> = copyOwnOptions(settings);
      for (const name of names) {
        const value: unknown = Reflect.get(call, name);
        if (value !== undefined || !Object.hasOwn(settings, name)) merged[name] = value;
      }
      return plan(merged);
    }
    const signal = resolveSignal(ownOption(call, "signal"));
    return signal === undefined ? basePlan : { ...basePlan, signal };
  };
  const prepare = (call?: AsyncOverrides): Planned => {
    const forCall = planFor(call);
    if (state.closed)
      return { ok: false, failure: { kind: "parser-closed" }, reported: forCall.reported };
    // Capture an already-aborted reason at the call; a later task abort before the first pull
    // must not replace it. Task wins the specified already-aborted tie.
    const task = state.signal;
    const stopped = readStop(task) ?? readStop(forCall.signal);
    return stopped === undefined
      ? forCall
      : {
          ok: false,
          failure: stopped,
          reported: forCall.reported,
        };
  };
  const close = (): Result<undefined, never> => {
    state.closed = true;
    // Calls already created own their task reference; closing only prevents new calls.
    state.signal = undefined;
    return RELEASED;
  };
  const configuration = {
    options: basePlan.options,
    settings: inherited,
    prepare,
    close,
    execute: (operation: WholeRequest, input: Input, planned: Planned, release?: () => void) =>
      execute(operation, input, planned, state.signal, release),
  };
  return AsyncConfiguration.create(configuration);
};
