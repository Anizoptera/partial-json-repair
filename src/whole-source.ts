// SPDX-License-Identifier: Apache-2.0

/** Decode whole-input sources and retain the original byte positions needed by recovery. */
import { DerivedBytePositions } from "./byte-positions";
import { utf16At } from "./positions";
import type { Scanner } from "./scan-contract";
import { byteLength, byteSlice, describeInput, isBytes } from "./transport";
import type { Input, ParseFailure } from "./types";
import { Utf8Decoder } from "./utf8";
import type { DecodedBytes, DeclaredEncoding } from "./utf8";

export type WholeInputSource = {
  readonly text: string;
  readonly malformed: readonly number[];
  readonly positionAt: Scanner["positionAt"];
  // Own this slot even for text, so inherited cleanup hooks cannot run.
  readonly releasePositions: (() => void) | undefined;
  readonly failure?: Extract<ParseFailure, { kind: "invalid-input" }>;
};

type WholeInputSourceFailure = Extract<
  ParseFailure,
  { kind: "invalid-input" | "unsupported-encoding" }
>;

type WholeInputSourceResult = WholeInputSource | WholeInputSourceFailure;

type BytePiece = Pick<DecodedBytes, "start" | "text" | "malformed">;
type ByteReadFailure = DeclaredEncoding | Extract<ParseFailure, { kind: "invalid-input" }>;
type WholeByteSource = Pick<WholeInputSource, "positionAt" | "releasePositions"> & {
  readonly text: undefined;
  readonly next: (units: number) => BytePiece | ByteReadFailure | undefined;
  readonly context: (from: number, until: number) => string;
};
export type WholeInputScanSource = WholeInputSource | WholeByteSource;

type ByteSource = {
  readonly input: Uint8Array;
  readonly decoder: Utf8Decoder;
  readonly positions: DerivedBytePositions;
  readonly length: number;
  from: number;
};

const byteSource = (input: Uint8Array): ByteSource => ({
  input,
  decoder: new Utf8Decoder(true, true),
  positions: new DerivedBytePositions(),
  length: byteLength(input),
  from: 0,
});

const createPositionRelease = (positions: DerivedBytePositions) => () => {
  // Capture only the map, not the decoder's caller input; discard its backing array too.
  positions.release();
};

// Eager materialization and incremental scanning must use identical decoding and position updates.
const readBytes = (
  source: ByteSource,
  units: number,
): DecodedBytes | ByteReadFailure | undefined => {
  if (source.from >= source.length) return undefined;
  // A yielded borrower can lose storage; growth never extends the window supplied to this call.
  if (byteLength(source.input) < source.length)
    return { kind: "invalid-input", received: "object" };
  const end = Math.min(source.length, source.from + units);
  const decoded = source.decoder.decode(
    byteSlice(source.input, source.from, end),
    undefined,
    end === source.length,
    source.from,
  );
  source.from += units;
  if (!("unsupported" in decoded))
    for (const run of decoded.runs)
      source.positions.anchor(decoded.start + run.start, run.byte, run.width);
  return decoded;
};

/** Decode one source through the same resumable operation used by cooperative calls. */
export function* wholeInputSourceSteps(
  input: Input,
  units: number,
): Generator<void, WholeInputSourceResult> {
  if (typeof input === "string")
    return { text: input, malformed: [], positionAt: utf16At, releasePositions: undefined };
  if (!isBytes(input)) return { kind: "invalid-input", received: describeInput(input) };
  if (!Number.isSafeInteger(units) || units < 1) throw new RangeError("units must be positive");
  const bytes = byteSource(input);
  const text: string[] = [];
  const malformed: number[] = [];
  let failure: Extract<ParseFailure, { kind: "invalid-input" }> | undefined;
  while (true) {
    const decoded = readBytes(bytes, units);
    if (decoded === undefined) break;
    if ("kind" in decoded) {
      failure = decoded;
      break;
    }
    if ("unsupported" in decoded)
      return { kind: "unsupported-encoding", encoding: decoded.unsupported };
    for (const at of decoded.malformed) malformed.push(decoded.start + at);
    text.push(decoded.text);
    if (bytes.from < bytes.length) yield;
  }
  const joined = text.join("");
  // Byte positions are derived from the decoded text this call keeps anyway.
  bytes.positions.read = (from, until) => joined.slice(from, until);
  const source = {
    text: joined,
    malformed,
    positionAt: bytes.positions.positionAt,
    releasePositions: createPositionRelease(bytes.positions),
  };
  // Keep the final decode and assembly separate from scanner construction after a large byte input.
  if (bytes.length > units) yield;
  return failure === undefined ? source : { ...source, failure };
}

export const wholeInputSource = (input: Input): WholeInputSourceResult => {
  if (typeof input === "string")
    return { text: input, malformed: [], positionAt: utf16At, releasePositions: undefined };
  if (!isBytes(input)) return { kind: "invalid-input", received: describeInput(input) };
  // One decoder result serves a synchronous call; cooperative accumulation stays removable.
  const bytes = byteSource(input);
  const decoded = readBytes(bytes, bytes.length);
  if (decoded !== undefined && "kind" in decoded) return decoded;
  if (decoded !== undefined && "unsupported" in decoded)
    return { kind: "unsupported-encoding", encoding: decoded.unsupported };
  const text = decoded?.text ?? "";
  bytes.positions.read = (from, until) => text.slice(from, until);
  return {
    text,
    malformed: decoded?.malformed ?? [],
    positionAt: bytes.positions.positionAt,
    releasePositions: createPositionRelease(bytes.positions),
  };
};

export const wholeInputScanSource = (
  input: Input,
  units: number,
): WholeInputScanSource | WholeInputSourceFailure => {
  // Context can look behind the scan; retain decoded text without reading an unrelated suffix.
  if (typeof input === "string") return wholeInputSource(input);
  if (!isBytes(input)) return { kind: "invalid-input", received: describeInput(input) };
  if (byteLength(input) <= units) return wholeInputSource(input);
  const bytes = byteSource(input);
  const pieces: Pick<BytePiece, "start" | "text">[] = [];
  const pending: DecodedBytes[] = [];
  let decodedEnd = 0;
  let refused: ByteReadFailure | undefined;
  const readPiece = (size: number): BytePiece | ByteReadFailure | undefined => {
    if (refused !== undefined) return refused;
    const decoded = readBytes(bytes, size);
    if (decoded === undefined) return undefined;
    if ("kind" in decoded) return (refused = decoded);
    if ("unsupported" in decoded) return (refused = decoded);
    // Context needs text only; release malformed offsets and decoder runs after delivery.
    pieces.push({ start: decoded.start, text: decoded.text });
    pending.push(decoded);
    decodedEnd = decoded.start + decoded.text.length;
    return decoded;
  };
  const scan: WholeByteSource = {
    text: undefined,
    positionAt: bytes.positions.positionAt,
    releasePositions: createPositionRelease(bytes.positions),
    next(size) {
      if (pending.length === 0) {
        const piece = readPiece(size);
        if (piece === undefined || "unsupported" in piece || "kind" in piece) return piece;
      }
      return pending.shift();
    },
    context(from, until) {
      // A diagnostic may need text beyond the scan window, but only its bounded context.
      while (true) {
        if (decodedEnd >= until) break;
        const piece = readPiece(Math.max(1, (until - decodedEnd) * 4));
        if (piece === undefined || "unsupported" in piece || "kind" in piece) break;
      }
      let low = 0;
      let high = pieces.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >>> 1;
        if ((pieces[mid] as { readonly start: number }).start <= from) low = mid;
        else high = mid - 1;
      }
      let context = "";
      for (let index = low; index < pieces.length; index++) {
        const piece = pieces[index] as Pick<BytePiece, "start" | "text">;
        if (piece.start >= until) break;
        context += piece.text.slice(Math.max(0, from - piece.start), until - piece.start);
      }
      return context;
    },
  };
  // Every decoded piece stays for diagnostic context, so positions read their text from it too.
  bytes.positions.read = (from, until) => scan.context(from, until);
  return scan;
};
