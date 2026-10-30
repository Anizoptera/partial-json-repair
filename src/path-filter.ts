// SPDX-License-Identifier: Apache-2.0

import type { Builder } from "./builder";
import { BUILT, DEAD, IN_ARRAY } from "./builder";
import type { Picks } from "./picks";
import type { Compiled } from "./selector";
import { Selection } from "./selector";

/** Allocation decisions are shared; only a selection owns delivery or snapshot state. */
export type BuildFilter = Pick<
  Picks,
  "open" | "opened" | "value" | "leave" | "retainsScalar" | "dispose"
> & { readonly delivery: Picks | undefined };

/** Decide storage before decoding without advancing the matcher or creating selected output. */
export const scalarIsWanted = (b: Builder, selection: Selection, withinMatch: boolean): boolean => {
  const parent = b.stack.length - 1;
  if (parent >= 0 && b.modes[parent] === DEAD) return false;
  const label =
    parent < 0 ? undefined : b.kinds[parent] === IN_ARRAY ? b.counts[parent] : b.keys[parent];
  if (parent >= 0 && label === undefined) return false;
  if (label !== undefined) selection.descend(label);
  const placement = selection.placement();
  if (label !== undefined) selection.ascend();
  return (
    !placement.skipped && (placement.hits !== undefined || !selection.selecting || withinMatch)
  );
};

/** Skip-only filtering owns no selected output; both filters share scalar storage decisions. */
export class SkipFilter implements BuildFilter {
  private readonly selection: Selection;

  constructor(
    private readonly b: Builder,
    skip: Compiled | undefined,
  ) {
    this.selection = new Selection(undefined, skip);
  }

  get delivery(): Picks | undefined {
    return undefined;
  }

  open(label: string | number, _at: number, parent: number): number {
    if (parent >= 0) this.selection.descend(label);
    return this.selection.placement().skipped ? DEAD : BUILT;
  }

  opened(_container: unknown, _frame: number, dropped: boolean): boolean {
    // Refused or dropped containers cannot accept descendants, even without selected output.
    return dropped || this.b.refusedFrom >= 0;
  }

  value(
    _value: unknown,
    label: string | number,
    _at: number,
    _end: number,
    parent: number,
    write: boolean,
    _stopped: boolean,
  ): boolean {
    if (parent >= 0) this.selection.descend(label);
    return !this.selection.placement().skipped && write;
  }

  leave(parent: number): void {
    // Dead subtrees never advance the matcher and therefore must not unwind it.
    if (parent >= 0 && this.b.modes[parent] !== DEAD) this.selection.ascend();
  }

  retainsScalar(): boolean {
    return scalarIsWanted(this.b, this.selection, false);
  }

  dispose(): void {
    this.selection.dispose();
  }
}
