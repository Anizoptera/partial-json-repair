// SPDX-License-Identifier: Apache-2.0

/** Resume one whole-input operation at explicit checkpoints under any executor. */

import { builtinAllowed, builtinParse } from "./builtin-route";
import { MODE_NATIVE } from "./native-slice";
import type { repairOperation } from "./repair-operation";
import type { spanOperation } from "./span-operation";
import type { manySteps } from "./whole-reader";
import type { WholeInputReader } from "./whole-reader";
import type { ResolvedOptions } from "./options";
import { bareFailure, recovered, reportOf, shaped, takeOutcome } from "./parser-outcome";
import type { Outcome } from "./parser-outcome";
import type { StopSignal } from "./stop-signal";
import { readStop } from "./stop-signal";
import { byteLength, isBytes } from "./transport";
import type {
  AbortedFailure,
  Cut,
  Diagnostics,
  Input,
  Match,
  ParseFailure,
  Recovery,
  SchedulingFailure,
  SignalFailure,
  Value,
} from "./types";
import {
  firstSteps,
  createBoundedWholeInputReader,
  laterValueSteps,
  moreSteps,
  WHOLE_INPUT_SLICE,
} from "./whole-reader";
import { wholeInputSourceSteps, wholeInputScanSource } from "./whole-source";
import type { WholeInputSource } from "./whole-source";

export type WholeOperation = "parse" | "parseMany" | "repair" | "findJsonSpan";
/** Callers carry optional delivery code so single-value parsing can omit it. */
export type WholeRequest =
  | "parse"
  | typeof manySteps
  | typeof repairOperation
  | typeof spanOperation;
export type WholeSingleRequest = Exclude<WholeRequest, typeof manySteps>;
export type WholeOperationStep =
  | { readonly kind: "checkpoint" }
  // Terminal failures release ownership before delivery; own flags keep inherited keys from
  // stopping a continuing root, and requiring the field makes omission a compile error.
  // The receiver consumes the owned value slot before forwarding it to a paused caller.
  | { readonly kind: "item"; value: unknown; readonly terminal: boolean };

/**
 * The longest text the built-in route may take here. `JSON.parse` cannot be sliced or stopped, so it
 * serves only text short enough to read in one step inside the 4 ms frame: 64 Ki units of
 * clean JSON took about 0.2 ms, under 0.5 ms at the 99th percentile, through `builtinRead`, about
 * 5x faster than the scanner (Bun 1.4.2, M4 Max, load ~20, one process, 200 runs). The slowest
 * shape measured, an array of exponent numbers, took 0.7-1 ms at the median and about 2 ms at the
 * 99th percentile (Bun and Node 24, load ~30): above the slice, inside the 4 ms frame. Longer text
 * stays on the sliced scanner.
 */
const BUILTIN_UNITS = 65_536;

type WholeStopFailure =
  | AbortedFailure
  | SignalFailure
  | SchedulingFailure
  | Extract<ParseFailure, { kind: "invalid-input" }>;

// Cancellation belongs to async execution; a method on the shared reader would ship it in sync parse.
export const stoppedOutcome = (
  reader: WholeInputReader,
  stopped: WholeStopFailure,
  pending: { matches: Match[]; root?: number | "open" } | undefined,
): Outcome<never, WholeStopFailure> => {
  // stopReader supplies every selected recovery; only an unselected scanner needs live recovery.
  // It commits pending text before preparation and closes after projection in finally.
  let diagnostics: Diagnostics | undefined;
  let open: Recovery | undefined =
    pending === undefined
      ? reader.scanner.recovery()
      : pending.root === "open"
        ? recovered(pending.matches, reader.scanner.cut())
        : recovered(pending.matches, reader.scanner.cutAt(pending.root ?? reader.scanned));
  // Filtering can hold an earlier object; use it only without live recovery or an accepted root.
  if (
    reader.compatible !== undefined &&
    !reader.scanner.build.hasOpenRoot &&
    (pending === undefined || pending.matches.length === 0)
  ) {
    open = reader.compatible.recovery;
    if (reader.opts.diagnostics !== false) diagnostics = reader.compatible.diagnostics;
  }
  let failure: WholeStopFailure = open === undefined ? stopped : { ...stopped, recovered: open };
  if (failure.kind === "invalid-input") {
    const cause = reader.scanner.failure() ?? reader.scanner.verdictAt(reader.scanned);
    if (cause !== undefined) failure = { ...failure, cause };
  }
  if (reader.opts.diagnostics !== false && diagnostics === undefined)
    diagnostics = reportOf(
      reader.scanner,
      reader.opts,
      reader.opts.diagnostics,
      reader.scanned,
      reader.cursor,
    );
  return diagnostics === undefined ? { ok: false, failure } : { ok: false, failure, diagnostics };
};

// A settled outcome's data and report, for a stop or source failure that arrives after it.
const recoveryOf = (parsed: Outcome<Value, ParseFailure>): Recovery | undefined =>
  parsed.ok
    ? recovered(parsed.value, parsed.cut)
    : "recovered" in parsed.failure
      ? parsed.failure.recovered
      : undefined;

const failedAfter = <F>(
  parsed: Outcome<Value, ParseFailure>,
  failure: F,
): { ok: false; failure: F; diagnostics?: Diagnostics } =>
  parsed.diagnostics === undefined
    ? { ok: false, failure }
    : { ok: false, failure, diagnostics: parsed.diagnostics };

export function* stopReader(reader: WholeInputReader, failure: WholeStopFailure, units: number) {
  try {
    reader.scanner.stopPending();
    const selection = reader.scanner.selectionRoots;
    let pending = selection?.resumeRoot(units);
    while (pending === "checkpoint") {
      // Resume only built recovery: stopped processing forbids source consumption or EOF repair.
      yield { kind: "checkpoint" as const };
      pending = selection?.resumeRoot(units);
    }
    if (
      selection !== undefined &&
      (pending === undefined || selection.recoveryRoot() !== undefined)
    ) {
      // Preserve unread completed matches or the unfinished root's live cut without EOF repairs.
      const matches: Match[] = [];
      let at = selection.recoverInto(matches, 0, units);
      while (at !== undefined) {
        yield { kind: "checkpoint" as const };
        at = selection.recoverInto(matches, at, units);
      }
      if (pending !== undefined) {
        // Accumulated occurrences precede the prepared root's remaining final matches.
        for (let index = 0; index < pending.matches.length; index++) {
          if (index > 0 && index % units === 0) yield { kind: "checkpoint" as const };
          matches.push(pending.matches[index] as Match);
        }
      }
      return shaped(
        stoppedOutcome(
          reader,
          failure,
          pending === undefined
            ? { matches, root: selection.recoveryRoot() ?? "open" }
            : { matches },
        ),
      );
    }
    return shaped(stoppedOutcome(reader, failure, pending));
  } finally {
    // Abandonment during recovery preparation must release the source and scanner too.
    reader.close();
  }
}

/**
 * The generator owns decoding, scanning, cancellation, and projection for one operation. Executors
 * decide only what happens between checkpoints, so changing placement cannot change the result.
 */
export function* wholeOperation(
  operation: WholeRequest,
  input: Input,
  options: ResolvedOptions,
  signal?: StopSignal,
  units = WHOLE_INPUT_SLICE,
  retain?: (value: unknown, cut: Cut | undefined) => void,
): Generator<
  WholeOperationStep,
  unknown,
  AbortedFailure | SchedulingFailure | SignalFailure | undefined
> {
  // A caller-supplied reader keeps multi-value delivery out of single-value consumers.
  const multiple = typeof operation === "function";
  const reported = options.diagnostics;
  const initialStop = readStop(signal);
  if (initialStop !== undefined) {
    const failure = shaped(bareFailure(initialStop, reported));
    if (multiple) {
      yield { kind: "item", value: failure, terminal: true };
      return undefined;
    }
    return failure;
  }

  const materialized =
    (typeof operation === "object" && operation.kind === "repair") ||
    (operation === "parse" &&
      builtinAllowed(options) &&
      // UTF-8 uses at most three bytes per decoded UTF-16 unit, including malformed sequences.
      // Above this bound the built-in parser cannot run; eager decoding only postpones recovery.
      (!isBytes(input) || byteLength(input) <= 3 * BUILTIN_UNITS));
  const decoding = materialized ? wholeInputSourceSteps(input, units) : undefined;
  let source;
  while (true) {
    const step = decoding?.next() ?? {
      done: true as const,
      value: wholeInputScanSource(input, units),
    };
    if (step.done === true) {
      if ("kind" in step.value) {
        const failure = shaped(bareFailure(step.value, reported));
        if (multiple) {
          yield { kind: "item", value: failure, terminal: true };
          return undefined;
        }
        return failure;
      }
      source = step.value;
      break;
    }
    const failed = yield { kind: "checkpoint" };
    const stopped = failed ?? readStop(signal);
    if (stopped !== undefined) {
      const failure = shaped(bareFailure(stopped, reported));
      if (multiple) {
        yield { kind: "item", value: failure, terminal: true };
        return undefined;
      }
      return failure;
    }
  }

  if (
    source.text !== undefined &&
    source.failure === undefined &&
    source.text.length <= BUILTIN_UNITS &&
    (operation === "parse" || (typeof operation === "object" && operation.kind === "repair"))
  ) {
    const built =
      operation === "parse"
        ? builtinParse(source, options)
        : operation.builtin(source, options, retain);
    if (built !== undefined) {
      source.releasePositions?.();
      return shaped(built);
    }
  }

  const reader = createBoundedWholeInputReader(
    source,
    options,
    typeof operation === "object" && operation.kind === "repair" ? operation.mode : MODE_NATIVE,
    units,
  );
  try {
    if (typeof operation === "function") {
      const steps = operation(reader);
      while (true) {
        const step = steps.next();
        if (step.done === true) {
          if (step.value !== undefined)
            yield {
              kind: "item",
              value:
                !step.value.ok && step.value.failure.kind === "invalid-input"
                  ? yield* stopReader(reader, step.value.failure, units)
                  : shaped(step.value),
              terminal: true,
            };
          return undefined;
        }
        if (step.value !== undefined) {
          // A limit can surface with its stopped root; unlike a policy refusal, it ends the scan.
          if (!step.value.ok && step.value.failure.kind === "limit-reached") {
            yield { kind: "item", value: shaped(step.value), terminal: true };
            return undefined;
          }
          const failed = yield { kind: "item", value: shaped(takeOutcome(step)), terminal: false };
          // Resuming a pull is a cancellation boundary even when the next root fits one slice.
          const stopped = failed ?? readStop(signal);
          if (stopped !== undefined) {
            yield {
              kind: "item",
              value: yield* stopReader(reader, stopped, units),
              terminal: true,
            };
            return undefined;
          }
          continue;
        }
        const failed = yield { kind: "checkpoint" };
        const stopped = failed ?? readStop(signal);
        if (stopped !== undefined) {
          yield {
            kind: "item",
            value: yield* stopReader(reader, stopped, units),
            terminal: true,
          };
          return undefined;
        }
      }
    }

    const steps = firstSteps(reader);
    while (true) {
      const step = steps.next();
      if (step.done === true) {
        const parsed = step.value.outcome;
        const later = laterValueSteps(input, step.value, units);
        while (later.next().done !== true) {
          const failed = yield { kind: "checkpoint" };
          const stopped = failed ?? readStop(signal);
          // A report cut short here would list no later values as if there were none.
          if (stopped !== undefined) {
            later.return();
            const open = recoveryOf(parsed);
            return shaped(
              failedAfter(parsed, open === undefined ? stopped : { ...stopped, recovered: open }),
            );
          }
        }
        if (!parsed.ok && parsed.failure.kind === "invalid-input")
          return yield* stopReader(reader, parsed.failure, units);
        if (source.text !== undefined && source.failure !== undefined) {
          // A root in the decoded prefix cannot turn unreadable input into successful completion.
          const open = recoveryOf(parsed);
          return shaped(
            failedAfter(parsed, {
              ...source.failure,
              ...(open === undefined ? {} : { recovered: open }),
              ...(parsed.ok ? {} : { cause: parsed.failure }),
            }),
          );
        }
        // Projection can discard the parsed tree; a cancellable worker retains that same tree until delivery.
        if (parsed.ok) retain?.(parsed.value, parsed.cut);
        let out: Parameters<typeof shaped>[0];
        if (operation === "parse") out = parsed;
        else if (operation.kind === "findJsonSpan" && !step.value.scanner.selecting)
          out = operation.direct(step.value);
        else if (parsed.ok) {
          // Repair selects materialized decoding above; span projection never reads source text.
          const projection = operation.project(source as WholeInputSource, step.value, units);
          while (true) {
            const projected = projection.next();
            if (projected.done === true) {
              out = projected.value;
              break;
            }
            const failed = yield { kind: "checkpoint" };
            const stopped = failed ?? readStop(signal);
            if (stopped !== undefined)
              return shaped(
                failedAfter(parsed, { ...stopped, recovered: recovered(parsed.value, parsed.cut) }),
              );
          }
        } else {
          out = parsed;
        }
        // After projection, as on the synchronous route: see `moreSteps`.
        const more = moreSteps(reader, step.value, out);
        while (more.next().done !== true) {
          const failed = yield { kind: "checkpoint" };
          const stopped = failed ?? readStop(signal);
          if (stopped !== undefined) {
            more.return();
            const open = recoveryOf(parsed);
            return shaped(
              failedAfter(parsed, open === undefined ? stopped : { ...stopped, recovered: open }),
            );
          }
        }
        return shaped(out);
      }
      const failed = yield { kind: "checkpoint" };
      const stopped = failed ?? readStop(signal);
      if (stopped !== undefined) return yield* stopReader(reader, stopped, units);
    }
  } finally {
    // Projection finishes before disposal so returned recovery keeps its values and reports.
    reader.close();
  }
}
