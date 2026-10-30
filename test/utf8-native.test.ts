// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * The native decoding path must not move a byte: `Utf8Decoder` hands a chunk's well-formed body to
 * the platform `TextDecoder` and keeps carried sequences, mark probes, cut-off tails and malformed
 * chunks on its own state machine. Positions in every report come from the runs and malformed
 * offsets it returns, so both paths must return the same text, the same malformed offsets and the
 * same runs, for every input and every way of cutting it into chunks. `new Utf8Decoder(false)` is
 * the state machine alone: the reference.
 *
 * The inputs are the corpus's byte cases and every text case encoded, plus seeded byte arrays built
 * from the constructs a decoder gets wrong: sequences cut short, overlong forms, encoded surrogates,
 * stray continuations, bytes no UTF-8 holds, and the openers of the byte-order marks. A failure
 * prints its seed; `UTF8_SEED=<seed>` replays it.
 */

import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { DerivedBytePositions } from "../src/byte-positions";
import { PositionMap } from "../src/positions";
import { Utf8Decoder } from "../src/utf8";
import { mulberry32 } from "./corpus-population";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const CORPUS = new URL("../corpus/", import.meta.url).pathname;
const SEED = Number(process.env["UTF8_SEED"] ?? 20261004);

/** Every corpus input as bytes: byte cases as recorded, text cases encoded. */
const corpusBytes = (): Uint8Array[] => {
  const out: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const file of ["corpus.jsonl", "seeds.jsonl"]) {
    for (const line of readFileSync(`${CORPUS}${file}`, "utf8").split("\n")) {
      if (line === "") continue;
      const row = JSON.parse(line) as { text?: unknown; bytes?: unknown };
      if (typeof row.bytes === "string") out.push(fromHex(row.bytes));
      else if (typeof row.text === "string" && row.text.length <= 4096)
        out.push(encoder.encode(row.text));
    }
  }
  return out;
};

/** Pieces a hostile array is assembled from: valid sequences of each width and every defect class. */
const PIECES: readonly (readonly number[])[] = [
  [0x7b],
  [0x22, 0x61],
  [0xd0, 0xb6],
  [0xe6, 0x97, 0xa5],
  [0xf0, 0x9f, 0x98, 0x80],
  [0xef, 0xbb, 0xbf],
  // A literal U+FFFD: well-formed, yet it sends a chunk off the native path, which refuses any
  // text holding one because its own replacements carry no offset.
  [0xef, 0xbf, 0xbd],
  [0xe6, 0x97],
  [0xf0, 0x9f, 0x98],
  [0xd0],
  [0xc0, 0x80],
  [0xe0, 0x80, 0x80],
  [0xf0, 0x80, 0x80, 0x80],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0x80],
  [0xbf],
  [0xff],
  [0xfe],
  [0x00],
  [0xf5],
];

const hostile = (random: () => number, count: number): Uint8Array[] =>
  Array.from({ length: count }, () => {
    const bytes: number[] = [];
    const length = 1 + Math.floor(random() * 12);
    for (let i = 0; i < length; i++)
      bytes.push(...(PIECES[Math.floor(random() * PIECES.length)] as readonly number[]));
    return Uint8Array.from(bytes);
  });

type Decoded = ReturnType<Utf8Decoder["decode"]>;

/**
 * Decoder results are plain records of strings, numbers, `undefined` and arrays, so own keys in
 * order plus `Object.is` per leaf is the whole comparison; a missing `chunk` still differs from
 * `chunk: undefined`. Not `same`: it reads a property descriptor per array element, which cost more
 * than both decoders together and pushed this case past the per-test timeout under load.
 */
const sameData = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const key = ka[i] as string;
    if (key !== kb[i]) return false;
    if (!sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false;
  }
  return true;
};

/** Decodes `bytes` cut at each offset in `cuts`, recording each chunk's result. */
const decodeAll = (decoder: Utf8Decoder, bytes: Uint8Array, cuts: readonly number[]): Decoded[] => {
  const out: Decoded[] = [];
  let from = 0;
  for (const [index, to] of [...cuts, bytes.length].entries()) {
    const result = decoder.decode(bytes.subarray(from, to), index, to === bytes.length, from);
    out.push(result);
    if ("unsupported" in result) break;
    from = to;
  }
  return out;
};

/** A few seeded splits into up to four chunks; none for an input too short to hold two cuts. */
const seededCuts = (length: number, random: () => number): number[][] => {
  if (length <= 2) return [];
  return Array.from({ length: 4 }, () => {
    const cuts = new Set<number>();
    for (let c = 0; c < 3; c++) cuts.add(1 + Math.floor(random() * (length - 1)));
    return [...cuts].toSorted((a, b) => a - b);
  });
};

/** Unsplit, then every single cut on a short input or the middle of a long one, then seeded splits. */
const splits = (length: number, random: () => number): number[][] => [
  [],
  ...(length <= 64
    ? Array.from({ length: Math.max(0, length - 1) }, (_, i) => [i + 1])
    : [[length >> 1]]),
  ...seededCuts(length, random),
];

describe("native UTF-8 decoding returns what the byte decoder returns", () => {
  const random = mulberry32(SEED);
  const cases: [string, Uint8Array[]][] = [
    ["corpus inputs", corpusBytes()],
    ["seeded hostile bytes", hostile(random, 2000)],
  ];

  it.each(cases)("%s", (_name, inputs) => {
    // Seeded per case, so `UTF8_SEED` replays a failing case run alone (`-t`) with the same cuts.
    const cutRandom = mulberry32(SEED);
    const divergences: string[] = [];
    let compared = 0;
    for (const bytes of inputs) {
      for (const cuts of splits(bytes.length, cutRandom)) {
        compared++;
        const native = decodeAll(new Utf8Decoder(), bytes, cuts);
        const reference = decodeAll(new Utf8Decoder(false), bytes, cuts);
        if (!sameData(native, reference))
          divergences.push(
            `UTF8_SEED=${SEED} bytes ${toHex(bytes)} cuts ${JSON.stringify(cuts)}\n  native    ${inspect(native)}\n  reference ${inspect(reference)}`,
          );
      }
    }
    expect(compared).toBeGreaterThan(inputs.length);
    expect(divergences.slice(0, 5)).toEqual([]);
  });
});

/**
 * Whole byte input keeps only the runs the text cannot predict and derives the rest from the text
 * (`DerivedBytePositions`). Every offset must map exactly where the full run map puts it, decoded in
 * slices as whole input decodes them (no chunk, absolute source offsets), on both decoder paths. The
 * long input crosses checkpoints, queried in random order so a backward query reads a filled one.
 */
describe("derived byte positions equal the full run map", () => {
  const random = mulberry32(SEED);
  const maps = (bytes: Uint8Array, cuts: readonly number[], native: boolean) => {
    const full = new PositionMap();
    const derived = new DerivedBytePositions();
    const fullDecoder = new Utf8Decoder(native);
    const derivedDecoder = new Utf8Decoder(native, true);
    let text = "";
    let from = 0;
    for (const to of [...cuts, bytes.length]) {
      const slice = bytes.subarray(from, to);
      const a = fullDecoder.decode(slice, undefined, to === bytes.length, from);
      const b = derivedDecoder.decode(slice, undefined, to === bytes.length, from);
      if ("unsupported" in a || "unsupported" in b) return undefined;
      for (const run of a.runs)
        full.add(a.start + run.start, run.chunk, "byte", run.byte, run.width);
      for (const run of b.runs) derived.anchor(b.start + run.start, run.byte, run.width);
      text += b.text;
      from = to;
    }
    derived.read = (start, until) => text.slice(start, until);
    return { full, derived, length: text.length };
  };
  const pieces = hostile(random, 3000);
  const long = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let filled = 0;
  for (const piece of pieces) {
    long.set(piece, filled);
    filled += piece.length;
  }

  it.each([
    ["corpus inputs", corpusBytes()],
    ["seeded hostile bytes", hostile(random, 2000)],
    ["one long hostile input", [long]],
  ] as const)("%s", (_name, inputs) => {
    const cutRandom = mulberry32(SEED);
    const divergences: string[] = [];
    let compared = 0;
    for (const bytes of inputs) {
      for (const cuts of splits(bytes.length, cutRandom)) {
        for (const native of [true, false]) {
          const built = maps(bytes, cuts, native);
          if (built === undefined) continue;
          const offsets = Array.from({ length: built.length + 1 }, (_, i) => i);
          // Random order: a backward query must read a filled checkpoint, not refill from the anchor.
          for (let i = offsets.length - 1; i > 0; i--) {
            const j = Math.floor(cutRandom() * (i + 1));
            [offsets[i], offsets[j]] = [offsets[j] as number, offsets[i] as number];
          }
          for (const at of offsets) {
            compared++;
            const want = built.full.at(at);
            const got = built.derived.at(at);
            if (got.offset !== want.offset || got.unit !== want.unit)
              divergences.push(
                `UTF8_SEED=${SEED} bytes ${toHex(bytes).slice(0, 200)} cuts ${JSON.stringify(cuts)} native ${native} at ${at}: ${inspect(got)} vs ${inspect(want)}`,
              );
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(inputs.length);
    expect(divergences.slice(0, 5)).toEqual([]);
  });
});
