// SPDX-License-Identifier: Apache-2.0

import type { Picks } from "./picks";
import { FragmentPicksConstructor } from "./decoded-picks";
import type { DecodedPicks } from "./decoded-picks";
import { ownText, type LexicalWindow, type NumberDrain, type WordDrain } from "./lexical-window";
import type { QuoteAmbiguity } from "./quote-ambiguity";
import type { QuotedSource } from "./scalar-reader";
import type { SourceFragment } from "./types";
import { canBeLiteral } from "./chars";

type ScalarKind = Exclude<Extract<SourceFragment, { kind: "end" }>["scalar"], "missing">;

// Name the reader-facing contract so declarations need not expose a factory's private class state.
export interface SourcePicks extends DecodedPicks, QuotedSource {
  window: LexicalWindow | undefined;
  hasFailure: () => boolean;
  readonly candidate: string | undefined;
  readonly root: boolean;
  readonly trailingSpace: boolean;
  scalar: ScalarKind;
  begin(at: number): boolean;
  readonly numberDrain: NumberDrain;
  readonly sourceWordDrain: WordDrain;
  finishScalar(end: number, missing?: boolean): void;
}

// Keep subclass evaluation removable too: an unused feature must not initialize its parent modules.
const sourcePicksClass = (): new (...args: ConstructorParameters<typeof Picks>) => SourcePicks => {
  // Source occurrences share selection, candidacy and delivery ordering with recovered fragments.
  class SourceSelection extends FragmentPicksConstructor {
    window: LexicalWindow | undefined;
    hasFailure: () => boolean = () => false;
    private from = 0;
    private sourceAt = 0;
    private deferred = false;
    private tail = "";
    private quote = "";
    private carry: number | undefined;
    private carryUnits = 0;
    private candidateText: string | undefined = "";
    trailingSpace = false;
    scalar: ScalarKind = "string";
    root = false;

    get candidate(): string | undefined {
      return this.candidateText;
    }
    get carryFrom(): number | undefined {
      return this.carry;
    }
    // Raw carry uses source units; Picks.held counts pending selected results instead.
    get rawHeld(): number {
      return this.carryUnits;
    }

    begin(at: number): boolean {
      if (this.fragment !== undefined) return true;
      const slot = this.selectedSlot();
      if (slot === undefined) return false;
      this.root = this.b.stack.length === 0;
      this.deferred = this.root || !this.established();
      if (!this.deferred) this.flush();
      const id = this.nextFragment++;
      this.fragment = { id };
      this.sourceAt = this.from = at;
      this.tail = "";
      this.candidateText = "";
      this.trailingSpace = false;
      this.scalar = "string";
      const valueIndex = this.b.completed;
      this.send({ kind: "start", id, valueIndex, path: slot.path, selectors: slot.hits });
      // A rejected candidate never marks a selector as matched.
      const hit = (): void => {
        for (const index of slot.hits) this.hit[index] = 1;
        this.delivered++;
      };
      if (this.deferred) this.pending.push(hit);
      else hit();
      return true;
    }

    override beginStreamedString(): boolean {
      return this.streaming;
    }

    override truncate(held: number): void {
      // A rejected candidate (or an unbanked token rewind) invalidates its unpublished occurrence.
      if (this.deferred && this.fragment !== undefined) {
        this.fragment = undefined;
        this.tail = this.quote = "";
        this.carry = undefined;
        this.carryUnits = 0;
      }
      super.truncate(held);
    }

    private send(piece: SourceFragment): void {
      if (!this.deferred) {
        this.out.push(piece);
        this.onDelivery();
        return;
      }
      // Until candidacy settles, raw pieces remain owned storage and cannot be retracted by a sink.
      const units = piece.kind === "data" ? piece.text.length : 0;
      this.b.charge(units, this.from);
      this.pending.push(() => {
        this.b.charge(-units, this.from);
        this.out.push(piece);
        this.onDelivery();
      });
    }

    private text(text: string, final = false): void {
      let value = this.tail + text;
      this.b.charge(-this.tail.length, this.from);
      this.tail = "";
      if (!final) {
        const last = value.charCodeAt(value.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          this.tail = ownText(value.slice(-1));
          this.b.charge(1, this.from);
          value = value.slice(0, -1);
        }
      }
      const fragment = this.fragment;
      if (fragment === undefined) return;
      for (let at = 0; at < value.length;) {
        let end = Math.min(value.length, at + 4096);
        const last = value.charCodeAt(end - 1),
          next = value.charCodeAt(end);
        if (
          end < value.length &&
          last >= 0xd800 &&
          last <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff
        )
          end--;
        this.send({ kind: "data", id: fragment.id, text: ownText(value.slice(at, end)) });
        at = end;
      }
    }

    part(until: number, ambiguous: boolean): void {
      if (this.window === undefined || this.fragment === undefined) return;
      if (ambiguous && this.carry !== undefined) {
        const units = Math.max(0, until - this.carry);
        this.b.charge(units - this.carryUnits, until);
        this.carryUnits = units;
        return;
      }
      // text() owns each delivered piece; this temporary view needs no intermediate copy.
      if (until > this.from)
        this.text(this.window.text.slice(this.from - this.window.base, until - this.window.base));
      this.from = until;
    }

    beginCarry(at: number, quote: string): void {
      this.carry = at;
      this.quote = quote;
    }

    end(until: number, ambiguity: QuoteAmbiguity | undefined): void {
      const window = this.window;
      if (window === undefined) return;
      if (this.carry !== undefined && ambiguity !== undefined) {
        this.b.charge(-this.carryUnits, until);
        this.carryUnits = 0;
        // A line break that ended its string is no part of it; a quote that ended it is.
        if (until > this.carry) this.text(this.quote);
        let left = until - this.carry - 1;
        // The quote owner may hold lookahead beyond the scalar; only its final span is source data.
        if (left > 0) {
          ambiguity.capture(window);
          for (const part of ambiguity.parts) {
            if (left <= 0) break;
            this.text(part.slice(0, left));
            left -= Math.min(left, part.length);
          }
        }
        this.from = until;
        this.carry = undefined;
        this.quote = "";
      } else this.part(until, false);
      this.text("", true);
    }

    private track(text: string): void {
      // A literal has bounded spelling; once disproved, never classify a later suffix on its own.
      if (text.length === 0) return;
      const trimmed = text.trimEnd();
      const wasSpace = this.trailingSpace;
      this.trailingSpace = text.length !== trimmed.length;
      const candidate = this.candidateText;
      if (candidate === undefined) return;
      if (wasSpace && trimmed !== "") {
        this.candidateText = undefined;
        return;
      }
      const joined = candidate + trimmed;
      this.candidateText = joined.length <= 9 && canBeLiteral(joined) ? ownText(joined) : undefined;
    }

    readonly numberDrain: NumberDrain = (window, state, from) => {
      const text = window.text.slice(from, window.cursor);
      this.track(text);
      this.part(window.absolute(window.cursor), false);
      if (this.root) return 0;
      state.mark ??= window.mark(state.start - window.base);
      state.parts = "";
      state.next = window.absolute(window.cursor);
      return state.next - state.start;
    };

    readonly sourceWordDrain: WordDrain = (window, state, from) => {
      this.numberDrain(window, state, from);
      if (window.cursor > from) state.prevChar = window.text.charCodeAt(window.cursor - 1);
      return this.root ? 0 : state.next - state.start;
    };

    finishScalar(end: number, missing = false): void {
      this.end(end, undefined);
      const fragment = this.fragment;
      if (fragment === undefined) return;
      if (!this.hasFailure()) {
        const span = { start: this.b.positionAt(this.sourceAt), end: this.b.positionAt(end) };
        this.send(
          missing
            ? { kind: "end", id: fragment.id, span, scalar: "missing", complete: false }
            : {
                kind: "end",
                id: fragment.id,
                span,
                scalar: this.scalar,
                complete: end !== this.cutEnd,
              },
        );
      }
      this.fragment = undefined;
    }

    override emitScalar(
      _value: unknown,
      _label: string | number,
      _at: number,
      end: number,
      _selectors: readonly number[],
      _parent: number,
    ): void {
      this.finishScalar(end);
    }

    override dispose(): void {
      this.window = undefined;
      this.tail = this.quote = "";
      this.candidateText = undefined;
      this.carry = undefined;
      super.dispose();
    }
  }
  return SourceSelection;
};
export const SourcePicksConstructor = /* @__PURE__ */ sourcePicksClass();
