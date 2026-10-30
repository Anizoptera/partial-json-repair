// SPDX-License-Identifier: Apache-2.0

import type { DecodedFragmentsFeature } from "./types";
import type { DecodedFragmentsImplementation, FilterFactory } from "./selection-feature";
import type { Picks } from "./picks";
import type { DecodedPicks } from "./decoded-picks";
import { FragmentPicksConstructor } from "./decoded-picks";
import type { SourcePath } from "./types";
import { isExactNumber } from "./exact-number";
import { fragmentPositions } from "./positions";

const decodedPicksClass = (): new (
  ...args: ConstructorParameters<typeof Picks>
) => DecodedPicks => {
  class DecodedSelection extends FragmentPicksConstructor {
    /**
     * Start a selected string occurrence before decoding; data leaves incrementally and value()
     * finishes it when its closer arrives, so the decoder never needs its complete text.
     */
    beginStreamedString(): boolean {
      // Never a root string: until it ends, nothing shows it stands alone (`"abc" today` is prose),
      // and a fragment cannot be taken back. It leaves whole from `emitScalar` once it is decided.
      if (this.b.stack.length === 0 || !this.established()) return false;
      const slot = this.selectedSlot();
      if (slot === undefined) return false;
      const id = this.nextFragment++;
      this.fragment = { id };
      this.start(id, slot.path, slot.hits, "string");
      return true;
    }

    private start(
      id: number,
      path: SourcePath,
      selectors: readonly number[],
      scalar: "string" | "number" | "literal",
    ): void {
      this.out.push({ kind: "start", id, valueIndex: this.b.completed, path, selectors, scalar });
      for (const s of selectors) this.hit[s] = 1;
      this.delivered++;
    }

    /**
     * A selected scalar under `fragments`, complete: the streamed string's tail and `end`, or a
     * number or literal as one `start`/`data`/`end`. Numbers arrive as the JSON spelling of the
     * recovered number — `01` was repaired to `1`, and the repair says so — literals as spelled.
     * Held until the candidate is established, like a match: a fragment out of prose is invented data.
     */
    emitScalar(
      v: unknown,
      label: string | number,
      at: number,
      end: number,
      selectors: readonly number[],
      parent: number,
    ): void {
      // Decided now: a held root scalar emits later, when another value may be the cut one.
      const complete = end !== this.cutEnd;
      // Recovered numeric text must wait: a `0x10` prefix may finish as `16` or `256`.
      // An append-only fragment cannot correct an already delivered first character.
      const streamed = this.fragment;
      if (streamed !== undefined) {
        this.fragmentData(v as string);
        this.fragment = undefined;
        this.out.push({
          kind: "end",
          id: streamed.id,
          span: { start: this.b.positionAt(at), end: this.b.positionAt(end) },
          complete,
        });
        this.onDelivery();
        return;
      }
      const path = Object.freeze(parent < 0 ? [] : this.b.pathTo(label));
      const scalar =
        typeof v === "string"
          ? "string"
          : typeof v === "number" || isExactNumber(v)
            ? "number"
            : "literal";
      const emit = (): void => {
        const id = this.nextFragment++;
        this.start(id, path, selectors, scalar);
        this.out.push(
          { kind: "data", id, text: isExactNumber(v) ? v.text : String(v) },
          {
            kind: "end",
            id,
            span: { start: this.b.positionAt(at), end: this.b.positionAt(end) },
            complete,
          },
        );
        this.onDelivery();
      };
      // A root scalar waits for its root to finish: until the input ends, prose after it (`"hi" today`)
      // can still show it is no value, and `finish()` flushes it only once that is settled.
      if (parent >= 0 && this.established()) emit();
      else this.pending.push(emit);
    }
  }
  return DecodedSelection;
};

export const DecodedPicksConstructor = /* @__PURE__ */ decodedPicksClass();

const decodedFeature = (): DecodedFragmentsImplementation => {
  // Carry the constructor and position history on the imported value: a switch in select would
  // retain decoded delivery even when the consumer only asks for whole selected matches.
  const factory: FilterFactory = (builder, compiled, occurrences, mode) =>
    new DecodedPicksConstructor(builder, compiled, occurrences, mode);
  const picks = Object.freeze(Object.assign(factory, { openFragmentHistory: fragmentPositions }));
  return Object.freeze({ feature: "decoded-fragments", picks });
};

/** Deliver selected decoded scalar contents incrementally without retaining each complete string. */
export const decodedFragments: DecodedFragmentsFeature = /* @__PURE__ */ decodedFeature();
