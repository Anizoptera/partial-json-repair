// SPDX-License-Identifier: Apache-2.0

import type { PositionAt } from "./positions";
import { LexicalWindow } from "./lexical-window";

/**
 * The scanner's sole owner of retained input and its position within that input. A stream appends
 * to it and drops its consumed prefix; a one-shot parse fills it once. One cursor serves both,
 * because a second scanner for streaming is the duplicate-mechanism defect this rewrite removed —
 * the extracted package re-parsed a buffer its parser had already read.
 */
export class ScanCursor {
  readonly window: LexicalWindow;
  pos = 0;
  /**
   * True only inside `end()`. It is the whole difference between "the string is unterminated" and
   * "the string has not finished arriving yet", and no reader can decide correctly without it.
   */
  atEnd = false;
  /** Set by a reader that ran out of input mid-token. The loop then rewinds and waits for more. */
  needMore = false;

  constructor(
    positionAt?: PositionAt,
    completeSource?: string | ((from: number, until: number) => string),
    scope: "whole" | "stream" = "whole",
  ) {
    this.window = new LexicalWindow(positionAt, completeSource, scope);
  }

  get text(): string {
    return this.window.text;
  }

  get base(): number {
    return this.window.base;
  }

  get length(): number {
    return this.window.length;
  }

  relative(absolute: number): number {
    return absolute - this.base;
  }

  append(chunk: string): void {
    this.window.append(chunk);
    this.needMore = false;
  }

  /*
   * Text not yet in the window, cut so that each piece ends with the replacement character for one
   * malformed byte sequence. A piece enters the window only once the previous one has been read,
   * which is what lets `invalid-utf8` carry the path the scan was in when it met the bytes — the
   * same rule for a stream chunk and for one-shot bytes, so neither reports it differently.
   */
  // Keep one record per supplied chunk, not one allocation per malformed byte sequence.
  private readonly chunks: (
    | { text: string; malformed: readonly number[]; from: number; next: number }
    | undefined
  )[] = [];
  private chunksHead = 0;
  /** Absolute offset of the replacement character ending the piece now in the window, if any. */
  private windowMalformedAt: number | undefined;

  /**
   * Adds a chunk; `malformedUtf8` lists the offsets in it holding a replacement character for
   * malformed bytes. Text enters the window in source order: a chunk arriving while pieces are still
   * queued waits behind them, whatever it holds — appending it at once would put it ahead of text
   * that came first.
   */
  supply(chunk: string, malformedUtf8: readonly number[]): void {
    const waiting = this.windowMalformedAt !== undefined || this.queued;
    if (!waiting && malformedUtf8.length === 0) {
      this.append(chunk);
      return;
    }
    this.chunks.push({ text: chunk, malformed: malformedUtf8, from: 0, next: 0 });
    if (!waiting) this.advance();
  }

  /** Whether text is waiting outside the window. */
  get queued(): boolean {
    return this.chunksHead < this.chunks.length;
  }

  /**
   * The window has been read: answers where its malformed character sat, if it held one. The caller
   * reports it before `advance` brings in the next piece, which is the point of pieces.
   */
  takeMalformed(): number | undefined {
    const at = this.windowMalformedAt;
    this.windowMalformedAt = undefined;
    return at;
  }

  /** Moves the next queued piece into the window; false when none is left. */
  advance(): boolean {
    const chunk = this.chunks[this.chunksHead];
    if (chunk === undefined) return false;
    const malformed = chunk.malformed[chunk.next++];
    const end = malformed === undefined ? chunk.text.length : malformed + 1;
    if (malformed !== undefined)
      this.windowMalformedAt = this.base + this.length + malformed - chunk.from;
    this.append(chunk.text.slice(chunk.from, end));
    chunk.from = end;
    if (end === chunk.text.length) {
      // Release consumed source immediately even when later chunks remain queued.
      this.chunks[this.chunksHead++] = undefined;
      if (this.chunksHead === this.chunks.length) {
        this.chunks.length = 0;
        this.chunksHead = 0;
      }
    }
    return true;
  }

  /** Whether only indentation precedes the retained input on its source line. */
  get baseAfterIndent(): boolean {
    return this.window.headAfterIndent;
  }

  /** Releases what was consumed; `pins` are absolute offsets an error may still name (`LexicalWindow.drop`). */
  drop(pins?: readonly (number | undefined)[]): void {
    this.window.drop(this.pos, pins);
    this.pos = 0;
  }

  clear(): void {
    this.window.clear();
    this.chunks.length = 0;
    this.chunksHead = 0;
    this.windowMalformedAt = undefined;
    this.pos = 0;
  }

  /** Resumes where a quote replay chose to re-read from, which is not always the buffer's head. */
  resumeAt(pos: number): void {
    this.pos = pos;
  }
}
