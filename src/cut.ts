// SPDX-License-Identifier: Apache-2.0

import type { Builder } from "./builder";
import type { ScalarReader } from "./scalar-reader";
import type { ScanCursor } from "./scan-cursor";
import type { Cut, CutKind, SourcePath } from "./types";

/**
 * Where the open root stops right now, decided from facts the scan recorded when it made each
 * decision, never by lexing the source again (one mechanism decides what the bytes mean):
 *
 * 1. A token the reader saw reach the END of input recorded its own cut: an open string, a number
 *    touching the end, an unfinished literal or number dropped as `missing`, a key the end cut.
 * 2. Mid-stream, a visible string prefix or streamed string fragment identifies the open string.
 * 3. The source began or named the item at the slot and the value leaves it out — a key waiting
 *    for its value (`keyWaiting`), or a number or word still being read. That item is `missing`.
 * 4. Otherwise the source stopped between items of the innermost open container.
 *
 * **Why `text` is the unfinished token and not every character after the last one the value holds.**
 * The wider reading needs the separators and comments since that value, and a stream keeps only a
 * bounded window: a long comment or run of spaces inside an open object must not grow the buffer
 * (`maxBuffer`, `test/scan.test.ts`). Keep only withheld token source, already held under
 * `maxRetained`, so inspecting a cut loses no text and retains no intervening layout.
 */
export const cutNow = (
  build: Builder,
  scalars: ScalarReader,
  cursor: ScanCursor,
  inKey: boolean,
  keyWaiting: boolean,
): Cut => {
  if (scalars.cut !== undefined) return scalars.cut;
  const { text, base, window } = cursor;
  // A KEY being read leaves its prefix pending too once it is banked across chunks, but a key is no
  // value: it falls through to the `between` cut below, with its text so far.
  if (scalars.pending !== undefined && !inKey)
    return cutOf("string", build.path(), text.slice(scalars.partialEnd - base));
  // The token still being read: a word or number the window holds; a key long enough to be banked
  // as its decoded prefix (`keyText`); anything else was rewound to its start, so it is what the
  // buffer holds past the cursor. At the end of input every token was finished or recorded by the
  // reader, so the buffer past the cursor is input a bound left unread, never a token.
  const banked = inKey ? scalars.continuation : undefined;
  const withheld =
    window.inWord || window.inNumber
      ? window.pendingRaw
      : banked === undefined
        ? cursor.atEnd
          ? ""
          : text.slice(cursor.pos)
        : keyText(banked.quote, scalars.pending ?? "");
  // A proven unquoted string has already delivered content; only its undecided tail stays here.
  if (!inKey && window.inWord && build.picks?.delivery?.fragmentDelivery?.streaming === true)
    return cutOf("string", build.path(), withheld);
  return !inKey && (keyWaiting || window.inWord || window.inNumber)
    ? cutOf("missing", build.path(), withheld)
    : cutOf("between", build.ancestors(), withheld);
};

/**
 * A cut key's `text`: the characters read so far as a string literal in the source's own quote,
 * without its closing quote. Built from the DECODED key, not its raw bytes, because a stream does
 * not keep a long key's source (keeping it moved `maxBuffer` failures: `{"incomplete` under a
 * buffer of 8 failed at `feed` instead of at the retained bound). The two spellings differ only
 * when the key held escapes, and every route builds it the same way.
 */
export const keyText = (quote: number, key: string): string =>
  String.fromCharCode(quote) + JSON.stringify(key).slice(1, -1);

/** The public record; `text` is absent rather than empty, so a caller tests it plainly. */
export const cutOf = (kind: CutKind, path: SourcePath, text: string): Cut =>
  text === "" ? { path, kind } : { path, kind, text };
