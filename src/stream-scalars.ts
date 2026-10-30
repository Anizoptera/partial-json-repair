// SPDX-License-Identifier: Apache-2.0

import type { BuildMode } from "./builder";
import { ST_KEY } from "./chars";
import { cutOf } from "./cut";
import { ownText } from "./lexical-window";
import { nativeSliceFor } from "./native-slice";
import { ScalarReader } from "./scalar-reader";
import type { ScalarRead } from "./scalar-reader";
import { retainedUnits, scalarUnits } from "./tree";

// Whole-input readers need no retained-storage ledger; fragment emission belongs to selection.
export class StreamScalarReader extends ScalarReader {
  protected override bank(
    text: string,
    before: number,
    start: number,
    ambiguous: boolean,
    _until: number,
  ): string {
    const picks = this.diagnostics.build.picks?.delivery?.fragmentDelivery;
    // Published text cannot be retracted; an ambiguous quote keeps its entire suffix charged.
    if (picks?.streaming === true && !ambiguous)
      return picks.bankFragment(text, before, start + this.cursor.base);
    // Compacted source leaves maxBuffer; undecided decoded text remains parser-owned.
    this.diagnostics.build.charge(text.length - before, start + this.cursor.base);
    return text;
  }

  protected override finishWord(word: string, state: number, depth: number): ScalarRead {
    const picks = this.diagnostics.build.picks?.delivery?.fragmentDelivery;
    return picks?.streaming === true
      ? // eslint-disable-next-line typescript/unbound-method -- Picks invokes the method with this reader; binding would allocate per token.
        picks.finishFragmentWord(this.cursor, word, depth, this, this.unquotedString)
      : super.finishWord(word, state, depth);
  }

  protected override limitCompleted(
    value: unknown,
    state: number,
    start: number,
    raw: string,
  ): boolean {
    const build = this.diagnostics.build;
    const room = build.retainedRoom;
    if (room === Infinity) return false;
    const key = state === ST_KEY;
    const picks = build.picks;
    // Decide the recovered type first: long source digits may become a small float, or a string
    // when followed by letters. Ignored values and fragment pieces never own a complete scalar.
    if (
      !key &&
      picks !== undefined &&
      (picks.delivery?.fragmentDelivery !== undefined || !picks.retainsScalar())
    )
      return false;
    const units = key && typeof value === "string" ? value.length : scalarUnits(value);
    if (units <= room) return false;
    const end = Math.min(this.cursor.pos + this.cursor.base, start + room);
    this.cursor.pos = Math.max(0, end - this.cursor.base);
    if (key) this.cut = cutOf("between", build.ancestors(), ownText(raw.slice(0, room)));
    else if (typeof value === "string") {
      // A string prefix is useful recovery; a numeric prefix would invent a different number.
      // EOF decoding may already have appended the requested suffix; terminal transfer appends it once.
      const text =
        this.cut?.kind === "string" && this.opts.cutSuffix.length > 0
          ? value.slice(0, -this.opts.cutSuffix.length)
          : value;
      this.partial = ownText(text.slice(0, room));
      this.partialStart = start;
      this.partialEnd = end;
      this.cut = cutOf("string", build.path(), "");
    } else this.cut = cutOf("missing", build.path(), ownText(raw.slice(0, room)));
    this.diagnostics.refuse("retained", this.opts.maxRetained, end);
    return true;
  }
}

/** A stream, which charges maxRetained and never records edits. */
export const MODE_STREAM: BuildMode = /* @__PURE__ */ Object.freeze({
  edits: false,
  fragments: false,
  streamReader: StreamScalarReader,
  retainedUnits,
  nativeSlice: nativeSliceFor,
  openEdits: undefined,
});

/** A stream delivering selected scalars as fragments. */
export const MODE_FRAGMENTS: BuildMode = /* @__PURE__ */ Object.freeze({
  edits: false,
  fragments: true,
  streamReader: StreamScalarReader,
  retainedUnits,
  nativeSlice: undefined,
  openEdits: undefined,
});
