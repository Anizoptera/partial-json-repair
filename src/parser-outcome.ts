// SPDX-License-Identifier: Apache-2.0

/** Build shaped parser outcomes and apply their retained diagnostics and source edits. */
import type { Delivery } from "./picks";
import type { Overflow, ReportFeature } from "./report";
import type { ResolvedOptions } from "./options";
import type { PositionAt } from "./positions";
import type { Scanner } from "./scan-contract";
import type { Limit } from "./scan-diagnostics";
import type {
  Completion,
  Cut,
  Diagnostics,
  Match,
  ParseFailure,
  Recovery,
  Span,
  Value,
} from "./types";

/** Scanner offsets are UTF-16 indexes into the decoded text; the source's owner says what that is in its own units. */
export const spanOf = (span: { start: number; end: number }, positionAt: PositionAt): Span => ({
  start: positionAt(span.start),
  end: positionAt(span.end),
});

/**
 * The runtime shape every outcome is built in. The report and `span` are present exactly when the
 * options ask for them, which is what the `Shaped` type parameter mirrors — so the one cast in this
 * file, at `shaped`, states a fact the code above it made true rather than asserting anything new.
 */
export type Outcome<T, F, C = Completion> = (
  | ({ ok: true; value: T; span?: Span } & C)
  | { ok: false; failure: F }
) & {
  diagnostics?: Diagnostics;
};

export const takeOutcome = <Payload>(slot: { value: Payload | undefined }): Payload => {
  // Suspended delegates can retain their last iterator-result record; empty it before yielding.
  const value = slot.value;
  slot.value = undefined;
  if (value === undefined)
    throw new Error("No staged outcome; filter checkpoints before delivering an iterator value.");
  return value;
};

/**
 * A success and its completion facts, written in one literal per case so every success has one of
 * two fixed shapes, and `cut` is absent (not `undefined`) on a value the source finished.
 */
export const success = <T>(value: T, cut: Cut | undefined): { ok: true; value: T } & Completion =>
  cut === undefined
    ? { ok: true, value, complete: true }
    : { ok: true, value, complete: false, cut };

/** `value` as a failure's recovery, with the same completion facts a success would carry. */
export const recovered = (value: unknown, cut: Cut | undefined): Recovery =>
  cut === undefined ? { value, complete: true } : { value, complete: false, cut };

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- `S` is the option-typed shape the caller promises; this is the one cast between the runtime object and it.
export const shaped = <S>(
  outcome: Outcome<unknown, unknown, { complete?: boolean; cut?: Cut | undefined }>,
): S => outcome as S;

/**
 * A failure that reached no scanner. The report is empty rather than absent when one was asked
 * for, so a caller whose type promises `diagnostics` finds it on every branch.
 */
export const bareFailure = <F>(failure: F, reported: false | ReportFeature): Outcome<never, F> =>
  reported === false ? { ok: false, failure } : { ok: false, failure, diagnostics: reported.empty };

/**
 * Where a consumer has read to in each retained log. The logs are ordered by `valueIndex`, so one
 * cursor walks each of them once across a whole stream instead of filtering them per value.
 */
export type LogCursor = {
  repair: number;
  error: number;
  /** The overflow counts the last report of value `index` already carried, so the next takes the rest. */
  overflowSeen?: { index: number; counts: Overflow };
};

/** Only the imported diagnostics feature projects reports; the shared core keeps no assembler. */
export const reportOf = (
  scanner: Scanner,
  opts: ResolvedOptions,
  feature: ReportFeature,
  valueIndex: number,
  cursor: LogCursor,
): Diagnostics => feature.project(scanner, opts, valueIndex, cursor);

/** The matches among a batch of deliveries; fragments and refusals are stream items in their own right. */
export const matchesOf = (deliveries: readonly Delivery[]): Match[] => {
  const out: Match[] = [];
  for (const d of deliveries) if (!("kind" in d)) out.push(d);
  return out;
};

/**
 * The outcome of a finished root. Its verdict — a refusal or a limit — becomes the failure, with
 * the tree that was built attached as `recovered`: the data is real, the status is not success.
 */
export const outcomeAt = (
  scanner: Scanner,
  opts: ResolvedOptions,
  valueIndex: number,
  value: unknown,
  cursor: LogCursor,
): Outcome<Value, ParseFailure> => {
  const verdict = scanner.verdictAt(valueIndex);
  const cut = scanner.cutAt(valueIndex);
  const outcome: Outcome<Value, ParseFailure> =
    verdict === undefined
      ? success(value, cut)
      : { ok: false, failure: { ...verdict, recovered: recovered(value, cut) } };
  if (outcome.ok && opts.locations) {
    outcome.span = spanOf(scanner.spanAt(valueIndex), scanner.positionAt);
  }
  if (opts.diagnostics !== false)
    outcome.diagnostics = reportOf(scanner, opts, opts.diagnostics, valueIndex, cursor);
  return outcome;
};

/**
 * The outcome of a root a buffer or scalar bound refused to finish. Whatever was built is the
 * recovery; there is no verdict to read because the root never finished.
 */
export const stoppedAt = (
  scanner: Scanner,
  opts: ResolvedOptions,
  valueIndex: number,
  limit: Limit,
  open: Recovery | undefined,
  cursor: LogCursor,
): Outcome<never, ParseFailure> => {
  const outcome: Outcome<never, ParseFailure> = {
    ok: false,
    failure: open === undefined ? limit : { ...limit, recovered: open },
  };
  if (opts.diagnostics !== false)
    outcome.diagnostics = reportOf(scanner, opts, opts.diagnostics, valueIndex, cursor);
  return outcome;
};

/**
 * What `close()` answers, every time. One frozen object rather than a fresh literal per call: HLD
 * requires `close()` to preserve its FIRST result, and a caller comparing two answers by identity
 * must see the same one. Nothing the TypeScript parser owns can fail to release, so it is always
 * success.
 */
export const RELEASED: { readonly ok: true; readonly value: undefined } =
  /* @__PURE__ */ Object.freeze({
    ok: true,
    value: undefined,
  });
