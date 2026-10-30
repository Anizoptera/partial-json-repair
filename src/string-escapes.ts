// SPDX-License-Identifier: Apache-2.0

import { BACKSLASH, ESCAPE } from "./chars";
import type { ScanCursor } from "./scan-cursor";

// Batch only known single-unit escapes; the string reader still owns incomplete and invalid ones.
export function readKnownEscapes(
  cursor: ScanCursor,
  first: number,
  room: number,
  retain: boolean,
): string {
  // Bound indivisible work and rope growth even when input arrives as one large caller chunk.
  let codes: number[] | undefined;
  for (let count = 1; count < Math.min(256, room); count++) {
    if (cursor.text.charCodeAt(cursor.pos + 1) !== BACKSLASH) break;
    const code = ESCAPE[cursor.text.charCodeAt(cursor.pos + 2)] ?? 0;
    if (code === 0) break;
    if (retain) (codes ??= [first]).push(code);
    cursor.pos += 2;
  }
  return retain
    ? codes === undefined
      ? String.fromCharCode(first)
      : String.fromCharCode(...codes)
    : "";
}
