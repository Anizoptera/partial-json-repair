// SPDX-License-Identifier: Apache-2.0

import type { LexicalWindow } from "./lexical-window";
import type { ResolvedOptions } from "./options";
import type {
  Cut,
  ErrorKind,
  ParseError,
  ParseFailure,
  SourcePath,
  SwitchableRepair,
} from "./types";
import type { BuildMode } from "./builder";
import { Builder } from "./builder";
import type { Report } from "./report";
import type { FinishedRoot } from "./root-log";
import { RootLog } from "./root-log";

export type Limit = Extract<ParseFailure, { kind: "limit-reached" }>;

/** Everything a rewindable scope has to put back. Reused per scope; nothing allocates per token. */
type Scope = {
  valueIndex: number;
  kept: number;
  count: number;
  counted: number;
  refusal: ParseError | undefined;
  limit: Limit | undefined;
  stopped: number | undefined;
  errorsLimit: Limit | undefined;
  deferred: ParseError["at"] | undefined;
};

const newScope = (): Scope => ({
  valueIndex: 0,
  kept: 0,
  count: 0,
  counted: 0,
  refusal: undefined,
  limit: undefined,
  stopped: undefined,
  errorsLimit: undefined,
  deferred: undefined,
});

/** A root no longer held, or never seen: nothing counted against it. */
const NO_FACTS = { refusal: undefined, limit: undefined };

/** What decides a value's outcome instead of success. See `verdictAt` for which wins. */
export type Verdict = Limit | Extract<ParseFailure, { kind: "policy-refused" }>;

/**
 * Owns scanner errors, their budgets, the verdict on each top-level value, and the Builder whose
 * path locates them.
 *
 * The verdict is kept per value rather than derived from the error log afterwards, because the log
 * is optional: with reporting off nothing is stored, yet a refused value must still come back as
 * `policy-refused` carrying its issue, and a stopped one as `limit-reached`.
 */
export class ScanDiagnostics {
  /** The report, when one was asked for: it stores and counts the errors this records. */
  readonly report: Report | undefined;
  /**
   * The open root's first policy refusal, and first depth, buffer or scalar bound. Only the open
   * root changes them — every rewind scope belongs to it — so `finish` hands them to the root's
   * record and starts the next root clean.
   */
  private openRefusal: ParseError | undefined;
  private openLimit: Limit | undefined;
  /** Every finished root not yet released, with its verdict facts. */
  readonly ledger = new RootLog<FinishedRoot>();
  /** The value the scan stopped inside, and the budget that stopped it, once it has. */
  private stoppedAt: number | undefined;
  private errorsLimit: Limit | undefined;
  readonly build: Builder;
  // Finished output belongs to its reader; disposal releases the scanner's own references.
  dispose(): void {
    this.build.dispose();
    this.ledger.truncate(this.ledger.start);
    this.keyErrors.length = 0;
  }
  errorCount = 0;
  /** `maxErrors` reached: the scan reads no further. */
  exhausted = false;
  /**
   * Whether the root candidate in progress has yet to show a mark of data. Wired by `scan` to the
   * candidate reader, and called only when the budget is already spent, so a clean token never
   * calls it.
   */
  undecided: () => boolean = () => false;
  /**
   * Where the error that spent `maxErrors` sat, while the candidate holding it is undecided.
   *
   * Detection must not depend on enabled repairs, and stopping here would make it: `STRICT` refused
   * the prose word in `Here: {"a": 1}`, stopped, and returned `no-json-found` for a document whose
   * JSON every lenient setting found. So the stop waits for the candidate's verdict. Rejected as
   * prose, its errors leave with it; once it shows a mark of data or is accepted, the stop lands.
   * Reading an undecided candidate is still one linear pass over input already held.
   */
  private deferred: ParseError["at"] | undefined;
  /** A buffer or scalar bound refused to hold more input: the scan is over for good. */
  terminalFailure: Limit | undefined;
  /**
   * Everything the current token has recorded, so a rewind can undo it.
   *
   * Taken on the token's FIRST error rather than at its start: a clean token pays one boolean
   * store, and the reused record allocates nothing — the token loop is the hottest path in the
   * package, which is also why the builder's token marks are records reused per site.
   */
  private marked = false;
  private triviaMarked = false;
  private readonly token = newScope();
  /**
   * The wider scope: whitespace and comments read BEFORE the token, which rewind separately because
   * the token is re-read without them. Two scopes rather than one because the two rewinds have
   * different targets, and a mark must pair with the offset it rewinds to.
   */
  private readonly trivia = newScope();
  /** Everything the root candidate in progress recorded, so rejecting it as prose undoes it. */
  private readonly candidate = newScope();
  /** What a held root's tail recorded; see {@link retractTail}. */
  private readonly tail = newScope();

  constructor(
    private readonly opts: ResolvedOptions,
    private readonly source: LexicalWindow,
    mode: BuildMode,
  ) {
    // Both come from the imported features, so a scan nobody asked to report or select imports
    // neither `Report` nor `Picks` (HLD D5).
    // Report captures the owner without reading build; its lookups run after construction.
    this.report = opts.diagnostics === false ? undefined : opts.diagnostics.open(this);
    const selection = opts.selection;
    this.build = new Builder(
      opts,
      (kind, at, refused) => {
        this.fail(kind, at - source.base, refused);
      },
      (at) => {
        this.refuse("retained", opts.maxRetained, at);
      },
      source.positionAt,
      mode,
      this.report,
      selection === undefined
        ? undefined
        : (build) => selection.picks(build, selection, opts.occurrences, mode),
    );
  }

  /**
   * Counts an error, decides what it means for the value in progress, and stores it if a report
   * was asked for and the cap allows. `invalid-utf8` decides nothing: the bytes were recovered with
   * replacement characters, which is a repair of the source rather than a refusal of it.
   */
  record(error: Omit<ParseError, "path" | "valueIndex">): ParseError | undefined {
    const valueIndex = this.countError(error.at);
    if (valueIndex === undefined) return undefined;
    const entry: ParseError = { ...error, path: Object.freeze(this.build.path()), valueIndex };
    if (error.kind === "depth-budget") {
      this.openLimit ??= this.limit("depth", this.opts.maxDepth, error.at);
    } else if (error.kind !== "invalid-utf8") {
      this.openRefusal ??= entry;
    }
    const report = this.report;
    if (report === undefined || !this.build.inScope || !report.countError()) return undefined;
    report.errors.push(entry);
    return entry;
  }

  // Budget and rewind state are required even when no diagnostic entry will survive.
  private countError(at: ParseError["at"]): number | undefined {
    // Closed once the budget is spent, even while its stop waits for the candidate to show a mark
    // (`deferred`): an accepted candidate stops at that point as if it never waited, and a rejected
    // one takes its errors back anyway. Counting on would report the unclosed string of
    // `'; DROP TABLE users; --` as a second error under `maxErrors: 1`.
    if (this.exhausted || this.deferred !== undefined) return undefined;
    const valueIndex = this.build.completed;
    if (!this.triviaMarked) {
      this.triviaMarked = true;
      this.snapshot(this.trivia, valueIndex);
    }
    if (!this.marked) {
      this.marked = true;
      this.snapshot(this.token, valueIndex);
    }
    // Counted against `maxErrors` wherever it happens: a refusal inside skipped content still
    // decides the candidate. Counted in the REPORT, and stored, only in the report's scope.
    this.errorCount++;
    if (this.errorCount >= this.opts.maxErrors) {
      if (this.undecided()) this.deferred ??= at;
      else this.exhaust(valueIndex, this.deferred ?? at);
    }
    return valueIndex;
  }

  fail(kind: ErrorKind, at: number, refused?: SwitchableRepair): void {
    this.record(this.source.locate(kind, at, refused));
  }

  private exhaust(valueIndex: number, at: ParseError["at"]): void {
    this.deferred = undefined;
    this.exhausted = true;
    this.stoppedAt = valueIndex;
    this.errorsLimit = this.limit("errors", this.opts.maxErrors, at);
  }

  /** A root candidate begins here. What it records from now on {@link retractCandidate} undoes. */
  beginCandidate(): void {
    this.snapshot(this.candidate, this.build.completed);
  }

  /** The candidate was prose: nothing it recorded describes a value, so all of it goes. */
  retractCandidate(): void {
    this.marked = false;
    this.triviaMarked = false;
    this.restore(this.candidate);
  }

  /** A held root's tail begins here: the value is complete, only its standing alone is unproved. */
  beginTail(): void {
    this.snapshot(this.tail, this.build.completed);
  }

  /**
   * The held root stood alone, so its tail was trivia and stray closers after a finished value. A
   * marked root reads that tail only after it completed, where it describes no value; the markless
   * one must report the same nothing, or `[1] // c` failed under `STRICT` while `{"a":1} // c`
   * passed — and a read made only to DETECT the root would have decided its outcome.
   */
  retractTail(): void {
    this.marked = false;
    this.triviaMarked = false;
    this.restore(this.tail);
  }

  /**
   * The open root became element 0 of a list (`Builder.wrapRoot`): every path recorded for it gains
   * that leading index, so a report names where each entry sits in the value actually returned.
   * Rewritten in place, because the refusal deciding the outcome is the same object as its report
   * entry and both must agree; a set visits that shared entry once.
   */
  nestOpenRoot(): void {
    const index = this.build.completed;
    const entries = new Set<{ path: SourcePath; readonly valueIndex: number }>();
    for (const log of [this.report?.repairs.items, this.report?.errors.items]) {
      for (let i = (log?.length ?? 0) - 1; i >= 0; i--) {
        const entry = log?.[i];
        if (entry === undefined || entry.valueIndex !== index) break;
        entries.add(entry);
      }
    }
    if (this.openRefusal?.valueIndex === index) entries.add(this.openRefusal);
    for (const entry of entries) {
      const path = [0, ...entry.path];
      entry.path = Object.isFrozen(entry.path) ? Object.freeze(path) : path;
    }
  }

  get deferring(): boolean {
    return this.deferred !== undefined;
  }

  /** The candidate is data, so a budget it spent while undecided stops the scan now. */
  decide(): void {
    if (this.deferred !== undefined) this.exhaust(this.candidate.valueIndex, this.deferred);
  }

  /** A token begins here. Whatever it records from now on can be undone by {@link retractToken}. */
  beginToken(): void {
    this.marked = false;
  }

  /** A run of whitespace and comments begins here; see {@link retractTrivia}. */
  beginTrivia(): void {
    this.triviaMarked = false;
    this.marked = false;
  }

  /**
   * Undoes what a run of trivia recorded, for a rewind that will read the same run again — a
   * comment cut in half by a chunk boundary is re-read whole, and its refusal would otherwise be
   * recorded once per chunk that failed to finish it.
   */
  retractTrivia(): void {
    if (!this.triviaMarked) return;
    this.triviaMarked = false;
    this.marked = false;
    this.restore(this.trivia);
  }

  private snapshot(into: Scope, valueIndex: number): void {
    into.valueIndex = valueIndex;
    into.kept = this.report?.errors.end ?? 0;
    into.count = this.errorCount;
    into.counted = this.report?.errorCount ?? 0;
    into.refusal = this.openRefusal;
    into.limit = this.openLimit;
    into.stopped = this.stoppedAt;
    into.errorsLimit = this.errorsLimit;
    into.deferred = this.deferred;
  }

  private restore(from: Scope): void {
    this.report?.rewindErrors(from.kept, from.counted);
    this.errorCount = from.count;
    this.openRefusal = from.refusal;
    this.openLimit = from.limit;
    this.stoppedAt = from.stopped;
    this.errorsLimit = from.errorsLimit;
    this.deferred = from.deferred;
    this.exhausted = false;
  }

  /**
   * Undoes everything the current token recorded, for a rewind that will read the same bytes again.
   *
   * The builder's own retraction is not enough: `Builder.rewindToken` restores the repairs and edits
   * but not the errors, so a re-read token reported its refusal TWICE — measured on `'abc'` under
   * `allowSingleQuotes: false` and on `-Infinity` under `allowJavaScript: false`. Worse, the first
   * read spent the error budget: `maxErrors: 1` stopped the scan before the second read, and a
   * document holding a refused value came back as `no-json-found`, which is the scanner's own
   * budget mistaken for a statement about the input.
   *
   * `exhausted` is cleared unconditionally because `record` is closed once the budget is spent or
   * pending: a token with anything to retract recorded it before then, so only its own record can
   * have spent the budget. A token re-read after a stop was decided records nothing.
   */
  retractToken(): void {
    if (!this.marked) return;
    this.marked = false;
    this.restore(this.token);
  }

  /** A bound on retained input was hit. Nothing past it is read, on this or any later call. */
  refuse(resource: "buffer" | "scalar" | "retained", limit: number, at: number): void {
    if (this.terminalFailure !== undefined) return;
    this.terminalFailure = this.limit(resource, limit, this.source.positionAt(at));
    this.openLimit ??= this.terminalFailure;
    this.stoppedAt = this.build.completed;
  }

  private limit(resource: Limit["resource"], limit: number, at: ParseError["at"]): Limit {
    return { kind: "limit-reached", resource, limit, at };
  }

  /**
   * Closes the open root: its record joins the ledger with both halves of its books, so every later
   * read of it comes from one place, and the next root starts with clean counters.
   */
  finishRoot(start: number, end: number, cut: Cut | undefined): void {
    this.ledger.push({
      cut,
      valueIndex: this.build.completed,
      // `from`: a list's opening bracket is inserted at its own start, inside its span (`spliceSteps`).
      // Read before `finish`, which clears it for the next root.
      span:
        this.build.listBracket < 0 ? { start, end } : { start, end, from: this.build.listBracket },
      ...this.build.finish(),
      refusal: this.openRefusal,
      limit: this.openLimit,
      tally: this.report?.finish(),
    });
    this.openRefusal = undefined;
    this.openLimit = undefined;
  }

  /** Errors charged against a key still being read; see {@link keyRead}. */
  private readonly keyErrors: ParseError[] = [];

  /** A malformed UTF-8 sequence at absolute `at`; `inKey` while the scanner is reading a key. */
  malformedUtf8(at: number, inKey: boolean): void {
    // Replacement bytes spend the error budget but cannot refuse a value; no report needs context.
    if (this.report === undefined || !this.build.inScope) {
      this.countError(this.source.positionAt(at));
      return;
    }
    const stored = this.record(this.source.locate("invalid-utf8", at - this.source.base));
    if (inKey && stored !== undefined) this.keyErrors.push(stored);
  }

  /**
   * Stamps the finished key's path onto the errors charged against it while it was still being read.
   *
   * The early return is not a micro-optimisation. The path exists only for those errors, and
   * building it walks the container stack, allocates and freezes — once per key. Bad UTF-8 is rare,
   * so without the guard that is the whole function's cost on nearly every key, decorating nothing.
   * It measured around a tenth of parse time.
   */
  keyRead(): void {
    if (this.keyErrors.length === 0) return;
    const path = Object.freeze(this.build.path());
    for (const error of this.keyErrors) error.path = path;
    this.keyErrors.length = 0;
  }

  /**
   * Releases the roots before `upTo`, which a reader has delivered, with their log entries; the
   * cursor that read those entries moves with them. See {@link RootLog}.
   */
  releaseBefore(upTo: number, cursor: { repair: number; error: number }): void {
    this.ledger.releaseBefore(upTo);
    if (this.report === undefined) return;
    cursor.repair = Math.max(0, cursor.repair - this.report.repairs.releaseBefore(upTo));
    cursor.error = Math.max(0, cursor.error - this.report.errors.releaseBefore(upTo));
  }

  /** The open root answers from its live counters, a finished one from its record. */
  private factsAt(valueIndex: number): Pick<FinishedRoot, "refusal" | "limit"> {
    return valueIndex === this.build.completed
      ? { refusal: this.openRefusal, limit: this.openLimit }
      : (this.ledger.at(valueIndex) ?? NO_FACTS);
  }

  /**
   * Why the value did not succeed, or `undefined` when it did.
   *
   * A depth, buffer or scalar bound wins: it cut the value short, so nothing else about it is the
   * headline. Then the refusal, because the error budget is spent BY refusals — under `STRICT` the
   * first one is also the last the budget allows, and the caller asked to hear about the refusal,
   * not about a budget of one. The budget is the verdict only when nothing else explains the stop,
   * which is how a value cut short by a run of `invalid-utf8` errors is still not handed back as
   * success.
   */
  verdictAt(valueIndex: number): Verdict | undefined {
    const { limit, refusal: issue } = this.factsAt(valueIndex);
    if (limit !== undefined) return limit;
    if (issue !== undefined) return { kind: "policy-refused", issue };
    return this.stoppedAt === valueIndex ? this.errorsLimit : undefined;
  }

  /** Whether the scanner read this value to its end, rather than giving up inside it. */
  scanCompleteAt(valueIndex: number): boolean {
    return this.stoppedAt === undefined || valueIndex < this.stoppedAt;
  }
}
