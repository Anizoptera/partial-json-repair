// SPDX-License-Identifier: Apache-2.0

/**
 * Builds one member's container natively when it closed without damage.
 *
 * A reply with one defect no mechanical edit expresses (a missing comma or quote, a mismatched
 * closer) sends the whole text to the scanner, which reads it character by character at many times
 * `JSON.parse`'s cost. Every member that closed cleanly is valid JSON on its own, so the scanner
 * hands that slice to `JSON.parse` and places the result as one value. The answer is the scanner's
 * by the same rule as the whole-text route (`builtin-route.ts`): `JSON.parse` must accept the slice,
 * and the slice must hold nothing `JSON.parse` reads differently: `faithfulEnd` finds the closer
 * and clears numbers and depth in one pass, `keysAreFaithful` clears dangerous keys. Brackets are
 * counted, never matched by kind: a mismatched closer makes `JSON.parse` throw, so the slice it
 * yields can only be rejected, never misread. `test/pre-scan.test.ts` holds
 * every input to the scanner alone.
 *
 * Reached through `MODE_NATIVE` (whole input) and `MODE_STREAM`; edit, fragment and view-sharing
 * builds never take it.
 */

import type { ResolvedOptions } from "./options";
import type { BuildMode } from "./builder";
import { builtinAllowed, faithfulEnd, keysAreFaithful } from "./builtin-route";

const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;
const COMMA = 0x2c;
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

/** Where the next sibling container opens after a comma at `from`, or -1. */
const siblingAt = (text: string, from: number, limit: number): number => {
  let i = from;
  let comma = false;
  for (; i < limit; i++) {
    const c = text.charCodeAt(i);
    if (c === SPACE || c === TAB || c === LF || c === CR) continue;
    if (c !== COMMA || comma) break;
    comma = true;
  }
  const c = text.charCodeAt(i);
  return comma && i < limit && (c === OPEN_BRACE || c === OPEN_BRACKET) ? i : -1;
};

/**
 * The natively built container opening at `from` and the offset past its closer, or, when the
 * scanner must read it, how many units the attempt read.
 */
export type NativeSlice = (
  text: string,
  from: number,
  limit: number,
  depthLeft: number,
  inArray: boolean,
) => { readonly value: unknown; readonly end: number; readonly run: boolean } | number;

/** The slice reader for these options, or undefined where `JSON.parse` may never answer for them. */
export const nativeSliceFor = (opts: ResolvedOptions): NativeSlice | undefined => {
  if (!builtinAllowed(opts)) return undefined;
  /**
   * Array elements that follow one another undamaged are parsed in one call: the scanner's own
   * per-member work costs about three times the native parse. A run that fails marks its text, so
   * the members inside it go one at a time and no text is retried as part of a run twice.
   */
  let noRunBefore = 0;
  const parsed = (slice: string): { value: unknown } | undefined => {
    try {
      return { value: JSON.parse(slice) as unknown };
    } catch {
      return undefined;
    }
  };
  return (text, from, limit, depthLeft, inArray) => {
    const first = faithfulEnd(text, from, limit, depthLeft, true);
    if (first < 0) return -1 - first - from;
    let end = first;
    if (inArray && from >= noRunBefore)
      for (let next = siblingAt(text, end, limit); next >= 0; next = siblingAt(text, end, limit)) {
        const closed = faithfulEnd(text, next, limit, depthLeft, true);
        if (closed < 0) break;
        end = closed;
      }
    if (end > first) {
      const run = text.slice(from, end);
      const values = parsed(`[${run}]`);
      if (values !== undefined && keysAreFaithful(run, opts))
        return { value: values.value, end, run: true };
      noRunBefore = end;
    }
    // A slice `JSON.parse` rejects is damaged inside: the scanner reads it and recovers what it can.
    const slice = text.slice(from, first);
    const single = parsed(slice);
    return single !== undefined && keysAreFaithful(slice, opts)
      ? { value: single.value, end: first, run: false }
      : first - from;
  };
};

/** `MODE_VALUE` plus native slices: `parse`, `parseMany` and `findJsonSpan` on whole input. */
export const MODE_NATIVE: BuildMode = /* @__PURE__ */ Object.freeze({
  edits: false,
  fragments: false,
  streamReader: undefined,
  retainedUnits: undefined,
  nativeSlice: nativeSliceFor,
  openEdits: undefined,
});
