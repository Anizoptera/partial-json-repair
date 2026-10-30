// SPDX-License-Identifier: Apache-2.0

import type { Mark } from "./builder";
import { newMark } from "./builder";
import type { ResolvedOptions } from "./options";
import type { ScalarReader } from "./scalar-reader";
import type { ScanCursor } from "./scan-cursor";
import type { ScanDiagnostics } from "./scan-diagnostics";
import {
  APOSTROPHE,
  BACKSLASH,
  BACKTICK,
  CLOSE_BRACE,
  CLOSE_BRACKET,
  COLON,
  COMMA,
  IS_WS,
  isExtraWhitespace,
  isInfoChar,
  CR,
  LF,
  MINUS,
  OPEN_BRACE,
  OPEN_BRACKET,
  QUOTE,
  SLASH,
  SPACE,
  STAR,
  TAB,
} from "./chars";

export const CANDIDATE_REJECT = 0;
export const CANDIDATE_ACCEPT = 1;
export const CANDIDATE_HOLD = -1;
/** `commaAfter` answers: no comma touches the value, or the buffer ended before it could tell. */
export const NO_COMMA = -1;
export const COMMA_WAIT = -2;

type CandidateScalarResult =
  | { kind: "skip" }
  | { kind: "wait" }
  /** `hold` means the value is complete but its claim to fill the document is not yet settled. */
  | { kind: "value"; value: unknown; start: number; hold?: boolean };

type SkipState = {
  nest: number;
  quote: number;
  escaped: boolean;
  comment: 0 | 1 | 2;
  star: boolean;
  /** Whether each skipped level is an object, innermost last, up to {@link SKIP_KINDS} levels. */
  objects: boolean[];
  /** What the next token would be: nothing countable, a value, or a key. */
  slot: 0 | typeof SLOT_VALUE | typeof SLOT_KEY;
};

/**
 * Levels of a skipped subtree whose kind is remembered for its marks. Deeper, what follows a comma
 * or colon cannot be told from a key, so it counts as no mark: the verdict errs towards prose, as it
 * would have without the subtree, and the skip holds bounded state however deep the input nests.
 */
const SKIP_KINDS = 64;
const SLOT_VALUE = 1;
const SLOT_KEY = 2;

/**
 * Distinguishes JSON candidates from balanced punctuation embedded in prose.
 *
 * A container inside prose needs source evidence of data: a written colon, a quoted token, or
 * multiple placed values. A container standing alone or filling a fence needs no such mark, because
 * `{}` and `[1]` are already valid JSON. Recovery diagnostics cannot decide candidacy: `[1]` in a
 * citation is syntactically perfect, and a refusal inside prose says nothing about the JSON after it.
 * So a rejected candidate takes its errors with it, and a spent error budget waits for the verdict
 * (`ScanDiagnostics.deferred`).
 *
 * A root object opener where a key belongs is decisive evidence against candidacy. No recovery can
 * read `{{name}}` as an object without manufacturing its first key; the same pattern nested inside
 * established JSON remains recovery's job.
 */
/**
 * What may follow a root with no mark of data without making it a word in a sentence: whitespace, a
 * comment, or a stray closer. A root WITH a mark (`{"a":1}}`) already leaves such a tail unread, so
 * the markless one must too, or the same tail decides the answer by the root's spelling (P3).
 */
const mayTrailRoot = (c: number): boolean =>
  c === SLASH || c === CLOSE_BRACKET || c === CLOSE_BRACE || isExtraWhitespace(c);

/**
 * What may begin the next root of an input made only of values (`[1]\n[2]`, JSONL of scalars): it
 * keeps a markless root standing alone. Without it each such root was prose to its neighbour and
 * the whole input answered `no-json-found`, though nothing in it was prose. A word must be a whole
 * JSON literal and `-` must lead a digit, so a sentence or a Markdown bullet never continues one.
 */
const LITERALS: readonly string[] = ["true", "false", "null"];
/** Read as values when the policy recovers them (Python's `json.dumps` writes `NaN` by default). */
const JS_LITERALS: readonly string[] = [
  "true",
  "false",
  "null",
  "NaN",
  "Infinity",
  "-Infinity",
  "undefined",
];

/** Whether `c` can follow a root on the same footing as the trivia `mayTrailRoot` allows. */
const mayChainRoot = (c: number): boolean =>
  c === COMMA ||
  c === OPEN_BRACKET ||
  c === OPEN_BRACE ||
  c === QUOTE ||
  c === MINUS ||
  (c >= 0x30 && c <= 0x39) ||
  JS_LITERALS.some((word) => word.charCodeAt(0) === c);

export class CandidateReader {
  private quoted = false;
  private colon = false;
  private braceKey = false;
  /** Where the logs stood when the candidate began, so rejecting it takes its repairs with it. */
  private readonly valueMark: Mark = newMark();
  /** The token's own rewind point, reused: a fresh record per token was measured in the parse cost. */
  private readonly tokenMark: Mark = newMark();
  /** Where the logs stood when the root was held, so its tail's repairs can go without the root's. */
  private readonly tailMark: Mark = newMark();
  private trimStart = 0;
  private inFence = false;
  private fenceStart = -1;
  private heldEnd: number | undefined;
  /**
   * Where a value may begin and still stand alone because only trivia separates it from the
   * previous root's end, or `-1`. The same rule `trimStart` is for the document's start, so
   * `[1]\n[2]` and `{"a":1}\n[2]` read every root: an input made only of values holds no prose.
   */
  private chainFrom = -1;
  /** What the gap has shown so far, kept across chunks because its bytes may be released. */
  private gapBreak = false;
  /**
   * Whether the held root completes as soon as no comma follows it: it carries a mark of data, so
   * prose after it is just more text, and it was held only to see whether a list begins.
   */
  heldMarked = false;
  /**
   * A list led by a root with no mark of data is open: its members' quotes and count are no mark,
   * because `1, 2 and 3` and `"a", "b" or "c"` are sentences until the list is shown to stand alone.
   */
  pendingList = false;
  /**
   * Whether the held root is spelled as JSON spells a value. Only then can a following root complete
   * it: `x\n{"b":1}` is a word, then data, while `1\n{"b":1}` is two values.
   */
  private heldSpelled = false;
  private skipped: SkipState | undefined;
  /**
   * Where the first scalar of a depth-refused subtree began, or `-1`, and whether a second one was
   * seen. Skipped values are never placed, yet they are the source's evidence of data all the same.
   * A position rather than a count, so reading the same subtree again cannot add a value.
   */
  private skippedValueAt = -1;
  private skippedValues = false;

  /** The literals a run of roots may hold: JSON's, plus JavaScript's when the policy reads them. */
  private readonly literals: readonly string[];
  /** Whether values separated by commas may be read as one array (`resolveHeld`). */
  readonly lists: boolean;

  constructor(
    private readonly cursor: ScanCursor,
    private readonly diagnostics: ScanDiagnostics,
    private readonly scalars: ScalarReader,
    private readonly opts: ResolvedOptions,
  ) {
    this.literals = opts.recover["js-literal"] ? JS_LITERALS : LITERALS;
    // Selection and root filters judge each root on its own; a list would hide every root inside it.
    this.lists =
      diagnostics.build.picks === undefined && !opts.objectOnly && opts.requiredKeys.length === 0;
    this.trim();
  }

  begin(): void {
    this.quoted = false;
    this.colon = false;
    this.braceKey = false;
    this.skippedValueAt = -1;
    this.skippedValues = false;
    this.diagnostics.build.placed = 0;
    this.diagnostics.build.markInto(this.valueMark);
    this.diagnostics.beginCandidate();
  }

  /**
   * Whether the candidate has already shown a mark of data — the same marks `judge` accepts on,
   * read before the candidate closes. What is true now stays true: a mark cannot be unseen, so a
   * match delivered on it can never come out of prose.
   */
  get established(): boolean {
    return !this.braceKey && !this.pendingList && (this.quoted || this.colon || this.manyValues());
  }

  /** Whether the source holds more than one value, counting those a depth refusal skipped. */
  private manyValues(): boolean {
    const skipped = this.skippedValues ? 2 : this.skippedValueAt >= 0 ? 1 : 0;
    return this.diagnostics.build.placed + skipped > 1;
  }

  /**
   * Whether a markless root at `start` may stand alone: it opens the input, or follows a root across
   * a line break. So `1\n2` and `[1]\n[2]` are values, while a label before data
   * (`[1] {"name":"x"}`) and a citation run (`[1] [2]`) stay prose. A comma touching the root
   * makes a list instead (`resolveHeld`). Adjacent marked roots (`}{`) never ask.
   */
  private standaloneAt(start: number): boolean {
    if (start === this.trimStart && this.diagnostics.build.completed === 0) return true;
    return start === this.chainFrom && this.gapBreak;
  }

  /**
   * A root ended at `end`: what follows it after trivia stands alone. A held root that completed
   * because the next one began has already placed `chainFrom` at that root, so nothing moves back.
   */
  afterRoot(end: number): void {
    // `>=`: adjacent roots (`[1][2]`) chain at `end` itself, and the gap already read must stay.
    if (this.chainFrom >= end) return;
    this.chainFrom = end;
    this.gapBreak = false;
  }

  noteQuoted(quoted: boolean): void {
    this.quoted ||= quoted;
  }

  noteColon(): void {
    this.colon = true;
  }

  noteBraceKey(): void {
    this.braceKey = true;
  }

  /**
   * Moves the source's logical start: what precedes `absolute` was consumed as a declaration
   * rather than content (a byte-order mark), so a value at `absolute` still counts as standalone.
   */
  startAt(absolute: number): void {
    this.trimStart = Math.max(this.trimStart, absolute);
  }

  /**
   * Records that the run from `from` to `to` was TRIVIA the reader consumed, not content.
   *
   * Only when the run reaches back TO where the content currently starts — at or before it, since
   * the reader begins a run before skipping the whitespace the start already excludes. A comment
   * further in has prose in front of it, and moving the start past that would turn a sentence with
   * a comment in it into a document holding whatever follows the comment.
   */
  consumedLeading(from: number, to: number): void {
    if (from <= this.trimStart) this.startAt(to);
    if (from > this.chainFrom || to <= this.chainFrom) return;
    for (let i = Math.max(from, this.cursor.base); !this.gapBreak && i < to; i++) {
      const c = this.cursor.text.charCodeAt(i - this.cursor.base);
      this.gapBreak = c === LF || c === CR;
    }
    this.chainFrom = to;
  }

  trim(): void {
    let start = this.cursor.relative(this.trimStart);
    while (start >= 0 && start < this.cursor.length) {
      const c = this.cursor.text.charCodeAt(start);
      if (c >= 128 || IS_WS[c] !== 1) break;
      start++;
    }
    this.trimStart = start + this.cursor.base;
  }

  /**
   * Where the content ends, before trailing whitespace. On demand, because only a finished root
   * scalar asks: computed for every window, it walked back over the same trailing run each time,
   * which made a long whitespace run inside a container quadratic.
   */
  private trimmedEnd(): number {
    let end = this.cursor.length;
    while (end + this.cursor.base > this.trimStart) {
      const c = this.cursor.text.charCodeAt(end - 1);
      if (c >= 128 || IS_WS[c] !== 1) break;
      end--;
    }
    return end + this.cursor.base;
  }

  /** A fence marker is structural only at a line head; an incomplete backtick run must wait. */
  readFence(): "none" | "consumed" | "wait" {
    if (
      this.cursor.text.charCodeAt(this.cursor.pos) !== BACKTICK ||
      !this.atLineStart(this.cursor.pos)
    )
      return "none";
    const ticks = this.backtickRun(this.cursor.pos);
    if (ticks < 3) {
      if (this.cursor.pos + ticks >= this.cursor.length && !this.cursor.atEnd) return "wait";
      this.cursor.pos += ticks;
      return "consumed";
    }
    let end = this.cursor.pos + ticks;
    while (end < this.cursor.length && isInfoChar(this.cursor.text.charCodeAt(end))) end++;
    if (end >= this.cursor.length && !this.cursor.atEnd) return "wait";
    if (end < this.cursor.length && this.cursor.text.charCodeAt(end) === LF) end++;
    this.cursor.pos = end;
    this.inFence = !this.inFence;
    this.fenceStart = this.inFence ? end + this.cursor.base : -1;
    return "consumed";
  }

  /**
   * Reads a root scalar only when it fills the trimmed document or current fence. Until EOF or a
   * closing fence proves that fact, it rewinds exactly to the caller's token/log marks. Bare tokens
   * are bounded while held; quoted strings use ScalarReader's compactable continuation instead.
   */
  readTopLevelScalar(c: number, state: number, depth: number): CandidateScalarResult {
    const build = this.diagnostics.build;
    const scalarAt = this.cursor.window.inWord
      ? this.cursor.window.wordStart
      : this.cursor.window.inNumber
        ? this.cursor.window.numberStart
        : this.cursor.pos + this.cursor.base;
    const fenced = this.inFence && this.fenceStart >= 0 && this.wsOnly(this.fenceStart, scalarAt);
    // A comma begins no value. One right after a root was already read as a list (`resolveHeld`).
    if (c === COMMA) {
      this.cursor.pos++;
      return { kind: "skip" };
    }
    if (!fenced && !this.standaloneAt(scalarAt)) {
      this.cursor.pos++;
      return { kind: "skip" };
    }
    // A root standing alone only because it follows another must be spelled as JSON spells values,
    // checked BEFORE reading: `then` after `{"a":1}` is the sentence going on, and reading it as a
    // word records an unquoted-root refusal for prose. A token resuming across chunks passed already.
    const chained = !fenced && !(scalarAt === this.trimStart && build.completed === 0);
    if (chained && !this.cursor.window.inWord && !this.cursor.window.inNumber) {
      const spelled = this.rootStartsAt(this.cursor.pos);
      if (spelled === CANDIDATE_HOLD) return { kind: "wait" };
      if (spelled === CANDIDATE_REJECT) {
        this.cursor.pos++;
        return { kind: "skip" };
      }
    }
    // A held scalar can later be rejected as prose, just like a container; its rollback mark
    // must precede its own repairs rather than retain an earlier candidate's confidence.
    if (!this.cursor.window.inWord && !this.cursor.window.inNumber) {
      this.begin();
      // Known only here for a string: its opener can leave the buffer before a long one completes.
      this.heldSpelled = c === QUOTE;
    }
    const bare = c !== QUOTE && c !== APOSTROPHE;
    build.markInto(this.tokenMark);
    const token = this.scalars.read(c, state, depth);
    if (token.status === "stopped") return { kind: "wait" };
    // A string still being read is no mark yet: noted here, a refusal later in it stopped the scan
    // at once instead of waiting for the hold to show it prose (`"hel\lo" today` per character
    // under `STRICT`). The continuation notes it when the string completes, as one read does.
    if (this.cursor.needMore) {
      if (this.scalars.continuation !== undefined) return { kind: "wait" };
      build.retract(this.tokenMark);
      return this.rewindScalar(bare, scalarAt);
    }
    this.noteQuoted(token.quoted);
    if (token.status === "cut") {
      // The token runs to the end of a final input and was never finished (`tru`, `1e`). Stepping
      // one character would only rescan fragments of that same unfinished token as fresh candidates;
      // nothing follows it, so the candidate search ends here.
      build.retract(this.tokenMark);
      this.cursor.pos = this.cursor.length;
      return { kind: "skip" };
    }
    if (token.status !== "done") {
      this.cursor.pos++;
      return { kind: "skip" };
    }
    // A bare token stays buffered while it is read, so its first character is still here.
    if (bare) this.heldSpelled = this.bareSpelled(scalarAt, token.value);
    if (fenced) {
      const verdict = this.fenceEndsAt(this.cursor.pos);
      // Another value after it is a run of values in the block (```jsonl), settled by `resolveHeld`.
      if (verdict === CANDIDATE_REJECT && this.heldSpelled && mayChainRoot(this.nextContent()))
        return { kind: "value", value: token.value, start: scalarAt, hold: true };
      if (verdict === CANDIDATE_REJECT) {
        build.retract(this.tokenMark);
        this.diagnostics.retractCandidate();
        this.begin();
        return { kind: "skip" };
      }
      if (verdict === CANDIDATE_HOLD) {
        build.retract(this.tokenMark);
        return this.rewindScalar(bare, scalarAt);
      }
      return { kind: "value", value: token.value, start: scalarAt };
    }
    // Only text BEFORE the trimmed end can follow the root. A token ending past it is a cut string
    // that owns the trailing whitespace (`"abc `), so it fills the document by itself.
    if (this.cursor.pos + this.cursor.base < this.trimmedEnd()) {
      let look = this.cursor.pos;
      while (look < this.cursor.length) {
        const unit = this.cursor.text.charCodeAt(look);
        if (unit >= 128 || IS_WS[unit] !== 1) break;
        look++;
      }
      if (look >= this.cursor.length && !this.cursor.atEnd)
        return { kind: "value", value: token.value, start: scalarAt, hold: true };
      const next = this.cursor.text.charCodeAt(look);
      const fenceCloses = this.inFence && next === BACKTICK;
      if (mayTrailRoot(next) || fenceCloses || (mayChainRoot(next) && this.heldSpelled))
        return { kind: "value", value: token.value, start: scalarAt, hold: true };
      build.retract(this.tokenMark);
      this.diagnostics.retractCandidate();
      // Its marks go with it, as `reject` does on the held path: a quoted `"x"` left `established`
      // true, which landed a deferred budget stop before the next candidate was read.
      this.begin();
      return { kind: "skip" };
    }
    // Unfinished tokens returned "wait" above. A finished token only awaits proof that it fills
    // the document; re-reading it can duplicate refusals or lose it after the error budget stops.
    if (!this.cursor.atEnd) {
      return { kind: "value", value: token.value, start: scalarAt, hold: true };
    }
    return { kind: "value", value: token.value, start: scalarAt };
  }

  judge(valueStart: number): number {
    if (this.braceKey) return CANDIDATE_REJECT;
    if (this.quoted || this.colon || this.manyValues()) return CANDIDATE_ACCEPT;
    // Only whitespace may sit between the fence opener and the value, the rule a fenced scalar
    // already used. Exact equality declined a CRLF opener (its `\r` stays before the value) and a
    // value on the opener's own line (`json [1]` after the backticks), though both fill the fence.
    if (this.inFence && this.fenceStart >= 0 && this.wsOnly(this.fenceStart, valueStart))
      return CANDIDATE_ACCEPT;
    if (!this.standaloneAt(valueStart)) return CANDIDATE_REJECT;
    if (!this.wsOnly(this.cursor.pos + this.cursor.base, this.cursor.length + this.cursor.base)) {
      let look = this.cursor.pos;
      while (look < this.cursor.length && IS_WS[this.cursor.text.charCodeAt(look)] === 1) look++;
      const next = this.cursor.text.charCodeAt(look);
      const fenceCloses = this.inFence && next === BACKTICK;
      return mayTrailRoot(next) || mayChainRoot(next) || fenceCloses
        ? CANDIDATE_HOLD
        : CANDIDATE_REJECT;
    }
    return this.cursor.atEnd ? CANDIDATE_ACCEPT : CANDIDATE_HOLD;
  }

  /** How many edits earlier roots recorded: the candidate's own begin after them. */
  get rootEdits(): number {
    return this.valueMark.e;
  }

  /** A finished root waits for the source to show whether it stands alone. */
  get held(): boolean {
    return this.heldEnd !== undefined;
  }

  /**
   * Holds the root that just ended at `end`. `marked` roots carry a mark of data and are held only
   * until the next character shows whether a list begins; the others must also stand alone.
   */
  hold(end: number, scalar: boolean, marked = false): void {
    this.heldEnd = end;
    this.heldMarked = marked;
    if (!scalar) this.heldSpelled = true;
    this.gapBreak = false;
    this.diagnostics.build.markInto(this.tailMark);
    this.diagnostics.beginTail();
  }

  /**
   * Whether a comma touches the value that just ended at the cursor: its buffer index,
   * {@link NO_COMMA}, or {@link COMMA_WAIT} while the buffer ends first.
   *
   * Touching, because a stream cannot withdraw a delivered value, so every value must wait until
   * the character after it rules a list out. Requiring the comma to touch keeps that wait to one
   * character: whitespace after a value (`{"a":1} `, a JSONL line break) settles it at once, so a
   * caller who sends one document and waits for a reply before closing the stream is answered.
   * Every list writer spells it that way (`1,2`, `{..},\n{..}`, MongoDB dumps); `1 , 2` is not a
   * list. It reads without consuming, so trivia after a value that no comma follows is read exactly
   * as before, including the line break a run of roots needs (`consumedLeading`).
   */
  commaAfter(): number {
    const i = this.cursor.pos;
    if (i >= this.cursor.length) return this.cursor.atEnd ? NO_COMMA : COMMA_WAIT;
    return this.cursor.text.charCodeAt(i) === COMMA ? i : NO_COMMA;
  }

  /**
   * Trivia and stray closers after a standalone value hold it; any later content retracts it as
   * prose. Closers are stepped over between trivia runs, so `[1] ] // c` stands alone too.
   *
   * A comma touching the root (`commaAfter`) answers `list`, leaving the cursor on it: the scanner
   * then reads the root as the first element of an array the source forgot to bracket (`1,2,3`).
   * Not under selection or a root filter, which judge roots one at a time.
   *
   * Another root also completes it when a line break separates them, and that root then stands
   * alone in turn (`chainFrom`): an input made only of values holds no prose to misread. A later
   * root followed by prose is still rejected on its own.
   */
  resolveHeld(consumeTrivia: () => void): {
    kind: "continue" | "wait" | "completed" | "rejected" | "list";
    end?: number;
  } {
    const end = this.heldEnd;
    if (end === undefined) return { kind: "continue" };
    // Asked once, before any trivia is consumed: later the cursor has moved past the root.
    if (this.cursor.pos + this.cursor.base === end) {
      const comma = this.commaAfter();
      if (comma === COMMA_WAIT) return { kind: "wait" };
      if (comma !== NO_COMMA && this.heldSpelled && this.lists) {
        this.cursor.pos = comma;
        this.heldEnd = undefined;
        return { kind: "list", end };
      }
      // Without lists the comma still separates values, as a line break does, so a root filter
      // judges each one (`[1],[2]` is two arrays to `objectOnly`, not prose).
      if (comma !== NO_COMMA && this.heldSpelled) {
        this.cursor.pos = comma + 1;
        this.gapBreak = true;
      }
      if (this.heldMarked) {
        this.heldEnd = undefined;
        return { kind: "completed", end };
      }
    }
    this.skipGap(consumeTrivia);
    while (!this.cursor.needMore && this.cursor.pos < this.cursor.length) {
      const c = this.cursor.text.charCodeAt(this.cursor.pos);
      if (c !== CLOSE_BRACKET && c !== CLOSE_BRACE) break;
      this.cursor.pos++;
      this.skipGap(consumeTrivia);
    }
    if (this.cursor.needMore) return { kind: "wait" };
    if (this.cursor.pos >= this.cursor.length && !this.cursor.atEnd) return { kind: "wait" };
    if (this.cursor.pos >= this.cursor.length) {
      this.heldEnd = undefined;
      this.diagnostics.build.retract(this.tailMark);
      this.diagnostics.retractTail();
      return { kind: "completed", end };
    }
    // A closing fence ends the block as the end of input ends the document.
    const fence = this.inFence ? this.fenceEndsAt(this.cursor.pos) : CANDIDATE_REJECT;
    if (fence === CANDIDATE_HOLD) return { kind: "wait" };
    if (fence === CANDIDATE_ACCEPT) {
      this.heldEnd = undefined;
      this.diagnostics.build.retract(this.tailMark);
      this.diagnostics.retractTail();
      return { kind: "completed", end };
    }
    const next = this.rootStartsAt(this.cursor.pos);
    if (next === CANDIDATE_HOLD) return { kind: "wait" };
    this.heldEnd = undefined;
    if (next === CANDIDATE_ACCEPT && this.heldSpelled && this.gapBreak) {
      this.chainFrom = this.cursor.pos + this.cursor.base;
      this.diagnostics.build.retract(this.tailMark);
      this.diagnostics.retractTail();
      return { kind: "completed", end };
    }
    this.reject();
    return { kind: "rejected" };
  }

  /** The first character after whitespace from the cursor, or `NaN` when the buffer ends first. */
  private nextContent(): number {
    let i = this.cursor.pos;
    while (i < this.cursor.length && IS_WS[this.cursor.text.charCodeAt(i)] === 1) i++;
    return this.cursor.text.charCodeAt(i);
  }

  /** Consumes trivia, noting a line break in it; the bytes may be gone by the time the gap ends. */
  private skipGap(consumeTrivia: () => void): void {
    const from = this.cursor.pos;
    consumeTrivia();
    for (let i = from; !this.gapBreak && i < this.cursor.pos; i++) {
      const c = this.cursor.text.charCodeAt(i);
      this.gapBreak = c === LF || c === CR;
    }
  }

  /**
   * Whether a finished bare token starting at absolute `at` is a number or one of `literals`; a
   * word is not, and neither is a JavaScript literal the policy does not read.
   */
  private bareSpelled(at: number, value: unknown): boolean {
    const i = this.cursor.relative(at);
    const first = this.cursor.text.charCodeAt(i);
    const digit = (c: number): boolean => c >= 0x30 && c <= 0x39;
    if (digit(first) || (first === MINUS && digit(this.cursor.text.charCodeAt(i + 1))))
      return typeof value === "number" || (typeof value === "object" && value !== null);
    // A literal's exact spelling, as `rootStartsAt` requires of the root after it: `True` is recovery.
    const length = this.cursor.pos - i;
    return this.literals.some(
      (word) => length === word.length && this.cursor.text.startsWith(word, i),
    );
  }

  /**
   * Whether a value begins at `i`: accept, reject, or hold until the buffer shows enough. Only JSON's
   * spellings and `literals`, so recovery's wider forms (`'tis`, a bare word) never extend a run.
   */
  rootStartsAt(i: number): number {
    const text = this.cursor.text;
    const c = text.charCodeAt(i);
    if (c === OPEN_BRACKET || c === OPEN_BRACE || c === QUOTE || (c >= 0x30 && c <= 0x39))
      return CANDIDATE_ACCEPT;
    if (c === MINUS) {
      if (i + 1 >= this.cursor.length) return this.cursor.atEnd ? CANDIDATE_REJECT : CANDIDATE_HOLD;
      const d = text.charCodeAt(i + 1);
      if (d >= 0x30 && d <= 0x39) return CANDIDATE_ACCEPT;
    }
    // Each literal opens with its own character, so the first one that matches decides.
    for (const word of this.literals) {
      if (c !== word.charCodeAt(0)) continue;
      const end = i + word.length;
      if (end > this.cursor.length) {
        const seen = text.slice(i, this.cursor.length);
        return !this.cursor.atEnd && word.startsWith(seen) ? CANDIDATE_HOLD : CANDIDATE_REJECT;
      }
      if (text.slice(i, end) !== word) return CANDIDATE_REJECT;
      if (end === this.cursor.length) return this.cursor.atEnd ? CANDIDATE_ACCEPT : CANDIDATE_HOLD;
      const after = text.charCodeAt(end);
      const ends =
        (after < 128 && IS_WS[after] === 1) ||
        mayTrailRoot(after) ||
        after === COMMA ||
        after === OPEN_BRACKET ||
        after === OPEN_BRACE ||
        after === QUOTE;
      return ends ? CANDIDATE_ACCEPT : CANDIDATE_REJECT;
    }
    return CANDIDATE_REJECT;
  }

  reject(): void {
    const build = this.diagnostics.build;
    build.discardOpenRoot();
    build.retract(this.valueMark);
    this.diagnostics.retractCandidate();
    this.begin();
  }

  startSkip(): void {
    this.skipped = {
      nest: 0,
      quote: 0,
      escaped: false,
      comment: 0,
      star: false,
      objects: [],
      slot: 0,
    };
  }

  get hasSkip(): boolean {
    return this.skipped !== undefined;
  }

  /**
   * Skips a depth-refused subtree without letting quotes, comments, or chunking alter its extent.
   *
   * It also notes the marks of data the scanner would have seen there: a quote opening a key or
   * value, a colon inside an object, and the values themselves. A depth stop leaves this input
   * unread, which says nothing about whether the source is JSON, so the candidate's verdict must
   * not change with `maxDepth`.
   */
  finishSkip(): boolean {
    const state = this.skipped;
    if (state === undefined) return true;
    while (this.cursor.pos < this.cursor.length) {
      const c = this.cursor.text.charCodeAt(this.cursor.pos);
      if (state.comment === 1) {
        this.cursor.pos++;
        if (c === LF) state.comment = 0;
        continue;
      }
      if (state.comment === 2) {
        this.cursor.pos++;
        if (state.star && c === SLASH) state.comment = 0;
        state.star = c === STAR;
        continue;
      }
      if (state.quote !== 0) {
        this.cursor.pos++;
        if (state.escaped) state.escaped = false;
        else if (c === BACKSLASH) state.escaped = true;
        else if (c === state.quote) state.quote = 0;
        continue;
      }
      if (c === QUOTE || c === APOSTROPHE) {
        if (state.slot !== 0) this.quoted = true;
        if (state.slot === SLOT_VALUE) this.noteSkippedValue();
        state.slot = 0;
        state.quote = c;
        this.cursor.pos++;
        continue;
      }
      if (c === SLASH && this.cursor.pos + 1 < this.cursor.length) {
        const next = this.cursor.text.charCodeAt(this.cursor.pos + 1);
        if (next === SLASH || next === STAR) {
          state.comment = next === SLASH ? 1 : 2;
          state.star = false;
          this.cursor.pos += 2;
          continue;
        }
      } else if (c === SLASH && !this.cursor.atEnd) {
        return false;
      }
      if (c === OPEN_BRACE || c === OPEN_BRACKET) {
        if (state.objects.length === state.nest && state.nest < SKIP_KINDS)
          state.objects.push(c === OPEN_BRACE);
        state.nest++;
        state.slot = c === OPEN_BRACE ? SLOT_KEY : SLOT_VALUE;
      } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
        state.nest--;
        if (state.objects.length > state.nest) state.objects.pop();
        state.slot = 0;
        if (state.nest === 0) {
          this.cursor.pos++;
          this.skipped = undefined;
          return true;
        }
      } else if (c === COMMA || c === COLON) {
        // The kind of a level past `SKIP_KINDS` is unknown, so what follows it counts as nothing.
        const object = state.objects.length === state.nest ? state.objects.at(-1) : undefined;
        if (c === COLON && object === true) this.colon = true;
        // A colon outside an object separates nothing: `[a:1]` holds no second value.
        if (object === undefined || (c === COLON && !object)) state.slot = 0;
        else state.slot = c === COLON || !object ? SLOT_VALUE : SLOT_KEY;
      } else if (IS_WS[c] !== 1 && !isExtraWhitespace(c)) {
        if (state.slot === SLOT_VALUE) this.noteSkippedValue();
        state.slot = 0;
      }
      this.cursor.pos++;
    }
    if (this.cursor.atEnd) this.skipped = undefined;
    return this.cursor.atEnd;
  }

  private noteSkippedValue(): void {
    const at = this.cursor.pos + this.cursor.base;
    if (this.skippedValueAt < 0) this.skippedValueAt = at;
    else if (this.skippedValueAt !== at) this.skippedValues = true;
  }

  /**
   * Drops the fence's content start unless everything read since it was whitespace, which is
   * exactly when a scalar can still be the whole content of the block.
   *
   * `released` is the absolute offset up to which bytes are about to leave the buffer, and it must
   * be asked BEFORE they do — see the caller. `openRoot` is where a root container still open
   * began: only the text before IT must be whitespace, or a chunk boundary inside a fenced `[1]`
   * dropped the fence that makes it a candidate, and the stream declined what the whole document
   * accepts.
   */
  compact(released: number, openRoot: number | undefined): void {
    if (this.fenceStart < 0) return;
    if (!this.wsOnly(this.fenceStart, Math.min(released, openRoot ?? released)))
      this.fenceStart = -1;
  }

  /**
   * Hands the scalar back to the next pass, rewound to where the SCALAR began — never to before the
   * trivia in front of it, which the caller has already retracted to with `tokenMark`. See the two
   * rewind points in `scan.ts`: re-reading consumed trivia lexes it differently once a chunk
   * boundary has split it.
   */
  private rewindScalar(bare: boolean, scalarAt: number): { kind: "wait" } {
    const start = this.cursor.relative(scalarAt);
    if (bare && this.cursor.pos - start > this.opts.maxScalar) {
      this.diagnostics.refuse("scalar", this.opts.maxScalar, scalarAt);
      return { kind: "wait" };
    }
    this.cursor.pos = start;
    this.diagnostics.retractToken();
    return { kind: "wait" };
  }

  private atLineStart(i: number): boolean {
    let j = i;
    while (j > 0) {
      const c = this.cursor.text.charCodeAt(j - 1);
      if (c !== SPACE && c !== TAB) return c === LF;
      j--;
    }
    return this.cursor.baseAfterIndent;
  }

  private backtickRun(i: number): number {
    let j = i;
    while (j < this.cursor.length && this.cursor.text.charCodeAt(j) === BACKTICK) j++;
    return j - i;
  }

  private wsOnly(start: number, end: number): boolean {
    for (
      let i = Math.max(start, this.cursor.base) - this.cursor.base;
      i < end - this.cursor.base;
      i++
    ) {
      const c = this.cursor.text.charCodeAt(i);
      if (c >= 128 || IS_WS[c] !== 1) return false;
    }
    return true;
  }

  private fenceEndsAt(i: number): number {
    let end = i;
    while (end < this.cursor.length) {
      const c = this.cursor.text.charCodeAt(end);
      if (c >= 128 || IS_WS[c] !== 1) break;
      end++;
    }
    if (end >= this.cursor.length) return this.cursor.atEnd ? CANDIDATE_ACCEPT : CANDIDATE_HOLD;
    if (this.cursor.text.charCodeAt(end) !== BACKTICK || !this.atLineStart(end))
      return CANDIDATE_REJECT;
    const run = this.backtickRun(end);
    if (run < 3)
      return end + run >= this.cursor.length && !this.cursor.atEnd
        ? CANDIDATE_HOLD
        : CANDIDATE_REJECT;
    return CANDIDATE_ACCEPT;
  }
}
