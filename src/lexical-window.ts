// SPDX-License-Identifier: Apache-2.0

import type { PositionAt } from "./positions";
import { utf16At } from "./positions";
import { ownText } from "./owned-text";
export { ownText } from "./owned-text";
import type { ErrorKind, ParseError, SwitchableRepair } from "./types";
import {
  BACKSLASH,
  COLON,
  DOT,
  ENDS_WORD,
  IS_WS,
  LF,
  LOWER_B,
  LOWER_E,
  LOWER_O,
  LOWER_X,
  MINUS,
  NINE,
  PLUS,
  SPACE,
  TAB,
  isDelimiter,
  isExtraWhitespace,
  SLASH,
  STAR,
  UNDERSCORE,
  UPPER_E,
  ZERO,
  digitValue,
} from "./chars";

export const TRIVIA_WAIT = 0;
export const TRIVIA_READY = 1;
export const TRIVIA_START = 2;
export const TRIVIA_END = 3;
export const TRIVIA_ESCAPE = 4;
export const TRIVIA_SPACE = 5;
export const TOKEN_WAIT = 0;
export const TOKEN_DONE = 1;
export const TOKEN_INTEGER = 2;
export const TOKEN_INVALID = 3;
export const TOKEN_STATUS = 3;
// Completed numeric facts share the verdict word: no per-token classification allocation or rescan.
export const NUMBER_PLUS = 1 << 2;
export const NUMBER_MINUS = 1 << 3;
export const NUMBER_HEX = 1 << 4;
export const NUMBER_BINARY = 1 << 5;
export const NUMBER_OCTAL = 1 << 6;
export const NUMBER_SEPARATED = 1 << 7;
export const NUMBER_LEADING_DOT = 1 << 8;
export const NUMBER_LEADING_ZERO = 1 << 9;
export const NUMBER_EMPTY_FRACTION = 1 << 10;
export const NUMBER_UNFINISHED = 1 << 11;
const NUMBER_PROBE = 0;
const NUMBER_DECIMAL = 1;
const DECIMAL_START = 0;
const DECIMAL_INTEGER = 1;
const DECIMAL_LEADING_DOT = 2;
const DECIMAL_FRACTION = 3;
const DECIMAL_EXPONENT = 4;
const DECIMAL_EXPONENT_SIGN = 5;
const DECIMAL_EXPONENT_DIGITS = 6;
const DECIMAL_INVALID = 7;
// A point following integer digits is valid even before a fractional digit (`1.e2`).
const DECIMAL_POINT = 8;

/**
 * A remembered source location: where a token began that may have to be reported after the
 * window has moved on. `at` stays a bare offset here because the window arithmetic needs a number;
 * `errorAt` is the one place it becomes a `Position` for a report.
 */
export type SourceMark = Readonly<{
  at: number;
  line: number;
  column: number;
  context: string;
}>;

type LocatedError = Omit<ParseError, "path" | "valueIndex">;

/** An error at a remembered location, placed by whoever knows the source's chunks and units. */
export const errorAt = (
  kind: ErrorKind,
  mark: SourceMark,
  positionAt: PositionAt,
  refused?: SwitchableRepair,
): LocatedError => ({
  kind,
  at: positionAt(mark.at),
  line: mark.line,
  column: mark.column,
  context: mark.context,
  refused,
});

// Keep the original token position for reports even after fragments release its leading text.
export type WordState = {
  start: number;
  next: number;
  // Scanned text still awaiting delivery; append new slices without recopying this prefix.
  parts: string | undefined;
  mark: SourceMark | undefined;
  prevChar: number;
};

// `from` is window-relative. Return total released source units: limits use the original start.
export type WordDrain = (window: LexicalWindow, state: WordState, from: number) => number;

export type NumberDrain = (
  window: LexicalWindow,
  state: Pick<NumberState, "start" | "next" | "parts" | "mark">,
  from: number,
) => number;

type NumberState = {
  start: number;
  next: number;
  /**
   * The released source of a token spanning chunks, `undefined` until a part is released. One
   * string, not a list joined on demand: `pendingRaw` is read by every snapshot's cut, and a join
   * per read made a long word or number streamed in small chunks quadratic.
   */
  parts: string | undefined;
  mark: SourceMark | undefined;
  mode: typeof NUMBER_PROBE | typeof NUMBER_DECIMAL | 2 | 8 | 16;
  // Syntax survives source release; Number conversion is for values, not recognition.
  decimal: number;
  facts: number;
  /** The integer part starts with `0`, where JavaScript and Python both forbid a separator. */
  zeroLed: boolean;
  /**
   * The last unit survives compaction for separator admission and EOF completion, without retaining
   * the source text already delivered to a fragment consumer.
   */
  last: number;
};

/** What a `_` inside a number token is: a separator, the end of the token, or not yet knowable. */
const SEPARATOR_ADMIT = 0;
const SEPARATOR_STOP = 1;
const SEPARATOR_WAIT = 2;

/** Owns the live source and every coordinate derived from its absolute position. */
export class LexicalWindow {
  text = "";
  base = 0;
  /** How an absolute offset is reported: the identity for one-shot text, chunk-aware for a stream. */
  readonly positionAt: PositionAt;
  // Private cold state lets consumer minifiers shorten internal names without changing the interface.
  #line = 1;
  #lineStart = 0;
  /** Whether only spaces and tabs were released since the head's line began; see `headAfterIndent`. */
  #releasedIndent = true;
  #scannedTo = 0;
  #scannedLine = 1;
  #scannedLineStart = 0;
  #comment: { kind: "line" | "block"; open: number } | undefined;
  #ownedPrefix = "";
  #ownedPrefixBase = 0;

  // Keep the token-loop cursor ordinary: the private-field variant regressed Bun recovery.
  private position = 0;

  constructor(
    positionAt: PositionAt = utf16At,
    private completeSource?: string | ((from: number, until: number) => string),
    scope: "whole" | "stream" = "whole",
  ) {
    this.positionAt = positionAt;
    // A byte source resolves context on demand; only a complete string can back input slices.
    // Whole-input fields share one bounded copy; stream values retain the smaller backing limit.
    this.ownedWindowSize = scope === "whole" ? 8192 : 256;
    // A short whole input may itself borrow an arbitrarily large caller string.
    if (typeof completeSource === "string" && completeSource.length <= this.ownedWindowSize)
      this.completeSource = ownText(completeSource);
  }
  private readonly ownedWindowSize: number;
  #commentOpen = 0;
  #commentClose = 0;
  #wordState: WordState | undefined;
  #completedWord = "";
  // A completed number is consumed before another token; a number becoming a word inherits its mark.
  #completedRaw = "";
  // A trailing whitespace refusal can outlive compaction and the word's final delivery.
  #wordSpaceMark: SourceMark | undefined;
  #completedStart = 0;
  #completedMark: SourceMark | undefined;
  #numberState: NumberState | undefined;

  get length(): number {
    return this.text.length;
  }

  retainedText(text: string): string {
    // Literal decoding can return borrowed text too; output limits do not establish ownership.
    return this.length > this.ownedWindowSize ? ownText(text) : text;
  }

  retainedSlice(start: number, end: number): string {
    // Owned small windows can share storage; larger borrowed windows must release unrelated source.
    return this.retainedText(this.text.slice(start, end));
  }

  /** How much of the word or number still being read has left the buffer for its `parts`. */
  get released(): number {
    return (this.#wordState ?? this.#numberState)?.parts?.length ?? 0;
  }

  #tokenLimited = false;

  get tokenLimited(): boolean {
    return this.#tokenLimited;
  }

  private limitToken(
    state: { start: number; parts: string | undefined },
    capacity: number,
    delivered = 0,
  ): void {
    // A completed token may become a small scalar, so bound storage only when raw text must wait.
    // Clamp before banking; recognition can borrow the active chunk without retaining its suffix.
    if (this.absolute(this.position) - state.start - delivered <= capacity) return;
    this.position = Math.max(0, state.start + delivered + capacity - this.base);
    if (state.parts !== undefined) state.parts = state.parts.slice(0, capacity);
    this.#tokenLimited = true;
  }

  get inComment(): boolean {
    return this.#comment !== undefined;
  }

  get cursor(): number {
    return this.position;
  }

  get commentStart(): number {
    return this.#commentOpen;
  }

  get commentEnd(): number {
    return this.#commentClose;
  }

  get inWord(): boolean {
    return this.#wordState !== undefined;
  }

  get wordStart(): number {
    return this.#wordState?.start ?? this.#completedStart;
  }

  get wordValue(): string {
    return this.#completedWord;
  }

  get wordRaw(): string {
    return this.#completedRaw;
  }

  get wordSpaceMark(): SourceMark | undefined {
    return this.#wordSpaceMark;
  }

  get inNumber(): boolean {
    return this.#numberState !== undefined;
  }

  get numberStart(): number {
    return this.#numberState?.start ?? this.#completedStart;
  }

  get numberRaw(): string {
    return this.#completedRaw;
  }

  /**
   * The raw text of the word or number still being read, through the end of the buffer: the parts
   * already released, then what the buffer holds. A snapshot's cut reports it as withheld `text`;
   * `wordRaw` and `numberRaw` exist only once the token completes.
   */
  get pendingRaw(): string {
    const state = this.#wordState ?? this.#numberState;
    if (state === undefined) return "";
    const from = state.parts === undefined ? state.start : state.next;
    const text =
      (state.parts ?? "") +
      this.text.slice(from - this.base, this.tokenLimited ? this.position : undefined);
    // Cut metadata outlives this window; a bounded prefix must not keep its original chunk alive.
    return this.tokenLimited ? ownText(text) : this.retainedText(text);
  }

  /**
   * Whole input arrives in slices only so a scan can stop between them; the window keeps every
   * byte for error context. Concatenating would build a rope over the whole retained prefix that
   * the next `charCodeAt` flattens, copying it again per slice: quadratic, and V8 ran out of heap
   * cooperatively parsing a 4 MB string. The window always holds `completeSource[base, base +
   * length)` (a quote replay splices in the source's own text), so re-slicing the source instead
   * yields the same string without repeatedly copying the retained prefix. Small windows own
   * their storage so returned pieces cannot keep the complete source alive. Grow that owned
   * prefix geometrically: malformed bytes can arrive singly, so copying every prefix is quadratic.
   */
  append(chunk: string): void {
    const length = this.text.length + chunk.length;
    const source = this.completeSource;
    if (
      typeof source === "string" &&
      source.length > this.ownedWindowSize &&
      length <= this.ownedWindowSize
    ) {
      if (this.#ownedPrefixBase !== this.base) this.#ownedPrefix = "";
      if (this.#ownedPrefix.length < length) {
        const capacity = Math.min(
          this.ownedWindowSize,
          Math.max(length, this.#ownedPrefix.length * 2),
        );
        this.#ownedPrefix = ownText(source.slice(this.base, this.base + capacity));
        this.#ownedPrefixBase = this.base;
      }
      // Prefetched units must not become visible to scanner lookahead before input advances.
      this.text = this.#ownedPrefix.slice(0, length);
      return;
    }
    this.#ownedPrefix = "";
    this.text =
      typeof source === "string"
        ? source.slice(this.base, this.base + length)
        : // A short caller slice can share arbitrary backing storage; own it once for all tokens.
          this.text + (chunk.length <= this.ownedWindowSize ? ownText(chunk) : chunk);
  }

  /**
   * Replays a probed quote suffix so the structural scanner can consume its chosen reading, and
   * answers the offset to resume reading at.
   *
   * **The bytes before the mark are KEPT wherever this buffer still holds them.** `context` on an
   * error is a window over this text, so discarding them made a second error in the same document
   * quote fewer characters than the first — a difference nothing in the consumer's input explains,
   * and one they cannot act on. Measured: `{"key1": "value1","key2": "value2','key3": "value3"}`
   * reported 40 characters around the first error and 18 around the second. Only a stream that has
   * already released those bytes rebases, and there the shorter context is the truth.
   *
   * `text` is authoritative from the mark onwards — `QuoteAmbiguity` accumulates the source's own
   * slices and never rewrites them — so splicing it in is correct whether or not this buffer still
   * agreed, which is why nothing here has to reason about which chunks arrived when.
   */
  replayAmbiguousQuote(text: string, mark: SourceMark): number {
    const keep = mark.at - this.base;
    if (keep < 0) {
      this.text = text.length <= this.ownedWindowSize ? ownText(text) : text;
      this.base = mark.at;
      this.#line = mark.line;
      this.#lineStart = mark.at - mark.column + 1;
      // Unknown past the line's first column; a quote is never where a fence is asked about.
      this.#releasedIndent = mark.column === 1;
      this.position = 0;
      this.resetLocationScan();
      return 0;
    }
    this.text =
      this.text.slice(0, keep) + (text.length <= this.ownedWindowSize ? ownText(text) : text);
    this.position = keep;
    // `line` and `lineStart` describe the buffer's HEAD, which has not moved. Only the incremental
    // location scan is re-anchored, onto the mark it is about to be asked about; an error located
    // before it still rewinds the scan to the head, where those two remain true.
    this.#scannedTo = keep;
    this.#scannedLine = mark.line;
    this.#scannedLineStart = mark.at - mark.column + 1;
    return keep;
  }

  /**
   * Whether only spaces and tabs stand between the start of the head's line and the head, so a
   * code fence the head reaches is still at a line start. Remembered, not derived from `lineStart`:
   * the released indentation is gone, and a chunk boundary inside it (`Here:\n  ` + `\`\`\`json`)
   * made the fence prose while the whole text read it as a fence. Kept only where the head moves,
   * `drop` and the quote replay; a replay that moves the position without the head changes nothing.
   */
  get headAfterIndent(): boolean {
    return this.#releasedIndent;
  }

  /**
   * Consumes whitespace and comments between tokens. Comment boundaries are surfaced once so the
   * structural scanner can apply policy without owning lexical continuation state.
   */
  trivia(at: number, final: boolean): number {
    this.position = at;
    if (this.#comment !== undefined) {
      const comment = this.#comment;
      if (comment.kind === "line") {
        while (this.position < this.length && this.text.charCodeAt(this.position) !== LF)
          this.position++;
        if (this.position >= this.length && !final) return TRIVIA_WAIT;
      } else {
        while (
          this.position < this.length &&
          !(
            this.text.charCodeAt(this.position) === STAR &&
            this.text.charCodeAt(this.position + 1) === SLASH
          )
        ) {
          this.position++;
        }
        if (this.position >= this.length && !final) {
          // Resume one unit back, so a `*` ending this chunk pairs with a `/` starting the next, but
          // never onto the opener's own `*`: `/*` then `/` opens a comment holding `/`.
          this.position = Math.max(0, comment.open + 2 - this.base, this.length - 1);
          return TRIVIA_WAIT;
        }
        this.position = Math.min(this.position + 2, this.length);
      }
      this.#commentOpen = comment.open;
      this.#commentClose = this.absolute(this.position);
      this.#comment = undefined;
      return TRIVIA_END;
    }
    while (this.position < this.length) {
      const c = this.text.charCodeAt(this.position);
      if (c < 128 && IS_WS[c] === 1) {
        this.position++;
        continue;
      }
      if (isExtraWhitespace(c)) {
        this.position++;
        return TRIVIA_SPACE;
      }
      if (c === BACKSLASH) {
        if (this.position + 1 >= this.length) return final ? TRIVIA_READY : TRIVIA_WAIT;
        const next = this.text.charCodeAt(this.position + 1);
        if (isDelimiter(next)) {
          // Consume only the escape. The grammar still owns the delimiter that follows it.
          this.position++;
          return TRIVIA_ESCAPE;
        }
      }
      if (c !== SLASH) return TRIVIA_READY;
      if (this.position + 1 >= this.length) return final ? TRIVIA_READY : TRIVIA_WAIT;
      const next = this.text.charCodeAt(this.position + 1);
      if (next !== SLASH && next !== STAR) return TRIVIA_READY;
      this.#comment = {
        kind: next === SLASH ? "line" : "block",
        open: this.absolute(this.position),
      };
      this.#commentOpen = this.#comment.open;
      this.position += 2;
      return TRIVIA_START;
    }
    return TRIVIA_READY;
  }

  /**
   * Reads a bare word once; only a token spanning chunks allocates continuation storage.
   *
   * `structural` says the word sits where the grammar is being decided — at the root, or in key
   * position — and there a space ends it, along with a colon. Inside an established container's
   * VALUE position both are ordinary content: `{a: John Doe, b: 1}` is one value and one member,
   * and ending at the space instead invents the key `Doe`, whose value swallows `b:` and destroys
   * the member after it. Conservative where candidacy is still in question, forgiving once it is
   * settled — the same split the whole scanner turns on. A line break ends a word either way, so a
   * missing comma between members cannot run one value into the next.
   */
  word(
    at: number,
    final: boolean,
    structural: boolean,
    mayRelease: boolean,
    /**
     * Text already consumed that belongs to this word, with the absolute offset it began at. Used
     * when a token first read as a number turns out not to be one: the digits are continued into
     * the word rather than re-read, because a chunk boundary may already have compacted them away
     * and rewinding would silently drop them — measured, `{"a": 1_000}` split after the `1` gave
     * `_000`.
     */
    prefix?: string,
    prefixStart?: number,
    capacity = Infinity,
    pieces?: WordDrain,
  ): number {
    let state = this.#wordState;
    if (state === undefined) {
      const start = this.absolute(at);
      state = {
        start: prefixStart ?? start,
        next: start,
        parts: prefix,
        // A word continuing a number starts where the number did. If the number waited across a
        // chunk, its digits may be released, so its mark is the only record of that position.
        mark: prefix === undefined ? undefined : this.#completedMark,
        prevChar: prefix === undefined ? 0 : prefix.charCodeAt(prefix.length - 1),
      };
      this.#wordState = state;
      this.#completedMark = undefined;
      this.#wordSpaceMark = undefined;
    }
    this.position = state.next - this.base;
    let partStart = this.position;
    // Fragment publication must also pause inside a single caller-sized chunk.
    const batchEnd = pieces === undefined ? this.length : Math.min(this.length, partStart + 4096);
    // Set when a comment opener needs a character the window does not hold yet.
    let undecided = false;
    while (this.position < batchEnd) {
      const c = this.text.charCodeAt(this.position);
      if (c < 128 && (ENDS_WORD[c] === 1 || (structural && (IS_WS[c] === 1 || c === COLON)))) {
        break;
      }
      if (structural && isExtraWhitespace(c)) break;
      if (c === BACKSLASH) {
        if (this.position + 1 >= this.length && !final) {
          undecided = true;
          break;
        }
        const next = this.text.charCodeAt(this.position + 1);
        if (isDelimiter(next) && (structural || next !== COLON)) break;
      }
      // A comment is a delimiter, so `{a: undefined // note}` holds `undefined`, not the note.
      // Only after whitespace: a `//` with no space before it is inside the value the source wrote,
      // which is what keeps `{url: http://x}` whole. One lookahead, and only on a slash.
      if (c === SLASH) {
        const prev =
          this.position > partStart ? this.text.charCodeAt(this.position - 1) : state.prevChar;
        if ((prev < 128 && IS_WS[prev] === 1) || isExtraWhitespace(prev)) {
          if (this.position + 1 >= this.length) {
            // The character that would decide it has not arrived; resume with more input.
            if (!final) {
              undecided = true;
              break;
            }
          } else {
            const next = this.text.charCodeAt(this.position + 1);
            if (next === SLASH || next === STAR) break;
          }
        }
      }
      if (isExtraWhitespace(c)) {
        this.#wordSpaceMark ??= this.mark(this.position);
      } else if (c >= 128 || IS_WS[c] !== 1) {
        // An interior space is value content; only a trailing run needs a source repair.
        this.#wordSpaceMark = undefined;
      }
      this.position++;
    }
    let delivered = 0;
    if (pieces !== undefined) {
      delivered = pieces(this, state, partStart);
      partStart = state.next - this.base;
    }
    if (
      undecided ||
      (this.position >= batchEnd && batchEnd < this.length) ||
      (this.position >= this.length && !final)
    ) {
      this.limitToken(state, capacity, delivered);
      if (!mayRelease) {
        // Keep the source for root candidacy, but resume after what was already scanned, as
        // `numberToken` does: returning without advancing re-read the whole word on every chunk,
        // quadratic in its length (each malformed byte of whole input is its own chunk).
        if (this.position > partStart) {
          if (state.parts !== undefined) state.parts += this.text.slice(partStart, this.position);
          state.prevChar = this.text.charCodeAt(this.position - 1);
        }
        state.next = this.absolute(this.position);
        return TOKEN_WAIT;
      }
      // At the word's start, not `at`: for a word continuing a number, `at` is where the digits
      // ended, and an error located there pointed one or more characters late.
      state.mark ??= this.mark(state.start - this.base);
      // Released slices can own the entire input chunk. Detach only newly acquired storage;
      // copying the accumulated prefix each chunk would make small feeds quadratic.
      if (prefix !== undefined && state.parts !== undefined)
        state.parts = this.retainedText(state.parts);
      if (this.position > partStart) {
        state.parts = (state.parts ?? "") + this.retainedSlice(partStart, this.position);
        // Carried so the comment test above still knows what preceded a slash opening the next
        // window: that character is dropped when the consumed prefix is compacted away.
        state.prevChar = this.text.charCodeAt(this.position - 1);
      }
      state.next = this.absolute(this.position);
      return TOKEN_WAIT;
    }
    // Nothing banked means the whole word is still in the window, from its start.
    const tail = this.text.slice(
      state.parts === undefined ? state.start - this.base : partStart,
      this.position,
    );
    // Trailing space is layout, not content: `{a: John Doe , b: 1}` holds the same value as without
    // it. Trimmed at completion rather than in the loop, so a word split across chunks trims once.
    this.#completedRaw = state.parts === undefined ? tail : state.parts + tail;
    this.#completedWord = this.#completedRaw.trimEnd();
    this.#completedStart = state.start;
    this.#completedMark = state.mark;
    this.#wordState = undefined;
    return TOKEN_DONE;
  }

  tokenError(kind: ErrorKind, refused?: SwitchableRepair): LocatedError {
    const mark = this.#completedMark;
    return mark === undefined
      ? this.locate(kind, this.#completedStart - this.base, refused)
      : errorAt(kind, mark, this.positionAt, refused);
  }

  numberToken(
    at: number,
    final: boolean,
    mayRelease: boolean,
    capacity = Infinity,
    pieces?: NumberDrain,
  ): number {
    let state = this.#numberState;
    if (state === undefined) {
      const start = this.absolute(at);
      state = {
        start,
        next: start,
        parts: undefined,
        mark: undefined,
        mode: NUMBER_PROBE,
        decimal: DECIMAL_START,
        facts: 0,
        zeroLed: false,
        last: Number.NaN,
      };
      this.#numberState = state;
      this.#completedMark = undefined;
    }
    this.position = state.next - this.base;
    let partStart = this.position;
    const batchEnd = pieces === undefined ? this.length : Math.min(this.length, partStart + 4096);
    if (state.mode === NUMBER_PROBE) {
      let probe = this.position;
      const sign = this.text.charCodeAt(probe);
      if (sign === MINUS || sign === PLUS) {
        state.facts = sign === MINUS ? NUMBER_MINUS : NUMBER_PLUS;
        probe++;
      }
      if (this.text.charCodeAt(probe) === DOT) state.facts |= NUMBER_LEADING_DOT;
      if (
        probe >= this.length ||
        (this.text.charCodeAt(probe) === ZERO && probe + 1 >= this.length)
      ) {
        if (!final) return TOKEN_WAIT;
      } else if (this.text.charCodeAt(probe) === ZERO) {
        state.zeroLed = true;
        const marker = this.text.charCodeAt(probe + 1) | 0x20;
        const radix = marker === LOWER_X ? 16 : marker === LOWER_B ? 2 : marker === LOWER_O ? 8 : 0;
        if (radix !== 0 && probe + 2 >= this.length && !final) return TOKEN_WAIT;
        state.mode =
          radix !== 0 && digitValue(this.text.charCodeAt(probe + 2)) < radix
            ? radix
            : NUMBER_DECIMAL;
        if (state.mode === 16) state.facts |= NUMBER_HEX;
        else if (state.mode === 2) state.facts |= NUMBER_BINARY;
        else if (state.mode === 8) state.facts |= NUMBER_OCTAL;
        else if (digitValue(this.text.charCodeAt(probe + 1)) <= 9)
          state.facts |= NUMBER_LEADING_ZERO;
      } else {
        state.mode = NUMBER_DECIMAL;
      }
    }
    // Set when a `_` sits on the last unit of a window that is not the end of input.
    let separatorPending = false;
    if (state.mode === 2 || state.mode === 8 || state.mode === 16) {
      if (state.next === state.start) {
        if (
          this.text.charCodeAt(this.position) === MINUS ||
          this.text.charCodeAt(this.position) === PLUS
        )
          this.position++;
        this.position += 2;
        partStart = state.start - this.base;
      }
      while (this.position < batchEnd) {
        const c = this.text.charCodeAt(this.position);
        if (digitValue(c) < state.mode) {
          this.position++;
          continue;
        }
        if (c === UNDERSCORE) {
          const verdict = this.separatorAt(state, partStart, final);
          if (verdict === SEPARATOR_ADMIT) {
            state.facts |= NUMBER_SEPARATED;
            this.position++;
            continue;
          }
          separatorPending = verdict === SEPARATOR_WAIT;
        }
        break;
      }
    } else {
      if (
        state.next === state.start &&
        (this.text.charCodeAt(this.position) === MINUS ||
          this.text.charCodeAt(this.position) === PLUS)
      )
        this.position++;
      while (this.position < batchEnd) {
        const c = this.text.charCodeAt(this.position);
        if ((c >= ZERO && c <= NINE) || c === DOT || c === LOWER_E || c === UPPER_E) {
          if (c >= ZERO && c <= NINE) {
            if (state.decimal === DECIMAL_START) state.decimal = DECIMAL_INTEGER;
            else if (state.decimal === DECIMAL_LEADING_DOT || state.decimal === DECIMAL_POINT)
              state.decimal = DECIMAL_FRACTION;
            else if (state.decimal === DECIMAL_EXPONENT || state.decimal === DECIMAL_EXPONENT_SIGN)
              state.decimal = DECIMAL_EXPONENT_DIGITS;
          } else if (c === DOT) {
            state.decimal =
              state.decimal === DECIMAL_START
                ? DECIMAL_LEADING_DOT
                : state.decimal === DECIMAL_INTEGER
                  ? DECIMAL_POINT
                  : DECIMAL_INVALID;
          } else {
            if (state.decimal === DECIMAL_POINT) state.facts |= NUMBER_EMPTY_FRACTION;
            state.decimal =
              state.decimal === DECIMAL_INTEGER ||
              state.decimal === DECIMAL_FRACTION ||
              state.decimal === DECIMAL_POINT
                ? DECIMAL_EXPONENT
                : DECIMAL_INVALID;
          }
          this.position++;
          continue;
        }
        if (
          (c === MINUS || c === PLUS) &&
          ((this.position > partStart ? this.text.charCodeAt(this.position - 1) : state.last) |
            0x20) ===
            LOWER_E
        ) {
          state.decimal =
            state.decimal === DECIMAL_EXPONENT ? DECIMAL_EXPONENT_SIGN : DECIMAL_INVALID;
          this.position++;
          continue;
        }
        if (c === UNDERSCORE) {
          const verdict = this.separatorAt(state, partStart, final);
          if (verdict === SEPARATOR_ADMIT) {
            state.facts |= NUMBER_SEPARATED;
            this.position++;
            continue;
          }
          separatorPending = verdict === SEPARATOR_WAIT;
        }
        break;
      }
    }
    if (this.position > partStart) state.last = this.text.charCodeAt(this.position - 1);
    let delivered = 0;
    if (pieces !== undefined) {
      delivered = pieces(this, state, partStart);
      partStart = state.next - this.base;
    }
    if (
      (this.position >= batchEnd && batchEnd < this.length) ||
      (!final &&
        (separatorPending ||
          this.position >= this.length ||
          (this.text.charCodeAt(this.position) === BACKSLASH && this.position + 1 >= this.length)))
    ) {
      this.limitToken(state, capacity, delivered);
      if (this.position > partStart) state.last = this.text.charCodeAt(this.position - 1);
      if (!mayRelease) {
        // Keep the source for root candidacy, but resume after the prefix already scanned.
        state.next = this.absolute(this.position);
        return TOKEN_WAIT;
      }
      state.mark ??= this.mark(at);
      if (this.position > partStart) {
        // A bounded token must not retain an oversized source through its slice's backing store.
        state.parts = (state.parts ?? "") + this.retainedSlice(partStart, this.position);
      }
      state.next = this.absolute(this.position);
      return TOKEN_WAIT;
    }
    const retainedStart = state.parts === undefined ? state.start - this.base : partStart;
    const tail = this.text.slice(retainedStart, this.position);
    if (this.position > partStart) state.last = this.text.charCodeAt(this.position - 1);
    if (state.decimal === DECIMAL_POINT) state.facts |= NUMBER_EMPTY_FRACTION;
    // A separator always promises another digit; hexadecimal e/b are digits, not exponent markers.
    if (
      state.last === UNDERSCORE ||
      (state.mode !== 16 &&
        (state.last === PLUS ||
          state.last === MINUS ||
          state.last === DOT ||
          (state.last | 0x20) === LOWER_E))
    )
      state.facts |= NUMBER_UNFINISHED;
    this.#completedRaw = state.parts === undefined ? tail : state.parts + tail;
    this.#completedStart = state.start;
    this.#completedMark = state.mark;
    this.#numberState = undefined;
    // A radix token contains only admitted digits. Decimal validity needs its punctuation history,
    // which remains bounded even when a source-fragment consumer releases the token's text.
    if (
      state.mode !== 2 &&
      state.mode !== 8 &&
      state.mode !== 16 &&
      state.decimal !== DECIMAL_INTEGER &&
      state.decimal !== DECIMAL_FRACTION &&
      state.decimal !== DECIMAL_POINT &&
      state.decimal !== DECIMAL_EXPONENT_DIGITS
    )
      return state.facts | TOKEN_INVALID;
    // Preserve the scanner's digit-only classification without retaining another token field.
    return (
      state.facts |
      (state.mode === NUMBER_DECIMAL && state.decimal === DECIMAL_INTEGER
        ? TOKEN_INTEGER
        : TOKEN_DONE)
    );
  }

  /** A digit of the token's radix; decimal until a prefix chose another. */
  private isTokenDigit(state: NumberState, c: number): boolean {
    return state.mode === 2 || state.mode === 8 || state.mode === 16
      ? digitValue(c) < state.mode
      : c >= ZERO && c <= NINE;
  }

  /**
   * Judges the `_` at the cursor by the rule JavaScript and Python share: one underscore between two
   * digits, never next to a prefix, `.` or exponent marker, and never in an integer part that starts
   * with `0`. Anything else ends the token, and the reader then keeps the whole run as source text.
   *
   * The digit after it may not have arrived. Mid-stream that is a wait, never a verdict: deciding
   * early would split `1_` + `000` into the number 1 and a word. At the end of input the `_` is
   * admitted, so the token's unfinished verdict drops the value and preserves its cut text.
   */
  private separatorAt(state: NumberState, partStart: number, final: boolean): number {
    const at = this.position;
    const before =
      at > partStart
        ? this.isTokenDigit(state, this.text.charCodeAt(at - 1))
        : this.isTokenDigit(state, state.last);
    const decimal = state.mode !== 2 && state.mode !== 8 && state.mode !== 16;
    if (!before || (decimal && state.zeroLed && state.decimal < DECIMAL_LEADING_DOT))
      return SEPARATOR_STOP;
    if (at + 1 >= this.length) return final ? SEPARATOR_ADMIT : SEPARATOR_WAIT;
    return this.isTokenDigit(state, this.text.charCodeAt(at + 1))
      ? SEPARATOR_ADMIT
      : SEPARATOR_STOP;
  }

  absolute(relative: number): number {
    return this.base + relative;
  }

  mark(relative: number): SourceMark {
    const { line, column, context } = this.locate("unparsable-span", relative);
    // The ABSOLUTE offset, never `locate`'s reported position: a mark is window arithmetic first —
    // it rebases the window on a quote replay and locates repairs and edits — and a report only
    // afterwards, through `errorAt`. Handing back the reported offset made the two readings the
    // same number under one-shot text, where `positionAt` is the identity, and different ones in a
    // stream, where it is chunk-local: `errorAt` converted a second time and the replay took a
    // chunk-local offset for an absolute base.
    return { at: this.absolute(relative), line, column, context };
  }

  locate(kind: ErrorKind, relative: number, refused?: SwitchableRepair): LocatedError {
    if (relative < 0) {
      const pin = this.#pinned?.get(this.base + relative);
      if (pin !== undefined) return errorAt(kind, pin, this.positionAt, refused);
    }
    if (relative < this.#scannedTo) this.resetLocationScan();
    for (let i = this.#scannedTo; i < relative; i++) {
      if (this.text.charCodeAt(i) === LF) {
        this.#scannedLine++;
        this.#scannedLineStart = this.base + i + 1;
      }
    }
    this.#scannedTo = relative;
    const at = this.absolute(relative);
    const source = this.completeSource;
    let context =
      typeof source === "function"
        ? source(Math.max(0, at - 20), at + 20)
        : source === undefined
          ? this.text.slice(Math.max(0, relative - 20), Math.min(this.length, relative + 20))
          : source.slice(Math.max(0, at - 20), at + 20);
    if (
      this.length > this.ownedWindowSize ||
      typeof source === "function" ||
      (source?.length ?? 0) > this.ownedWindowSize
    ) {
      // A callback can borrow decoded storage outside this window; detach its contexts too.
      context = ownText(context);
    }
    return {
      kind,
      at: this.positionAt(at),
      line: this.#scannedLine,
      column: at - this.#scannedLineStart + 1,
      // Whole-input context includes unread source near a slice boundary, as a one-shot call does.
      context,
      refused,
    };
  }

  /**
   * Located positions this window released but an error may still name: a comma found trailing only
   * when its closer arrives, a key refused only when its value lands. Their line, column and context
   * cannot be computed once the text is gone, so `drop` records them first.
   */
  #pinned: Map<number, SourceMark> | undefined;

  // Expose offsets only; fragment history must not mutate diagnostic marks or retain their text.
  get pinnedOffsets(): Iterable<number> | undefined {
    return this.#pinned?.keys();
  }

  /**
   * Releases a decided prefix, keeping what `headAfterIndent` needs to know about it, and the
   * location of each absolute offset in `pins` that the cut releases. Pins are the scanner's pending
   * anchors, a few per drop, and a drop runs once per chunk: never per token.
   */
  drop(cut: number, pins?: readonly (number | undefined)[]): void {
    // Completed scalars belong to the builder or caller; only continuation state needs raw text.
    this.#completedWord = "";
    this.#completedRaw = "";
    if (this.#wordState === undefined) this.#wordSpaceMark = undefined;
    this.#completedMark = undefined;
    let pinned: Map<number, SourceMark> | undefined;
    if (pins !== undefined) {
      for (const at of pins) {
        if (at === undefined || at >= this.base + cut) continue;
        const kept =
          pinned?.get(at) ??
          this.#pinned?.get(at) ??
          (at >= this.base ? this.mark(at - this.base) : undefined);
        if (kept !== undefined) (pinned ??= new Map()).set(at, kept);
      }
    }
    this.#pinned = pinned;
    // A released prefix can be a whole large chunk of prose; a per-unit walk here was most of
    // large-chunk stream time. Only its line breaks and the blanks after the last one matter.
    let lineFrom = 0;
    for (
      let lf = this.text.indexOf("\n");
      lf !== -1 && lf < cut;
      lf = this.text.indexOf("\n", lf + 1)
    ) {
      this.#line++;
      lineFrom = lf + 1;
    }
    if (lineFrom > 0) {
      this.#lineStart = this.base + lineFrom;
      this.#releasedIndent = true;
    }
    for (let i = lineFrom; i < cut && this.#releasedIndent; i++) {
      const c = this.text.charCodeAt(i);
      if (c !== SPACE && c !== TAB) this.#releasedIndent = false;
    }
    const tail = this.text.slice(cut);
    // A short carry must not disguise a released large source as a bounded context window.
    this.text =
      this.length > this.ownedWindowSize && tail.length > 0 && tail.length <= this.ownedWindowSize
        ? ownText(tail)
        : tail;
    this.base += cut;
    this.position -= cut;
    this.resetLocationScan();
  }

  /** Releases terminal state without scanning bytes whose locations can never be queried again. */
  clear(): void {
    this.#tokenLimited = false;
    this.base += this.text.length;
    this.text = "";
    // Terminal readers cannot query source context again; release its backing storage too.
    this.completeSource = undefined;
    this.#ownedPrefix = "";
    this.#pinned = undefined;
    this.#completedWord = "";
    this.#completedRaw = "";
    this.#wordSpaceMark = undefined;
    this.#completedMark = undefined;
    this.#wordState = undefined;
    this.#numberState = undefined;
    this.position = 0;
    this.resetLocationScan();
  }

  private resetLocationScan(): void {
    this.#scannedTo = 0;
    this.#scannedLine = this.#line;
    this.#scannedLineStart = this.#lineStart;
  }
}
