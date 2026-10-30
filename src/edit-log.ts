// SPDX-License-Identifier: Apache-2.0

import type { BuildMode } from "./builder";

export type Edit = { start: number; end: number; text: string };
export type RecordedEdits = readonly Edit[];

/** Source rewrites belong only to repair calls; values and reports have separate rewind lifetimes. */
export class EditLog {
  readonly edits: Edit[] = [];
  // A closer inserted at the match end may belong inside or outside it; the edit count decides.
  private matches:
    | { root: number; spans: { start: number; end: number; until: number }[] }
    | undefined;

  record(start: number, end: number, text: string): void {
    this.edits.push({ start, end, text });
  }

  rewind(held: number): void {
    this.edits.length = held;
  }

  /**
   * Inserts `text` at `at` ahead of every edit already recorded at or after `at`, and answers its
   * index. Equal offsets splice in recording order, so the opening bracket of a list found only
   * after its first element was read (`'a','b'`) would otherwise land after that element's own
   * rewrite of its first character. Never below `from`, where the root's own edits begin: the
   * previous root's closer can sit at the same offset (`{"id":2,{"id":3}` closes the first there).
   */
  insertFirst(at: number, text: string, from: number): number {
    let i = this.edits.length;
    while (i > from && (this.edits[i - 1] as Edit).start >= at) i--;
    this.edits.splice(i, 0, { start: at, end: at, text });
    return i;
  }

  recordMatch(occurrence: {
    valueIndex: number;
    start: number;
    end: number;
    closeEdit: number;
  }): void {
    // Whole-input repair stops at the first accepted root; eager occurrences forbid root filters.
    // Advancing to another root therefore discards only ranges of filtered final matches.
    if (this.matches?.root !== occurrence.valueIndex)
      this.matches = { root: occurrence.valueIndex, spans: [] };
    this.matches.spans.push({
      start: occurrence.start,
      end: occurrence.end,
      until: occurrence.closeEdit,
    });
  }

  takeMatchRanges(): { start: number; end: number; until: number }[] | undefined {
    // Decoded ranges and closer cutoffs cannot be recovered from public byte/chunk positions.
    // Delivery order already matches projection order, so no per-match lookup or copy is needed.
    const spans = this.matches?.spans;
    this.matches = undefined;
    return spans;
  }

  dispose(): void {
    this.edits.length = 0;
    this.matches = undefined;
  }

  /** Dropping a member also removes preceding trivia whose repair its mark retracts. */
  memberStart(held: number, keyAt: number): number {
    let start = keyAt;
    for (let i = held; i < this.edits.length; i++) {
      const edit = this.edits[i];
      if (edit !== undefined) start = Math.min(start, edit.start);
    }
    return start;
  }
}

/** Keep the same frozen mode shape as value and stream calls without constructing unused logs. */
export const MODE_EDITS: BuildMode = /* @__PURE__ */ Object.freeze({
  edits: true,
  fragments: false,
  streamReader: undefined,
  retainedUnits: undefined,
  nativeSlice: undefined,
  openEdits: () => new EditLog(),
});
