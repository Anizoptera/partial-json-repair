// SPDX-License-Identifier: Apache-2.0

/** Read whole-input outcomes through one scanner while retaining only projection state. */

import type { BuildMode } from "./builder";
import { MODE_VALUE } from "./builder";
import { MODE_NATIVE } from "./native-slice";
import type { ResolvedOptions } from "./options";
import {
  bareFailure,
  matchesOf,
  outcomeAt,
  recovered,
  reportOf,
  spanOf,
  stoppedAt,
  takeOutcome,
  type LogCursor,
  type Outcome,
} from "./parser-outcome";
import { acceptsRoot, noMatch } from "./root-filter";
import { createScanner } from "./scan";
import type { Scanner, ScanEnd } from "./scan-contract";
import { ScanCursor } from "./scan-cursor";
import type { Limit } from "./scan-diagnostics";
import type { Diagnostics, Input, Match, ParseFailure, Recovery, Span, Value } from "./types";
import { wholeInputScanSource, type WholeInputScanSource } from "./whole-source";

type ReaderStep =
  | { kind: "checkpoint" }
  | { kind: "deliveries"; matches: Match[]; valueIndex: number }
  | { kind: "root"; value: unknown; matches: Match[]; valueIndex: number }
  | {
      kind: "stopped";
      matches: Match[];
      open: Recovery | undefined;
      valueIndex: number;
      limit: Limit;
    }
  | { kind: "done"; failure: ParseFailure | undefined };

export type ReaderResult = {
  outcome: Outcome<Value, ParseFailure>;
  options: ResolvedOptions;
  scanner: Scanner;
  valueIndex: number;
  /** The outcome is a finished root's, so the input past it may hold later values. */
  root: boolean;
};

/** One deterministic source quantum for sync draining and async host checkpoints. */
export const WHOLE_INPUT_SLICE = 4096;

// Projections are free functions: retaining scan state must not retain every delivery strategy.
const readerResult = (
  reader: WholeInputReader,
  outcome: Outcome<Value, ParseFailure>,
  valueIndex: number,
  root = false,
): ReaderResult => ({ outcome, options: reader.opts, scanner: reader.scanner, valueIndex, root });

/**
 * The report's later-value scan, for a single-value verb. The imported diagnostics feature owns the
 * loop; this only makes its second reader, with the call's policy and root filters but no report,
 * selection or locations, because the whole-input drivers already own source and reader
 * construction. A default call has no feature and never scans past its value.
 */
export function* laterValueSteps(
  input: Input,
  result: ReaderResult,
  units: number,
): Generator<void, void> {
  const feature = result.options.diagnostics;
  if (feature === false) return;
  yield* feature.later(input, result, () => {
    const source = wholeInputScanSource(input, units);
    if ("kind" in source) return undefined;
    const plain = {
      ...result.options,
      diagnostics: false,
      locations: false,
      selection: undefined,
      occurrences: false,
      fragments: false,
    } as const;
    return createBoundedWholeInputReader(source, plain, MODE_VALUE, units);
  });
}

/**
 * HLD P4: a single-value verb's success says when the input holds a value after the returned one
 * (`more: true`), with or without a report, because a caller reading only the value otherwise takes
 * the first of two answers, perhaps the one the model then corrected. A requested report already
 * finds later values with a second reader, so its list decides. Without a report, the same reader
 * continues, and only after projection, because later roots would add to the returned root's edits
 * and spans. A second reader would re-read the returned value, and every fenced reply would pay
 * that: its closing fence is text after the value, so the scan always runs. The reader's next
 * accepted root is the one `parseMany` would deliver next; the scan stops there, and reads to the
 * end of input only when no value follows. A limit or the error budget ending the scan first leaves
 * `more` absent: nothing was found.
 */
export function* moreSteps(
  reader: WholeInputReader,
  result: ReaderResult,
  out: { readonly ok: boolean },
): Generator<void, void> {
  if (!out.ok || !result.root) return;
  if (result.options.diagnostics !== false) {
    if ((result.outcome.diagnostics?.laterValues.length ?? 0) > 0) markMore(out);
    return;
  }
  while (true) {
    const step = reader.next();
    if (step.kind === "checkpoint") {
      yield;
      continue;
    }
    if (step.kind === "deliveries") continue;
    if (step.kind === "root") markMore(out);
    return;
  }
}

const markMore = (out: { readonly ok: boolean }): void => {
  (out as { more?: true }).more = true;
};

/** Synchronous calls drain `moreSteps` as they drain every other checkpointed step. */
export const withMore = <T extends { readonly ok: boolean }>(
  reader: WholeInputReader,
  result: ReaderResult,
  out: T,
): T => {
  const steps = moreSteps(reader, result, out);
  while (steps.next().done !== true);
  return out;
};

/** Synchronous calls drain the later-value scan's checkpoints, as `readFirst` drains its own. */
export const withLaterValues = (input: Input, result: ReaderResult): ReaderResult => {
  const steps = laterValueSteps(input, result, WHOLE_INPUT_SLICE);
  while (steps.next().done !== true);
  return result;
};

export const readFirst = (reader: WholeInputReader): ReaderResult => {
  // Synchronous recovery drains checkpoints; async schedulers use firstSteps directly.
  const operation = firstSteps(reader);
  while (true) {
    const step = operation.next();
    if (step.done === true) return step.value;
  }
};

export function* firstSteps(reader: WholeInputReader): Generator<void, ReaderResult> {
  // Each batch already owns its array; accumulate occurrences without copying the first batch.
  let matches: Match[] = [];
  while (true) {
    const step = reader.next();
    if (step.kind === "checkpoint") {
      yield;
      continue;
    }
    if (step.kind !== "done") {
      if (matches.length === 0) matches = step.matches;
      else for (const match of step.matches) matches.push(match);
    }
    if (step.kind === "deliveries") {
      // First-result calls have not handed these occurrences to the caller yet.
      reader.scanner.selectionRoots?.retainDeliveries(matches, "open");
      continue;
    }
    if (step.kind === "root")
      return readerResult(
        reader,
        outcomeAt(
          reader.scanner,
          reader.opts,
          step.valueIndex,
          reader.scanner.selecting ? matches : step.value,
          reader.cursor,
        ),
        step.valueIndex,
        true,
      );
    if (step.kind === "stopped") {
      const open =
        reader.scanner.selecting && step.open !== undefined
          ? { ...step.open, value: [...matches, ...(step.open.value as Match[])] }
          : step.open;
      return readerResult(
        reader,
        stoppedAt(reader.scanner, reader.opts, step.valueIndex, step.limit, open, reader.cursor),
        step.valueIndex,
      );
    }
    const outcome = bareFailure<ParseFailure>(
      step.failure ?? { kind: "no-json-found" },
      reader.opts.diagnostics,
    );
    if (reader.opts.diagnostics !== false && step.failure?.kind === "no-match") {
      const diagnostics = reader.compatible?.diagnostics;
      if (diagnostics !== undefined) outcome.diagnostics = diagnostics;
    }
    return readerResult(reader, outcome, 0);
  }
}

export function* readMany(
  reader: WholeInputReader,
): Generator<Outcome<unknown, ParseFailure>, Outcome<unknown, ParseFailure> | undefined> {
  // Hide checkpoints; returning terminal recovery lets the owning handle release before delivery.
  const steps = manySteps(reader);
  try {
    while (true) {
      const step = steps.next();
      if (step.done === true) return step.value;
      if (step.value !== undefined) {
        // A limit may arrive with a completed recovery root, but cannot resume like a refusal.
        if (!step.value.ok && step.value.failure.kind === "limit-reached") return step.value;
        yield takeOutcome(step);
      }
    }
  } finally {
    steps.return(undefined);
  }
}

export function* manySteps(
  reader: WholeInputReader,
): Generator<
  Outcome<unknown, ParseFailure> | undefined,
  Outcome<unknown, ParseFailure> | undefined
> {
  const reported = reader.opts.diagnostics;
  const selection = reader.scanner.selectionRoots;
  const delivery: { value: Outcome<unknown, ParseFailure> | undefined } = { value: undefined };
  while (true) {
    let step: ReturnType<typeof reader.next> | undefined = reader.next();
    if (step.kind === "checkpoint") {
      yield undefined;
      continue;
    }
    if (step.kind === "done") {
      // Return the final failure so executors can distinguish it from resumable root refusals.
      if (step.failure === undefined) return undefined;
      const outcome = bareFailure(step.failure, reported);
      if (reported !== false && step.failure.kind === "no-match") {
        const diagnostics = reader.compatible?.diagnostics;
        if (diagnostics !== undefined) outcome.diagnostics = diagnostics;
      }
      return outcome;
    }
    const verdict =
      step.kind === "root" && selection !== undefined
        ? reader.scanner.verdictAt(step.valueIndex)
        : undefined;
    if (
      step.kind === "root" &&
      (selection === undefined || (verdict !== undefined && !reader.opts.occurrences))
    ) {
      delivery.value = outcomeAt(
        reader.scanner,
        reader.opts,
        step.valueIndex,
        selection === undefined ? step.value : step.matches,
        reader.cursor,
      );
      // The outcome owns its report; neither the root log nor this frame needs delivered data.
      const nextRoot = step.valueIndex + 1;
      step = undefined;
      reader.scanner.releaseBefore(nextRoot, reader.cursor);
      yield takeOutcome(delivery);
      continue;
    }
    // Final matches share one report; source occurrences take only each delivery's delta.
    let diagnostics =
      step.kind === "root" && reported !== false
        ? reportOf(reader.scanner, reader.opts, reported, step.valueIndex, reader.cursor)
        : undefined;
    if (selection !== undefined) {
      selection.retainDeliveries(step.matches, step.kind === "root" ? step.valueIndex : "open");
      const matches = step.matches;
      for (let index = 0; index < matches.length; index++) {
        delivery.value = selection.outcome(matches[index] as Match, reader.scanner);
        selection.consumeDelivery();
        if (diagnostics !== undefined) delivery.value.diagnostics = diagnostics;
        else if (reported !== false && step.kind !== "root")
          delivery.value.diagnostics = reportOf(
            reader.scanner,
            reader.opts,
            reported,
            step.valueIndex,
            reader.cursor,
          );
        if (index + 1 === matches.length && step.kind === "root" && verdict === undefined) {
          // Later matches share this report; the last one transfers its remaining ownership.
          const nextRoot = step.valueIndex + 1;
          diagnostics = undefined;
          step = undefined;
          reader.scanner.releaseBefore(nextRoot, reader.cursor);
        }
        yield takeOutcome(delivery);
        if (step === undefined) break;
      }
    }
    if (step === undefined) continue;
    if (step.kind === "root") {
      if (verdict !== undefined)
        delivery.value =
          diagnostics === undefined
            ? { ok: false, failure: verdict }
            : { ok: false, failure: verdict, diagnostics };
      const nextRoot = step.valueIndex + 1;
      diagnostics = undefined;
      step = undefined;
      reader.scanner.releaseBefore(nextRoot, reader.cursor);
      if (verdict !== undefined) yield takeOutcome(delivery);
    } else if (step.kind === "stopped") {
      return stoppedAt(
        reader.scanner,
        reader.opts,
        step.valueIndex,
        step.limit,
        step.open,
        reader.cursor,
      );
    }
  }
}

export type { WholeInputReader };

// Free factories keep asynchronous budget validation out of direct-call consumer bundles.
export const createWholeInputReader = (
  source: WholeInputScanSource,
  opts: ResolvedOptions,
  mode = MODE_NATIVE,
): WholeInputReader => new WholeInputReader(source, opts, mode, WHOLE_INPUT_SLICE);

export const createBoundedWholeInputReader = (
  source: WholeInputScanSource,
  opts: ResolvedOptions,
  mode: BuildMode,
  units: number,
): WholeInputReader => {
  if (!Number.isSafeInteger(units) || units < 1) throw new RangeError("units must be positive");
  return new WholeInputReader(source, opts, mode, units);
};

/** Owns one whole-input scan and the root-filter state shared by every projection of that scan. */
class WholeInputReader {
  readonly scanner: Scanner;
  readonly cursor: LogCursor = { repair: 0, error: 0 };
  // Async stopped projection reads this position without retaining its code in sync consumers.
  scanned = 0;
  private accepted = 0;
  // Later roots retire their logs; a fallback must keep its own requested explanation.
  compatible: { readonly recovery: Recovery; readonly diagnostics?: Diagnostics } | undefined;
  private rest: ScanEnd | undefined;
  private supplied = 0;
  private malformed = 0;
  private sourceFailure: ParseFailure | undefined;
  private source: WholeInputScanSource | undefined;

  constructor(
    source: WholeInputScanSource,
    readonly opts: ResolvedOptions,
    mode: BuildMode,
    private readonly units: number,
  ) {
    this.source = source;
    this.scanner = createScanner(
      opts,
      source.positionAt,
      mode,
      new ScanCursor(source.positionAt, source.text ?? source.context),
      true,
    );
    this.supply();
  }

  close(): void {
    // Native frames can retain this reader after return; closing only its scanner leaves input live.
    this.source?.releasePositions?.();
    this.source = undefined;
    this.rest = undefined;
    this.compatible = undefined;
    this.scanner.close();
  }

  // Delivery projections read one checkpoint without retaining their code on the scan-state object.
  next(): ReaderStep {
    if (this.sourceFailure !== undefined) return { kind: "done", failure: this.sourceFailure };
    while (true) {
      const pending = this.scanner.selectionRoots?.resumeRoot(this.units);
      if (pending !== undefined) {
        if (pending === "checkpoint") return { kind: "checkpoint" };
        const root = this.accept(pending.value, pending.matches);
        if (root !== undefined) return root;
        continue;
      }
      if (this.rest === undefined) {
        const pulled = this.scanner.pull();
        if (pulled === undefined) {
          if (this.supply()) return { kind: "checkpoint" };
          if (this.sourceFailure !== undefined)
            return { kind: "done", failure: this.sourceFailure };
          this.rest = this.scanner.end();
          continue;
        }
        if (pulled.root === undefined) {
          const matches = matchesOf(this.scanner.deliveries());
          if (matches.length > 0) return { kind: "deliveries", matches, valueIndex: this.scanned };
          continue;
        }
        const root = this.accept(pulled.root.value);
        if (root !== undefined) return root;
        continue;
      }

      if (this.scanned < this.rest.first + this.rest.values.length) {
        const value = this.rest.values[this.scanned - this.rest.first];
        const root = this.accept(value);
        if (root !== undefined) return root;
        continue;
      }
      const limit = this.scanner.failure();
      const matches = matchesOf(this.scanner.deliveries());
      if (limit !== undefined) {
        return { kind: "stopped", matches, open: this.rest.open, valueIndex: this.scanned, limit };
      }
      return {
        kind: "done",
        failure:
          this.scanned === 0
            ? { kind: "no-json-found" }
            : this.accepted === 0
              ? noMatch(this.opts, this.compatible?.recovery)
              : undefined,
      };
    }
  }

  private accept(value: unknown, matches?: Match[]): ReaderStep | undefined {
    if (matches === undefined) {
      const prepared = this.scanner.selectionRoots?.prepareRoot(value, this.units);
      if (prepared === "checkpoint") return { kind: "checkpoint" };
      matches = prepared?.matches ?? matchesOf(this.scanner.deliveries());
    }
    const valueIndex = this.scanned++;
    // Filtered candidates have no delivery boundary; release earlier logs when another root arrives.
    this.scanner.releaseBefore(valueIndex, this.cursor);
    if (
      this.scanner.verdictAt(valueIndex) === undefined &&
      !acceptsRoot(this.scanner, valueIndex, this.opts)
    ) {
      if (
        this.accepted === 0 &&
        this.compatible === undefined &&
        this.scanner.rootInfoAt(valueIndex)?.object === true
      ) {
        const recovery = recovered(
          this.scanner.selecting ? matches : value,
          this.scanner.cutAt(valueIndex),
        );
        this.compatible =
          this.opts.diagnostics === false
            ? { recovery }
            : {
                recovery,
                diagnostics: reportOf(
                  this.scanner,
                  this.opts,
                  this.opts.diagnostics,
                  valueIndex,
                  this.cursor,
                ),
              };
      }
      return undefined;
    }
    // Once a root is accepted for delivery, the earlier fallback is no longer needed.
    this.compatible = undefined;
    this.accepted++;
    return { kind: "root", value, matches, valueIndex };
  }

  private supply(): boolean {
    const source = this.source;
    if (source === undefined) return false;
    if (source.text === undefined) {
      if (this.scanner.failure() !== undefined) return false;
      // No complete decoded string backs these slices; compaction prevents repeated prefix copying.
      this.scanner.compactInput();
      const piece = source.next(this.units);
      if (piece === undefined) return false;
      if ("kind" in piece) {
        this.sourceFailure = piece;
        return false;
      }
      if ("unsupported" in piece) {
        this.sourceFailure = { kind: "unsupported-encoding", encoding: piece.unsupported };
        return false;
      }
      this.scanner.supply(piece.text, piece.malformed);
      return true;
    }
    if (this.supplied >= source.text.length) {
      this.sourceFailure = source.failure;
      return false;
    }
    const end = Math.min(source.text.length, this.supplied + this.units);
    const malformed: number[] = [];
    for (let at = source.malformed[this.malformed]; at !== undefined && at < end;) {
      if (at >= this.supplied) malformed.push(at - this.supplied);
      at = source.malformed[++this.malformed];
    }
    this.scanner.supply(source.text.slice(this.supplied, end), malformed);
    this.supplied = end;
    return true;
  }
}

// Projection changes the payload while retaining the scan's requested report.
const projectedSpan = (
  outcome: Extract<ReaderResult["outcome"], { ok: true }>,
  value: Span | Match<Span>[],
) =>
  outcome.diagnostics === undefined
    ? { ok: true as const, value }
    : { ok: true as const, value, diagnostics: outcome.diagnostics };

/** Project selected source spans at bounded checkpoints after scanning. */
export function* spanSteps(
  { outcome }: ReaderResult,
  units: number,
): Generator<void, Outcome<Span | Match<Span>[], ParseFailure, unknown>> {
  if (!outcome.ok) return outcome;
  // Both callers establish selection before entering; refusal retains its original source data.
  const matches = outcome.value as Match[];
  const spans: Match<Span>[] = [];
  for (let index = 0; index < matches.length; index++) {
    // Final projection grows with matches even after the scanner's bounded work is finished.
    if (index > 0 && index % units === 0) yield;
    const match = matches[index] as Match;
    spans.push({
      value: match.span,
      path: match.path,
      valueIndex: match.valueIndex,
      span: match.span,
      selectors: match.selectors,
    });
  }
  return projectedSpan(outcome, spans);
}

export const spanOutcome = (
  result: ReaderResult,
): Outcome<Span | Match<Span>[], ParseFailure, unknown> => {
  if (!result.outcome.ok) return result.outcome;
  // A single source span needs no match traversal or scheduling allocation.
  if (!result.scanner.selecting)
    return projectedSpan(
      result.outcome,
      spanOf(result.scanner.spanAt(result.valueIndex), result.scanner.positionAt),
    );
  // Synchronous callers drain the same projection without introducing a scheduling boundary.
  const steps = spanSteps(result, Infinity);
  const step = steps.next();
  if (step.done !== true) throw new Error("one-shot span projection yielded");
  return step.value;
};
