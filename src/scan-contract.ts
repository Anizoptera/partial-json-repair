// SPDX-License-Identifier: Apache-2.0

/**
 * What a scan hands its readers: the scanner's interface, and the shapes it returns. Kept apart from
 * `scan.ts`, which implements it, because the parser, the readers and the snapshot depend on this
 * contract and never on the scan loop behind it.
 */

import type { Builder, RootInfo } from "./builder";
import type { CandidateReader } from "./candidate-reader";
import type { RecordedEdits } from "./edit-log";
import type { ScalarReader } from "./scalar-reader";
import type { Delivery, Picks } from "./picks";
import type { PositionAt } from "./positions";
import type { Tally } from "./report";
import type { FinishedRoot } from "./root-log";
import type { Limit, Verdict } from "./scan-diagnostics";
import type { Cut, ParseError, Recovery, Repair } from "./types";

/**
 * A string value that has not finished arriving, and where it belongs in the innermost open
 * container: under `key` when that container is an object, appended when `key` is undefined because
 * it is an array.
 *
 * Only strings are ever reported, and only values. A number or bare-word prefix is a DIFFERENT
 * value rather than a partial one, and a half-read key would name a member whose name then changes.
 */
export type Pending = { key: string | undefined; text: string };

export type SnapshotState = {
  readonly spine: readonly object[];
  readonly labels: readonly (string | number)[];
  readonly pending: Pending | undefined;
  readonly value: unknown;
};

/**
 * Why `pull` stopped: a root completed, or only deliveries were queued — under `occurrences` a
 * match leaves as soon as it closes, and a consumer pulling one at a time must not have the rest
 * of the root scanned out from under it.
 */
export type Pulled = { root: { value: unknown } | undefined };

/**
 * The full internal scan probe. The values are every top-level value the scan FINISHED, and the
 * per-value verdicts, counts and scores stay on the scanner so a lazy consumer can read them for
 * one value before the next is scanned.
 */
export type ScanResult = {
  /** The finished roots still held, from absolute index `first`; a stream released those before. */
  values: unknown[];
  first: number;
  repairs: readonly Repair[];
  /**
   * Budgets that were exhausted. Recoverable and carried in the result: a parser contracted never to
   * lose data silently must not answer an over-deep document with a thrown `RangeError`.
   */
  errors: readonly ParseError[];
  /**
   * A root that opened and never finished because a buffer or scalar bound refused to hold more
   * input. Not in `values`, because it is not a value — it is the recovery a `limit-reached`
   * failure carries.
   */
  open: Recovery | undefined;
  /** Half-open source extent of each root in `values`, parallel to it. */
  spans: { start: number; end: number }[];
  /**
   * The source rewrites that express the repairs, for `repair(text)`. NOT parallel to `repairs`:
   * some repairs need no rewrite, and one rewrite can sit far from the repair that motivated it.
   */
  edits: readonly { start: number; end: number; text: string }[];
};

/** EOF delivery needs roots and stopped recovery; report cursors read the scanner's live logs. */
export type ScanEnd = Pick<ScanResult, "values" | "first" | "open">;

/**
 * A scan in progress. One per stream, holding all the mutable state; the options it was built from
 * stay immutable and shared, which is the split the extracted package lacked — one object held both,
 * so a per-call override silently reconfigured every later call on the same instance.
 */
export type Scanner = {
  /** Views read existing scan state; default scans allocate no view readers. */
  readonly build: Builder;
  readonly scalars: Pick<
    ScalarReader,
    "pending" | "partialStart" | "continuation" | "quoteReplayCarry"
  >;
  readonly candidate: Pick<CandidateReader, "held">;
  readonly cutSuffix: string;
  /**
   * Adds input WITHOUT scanning it. The other half of `pull`: a caller pulling values one at a time
   * must not have the text scanned out from under it by the call that supplied the text.
   * `malformedUtf8` lists the offsets within `chunk` holding a replacement character for malformed
   * bytes; each is reported as `invalid-utf8` at the path the scan is in when it passes it.
   */
  supply(chunk: string, malformedUtf8?: readonly number[]): void;
  /** Release consumed text between incremental whole-input slices without applying stream limits. */
  compactInput(): void;
  /** How this scanner's absolute offsets are reported; one-shot text uses the identity. */
  readonly positionAt: PositionAt;
  /**
   * Where the value in progress began, absolute. Nothing earlier can appear in a later report, so
   * a caller holding per-chunk position data may release everything before it.
   */
  valueStart(): number;
  /**
   * Settles a chunk once every value it completed has been pulled: drops the consumed prefix, then
   * judges the retained window against `maxBuffer`. AFTER compaction, because compaction is what
   * keeps a well-behaved stream inside the bound; measured before it, a stream of small values that
   * never retains more than one would be refused. A refusal is terminal and releases the window —
   * resuming from its suffix would turn the configured limit into silent data loss.
   */
  finishChunk(): void;
  /** Releases owned source and trees after the reader captures any recovery or final view it needs. */
  close(): void;
  /** Discard abandoned input while unread deliveries or a requested view still own recovered trees. */
  releaseInput(): void;
  /** Closes open structure and returns retained roots and any recovery a limit stopped inside. */
  end(): ScanEnd;
  /**
   * Scans until ONE more top-level value completes, and stops there. `undefined` means the input in
   * hand holds no further value — call `end()` to close what is still open.
   *
   * This is what makes `parseMany` a genuine generator rather than an iterator over a finished
   * array: after the first `pull`, the source past that value has not been read.
   */
  pull(): Pulled | undefined;
  /** Matches and fragments queued since the last take. Empty without `select`. */
  deliveries(): Delivery[];
  /** Only the imported selection feature owns final root preparation and stopped recovery. */
  readonly selectionRoots:
    | Pick<
        Picks,
        | "prepareRoot"
        | "resumeRoot"
        | "recoverInto"
        | "retainDeliveries"
        | "consumeDelivery"
        | "recoveryRoot"
        | "outcome"
        | "fragmentDelivery"
      >
    | undefined;
  /** Whether `select` was given: results are matches, and `recovery()` is the matches still held. */
  readonly selecting: boolean;
  /** What a stopped or refused root still holds for the caller; `undefined` when nothing was built. */
  recovery(): Recovery | undefined;
  /** Transfers a decoded string prefix into terminal recovery without consuming input or closing it. */
  stopPending(): void;
  /**
   * Where the open root stops right now (see `cut.ts`); meaningful only while one is open.
   * `undefined` when it is finished and held only to see whether a comma begins a list.
   */
  cut(): Cut | undefined;
  /** Where the source ended inside a finished root, or `undefined` when the source finished it. */
  cutAt(valueIndex: number): Cut | undefined;
  /** How many matches or started occurrences have been queued, and which selectors never produced one. */
  delivered(): number;
  unmatched(): number[];
  /** Retained raw source only; decoded values and completed output are not part of this window. */
  buffered(): number;
  spanAt(valueIndex: number): FinishedRoot["span"];
  /** Acceptance facts for a completed root; present only when a root filter requested them. */
  rootInfoAt(valueIndex: number): RootInfo | undefined;
  /**
   * Why a value did not succeed, or `undefined` when it did. Answered per value rather than per
   * scan because a refusal on the second root says nothing about the first, which was fine.
   */
  verdictAt(valueIndex: number): Verdict | undefined;
  /** False when a budget stopped the scanner inside this value. */
  scanCompleteAt(valueIndex: number): boolean;
  /** The error budget is exhausted and the current token has settled; finalize the read prefix. */
  stopped(): boolean;
  /** Only requested diagnostics own report totals and confidence lookup. */
  readonly tallyAt: ((valueIndex: number) => Tally) | undefined;
  /** A buffer or scalar bound that ended the scan for good. Nothing fed after it is read. */
  failure(): Limit | undefined;
  /**
   * The roots before `upTo` are delivered and never read again: release them and their report
   * entries, moving the cursor that read those entries. Without it a stream holds every root it saw.
   */
  releaseBefore(upTo: number, cursor: { repair: number; error: number }): void;
  /**
   * Requested report slots in scan order; released prefixes are empty until compaction moves
   * the report cursors. Readable mid-stream so a report is built before the next value is scanned.
   */
  readonly repairs: readonly (Repair | undefined)[] | undefined;
  readonly errors: readonly (ParseError | undefined)[] | undefined;
  /** The source rewrites so far, for `repair(text)`. See `ScanResult.edits`. */
  readonly edits: RecordedEdits;
};
