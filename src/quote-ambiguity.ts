// SPDX-License-Identifier: Apache-2.0

import type { LexicalWindow, SourceMark } from "./lexical-window";
import type { ResolvedOptions } from "./options";
import type { ParseError } from "./types";
import type { Builder } from "./builder";
import {
  APOSTROPHE,
  BACKSLASH,
  CLOSE_BRACE,
  CLOSE_BRACKET,
  COLON,
  COMMA,
  CR,
  IS_WS,
  LF,
  OPEN_BRACE,
  QUOTE,
  SLASH,
  SPACE,
  STAR,
  ST_KEY,
  TAB,
  endsScalar,
} from "./chars";
import { errorAt } from "./lexical-window";

export const QUOTE_WAIT = 0;
const QUOTE_FITS = 1;
export const QUOTE_MISMATCH = 2;
type QuoteVerdict = typeof QUOTE_WAIT | typeof QUOTE_FITS | typeof QUOTE_MISMATCH;

export const LINE_WAIT = 0;
export const LINE_STRUCTURE = 1;
export const LINE_TEXT = 2;
/**
 * Structure that opens with a quote of the string's own kind: a key and its colon (`"b":`), or a
 * comma and then such a quote (`, "b"`). The literal reading would close the string at that quote
 * and then read the word after it as a new member, inventing a key and value the input never had;
 * ending the string at the break is the only reading that keeps the line's structure.
 */
export const LINE_QUOTED = 3;
/**
 * Only closers (and whitespace) after the break, up to the end of input: `"cut⏎ }` ends a truncated
 * record, but `"f() {⏎}` is cut code. The reader decides with the string's own bracket balance,
 * which only it tracks: the closer ends the string unless the string opened what it closes.
 */
export const LINE_CLOSING = 4;

// Phases of the line probe below; its state survives between feeds in a `LineProbe`.
const AFTER_BREAK = 0;
const IN_KEY = 1;
const IN_WORD = 2;
const BEFORE_COLON = 3;
const SLASH_SEEN = 4;
const IN_LINE_COMMENT = 5;
const IN_BLOCK_COMMENT = 6;
const BLOCK_STAR_SEEN = 7;
const AFTER_COMMA = 8;
const CLOSERS = 9;
// Phases of the one-line probe (`runFollower`): closers, then a comma, then an optional `{`.
export const RUN_CLOSERS = 10;
const RUN_COMMA = 11;
const RUN_OPEN = 12;

/**
 * A line probe in progress: the break it judges, how far it has read and in which phase, and the
 * open key quote. Absolute offsets, so it survives window compaction between feeds.
 */
export type LineProbe = { at: number; next: number; phase: number; quote: number };

/**
 * Whether the text after a raw line break inside a string is structure: a closer or comma, or a key
 * (quoted on one line, or a bare word) and its colon, after any blank lines and comments. Only then
 * can the string end there; anything else is the string's own next line. `LINE_QUOTED` separates
 * the structure that `missing-quote` ends the string at by default from the rest, which only the
 * opt-in `guessed-string-end` ends it at (`closer` is the string's quote kind).
 *
 * It waits rather than guesses while that text is still arriving, so a stream holds the break unread
 * until the line shows which it is. The wait resumes where it stopped, never from the break: a
 * restart re-read the pending line on every feed, quadratic in its length for small chunks.
 */
export const lineFollower = (
  text: string,
  base: number,
  probe: LineProbe,
  final: boolean,
  closer: number,
): number => {
  let at = probe.next - base;
  let phase = probe.phase;
  for (; at < text.length; at++) {
    const c = text.charCodeAt(at);
    switch (phase) {
      case AFTER_BREAK:
        if (c < 128 && IS_WS[c] === 1) continue;
        // Closers wait for the end of input: only then is the rest of the line known to be structure.
        if (c === CLOSE_BRACE || c === CLOSE_BRACKET) phase = CLOSERS;
        else if (c === COMMA) phase = AFTER_COMMA;
        else if (c === SLASH) phase = SLASH_SEEN;
        else if (c === QUOTE || c === APOSTROPHE) {
          phase = IN_KEY;
          probe.quote = c;
        } else if (endsScalar(c)) return LINE_TEXT;
        else phase = IN_WORD;
        continue;
      case IN_KEY:
        // Stop on a backslash whose escaped unit has not arrived, so the resume reads the pair.
        if (c === BACKSLASH) {
          if (at + 1 === text.length) break;
          at++;
        } else if (c === LF || c === CR) return LINE_TEXT;
        else if (c === probe.quote) phase = BEFORE_COLON;
        continue;
      case IN_WORD:
        if (!endsScalar(c)) continue;
        // The character that ended the word may already be the colon.
        if (c === COLON) return LINE_STRUCTURE;
        if (c !== SPACE && c !== TAB) return LINE_TEXT;
        phase = BEFORE_COLON;
        continue;
      case BEFORE_COLON:
        if (c === SPACE || c === TAB) continue;
        if (c !== COLON) return LINE_TEXT;
        // A bare-word key leaves `quote` at the reset value, which no closer equals.
        return probe.quote === closer ? LINE_QUOTED : LINE_STRUCTURE;
      case AFTER_COMMA:
        if (c < 128 && IS_WS[c] === 1) continue;
        return c === closer ? LINE_QUOTED : LINE_STRUCTURE;
      case CLOSERS:
        if ((c < 128 && IS_WS[c] === 1) || c === CLOSE_BRACE || c === CLOSE_BRACKET) continue;
        return LINE_STRUCTURE;
      // Without a break nothing else marks the string as unfinished, so only a quote of its own
      // kind opening a key with its colon counts (`IN_KEY` stops at a line break).
      case RUN_CLOSERS:
        if (c === SPACE || c === TAB || c === CLOSE_BRACE || c === CLOSE_BRACKET) continue;
        if (c !== COMMA) return LINE_TEXT;
        phase = RUN_COMMA;
        continue;
      case RUN_COMMA:
      case RUN_OPEN:
        if (c === SPACE || c === TAB) continue;
        if (c === OPEN_BRACE && phase === RUN_COMMA) phase = RUN_OPEN;
        else if (c === closer) {
          phase = IN_KEY;
          probe.quote = c;
        } else return LINE_TEXT;
        continue;
      // Comments are trivia between members, so a member may follow them.
      case SLASH_SEEN:
        if (c === SLASH) phase = IN_LINE_COMMENT;
        else if (c === STAR) phase = IN_BLOCK_COMMENT;
        else return LINE_TEXT;
        continue;
      case IN_LINE_COMMENT:
        if (c === LF || c === CR) phase = AFTER_BREAK;
        continue;
      case IN_BLOCK_COMMENT:
        if (c === STAR) phase = BLOCK_STAR_SEEN;
        continue;
      default:
        if (c === SLASH) phase = AFTER_BREAK;
        else if (c !== STAR) phase = IN_BLOCK_COMMENT;
        continue;
    }
    break;
  }
  // A comma already made the line structure; only the quote that might follow it was unknown.
  if (final)
    return phase === CLOSERS ? LINE_CLOSING : phase === AFTER_COMMA ? LINE_STRUCTURE : LINE_TEXT;
  probe.next = base + at;
  probe.phase = phase;
  return LINE_WAIT;
};

/**
 * Owns the undecidable suffix of a string whose end is in doubt, up to its first true closer: after
 * an apparent mismatched quote, or from a raw line break that structure follows (`missing-quote`).
 * Both settle the same way, by the closer's follower or the end of input, so one owner holds,
 * replays and delivers either; they differ only in whether the doubtful character joins the string
 * (`end`).
 */
export class QuoteAmbiguity {
  // Source delivery reads this existing carry; it must not retain another copy of the suffix.
  readonly parts: string[] = [];
  private readonly replayMark: SourceMark;
  private next: number;
  private lookahead: number | undefined;

  constructor(
    source: LexicalWindow,
    readonly at: number,
    readonly prefix: string,
    private readonly dirty: boolean,
    private readonly badEscape: boolean,
    private readonly openMark: SourceMark,
    /**
     * Set for a line break, which ends the string before itself and is replayed as structure, and
     * names the repair reported; unset for a quote, which is consumed.
     */
    private readonly line?: "missing-quote" | "guessed-string-end",
  ) {
    this.next = line === undefined ? at + 1 : at;
    this.replayMark = source.mark(this.next - source.base);
  }

  capture(source: LexicalWindow): void {
    const from = this.next - source.base;
    if (from < source.length) this.parts.push(source.text.slice(from));
    this.next = source.base + source.length;
  }

  releasedBefore(base: number): number {
    // Replay owns this raw source after compaction; overlap with the live window is counted there.
    return Math.max(0, Math.min(this.next, base) - this.replayMark.at);
  }

  probe(
    source: LexicalWindow,
    at: number,
    state: number,
    nested: boolean,
    final: boolean,
  ): QuoteVerdict {
    // A waiting probe resumes at the same closer; absolute offsets survive window compaction.
    let next = this.lookahead === undefined ? at + 1 : this.lookahead - source.base;
    // Window text stays fixed during a probe; one read classifies whitespace and its final follower.
    let follower = source.text.charCodeAt(next);
    while (next < source.length && follower < 128 && IS_WS[follower] === 1)
      follower = source.text.charCodeAt(++next);
    if (next >= source.length && !final) {
      this.lookahead = source.base + next;
      return QUOTE_WAIT;
    }
    this.lookahead = undefined;
    const fits =
      state === ST_KEY
        ? follower === COLON
        : next === source.length ||
          follower === COMMA ||
          (nested && (follower === CLOSE_BRACE || follower === CLOSE_BRACKET));
    return fits ? QUOTE_FITS : QUOTE_MISMATCH;
  }

  private replay(source: LexicalWindow): number {
    this.capture(source);
    return source.replayAmbiguousQuote(this.parts.join(""), this.replayMark);
  }

  /**
   * Settles the mismatch and answers the buffer offset the scan resumes at. Not always zero: the
   * replay keeps the bytes before the mark wherever the window still holds them.
   */
  /** Where the string's source ends when the doubtful character turns out to end it. */
  get end(): number {
    return this.line === undefined ? this.at + 1 : this.at;
  }

  resolve(
    source: LexicalWindow,
    build: Builder,
    opts: ResolvedOptions,
    recordError: (error: Omit<ParseError, "path" | "valueIndex">) => void,
  ): number {
    // `guessed-string-end` exists only when on; `missing-quote` is refused when off, never skipped.
    if (this.line !== undefined) {
      if (opts.recover[this.line]) build.repair(this.line, this.openMark.at);
      else recordError(errorAt("unparsable-span", this.openMark, source.positionAt, this.line));
    } else if (opts.recover["quote-mismatch"]) build.repair("quote-mismatch", this.openMark.at);
    else
      recordError(errorAt("unparsable-span", this.openMark, source.positionAt, "quote-mismatch"));
    if (this.badEscape) {
      if (opts.recover["invalid-escape"]) build.repair("invalid-escape", this.openMark.at);
      else
        recordError(errorAt("unparsable-span", this.openMark, source.positionAt, "invalid-escape"));
    } else if (this.dirty && !opts.repairBroken) {
      recordError(errorAt("unparsable-span", this.openMark, source.positionAt));
    }
    build.edit(this.openMark.at, this.end, JSON.stringify(this.prefix));
    return this.replay(source);
  }
}

export type StringResume = {
  /** Opening location survives release of the source prefix, including its line breaks. */
  openMark: SourceMark;
  next: number;
  quote: number;
  text: string;
  /** Unselected stream values still recognize escapes and quotes, but keep no decoded content. */
  retain: boolean;
  /**
   * `text`'s last code unit, kept because reading it from `text` would copy the whole string: a
   * banked prefix grows by concatenation, which engines keep as a rope until a character is read.
   */
  last: number;
  dirty: boolean;
  badEscape: boolean;
  /** Raw `{[` the string's text left open at `next` (see `LINE_CLOSING`); released text keeps it. */
  nest: number;
  ambiguity: QuoteAmbiguity | undefined;
};
