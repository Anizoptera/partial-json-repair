// SPDX-License-Identifier: Apache-2.0

/**
 * Incremental UTF-8 decoding that keeps two things a `TextDecoder` throws away: where each
 * replacement character's malformed bytes were, and which chunk and byte every decoded unit came
 * from — so a report can point at the original bytes even when a character straddled two chunks.
 */

import { byteLength, byteSlice } from "./transport";

type DecodedRun = Readonly<{
  /** UTF-16 offset within `text` where the run begins. */
  start: number;
  chunk: number | undefined;
  /** Byte offset of `start` within its chunk. */
  byte: number;
  /** Bytes per UTF-16 code unit across the run. */
  width: number;
}>;

export type DecodedBytes = Readonly<{
  /** UTF-16 offset in the complete decoded stream represented by `text[0]`. */
  start: number;
  text: string;
  /** UTF-16 offsets within `text` where malformed input produced U+FFFD. */
  malformed: readonly number[];
  runs: readonly DecodedRun[];
}>;

type UnsupportedEncoding = "utf-16be" | "utf-16le" | "utf-32be" | "utf-32le";

/** A leading byte-order mark that declares an encoding this package does not decode. */
export type DeclaredEncoding = Readonly<{ unsupported: UnsupportedEncoding }>;

const REPLACEMENT = 0xfffd;
const CONTINUATION_MIN = 0x80;
const CONTINUATION_MAX = 0xbf;
const BATCH = 4096;

/**
 * The longest mark first: `FF FE 00 00` is UTF-32LE, and reading it as UTF-16LE plus two NULs would
 * name the wrong encoding. Only a first byte no UTF-8 text can begin with starts the probe, so
 * ordinary input never waits on it.
 */
const bomOf = (b: readonly number[]): UnsupportedEncoding | undefined => {
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0xfe && b[3] === 0xff) return "utf-32be";
  if (b[0] === 0xff && b[1] === 0xfe && b[2] === 0x00 && b[3] === 0x00) return "utf-32le";
  if (b[0] === 0xfe && b[1] === 0xff) return "utf-16be";
  if (b[0] === 0xff && b[1] === 0xfe) return "utf-16le";
  return undefined;
};

/** Whether a first byte could open a UTF-16 or UTF-32 mark; none of these opens valid UTF-8. */
const mayOpenMark = (byte: number): boolean => byte === 0x00 || byte === 0xfe || byte === 0xff;

/**
 * The platform decoder, for the well-formed body of a chunk. A replacement it chose would carry no
 * offset, and the offsets are what this module exists for, so any text holding U+FFFD is refused and
 * the chunk takes the byte-by-byte path below. Error mode changes output only where it replaces, so
 * text without U+FFFD is exactly what `fatal: true` returns; a literal U+FFFD in the source merely
 * takes the slower path. Not `fatal: true`: its throw cost 4.6-5.3 µs per malformed chunk on Bun 1.4.2 and
 * Node 24 (M4 Max), 7-16x the byte path, and an exception is not control flow here.
 * `ignoreBOM` because by default it strips a leading `EF BB BF`, which the scanner must see to
 * report `bom-removed`. Created on first use: a stateless one-shot decode, so one serves every call,
 * and an app that never passes bytes never builds it. U+FFFD is built at use, never a
 * literal: a bundle read as Latin-1 (Bun, for one that starts `// @bun`) splits a literal into three
 * characters, and the check below would then accept every replacement unplaced.
 */
let native: TextDecoder | undefined;
const decodeNative = (bytes: Uint8Array): string | undefined => {
  native ??= new TextDecoder("utf-8", { ignoreBOM: true });
  const text = native.decode(bytes);
  return text.includes(String.fromCharCode(REPLACEMENT)) ? undefined : text;
};

/** UTF-8 bytes per UTF-16 unit: 1-3 below the surrogates, 2 per half of an astral pair's 4. */
export const widthOf = (unit: number): number =>
  unit < 0x80 ? 1 : unit < 0x800 ? 2 : unit >= 0xd800 && unit <= 0xdfff ? 2 : 3;

/**
 * Where the chunk's complete sequences end: before a lead byte whose sequence the chunk cuts off.
 * Only the last three bytes can belong to one, so only they are read; anything malformed there is
 * left to the byte path, which places it exactly.
 */
const completeEnd = (bytes: Uint8Array, from: number): number => {
  const length = byteLength(bytes);
  for (let i = length - 1; i >= Math.max(from, length - 3); i--) {
    const byte = bytes[i] as number;
    if (byte < CONTINUATION_MIN) return length;
    if (byte > CONTINUATION_MAX) {
      const needs = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      return length - i >= needs ? length : i;
    }
  }
  return length;
};

export class Utf8Decoder {
  /**
   * `native` false keeps every byte on the state machine below: the reference the native path is
   * tested against, since both must give the same text, malformed offsets and runs.
   */
  constructor(
    private readonly useNative = true,
    /**
     * Record a run only where the text cannot predict the bytes: the first unit, a jump in source
     * (a new chunk, a slice), and a unit whose width is not `widthOf` it (a replacement for a
     * malformed sequence). A caller that keeps the decoded text derives every other position from
     * it (`DerivedBytePositions`); one run per width change kept about ten times the input for
     * text that alternates scripts, such as Cyrillic words between ASCII spaces.
     */
    private readonly derived = false,
  ) {}

  /** Derived mode: where the next unit's bytes start if the text predicts them. */
  private expectChunk: number | undefined;
  private expectByte = -1;

  private needed = 0;
  private seen = 0;
  private codePoint = 0;
  private lower = CONTINUATION_MIN;
  private upper = CONTINUATION_MAX;
  /** UTF-16 offset in the complete decoded stream of the next unit. */
  private offset = 0;
  /** Where the sequence in progress began, so a character split across chunks is placed at its lead byte. */
  private leadChunk: number | undefined;
  private leadByte = 0;
  /**
   * Bytes held back at the very start until a byte-order mark can be ruled in or out — with their
   * provenance, since they are decoded like any others once it is ruled out. `undefined` once the
   * question is settled.
   */
  private held: { byte: number; chunk: number | undefined; at: number }[] | undefined = [];

  /**
   * Decodes one chunk. `chunk` is its ordinal in the stream, or `undefined` for one-shot input;
   * `end` flushes an incomplete sequence as malformed.
   */
  decode(
    bytes: Uint8Array,
    chunk: number | undefined,
    end = false,
    sourceOffset = 0,
  ): DecodedBytes | DeclaredEncoding {
    const start = this.offset;
    const length = byteLength(bytes);
    const parts: string[] = [];
    const units: number[] = [];
    const malformed: number[] = [];
    const runs: DecodedRun[] = [];
    const flush = (): void => {
      if (units.length === 0) return;
      parts.push(String.fromCharCode(...units));
      units.length = 0;
    };
    const run = (fromChunk: number | undefined, fromByte: number, width: number): void => {
      const at = this.offset - start;
      const last = runs[runs.length - 1];
      if (
        last !== undefined &&
        last.chunk === fromChunk &&
        last.width === width &&
        fromByte === last.byte + (at - last.start) * width
      ) {
        return;
      }
      runs.push({ start: at, chunk: fromChunk, byte: fromByte, width });
    };
    // Derived mode's `run`: `regular` is the width the text implies, `consumed` the bytes taken.
    const mark = (
      fromChunk: number | undefined,
      fromByte: number,
      width: number,
      regular: number,
      consumed: number,
    ): void => {
      if (fromChunk !== this.expectChunk || fromByte !== this.expectByte || width !== regular)
        runs.push({ start: this.offset - start, chunk: fromChunk, byte: fromByte, width });
      this.expectChunk = fromChunk;
      this.expectByte = fromByte + consumed;
    };
    const emit = (
      codePoint: number,
      fromChunk: number | undefined,
      fromByte: number,
      width: number,
    ): void => {
      if (codePoint <= 0xffff) {
        if (this.derived) mark(fromChunk, fromByte, width, widthOf(codePoint), width);
        else run(fromChunk, fromByte, width);
        units.push(codePoint);
        this.offset++;
      } else {
        if (this.derived) mark(fromChunk, fromByte, 2, 2, 4);
        else run(fromChunk, fromByte, 2);
        const scalar = codePoint - 0x10000;
        units.push(0xd800 + (scalar >> 10), 0xdc00 + (scalar & 0x3ff));
        this.offset += 2;
      }
      if (units.length >= BATCH) flush();
    };
    const reset = (): void => {
      this.needed = 0;
      this.seen = 0;
      this.codePoint = 0;
      this.lower = CONTINUATION_MIN;
      this.upper = CONTINUATION_MAX;
    };
    /** One replacement for the maximal subpart consumed so far, placed at its first byte. */
    const reject = (fromChunk: number | undefined, fromByte: number, width: number): void => {
      malformed.push(this.offset - start);
      emit(REPLACEMENT, fromChunk, fromByte, width);
      reset();
    };
    const step = (byte: number, fromChunk: number | undefined, at: number): void => {
      if (this.needed === 0) {
        if (byte <= 0x7f) {
          emit(byte, fromChunk, at, 1);
          return;
        }
        if (byte >= 0xc2 && byte <= 0xdf) {
          this.needed = 1;
          this.codePoint = byte & 0x1f;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          this.needed = 2;
          this.codePoint = byte & 0x0f;
          if (byte === 0xe0) this.lower = 0xa0;
          else if (byte === 0xed) this.upper = 0x9f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          this.needed = 3;
          this.codePoint = byte & 0x07;
          if (byte === 0xf0) this.lower = 0x90;
          else if (byte === 0xf4) this.upper = 0x8f;
        } else {
          reject(fromChunk, at, 1);
          return;
        }
        this.leadChunk = fromChunk;
        this.leadByte = at;
        return;
      }
      if (byte < this.lower || byte > this.upper) {
        // The Encoding Standard's rule: replace the bytes so far and read this byte afresh.
        reject(this.leadChunk, this.leadByte, this.seen + 1);
        step(byte, fromChunk, at);
        return;
      }
      this.lower = CONTINUATION_MIN;
      this.upper = CONTINUATION_MAX;
      this.codePoint = (this.codePoint << 6) | (byte & 0x3f);
      this.seen++;
      if (this.seen === this.needed) {
        emit(this.codePoint, this.leadChunk, this.leadByte, this.needed + 1);
        reset();
      }
    };

    let from = 0;
    if (this.held !== undefined) {
      // Still deciding whether the source opens with a mark. Nothing decodes until it is settled,
      // since a mark's bytes must never reach the text and a non-mark's must decode in order.
      let settled = end;
      while (from < length && this.held.length < 4) {
        const byte = bytes[from] as number;
        if (this.held.length === 0 && !mayOpenMark(byte)) {
          settled = true;
          break;
        }
        this.held.push({ byte, chunk, at: sourceOffset + from });
        from++;
      }
      if (this.held.length === 4) settled = true;
      if (!settled) {
        return Object.freeze({
          start,
          text: "",
          malformed: Object.freeze([]),
          runs: Object.freeze([]),
        });
      }
      const encoding = bomOf(this.held.map((h) => h.byte));
      if (encoding !== undefined) return Object.freeze({ unsupported: encoding });
      const replay = this.held;
      this.held = undefined;
      for (const h of replay) step(h.byte, h.chunk, h.at);
    }
    // A sequence an earlier chunk opened finishes on the byte path, which holds its state.
    while (this.needed !== 0 && from < length) {
      step(bytes[from] as number, chunk, sourceOffset + from);
      from++;
    }
    let body = from;
    if (this.useNative && this.needed === 0 && from < length) {
      // On a final chunk an incomplete tail is malformed, so the whole rest goes native and a
      // replacement sends it to the byte path; otherwise the tail waits there for its next chunk.
      const until = end ? length : completeEnd(bytes, from);
      const text = until > from ? decodeNative(byteSlice(bytes, from, until)) : undefined;
      if (text !== undefined) {
        flush();
        parts.push(text);
        let byte = sourceOffset + from;
        if (this.derived) {
          // The platform refused any replacement, so every unit has its regular width.
          const first = text.charCodeAt(0);
          mark(chunk, byte, widthOf(first), widthOf(first), until - from);
          this.offset += text.length;
        } else if (text.length === until - from) {
          // As many units as bytes: all ASCII, one run.
          run(chunk, byte, 1);
          this.offset += text.length;
        } else {
          // Width per unit from the unit itself, exactly as `emit` records them, one run per
          // stretch of equal widths: a run per unit is what made the byte path slow.
          for (let i = 0; i < text.length;) {
            const width = widthOf(text.charCodeAt(i));
            let j = i + 1;
            while (j < text.length && widthOf(text.charCodeAt(j)) === width) j++;
            run(chunk, byte, width);
            this.offset += j - i;
            byte += (j - i) * width;
            i = j;
          }
        }
        body = until;
      }
    }
    for (let i = body; i < length; i++) step(bytes[i] as number, chunk, sourceOffset + i);
    if (end && this.needed !== 0) reject(this.leadChunk, this.leadByte, this.seen + 1);
    flush();
    // The arrays are not frozen: each is read once, by the reader that asked for this chunk, and
    // JavaScriptCore freezes at ~0.13 µs per element, which was most of decoding non-ASCII text.
    return Object.freeze({ start, text: parts.join(""), malformed, runs });
  }

  /** Accounts for a caller-supplied text chunk after any pending byte sequence was flushed. */
  advance(text: string): void {
    this.offset += text.length;
  }

  /**
   * Nothing half-read and the byte-order-mark question settled: flushing now decodes no unit and
   * changes no state. A text stream checks this before each chunk, because the flush it would
   * otherwise make allocates and walks the whole decode setup on every feed for nothing.
   */
  get idle(): boolean {
    return this.needed === 0 && this.held === undefined;
  }

  /** UTF-16 offset in the complete decoded stream of whatever comes next. */
  get decoded(): number {
    return this.offset;
  }
}
