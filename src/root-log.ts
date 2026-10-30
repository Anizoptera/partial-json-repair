// SPDX-License-Identifier: Apache-2.0

import type { RootInfo } from "./builder";
import type { Tally } from "./report";
import type { Limit } from "./scan-diagnostics";
import type { Cut, ParseError } from "./types";

/**
 * What a reader needs about a root after the scan has moved past it: the value, where it sat, its
 * verdict facts, and its report totals. One record per root, written once when the root finishes;
 * the root still open keeps these as live counters in the builder, diagnostics and report.
 */
export type FinishedRoot = {
  valueIndex: number;
  value: unknown;
  /** `from`: the edit index of a list's opening bracket, which sits at `start` yet belongs inside. */
  span: { readonly start: number; readonly end: number; readonly from?: number };
  /** Only when a root filter (`objectOnly`, `requiredKeys`) needs it. */
  info: RootInfo | undefined;
  refusal: ParseError | undefined;
  limit: Limit | undefined;
  /** Only when a report was asked for. */
  tally: Tally | undefined;
  /** Where the source ended inside the root; `undefined` when the source finished it. */
  cut: Cut | undefined;
};

/**
 * Entries tagged with the root they belong to — finished-root records, repairs, errors — addressed
 * by absolute position and released from the front once their roots are delivered.
 *
 * A stream may run forever, so a log keeping every root it saw would grow without bound even with
 * every item read (SECURITY.md: unbounded growth is a defect). Readers deliver roots in order and
 * never look back past the previous one, so they release what they delivered.
 * Positions stay absolute, so the rewind marks and report cursors taken earlier remain valid, and
 * nothing outside this class knows what was dropped.
 */
export class RootLog<T extends { readonly valueIndex: number }> {
  /** Held entries, in scan order and so in `valueIndex` order. The first `released` are dead. */
  readonly items: (T | undefined)[] = [];
  /** Absolute position of `items[0]`. */
  private base = 0;
  private released = 0;

  get start(): number {
    return this.base + this.released;
  }

  get end(): number {
    return this.base + this.items.length;
  }

  at(position: number): T | undefined {
    return this.items[position - this.base];
  }

  push(entry: T): void {
    this.items.push(entry);
  }

  /** Map live records in one pass without copying the released prefix or retaining its payloads. */
  map<Output>(read: (entry: T) => Output): Output[] {
    const result: Output[] = [];
    // Empty slots exist only before `released`; every later slot was filled by push().
    for (let index = this.released; index < this.items.length; index++)
      result.push(read(this.items[index] as T));
    return result;
  }

  /** Rewinds to the absolute position `end` and answers how many entries went. */
  truncate(end: number): number {
    const removed = this.end - end;
    this.items.length = end - this.base;
    return removed;
  }

  /**
   * Clears records before `upTo` immediately and answers how many slots were compacted. Compact
   * only when at least half are empty: one splice per release would make a consumer draining a
   * 100 000-root chunk pay for every root still queued, each time.
   */
  releaseBefore(upTo: number): number {
    const length = this.items.length;
    if (length > 0 && (this.items[length - 1]?.valueIndex ?? upTo) < upTo) {
      // A whole finished report can leave at once; walking it delays the waiting consumer.
      this.items.length = 0;
      this.base += length;
      this.released = 0;
      return length;
    }
    while (
      this.released < this.items.length &&
      (this.items[this.released]?.valueIndex ?? upTo) < upTo
    )
      // Keep dense own slots so an inherited numeric property cannot resurrect a released record.
      this.items[this.released++] = undefined;
    const n = this.released;
    if (n === 0 || 2 * n < this.items.length) return 0;
    this.items.splice(0, n);
    this.base += n;
    this.released = 0;
    return n;
  }
}
