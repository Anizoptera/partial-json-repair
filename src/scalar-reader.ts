// SPDX-License-Identifier: Apache-2.0

import { cutOf, keyText } from "./cut";
import { readKnownEscapes } from "./string-escapes";
import { numberKind, wordValue, WORD_TEXT, type WordValue, type SOURCE_VALUE } from "./bare-values";
import type { ResolvedOptions } from "./options";
import type { Cut, RepairKind, SwitchableRepair } from "./types";
import type { ScanCursor } from "./scan-cursor";
import type { ScanDiagnostics } from "./scan-diagnostics";
import type { SourceMark, NumberDrain, WordDrain } from "./lexical-window";
import {
  LINE_CLOSING,
  LINE_QUOTED,
  LINE_TEXT,
  LINE_WAIT,
  QUOTE_MISMATCH,
  QUOTE_WAIT,
  QuoteAmbiguity,
  RUN_CLOSERS,
  lineFollower,
  type LineProbe,
  type StringResume,
} from "./quote-ambiguity";
import { ExactNumber } from "./exact-number";
import { jsonSpelling, MAX_FINITE_INT_DIGITS, needsExact } from "./number-fidelity";
import {
  errorAt,
  ownText,
  TOKEN_DONE,
  TOKEN_INTEGER,
  TOKEN_STATUS,
  TOKEN_WAIT,
  NUMBER_PLUS,
  NUMBER_MINUS,
  NUMBER_HEX,
  NUMBER_BINARY,
  NUMBER_OCTAL,
  NUMBER_SEPARATED,
  NUMBER_UNFINISHED,
} from "./lexical-window";
import {
  endsScalar,
  APOSTROPHE,
  BACKSLASH,
  CLOSE_BRACE,
  COMMA,
  DOT,
  ESCAPE,
  IS_WS,
  isSeparator,
  isDelimiter,
  isExtraWhitespace,
  isLiteralPrefix,
  CR,
  LF,
  LOWER_U,
  MINUS,
  NINE,
  OPEN_BRACE,
  PLUS,
  QUOTE,
  ST_KEY,
  ZERO,
  hexValue,
} from "./chars";

export type ScalarRead<T = unknown> = {
  /**
   * `cut`: the input ENDED inside this token and it is a literal or number the source never
   * finished (`tru`, `1e`, `-`). There is no value; the scanner drops the member or element as if
   * the value never arrived, and reports it. `stopped` leaves a typed storage failure and bounded
   * recovery; the scanner must not install its original completed value or rewind the refusal.
   */
  status: "done" | "none" | "wait" | "cut" | "stopped";
  value: T;
  quoted: boolean;
};

export type QuotedSource = {
  readonly carryFrom: number | undefined;
  readonly rawHeld: number;
  beginCarry(at: number, quote: string): void;
  part(until: number, ambiguous: boolean): void;
  end(until: number, ambiguity: QuoteAmbiguity | undefined): void;
};

/**
 * The last code unit of a banked text, from `tracked` unless `bank` handed the text out as fragments
 * and kept at most one held unit, which is then read directly at no cost.
 */
const lastUnit = (text: string, tracked: number): number =>
  text.length > 1 ? tracked : text.charCodeAt(text.length - 1);

export class ScalarReader {
  // LexicalWindow owns bare-token continuation. String tails stay separate from decided prefixes
  // so delivery can release completed text without guessing an ambiguous suffix.
  private resume: StringResume | undefined;
  protected partial: string | undefined;
  /** What `chargeToken` has charged for the word or number still being read. */
  private chargedToken = 0;
  /** Absolute offset where the source of `pending` ends: the snapshot cut's `text` starts there. */
  partialEnd = 0;
  /** Absolute offset of the opening quote of `pending`: a view's match for it starts there. */
  partialStart = 0;
  /**
   * The cut a token reaching the END of input recorded: only the last token can, so it is written
   * once per input and never cleared. `cut.ts` reads it first.
   */
  cut: Cut | undefined;

  constructor(
    protected readonly cursor: ScanCursor,
    protected readonly diagnostics: ScanDiagnostics,
    protected readonly opts: ResolvedOptions,
  ) {}

  beginRun(): void {
    this.partial = undefined;
    this.deliveryPaused = false;
  }

  // A batch boundary may leave readable input even when no decided fragment can be published.
  deliveryPaused = false;

  get pending(): string | undefined {
    return this.partial;
  }

  get quoteReplayCarry(): number {
    // Decoded content and replay source have separate owners and separate storage limits.
    return this.resume?.ambiguity?.releasedBefore(this.cursor.base) ?? 0;
  }

  private get continuingString(): boolean {
    return this.resume !== undefined && this.resume.next === this.cursor.pos + this.cursor.base;
  }

  get continuation(): Readonly<{ open: number; quote: number }> | undefined {
    const resume = this.continuingString ? this.resume : undefined;
    return resume === undefined ? undefined : { open: resume.openMark.at, quote: resume.quote };
  }

  clearPending(): void {
    this.partial = undefined;
  }

  stopPending(): void {
    const prefix = this.partial;
    if (prefix === undefined) return;
    // Transfer banked text into terminal recovery through the normal policy/selection writer.
    // No closer or unclosed-string repair is invented; no scan may resume after this transfer.
    if (this.resume !== undefined)
      this.diagnostics.build.charge(-this.resume.text.length, this.partialStart);
    this.diagnostics.build.value(
      prefix + this.opts.cutSuffix,
      this.partialStart,
      this.partialEnd,
      true,
    );
    this.partial = undefined;
    this.resume = undefined;
  }

  // A stopped parser must not bank a string prefix after its view has been captured.
  dispose(): void {
    this.resume = undefined;
    this.partial = undefined;
    this.cut = undefined;
  }

  /**
   * Charges a word or number still being read against `maxRetained`, as `bank` charges a string:
   * the buffer releases the token's text into its `parts`, so `maxBuffer` no longer sees it and one
   * endless token (`[1, 2333…`) would otherwise grow without any limit. The charge is returned once
   * the token completes, since a finished value is charged when it is placed.
   */
  private chargeToken(waiting: boolean): void {
    const held = waiting ? this.cursor.window.released : 0;
    if (held === this.chargedToken && !this.cursor.window.tokenLimited) return;
    const build = this.diagnostics.build;
    if (held !== this.chargedToken)
      build.charge(held - this.chargedToken, this.cursor.base + this.cursor.pos);
    this.chargedToken = held;
    if (this.cursor.window.tokenLimited)
      build.charge(build.retainedRoom + 1, this.cursor.base + this.cursor.pos);
  }

  readWord(
    state: number,
    depth: number,
    prefix?: string,
    prefixStart?: number,
  ): ScalarRead<string> {
    const before = this.cursor.pos;
    const pieces = this.wordPieces(state, depth);
    const result = this.cursor.window.word(
      this.cursor.pos,
      this.cursor.atEnd,
      // Structural where candidacy is still being decided: at the root, and in key position.
      depth === 0 || state === ST_KEY,
      depth > 0,
      prefix,
      prefixStart,
      this.diagnostics.build.retainedRoom + this.chargedToken,
      pieces,
    );
    this.cursor.pos = this.cursor.window.cursor;
    this.chargeToken(result === TOKEN_WAIT);
    if (result === TOKEN_WAIT) {
      this.cursor.needMore = true;
      this.deliveryPaused =
        pieces !== undefined &&
        this.cursor.pos >= before + 4096 &&
        this.cursor.pos < this.cursor.length;
      return { status: "wait", value: "", quoted: false };
    }
    const word = result === TOKEN_DONE ? this.cursor.window.wordValue : "";
    const value = state === ST_KEY ? this.cursor.window.retainedText(word) : word;
    const mark = this.cursor.window.wordSpaceMark;
    if (result === TOKEN_DONE && mark !== undefined) {
      const window = this.cursor.window;
      if (this.opts.recover["non-json-whitespace"])
        this.diagnostics.build.repair("non-json-whitespace", mark.at);
      else
        this.diagnostics.record(
          errorAt("unparsable-span", mark, window.positionAt, "non-json-whitespace"),
        );
      for (let i = value.length; i < window.wordRaw.length; i++) {
        if (isExtraWhitespace(window.wordRaw.charCodeAt(i))) {
          const at = this.cursor.pos + this.cursor.base - window.wordRaw.length + i;
          this.diagnostics.build.edit(at, at + 1, " ");
        }
      }
    }
    if (
      state === ST_KEY &&
      this.limitCompleted(value, state, this.cursor.window.wordStart, this.cursor.window.wordRaw)
    )
      return { status: "stopped", value: "", quoted: false };
    return {
      status:
        value === "" && this.diagnostics.build.picks?.delivery?.fragmentDelivery?.streaming !== true
          ? "none"
          : "done",
      value,
      quoted: false,
    };
  }

  readQuoted(c: number, state: number, depth: number): ScalarRead<string> {
    const build = this.diagnostics.build;
    if (c === APOSTROPHE) {
      const resumed = this.continuingString;
      const start = resumed
        ? (this.resume?.openMark.at ?? this.cursor.base) - this.cursor.base
        : this.cursor.pos;
      const startAt = start + this.cursor.base;
      if (!resumed) this.lenient("single-quote", start);
      const editCount = build.edits.length;
      const value = this.readString(APOSTROPHE, state, depth);
      if (this.cursor.needMore) return { status: "wait", value, quoted: true };
      if (build.editsEnabled && build.edits.length === editCount)
        build.edit(startAt, this.cursor.pos + this.cursor.base, JSON.stringify(value));
      return { status: "done", value, quoted: true };
    }
    const value = this.readString(QUOTE, state, depth);
    return { status: this.cursor.needMore ? "wait" : "done", value, quoted: true };
  }

  read(c: number, state: number, depth: number): ScalarRead {
    if (c === QUOTE || c === APOSTROPHE) return this.readQuoted(c, state, depth);
    if (c === MINUS) {
      const literal = "-Infinity";
      const available = this.cursor.text.slice(
        this.cursor.pos,
        Math.min(this.cursor.length, this.cursor.pos + literal.length),
      );
      if (
        literal.startsWith(available) &&
        available.length < literal.length &&
        !this.cursor.atEnd
      ) {
        this.cursor.needMore = true;
        return { status: "wait", value: undefined, quoted: false };
      }
      if (available === literal) {
        const end = this.cursor.pos + literal.length;
        const next = this.cursor.text.charCodeAt(end);
        if (
          !this.cursor.atEnd &&
          (end === this.cursor.length || (next === BACKSLASH && end + 1 === this.cursor.length))
        ) {
          this.cursor.needMore = true;
          return { status: "wait", value: undefined, quoted: false };
        }
        if (
          end === this.cursor.length ||
          isExtraWhitespace(next) ||
          (next === BACKSLASH && isDelimiter(this.cursor.text.charCodeAt(end + 1))) ||
          (next < 128 && (IS_WS[next] === 1 || isSeparator(next)))
        ) {
          const start = this.cursor.pos;
          this.cursor.pos += literal.length;
          const asLiteral = this.opts.recover["js-literal"];
          this.lenient("js-literal", start);
          const value = asLiteral ? Number.NEGATIVE_INFINITY : literal;
          if (this.diagnostics.build.editsEnabled)
            this.edit(start, this.cursor.pos, asLiteral ? "null" : JSON.stringify(literal));
          return { status: "done", value, quoted: false };
        }
      }
    }
    if ((c >= ZERO && c <= NINE) || c === MINUS || c === PLUS || c === DOT) {
      const token = this.scanNumber(depth);
      if (this.cursor.needMore) return { status: "wait", value: undefined, quoted: false };
      const ends = this.cursor.atEnd && this.cursor.pos === this.cursor.length;
      if (ends && (token & NUMBER_UNFINISHED) !== 0)
        return this.cutToken(this.cursor.window.numberRaw);
      // A number is only a number if what follows it could follow a scalar. `1_000` otherwise reads
      // as `1` — a value the source never wrote — and leaves `_000` to become an invented key whose
      // value swallows the next member. Continue consumed digits into the same word so chunk
      // compaction cannot drop source text.
      const follower = this.cursor.text.charCodeAt(this.cursor.pos);
      if (
        !endsScalar(follower) &&
        !(follower === BACKSLASH && isDelimiter(this.cursor.text.charCodeAt(this.cursor.pos + 1)))
      ) {
        const raw = this.cursor.window.numberRaw;
        const from = this.cursor.window.numberStart;
        const whole = this.readWord(state, depth, raw, from);
        if (whole.status !== "done") return whole;
        return this.finishWord(whole.value, state, depth);
      }
      // Only settled numeric spelling may convert or spend the numeric-policy error budget.
      const value = this.readNumber(depth, state, token);
      // A valid number the end touched may be the start of a longer one (`12` of `123`). At the
      // root it is the whole document and complete; in a container the source stopped inside it.
      // A token kept as its text (`01`) was already cut as the string it is.
      if (ends && depth > 0 && typeof value !== "string")
        this.cutValue("number", this.diagnostics.build.path(), "");
      if (
        this.limitCompleted(
          value,
          state,
          this.cursor.window.numberStart,
          this.cursor.window.numberRaw,
        )
      )
        return { status: "stopped", value: undefined, quoted: false };
      return { status: "done", value, quoted: false };
    }
    const word = this.readWord(state, depth);
    if (word.status !== "done") return word;
    return this.finishWord(word.value, state, depth);
  }

  protected wordPieces(state: number, depth: number): WordDrain | undefined {
    return state !== ST_KEY && depth > 0 && this.opts.recover["unquoted-string"]
      ? this.diagnostics.build.picks?.delivery?.fragmentDelivery?.wordPieces
      : undefined;
  }

  /** Both bare-word routes reject unfinished literal prefixes rather than inventing prose. */
  protected finishWord(word: string, state: number, depth: number): ScalarRead {
    return this.finishRetainedWord(word, state, depth);
  }

  protected finishRetainedWord(word: string, state: number, depth: number): ScalarRead {
    // A word's raw text keeps its trailing spaces, since a bare word may contain spaces. A word the
    // source followed with a space was finished by the source, so it is not cut.
    const raw = this.cursor.window.wordRaw;
    const ends =
      this.endsInput(this.cursor.window.wordStart, raw) && raw.trimEnd().length === raw.length;
    if (ends && isLiteralPrefix(word)) return this.cutToken(raw);
    const value = this.decodeWord(word, depth, ends && depth > 0 && state !== ST_KEY);
    if (this.limitCompleted(value, state, this.cursor.window.wordStart, raw))
      return { status: "stopped", value: undefined, quoted: false };
    return { status: "done", value, quoted: false };
  }

  // Whole-input readers have no retained-storage ceiling; stream modes supply the bounded reader.
  protected limitCompleted(_value: unknown, _state: number, _start: number, _raw: string): boolean {
    return false;
  }

  protected retainsScalar(state: number, depth: number): boolean {
    // Keys, root candidacy and repair edits need spelling even when a selection discards the value.
    const build = this.diagnostics.build;
    return (
      state === ST_KEY ||
      depth === 0 ||
      build.editsEnabled ||
      build.picks?.retainsScalar() !== false
    );
  }

  // Imported source readers provide raw delivery without a second quote/escape recognizer.
  protected get quotedSource(): QuotedSource | undefined {
    return undefined;
  }

  /**
   * The value of an unquoted token read as its own text: a bare word, or a number JSON cannot spell
   * (`01`). One the end of a final input touched, as a value inside a container, is a string still
   * arriving (`{"status": complet`), so it is cut exactly like a quoted one: `cut` names its item and
   * `cutSuffix` goes onto the value and its repaired text alike. Recognized literals bypass string
   * recovery, so the suffix never changes their type.
   */
  protected unquotedString(text: string, start: number, end: number, cut: boolean): string {
    const owned = this.cursor.window.retainedText(text);
    const value = cut ? owned + this.opts.cutSuffix : owned;
    if (cut) this.cutValue("string", this.diagnostics.build.path(), "");
    // Only repaired text needs JSON spelling; value-only recovery must not allocate it.
    if (this.diagnostics.build.editsEnabled) this.edit(start, end, JSON.stringify(value));
    return value;
  }

  /**
   * Records the cut of a value the end of input stopped inside. Under `fragments` its `end` must say
   * so, and the only mark that value carries into `Picks` is where it ends: the end of input.
   */
  protected cutValue(kind: "string" | "number", path: Cut["path"], text: string): void {
    this.cut = cutOf(kind, path, text);
    const picks = this.diagnostics.build.picks?.delivery;
    if (picks !== undefined) picks.cutEnd = this.cursor.length + this.cursor.base;
  }

  /** A literal or number the end of input cut (`tru`, `1e`): no value, and its item is `missing`. */
  protected cutToken(raw: string): ScalarRead {
    this.cut = cutOf(
      "missing",
      this.diagnostics.build.path(),
      this.cursor.window.retainedText(raw),
    );
    return { status: "cut", value: undefined, quoted: false };
  }

  /**
   * Whether a token reaches the last character of a FINAL input. A token followed by anything — even
   * whitespace — was finished by the source, and mid-stream the input may still continue it.
   */
  protected endsInput(start: number, raw: string): boolean {
    return this.cursor.atEnd && this.relative(start) + raw.length === this.cursor.length;
  }

  private relative(absolute: number): number {
    return this.cursor.relative(absolute);
  }

  private repair(kind: RepairKind, at: number): void {
    this.diagnostics.build.repair(kind, at + this.cursor.base);
  }

  private edit(start: number, end: number, text: string): void {
    this.diagnostics.build.edit(start + this.cursor.base, end + this.cursor.base, text);
  }

  /** The line-break probe for the break being read, kept across feeds by absolute offset. */
  private readonly lineProbe: LineProbe = { at: -1, next: 0, phase: 0, quote: 0 };

  /**
   * Judges a raw line break inside a string: structure follows, text follows, or not known yet. Kept
   * out of `readString`, whose size decides whether the engine inlines into the per-character loop.
   */
  private judgeBreak(c: number, closer: number): number {
    const { text, pos, base, atEnd } = this.cursor;
    // CR, LF and CR LF are each one break, as in JavaScript; an LF after a CR was judged with it.
    if (c === LF && text.charCodeAt(pos - 1) === CR) return LINE_TEXT;
    const probe = this.lineProbe;
    if (probe.at !== pos + base) {
      // A CR whose next unit has not arrived may be half of a CR LF, which is judged after its LF.
      if (c === CR && pos + 1 === text.length && !atEnd) return LINE_WAIT;
      probe.at = pos + base;
      probe.next = probe.at + (c === CR && text.charCodeAt(pos + 1) === LF ? 2 : 1);
      probe.phase = 0;
      // A bare-word key must not inherit the quote of an earlier break's key.
      probe.quote = 0;
    }
    return lineFollower(text, base, probe, atEnd, closer);
  }

  /** Judges closers and a comma inside a string as `judgeBreak` judges a break, from `pos`. */
  private judgeRun(closer: number): number {
    const { text, pos, base, atEnd } = this.cursor;
    const probe = this.lineProbe;
    if (probe.at !== pos + base) {
      probe.at = pos + base;
      probe.next = probe.at;
      probe.phase = RUN_CLOSERS;
      probe.quote = 0;
    }
    return lineFollower(text, base, probe, atEnd, closer);
  }

  private lenient(kind: SwitchableRepair, at: number, mark?: SourceMark): void {
    if (this.opts.recover[kind]) this.repair(kind, at);
    else this.refuse(at, kind, mark);
  }

  private refuse(at: number, kind?: SwitchableRepair, mark?: SourceMark): void {
    if (mark === undefined) this.diagnostics.fail("unparsable-span", at, kind);
    else
      this.diagnostics.record(
        errorAt("unparsable-span", mark, this.cursor.window.positionAt, kind),
      );
  }

  // Whole-input modes have no retained-content ledger; streams own banking charges and delivery.
  protected bank(
    text: string,
    _before: number,
    _start: number,
    _ambiguous: boolean,
    _until: number,
  ): string {
    return text;
  }

  /** Decodes by slices until the first escape; invalid escapes retain their source backslash. */
  private readString(closer: number, state: number, depth: number): string {
    const build = this.diagnostics.build;
    // A delivery pause resumes the same input window, without append() clearing the wait flag.
    this.cursor.needMore = false;
    const resume = this.continuingString ? this.resume : undefined;
    const quote = resume?.quote ?? closer;
    if (resume === undefined) this.cursor.pos++;
    const start =
      resume === undefined ? this.cursor.pos : resume.openMark.at + 1 - this.cursor.base;
    // A selected value string under `fragments` is handed out as it is decided rather than banked.
    // Short undecided strings rewind to their quote; the builder still owns the started occurrence.
    const picks = build.picks?.delivery?.fragmentDelivery;
    const source = this.quotedSource;
    // Ignored values need recognition and policy, not a decoded copy. Edits, keys and root
    // candidates still need their spelling; an unlimited storage budget does not request values.
    const retain = resume?.retain ?? this.retainsScalar(state, depth);
    if (
      picks !== undefined &&
      !picks.streaming &&
      resume === undefined &&
      state !== ST_KEY &&
      depth > 0
    )
      picks.beginStreamedString();
    let out = "";
    // `out`'s last code unit, tracked wherever `out` grows. `out` holds every banked chunk of a long
    // string, and reading a character of it flattens that rope: once per chunk, so a 64 KB value
    // streamed in 4-character chunks took a second, quadratic in its length.
    let outLast = Number.NaN;
    let chunk = start;
    let dirty = false;
    let badEscape = false;
    let chunkBadEscape = badEscape;
    let bankAt = this.cursor.pos;
    // Raw `{[` this string's text left open, never below zero, carried in `resume` because the text
    // itself may be delivered and released before a line break needs it. Every resume point is the
    // loop's stop or one held quote before it, so the loop's count is always the resume point's.
    let nest = 0;
    let bankText = out;
    let bankLast = outLast;
    let bankDirty = dirty;
    let bankBadEscape = badEscape;
    let undecided = this.cursor.length;
    /** Where an escape the end of input cut begins; it goes to the cut's text, never the value. */
    let escapeAt = -1;
    let ambiguity = resume?.ambiguity;
    let charged = resume?.text.length ?? 0;
    // Fragments relax the decoded-value limit; retainedSlice enforces source ownership separately.
    let capacity =
      source?.carryFrom === undefined
        ? !retain || (picks?.streaming === true && ambiguity === undefined)
          ? Infinity
          : build.retainedRoom + charged
        : build.retainedRoom + source.rawHeld;
    let limited = false;
    // Keys and roots are excluded: a key with a line break is no member yet, and after a root
    // string the structure this recovery protects (closers, members) cannot follow.
    const member = depth > 0 && state !== ST_KEY;
    // `missing-quote` is judged whatever its switch: off, it is refused rather than read literally,
    // because the literal reading is no honest alternative (see its kind in `types.ts`).
    const guessedEnds = member && this.opts.recover["guessed-string-end"];
    const resolveMismatch = (): string => {
      const mismatch = ambiguity;
      if (mismatch === undefined) return "";
      this.cursor.resumeAt(
        mismatch.resolve(
          this.cursor.window,
          build,
          this.opts,
          // Wrapped rather than bound: `record` returns the error it stored, and the callback slot
          // is void, so passing the method directly makes the return value look meaningful here.
          (error) => {
            this.diagnostics.record(error);
          },
        ),
      );
      if (charged !== 0) build.charge(-charged, start);
      source?.end(mismatch.end, mismatch);
      this.resume = undefined;
      return mismatch.prefix;
    };
    if (resume !== undefined) {
      chunk = this.cursor.pos;
      out = resume.text;
      outLast = resume.last;
      bankLast = outLast;
      dirty = resume.dirty;
      badEscape = resume.badEscape;
      nest = resume.nest;
      bankAt = this.cursor.pos;
      bankText = out;
      bankDirty = dirty;
      bankBadEscape = badEscape;
      chunkBadEscape = badEscape;
    }
    // Resume through the existing decoder tail after delivery; do not decode a caller-sized token
    // before its first piece. Lookahead still sees the real window, and EOF runs to completion.
    const end =
      picks !== undefined && picks.streaming && (!this.cursor.atEnd || source !== undefined)
        ? Math.min(this.cursor.length, this.cursor.pos + 4096)
        : this.cursor.length;
    while (this.cursor.pos < end) {
      const c = this.cursor.text.charCodeAt(this.cursor.pos);
      // A closer needs no decoded storage. Every other character must fit before it is retained;
      // a capacity stop keeps this prefix pending, even at EOF, rather than inventing a closer.
      if (
        capacity !== Infinity &&
        c !== closer &&
        (source?.carryFrom === undefined
          ? out.length + this.cursor.pos - chunk
          : this.cursor.base + this.cursor.pos - source.carryFrom) >= capacity
      ) {
        limited = true;
        break;
      }
      const wrongQuote =
        ambiguity === undefined &&
        c === (closer === QUOTE ? APOSTROPHE : QUOTE) &&
        isSeparator(this.cursor.text.charCodeAt(this.cursor.pos + 1));
      // A raw break is rare (JSON forbids it). The range test first leaves one comparison per
      // ordinary character: this runs on every unit of every string, as `lineEnds` once did when off.
      let lineBreak: "missing-quote" | "guessed-string-end" | undefined;
      if (c <= CR && (c === LF || c === CR) && member && ambiguity === undefined) {
        const follower = this.judgeBreak(c, closer);
        if (follower === LINE_WAIT) {
          // The break stays unread, so no fragment past it leaves before the line decides.
          undecided = this.cursor.pos;
          break;
        }
        if (follower === LINE_QUOTED || (follower === LINE_CLOSING && nest === 0))
          lineBreak = "missing-quote";
        else if (follower !== LINE_TEXT && guessedEnds) lineBreak = "guessed-string-end";
      } else if (
        (c === COMMA || ((c | 0x20) === CLOSE_BRACE && nest === 0)) &&
        member &&
        ambiguity === undefined
      ) {
        // The same structure on one line: `"x, "b": 1` read literally closes the string at the
        // key's quote and invents members from the rest. A closer the string opened is its own.
        const follower = this.judgeRun(closer);
        if (follower === LINE_WAIT) {
          undecided = this.cursor.pos;
          break;
        }
        if (follower === LINE_QUOTED) lineBreak = "missing-quote";
      }
      if (wrongQuote || lineBreak !== undefined) {
        source?.part(this.cursor.pos + this.cursor.base, false);
        source?.beginCarry(
          this.cursor.pos + this.cursor.base,
          this.cursor.text.charAt(this.cursor.pos),
        );
        if (picks?.streaming === true) {
          // Both interpretations preserve this prefix; only the quote and its suffix can change.
          // Rebase the existing decoder bank so neither replay nor refunds count delivered text.
          out = this.bank(
            out + this.cursor.window.retainedSlice(chunk, this.cursor.pos),
            charged,
            start,
            false,
            this.cursor.pos + this.cursor.base,
          );
          charged = out.length;
          capacity = build.retainedRoom + charged;
          outLast = lastUnit(out, outLast);
          chunk = this.cursor.pos;
          bankAt = chunk;
          bankText = out;
          bankLast = outLast;
          bankDirty = dirty;
          bankBadEscape = badEscape;
        }
        ambiguity = new QuoteAmbiguity(
          this.cursor.window,
          this.cursor.pos + this.cursor.base,
          retain ? out + this.cursor.window.retainedSlice(chunk, this.cursor.pos) : "",
          dirty,
          badEscape,
          resume?.openMark ?? this.cursor.window.mark(start - 1),
          lineBreak,
        );
      }
      if (c === closer && ambiguity !== undefined) {
        const verdict = ambiguity.probe(
          this.cursor.window,
          this.cursor.pos,
          state,
          depth > 0,
          this.cursor.atEnd,
        );
        if (verdict === QUOTE_WAIT) {
          ambiguity.capture(this.cursor.window);
          undecided = this.cursor.pos;
          break;
        }
        if (verdict === QUOTE_MISMATCH) return resolveMismatch();
      }
      if (c === closer) {
        const tail = retain ? this.cursor.window.retainedSlice(chunk, this.cursor.pos) : "";
        this.cursor.pos++;
        let value = out === "" ? tail : out + tail;
        // A budget-edge value will stop at placement; flatten its bounded text before ownership
        // transfers, since a short source slice can otherwise retain the caller's entire chunk.
        if (capacity !== Infinity && value.length >= capacity) value = ownText(value);
        // The banked prefix was charged as it was held; the whole value is charged when placed.
        if (charged !== 0) build.charge(-charged, start);
        if (badEscape) this.lenient("invalid-escape", start - 1, resume?.openMark);
        else if (dirty && !this.opts.repairBroken)
          this.refuse(start - 1, undefined, resume?.openMark);
        if (build.editsEnabled && dirty && quote !== APOSTROPHE)
          this.edit(start - 1, this.cursor.pos, JSON.stringify(value));
        source?.end(this.cursor.pos + this.cursor.base, ambiguity);
        this.resume = undefined;
        return value;
      }
      if (c !== BACKSLASH) {
        if (c < 0x20) dirty = true;
        else {
          // `| 0x20` maps `[` onto `{` and `]` onto `}`, and nothing else onto either.
          const bracket = c | 0x20;
          if (bracket === OPEN_BRACE) nest++;
          else if (bracket === CLOSE_BRACE && nest > 0) nest--;
        }
        this.cursor.pos++;
        continue;
      }
      if (this.cursor.pos > chunk) outLast = this.cursor.text.charCodeAt(this.cursor.pos - 1);
      if (retain) out += this.cursor.window.retainedSlice(chunk, this.cursor.pos);
      chunk = this.cursor.pos + 1;
      this.cursor.pos++;
      if (this.cursor.pos >= this.cursor.length) {
        if (this.cursor.atEnd) {
          dirty = true;
          escapeAt = this.cursor.pos - 1;
        } else {
          // Keep the undecided backslash unread, but bank everything before it: rewinding to
          // the opening quote rescans the growing prefix whenever slices end inside escapes.
          this.cursor.pos--;
          chunk = this.cursor.pos;
          bankAt = chunk;
          bankText = out;
          bankLast = outLast;
          bankDirty = dirty;
          bankBadEscape = badEscape;
        }
        break;
      }
      const e = this.cursor.text.charCodeAt(this.cursor.pos);
      const room = capacity - out.length;
      if (
        room < 2 &&
        e !== LOWER_U &&
        e !== QUOTE &&
        e !== APOSTROPHE &&
        !(e < 128 && ESCAPE[e] !== 0)
      ) {
        // An unknown escape preserves both source units; never manufacture a half-decoded escape.
        this.cursor.pos--;
        chunk = this.cursor.pos;
        limited = true;
        break;
      }
      if (e === LOWER_U) {
        let digits = 0;
        let code = 0;
        while (digits < 4 && this.cursor.pos + 1 + digits < this.cursor.length) {
          const h = hexValue(this.cursor.text.charCodeAt(this.cursor.pos + 1 + digits));
          if (h < 0) break;
          code = code * 16 + h;
          digits++;
        }
        if (digits < 4 && this.cursor.pos + 1 + digits === this.cursor.length) {
          // The text ends inside the escape, so no character was written yet. Mid-stream the escape
          // is left unread for the next chunk and kept out of a snapshot; at end of input it never
          // finished, so nothing is placed for it (HLD P1) — `"x\u00` recovers `"x"`, never the raw
          // `\u00`. `dirty` makes the repaired text rewrite the string rather than append a quote
          // after the half escape, which would not be JSON.
          if (this.cursor.atEnd) {
            dirty = true;
            escapeAt = this.cursor.pos - 1;
            this.cursor.pos = this.cursor.length;
          } else {
            this.cursor.pos = chunk - 1;
          }
          chunk = this.cursor.pos;
          break;
        }
        if (digits === 4) {
          if (retain) out += String.fromCharCode(code);
          outLast = code;
          this.cursor.pos += 1 + digits;
        } else {
          if (room < 2) {
            this.cursor.pos = chunk - 1;
            chunk = this.cursor.pos;
            limited = true;
            break;
          }
          dirty = true;
          badEscape = true;
          if (retain) out += "\\u";
          outLast = LOWER_U;
          this.cursor.pos++;
        }
      } else {
        const known = e < 128 && ESCAPE[e] !== 0;
        const isQuote = e === QUOTE || e === APOSTROPHE;
        if (!known) {
          dirty = true;
          if (!isQuote) badEscape = true;
        }
        // Every spelling ends in the escape's own character, except a known one, which decodes to it.
        const decoded = known
          ? readKnownEscapes(this.cursor, ESCAPE[e] ?? 0, room, retain)
          : isQuote
            ? this.cursor.text.charAt(this.cursor.pos)
            : `\\${this.cursor.text.charAt(this.cursor.pos)}`;
        outLast = decoded.charCodeAt(decoded.length - 1);
        if (retain) out += decoded;
        this.cursor.pos++;
      }
      // Every escape moves the bank point with its flags, an invalid `\u` included: text banked past
      // it carries `chunkBadEscape`, and a stale `false` dropped the `invalid-escape` repair of a
      // string that was read across chunks.
      chunk = this.cursor.pos;
      chunkBadEscape = badEscape;
      bankAt = chunk;
      bankText = out;
      bankLast = outLast;
      bankDirty = dirty;
      bankBadEscape = badEscape;
    }
    if (
      !this.cursor.atEnd ||
      limited ||
      (source !== undefined && end < this.cursor.length && this.cursor.pos >= end)
    ) {
      this.cursor.needMore = true;
      ambiguity?.capture(this.cursor.window);
      // What is decided ends where the loop stopped: at the end of input, at the backslash of a
      // `\u` escape still arriving (the loop rewinds `pos` to it), or at a closer whose quote
      // mismatch waits for more input (`undecided`). One more unit is held when the last one is the
      // OTHER quote kind: whether it ends the string is read from the character after it, and a
      // banked quote would never be looked at again. Nothing else in a string looks ahead, so
      // every other character leaves at once — a selected string's fragments trail the input by at
      // most one unit, where a flat six-unit hold (the `\u` escape's length) made them trail by six.
      const stop = Math.min(this.cursor.pos, undecided);
      const safe =
        ambiguity === undefined &&
        this.cursor.text.charCodeAt(stop - 1) === (closer === QUOTE ? APOSTROPHE : QUOTE)
          ? stop - 1
          : stop;
      const tail = retain ? this.cursor.window.retainedSlice(chunk, this.cursor.pos) : "";
      // `>=`: a chunk ending exactly where an escape ends leaves `bankAt === safe === chunk`, and the
      // branch below banks only past `chunk`, so without the equality nothing moved the resume point.
      if (bankAt >= safe && bankAt > start) {
        const text = this.bank(
          bankText,
          charged,
          start,
          ambiguity !== undefined,
          bankAt + this.cursor.base,
        );
        this.resume = {
          openMark: resume?.openMark ?? this.cursor.window.mark(start - 1),
          next: bankAt + this.cursor.base,
          quote,
          text,
          retain,
          last: lastUnit(text, bankLast),
          dirty: bankDirty,
          badEscape: bankBadEscape,
          nest,
          ambiguity,
        };
      } else if (safe > chunk) {
        // The first pass already saw every control in this tail; a held quote cannot add one.
        const text = this.bank(
          retain
            ? out +
                (safe === this.cursor.pos ? tail : this.cursor.window.retainedSlice(chunk, safe))
            : "",
          charged,
          start,
          ambiguity !== undefined,
          safe + this.cursor.base,
        );
        this.resume = {
          openMark: resume?.openMark ?? this.cursor.window.mark(start - 1),
          next: safe + this.cursor.base,
          quote,
          text,
          retain,
          last: lastUnit(text, this.cursor.text.charCodeAt(safe - 1)),
          dirty,
          badEscape: chunkBadEscape,
          nest,
          ambiguity,
        };
      }
      const partial = retain ? out + tail : "";
      // A high surrogate at the end may be the first half of a pair still arriving; showing it alone
      // would flash a replacement character in a view. At end of input it is genuinely lone and kept.
      const last =
        chunk < this.cursor.pos ? this.cursor.text.charCodeAt(this.cursor.pos - 1) : outLast;
      const held = last >= 0xd8_00 && last <= 0xdb_ff;
      this.partial = held ? partial.slice(0, -1) : partial;
      if (limited) this.partial = ownText(this.partial);
      // A held surrogate is one source character when written literally, six when it is the escape
      // just decoded: when this call read past the last escape (`chunk < pos`) the surrogate is the
      // last literal character, otherwise it came from the escape that ended at `chunk`.
      const heldUnits = chunk < this.cursor.pos ? 1 : 6;
      this.partialEnd = this.cursor.pos + this.cursor.base - (held ? heldUnits : 0);
      this.partialStart = start - 1 + this.cursor.base;
      if (limited) {
        // Unread input is not an unfinished token; keeping that suffix would retain the whole chunk.
        this.cut =
          state === ST_KEY
            ? cutOf("between", build.ancestors(), keyText(quote, partial))
            : cutOf(
                "string",
                build.path(),
                held ? this.cursor.text.slice(this.cursor.pos - heldUnits, this.cursor.pos) : "",
              );
        build.charge(build.retainedRoom + 1, this.cursor.pos + this.cursor.base);
      }
      this.deliveryPaused = end < this.cursor.length && this.cursor.pos >= end;
      this.cursor.pos = this.resume === undefined ? start - 1 : this.resume.next - this.cursor.base;
      return "";
    }
    if (ambiguity !== undefined) return resolveMismatch();
    source?.end(this.cursor.pos + this.cursor.base, undefined);
    if (charged !== 0) build.charge(-charged, start);
    this.lenient("unclosed-string", start - 1, resume?.openMark);
    if (badEscape) this.lenient("invalid-escape", start - 1, resume?.openMark);
    // An apostrophe that never closes is the only mark of a root like `'tis the season`, and prose
    // writes apostrophes, so the root holds no more JSON evidence than a lone word and takes that
    // word's switch: refused with its text kept unless the caller turned it on (P2 before P5).
    if (quote === APOSTROPHE && depth === 0 && state !== ST_KEY)
      this.lenient("unquoted-root-string", start - 1, resume?.openMark);
    // The one place a cut string value is made, so the caller's `cutSuffix` added here reaches the
    // value, a match, the last fragment piece (this is that tail) and the repaired literal alike.
    // Never on a key: a key is no value, and a cut key names no member.
    const suffix = state === ST_KEY ? "" : this.opts.cutSuffix;
    const value = retain
      ? out + this.cursor.window.retainedSlice(chunk, this.cursor.pos) + suffix
      : "";
    if (build.editsEnabled && this.opts.recover["unclosed-string"]) {
      if (dirty && quote !== APOSTROPHE)
        this.edit(start - 1, this.cursor.pos, JSON.stringify(value));
      else if (quote !== APOSTROPHE)
        this.edit(this.cursor.pos, this.cursor.pos, `${JSON.stringify(suffix).slice(1, -1)}"`);
    }
    // A key the end cut names no member, so the source stopped between items and the key read so far
    // is the unfinished token (`keyText`). A value keeps every character it has; only a half escape
    // is left over for the cut's text, after the key's own characters too.
    const half = escapeAt < 0 ? "" : this.cursor.text.slice(escapeAt);
    if (state === ST_KEY)
      this.cut = cutOf("between", build.ancestors(), keyText(quote, value) + half);
    else this.cutValue("string", build.path(), half);
    this.resume = undefined;
    return value;
  }

  // Recognition may become a word; conversion and policy must wait for the follower.
  protected scanNumber(depth: number, pieces?: NumberDrain): number {
    const before = this.cursor.pos;
    const token = this.cursor.window.numberToken(
      this.cursor.pos,
      this.cursor.atEnd,
      depth > 0,
      this.diagnostics.build.retainedRoom + this.chargedToken,
      pieces,
    );
    this.cursor.pos = this.cursor.window.cursor;
    this.chargeToken(token === TOKEN_WAIT);
    if (token === TOKEN_WAIT) {
      this.cursor.needMore = true;
      // A split sign/radix prefix needs more input; only a full delivery batch may resume now.
      this.deliveryPaused =
        pieces !== undefined &&
        this.cursor.pos >= before + 4096 &&
        this.cursor.pos < this.cursor.length;
    }
    return token;
  }

  /**
   * Keep ordinary fractions as doubles; preserve other numbers exactly when a double would change
   * their value, and every number in exact mode. Invalid tokens remain source text, never a guess.
   * Policy-permitted dialect repairs and exact values share one JSON spelling. Normalize radix
   * integers with BigInt so values above 2^53 cannot lose digits before either consumer sees them.
   */
  protected readNumber(
    depth: number,
    state: number,
    token: number,
  ): number | string | ExactNumber | typeof SOURCE_VALUE {
    const raw = this.cursor.window.numberRaw;
    const start = this.relative(this.cursor.window.numberStart);
    // A token that is no number stays its source text (P1). At the root that text is the whole value,
    // an unquoted string with no JSON evidence, so it takes the same verdict a lone word does.
    if (numberKind(this.cursor.window, this.diagnostics, this.opts, depth, token) === "string") {
      const cut =
        depth > 0 && state !== ST_KEY && this.endsInput(this.cursor.window.numberStart, raw);
      return this.unquotedString(raw, start, this.cursor.pos, cut);
    }
    // Selection can discard this leaf only after syntax and policy settle; keys, root evidence
    // and repair edits still retain it. No caller can use its conversion or owned digits otherwise.
    if (!this.retainsScalar(state, depth)) return 0;
    const negative = (token & NUMBER_MINUS) !== 0;
    const positive = (token & NUMBER_PLUS) !== 0;
    const digitsAt = negative || positive ? 1 : 0;
    const radix = (token & (NUMBER_HEX | NUMBER_BINARY | NUMBER_OCTAL)) !== 0;
    // The window admits `_` only between two digits where JavaScript and Python both allow it, so
    // dropping every one leaves the number the source wrote. Neither `Number` nor `BigInt` accepts it.
    const plain = token & NUMBER_SEPARATED ? raw.replaceAll("_", "") : raw;
    // The scanner and guards below establish canonical integer syntax. Beyond 309 digits,
    // ordinary mode must keep it exact too; conversion and another digit scan add no evidence.
    if (
      (this.opts.exactNumbers || raw.length - digitsAt > MAX_FINITE_INT_DIGITS) &&
      (token & TOKEN_STATUS) === TOKEN_INTEGER &&
      plain === raw &&
      !positive &&
      // An integer-shaped scan can contain only its sign; exact mode must not bypass validation.
      raw.length > digitsAt &&
      (raw.charCodeAt(digitsAt) !== ZERO || raw.length === digitsAt + 1)
    ) {
      return new ExactNumber(this.cursor.window.retainedText(raw));
    }
    // Exact output never uses the double; the scanner has already settled syntax and policy.
    // Skip the redundant native conversion, which cannot yield during a large token.
    let value = radix || this.opts.exactNumbers ? 0 : Number(plain);
    let text: string;
    if (radix) {
      // `BigInt` reads the `0x`/`0b`/`0o` prefix itself, in either case, and the window admitted only
      // digits of that radix after it, so this cannot throw.
      const magnitude = BigInt(plain.slice(digitsAt));
      text = negative ? `-${magnitude}` : String(magnitude);
      if (!this.opts.exactNumbers) value = Number(text);
    } else {
      text = jsonSpelling(plain);
    }
    if (text !== raw) this.edit(start, this.cursor.pos, text);
    return this.opts.exactNumbers || needsExact(text, value)
      ? new ExactNumber(this.cursor.window.retainedText(text))
      : value;
  }

  private decodeWord(
    word: string,
    depth: number,
    cut: boolean,
  ): Exclude<WordValue, typeof WORD_TEXT> {
    const value = wordValue(this.cursor.window, this.diagnostics, this.opts, word, depth);
    if (value !== WORD_TEXT) return value;
    const start = this.relative(this.cursor.window.wordStart);
    return this.unquotedString(word, start, start + word.length, cut);
  }
}
