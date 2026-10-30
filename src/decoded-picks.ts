// SPDX-License-Identifier: Apache-2.0

import { Picks } from "./picks";
import type { Delivery } from "./picks";
import type { Fragment } from "./types";
import type { LexicalWindow, WordDrain, WordState } from "./lexical-window";
import { ownText } from "./lexical-window";
import { canBeLiteral } from "./chars";
import type { ScanCursor } from "./scan-cursor";
import type { ScalarRead, ScalarReader } from "./scalar-reader";

// The scanner sees delivery capabilities without importing their implementation into plain matches.
export interface FragmentDelivery {
  readonly streaming: boolean;
  readonly wordPieces: WordDrain | undefined;
  readonly fragmentPieces: (
    delivery: Delivery,
  ) => Generator<Extract<Fragment, { kind: "data" }>> | undefined;
  beginStreamedString(): boolean;
  bankFragment(text: string, before: number, at: number): string;
  finishFragmentWord(
    cursor: ScanCursor,
    word: string,
    depth: number,
    reader: ScalarReader,
    finish: (this: ScalarReader, text: string, start: number, end: number, cut: boolean) => string,
  ): ScalarRead;
  emitScalar(
    value: unknown,
    label: string | number,
    at: number,
    end: number,
    selectors: readonly number[],
    parent: number,
  ): void;
}

export interface DecodedPicks extends Picks, FragmentDelivery {
  nextFragment: number;
  fragment: { id: number } | undefined;
}

function* dataPieces(id: number, text: string): Generator<Extract<Fragment, { kind: "data" }>> {
  // The piece's text is decided; split delivery without changing text or completed surrogate pairs.
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 4096);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (last >= 0xd8_00 && last <= 0xdb_ff && next >= 0xdc_00 && next <= 0xdf_ff) end--;
    }
    // A caller may keep one piece after closing the iterator; release the rest of this scalar.
    yield { kind: "data", id, text: ownText(text.slice(offset, end)) };
    offset = end;
  }
}

const fragmentPieces = (delivery: Delivery) => {
  // Short pieces and non-data events keep their identity and avoid another iterator allocation.
  if (!("kind" in delivery) || delivery.kind !== "data" || delivery.text.length <= 4096)
    return undefined;
  return dataPieces(delivery.id, delivery.text);
};

/**
 * What decoded and source fragments share: word draining, banking, delivery and its shaping. Each
 * mode starts and finishes an occurrence its own way (`beginStreamedString`, `emitScalar`), so those
 * stay abstract here: bundlers keep every method of a retained class, and a source-fragment caller
 * would otherwise ship decoded delivery it never runs.
 */
// Optional subclasses must not evaluate their parent graph for an unused feature import.
const fragmentPicksClass = (): abstract new (
  ...args: ConstructorParameters<typeof Picks>
) => DecodedPicks & { fragmentData(text: string): void } => {
  abstract class FragmentSelection extends Picks {
    readonly fragmentDelivery = this;
    nextFragment = 0;
    /** The string being streamed as fragments, while one is. */
    fragment: { id: number } | undefined;
    private readonly drainWord: WordDrain = (window, state, from) =>
      this.fragmentWord(window, state, from);

    override dispose(): void {
      this.fragment = undefined;
      super.dispose();
    }

    abstract beginStreamedString(): boolean;

    abstract emitScalar(
      v: unknown,
      label: string | number,
      at: number,
      end: number,
      selectors: readonly number[],
      parent: number,
    ): void;

    get wordPieces(): WordDrain | undefined {
      // Undecided candidates and unselected words must not repeatedly flatten a growing prefix.
      return this.established() && this.retainsScalar() ? this.drainWord : undefined;
    }

    private fragmentWord(window: LexicalWindow, state: WordState, from: number): number {
      const at = window.cursor;
      const part = window.retainedSlice(from, at);
      // New whitespace cannot settle a literal or release layout; the lexer banks only this part.
      if (part.trimEnd() === "") return state.next - state.start - (state.parts?.length ?? 0);
      state.mark ??= window.mark(state.start - window.base);
      const text = (state.parts ?? "") + part;
      // Whitespace can still be trailing layout; a high surrogate may acquire its second unit.
      const stable = text.trimEnd();
      if (!this.streaming && (stable === "" || canBeLiteral(stable) || !this.beginStreamedString()))
        return state.next - state.start - (state.parts?.length ?? 0);
      let end = stable.length;
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd8_00 && last <= 0xdb_ff) end--;
      const prefix = text.slice(0, end);
      this.fragmentData(end === text.length ? text : ownText(prefix));
      if (at > from) state.prevChar = window.text.charCodeAt(at - 1);
      state.parts = window.retainedText(text.slice(end));
      state.next = window.absolute(at);
      return state.next - state.start - state.parts.length;
    }

    bankFragment(text: string, before: number, at: number): string {
      let end = text.length;
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd8_00 && last <= 0xdb_ff) end--;
      // Only the decoder tail remains owned; delivery must not create retained-storage credit.
      const held = text.length - end;
      if (held !== before) this.b.charge(held - before, at);
      this.fragmentData(text.slice(0, end));
      return text.slice(end);
    }

    finishFragmentWord(
      cursor: ScanCursor,
      word: string,
      depth: number,
      reader: ScalarReader,
      finish: (
        this: ScalarReader,
        text: string,
        start: number,
        end: number,
        cut: boolean,
      ) => string,
    ): ScalarRead {
      const window = cursor.window;
      const raw = window.wordRaw;
      // Earlier pieces left already; raw and word contain only the withheld tail.
      this.b.repair("unquoted-string", window.wordStart);
      return {
        status: "done",
        // The reader applies the same cut suffix and metadata as ordinary string recovery.
        value: finish.call(
          reader,
          word,
          cursor.relative(window.wordStart),
          cursor.pos - (raw.length - word.length),
          cursor.atEnd &&
            cursor.pos === cursor.length &&
            raw.trimEnd().length === raw.length &&
            depth > 0,
        ),
        quoted: false,
      };
    }

    /** Whether a string is being streamed as fragments right now. */
    get streaming(): boolean {
      return this.fragment !== undefined;
    }

    get fragmentPieces(): typeof fragmentPieces {
      // The selection feature owns shaping; the stream caches this only when fragments are requested.
      return fragmentPieces;
    }

    /** A decided piece of the string being streamed. Empty pieces are not delivered. */
    fragmentData(text: string): void {
      if (this.fragment === undefined || text.length === 0) return;
      this.out.push({ kind: "data", id: this.fragment.id, text });
      this.onDelivery();
    }
  }
  return FragmentSelection;
};

export const FragmentPicksConstructor = /* @__PURE__ */ fragmentPicksClass();
