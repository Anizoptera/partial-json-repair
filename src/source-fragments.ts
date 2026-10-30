// SPDX-License-Identifier: Apache-2.0

import { numberKind, wordValue, WORD_TEXT, SOURCE_VALUE } from "./bare-values";
import { ST_KEY, QUOTE, APOSTROPHE, isLiteralPrefix } from "./chars";
import type { Cut, SourceFragmentsFeature } from "./types";
import type { NumberDrain, WordDrain } from "./lexical-window";
import { StreamScalarReader } from "./stream-scalars";
import type { ScalarRead, QuotedSource } from "./scalar-reader";
import type { ScanCursor } from "./scan-cursor";
import type { ScanDiagnostics } from "./scan-diagnostics";
import type { ResolvedOptions } from "./options";
import type { SourceFragmentsImplementation, FilterFactory } from "./selection-feature";
import { SourcePicksConstructor } from "./source-picks";
import type { SourcePicks } from "./source-picks";
import { fragmentPositions } from "./positions";
import { isExactNumber } from "./exact-number";

// A pure feature factory makes even superclass evaluation disappear from unused imports.
const sourceFeature = (): SourceFragmentsImplementation => {
  class SourceScalarReader extends StreamScalarReader {
    private readonly picks: SourcePicks;

    constructor(cursor: ScanCursor, diagnostics: ScanDiagnostics, opts: ResolvedOptions) {
      super(cursor, diagnostics, opts);
      // This reader is installed only by the same feature factory that creates SourcePicks.
      this.picks = diagnostics.build.picks?.delivery as SourcePicks;
      const picks = this.picks;
      picks.window = cursor.window;
      picks.hasFailure = () => diagnostics.verdictAt(diagnostics.build.completed) !== undefined;
    }

    private begin(state: number, quoted = false): void {
      // Bare roots stay in the input window for candidacy; its rewind must not erase queued pieces.
      if (state !== ST_KEY && (quoted || this.diagnostics.build.stack.length > 0))
        this.picks.begin(this.cursor.pos + this.cursor.base);
    }

    override read(c: number, state: number, depth: number): ScalarRead {
      const window = this.cursor.window;
      const at = window.inWord
        ? window.wordStart
        : window.inNumber
          ? window.numberStart
          : this.cursor.pos + this.cursor.base;
      this.begin(state, c === QUOTE || c === APOSTROPHE);
      const result = super.read(c, state, depth);
      if (depth === 0 && result.status === "done" && !this.picks.streaming) this.picks.begin(at);
      if (this.picks.streaming && result.status === "done") {
        this.picks.part(this.cursor.pos + this.cursor.base, false);
        if (result.quoted) this.picks.scalar = "string";
        else if (result.value !== SOURCE_VALUE)
          this.picks.scalar =
            typeof result.value === "string"
              ? "string"
              : isExactNumber(result.value) ||
                  (typeof result.value === "number" && Number.isFinite(result.value))
                ? "number"
                : "literal";
      }
      return result;
    }

    override readQuoted(c: number, state: number, depth: number): ScalarRead<string> {
      this.begin(state, true);
      return super.readQuoted(c, state, depth);
    }

    override readWord(
      state: number,
      depth: number,
      prefix?: string,
      prefixStart?: number,
    ): ScalarRead<string> {
      this.begin(state);
      return super.readWord(state, depth, prefix, prefixStart);
    }

    protected override get quotedSource(): QuotedSource | undefined {
      // Selection owns both quote carry and delivery; no reader-local forwarding object is needed.
      return this.picks.streaming ? this.picks : undefined;
    }

    protected override retainsScalar(state: number, depth: number): boolean {
      return this.picks.streaming && !this.picks.root ? false : super.retainsScalar(state, depth);
    }

    protected override bank(
      text: string,
      before: number,
      start: number,
      ambiguous: boolean,
      until: number,
    ): string {
      if (!this.picks.streaming) return super.bank(text, before, start, ambiguous, until);
      this.picks.part(until, ambiguous);
      if (!this.picks.root) return "";
      this.diagnostics.build.charge(text.length - before, start + this.cursor.base);
      return text;
    }

    protected override scanNumber(depth: number, pieces?: NumberDrain): number {
      return super.scanNumber(depth, this.picks.streaming ? this.picks.numberDrain : pieces);
    }

    protected override wordPieces(state: number, depth: number): WordDrain | undefined {
      return this.picks.streaming && state !== ST_KEY
        ? this.picks.sourceWordDrain
        : super.wordPieces(state, depth);
    }

    protected override readNumber(
      depth: number,
      state: number,
      token: number,
    ): ReturnType<StreamScalarReader["readNumber"]> {
      if (!this.picks.streaming || this.picks.root) return super.readNumber(depth, state, token);
      this.picks.scalar = numberKind(this.cursor.window, this.diagnostics, this.opts, depth, token);
      return SOURCE_VALUE;
    }

    protected override finishWord(word: string, state: number, depth: number): ScalarRead {
      if (this.picks.root) return this.finishRetainedWord(word, state, depth);
      if (!this.picks.streaming) return super.finishWord(word, state, depth);
      const candidate = this.picks.candidate;
      const ends =
        this.cursor.atEnd && this.cursor.pos === this.cursor.length && !this.picks.trailingSpace;
      if (ends && candidate !== undefined && isLiteralPrefix(candidate)) return this.cutToken("");
      const value = wordValue(this.cursor.window, this.diagnostics, this.opts, candidate, depth);
      this.picks.scalar = value === WORD_TEXT || typeof value === "string" ? "string" : "literal";
      if (ends && this.picks.scalar === "string")
        this.cutValue("string", this.diagnostics.build.path(), "");
      return { status: "done", value: SOURCE_VALUE, quoted: false };
    }

    protected override cutValue(kind: "string" | "number", path: Cut["path"], text: string): void {
      super.cutValue(
        this.picks.streaming ? (this.picks.scalar === "string" ? "string" : kind) : kind,
        path,
        this.picks.streaming ? "" : text,
      );
    }

    protected override cutToken(raw: string): ScalarRead {
      const result = super.cutToken(this.picks.streaming && !this.picks.root ? "" : raw);
      if (this.picks.streaming) this.picks.finishScalar(this.cursor.pos + this.cursor.base, true);
      return result;
    }
  }

  const sourcePicks: FilterFactory = /* @__PURE__ */ Object.freeze(
    /* @__PURE__ */ Object.assign(
      (
        b: ConstructorParameters<typeof SourcePicksConstructor>[0],
        compiled: ConstructorParameters<typeof SourcePicksConstructor>[1],
        occurrences: boolean,
        mode: ConstructorParameters<typeof SourcePicksConstructor>[3],
      ) => new SourcePicksConstructor(b, compiled, occurrences, mode),
      { openFragmentHistory: fragmentPositions, streamReader: SourceScalarReader },
    ),
  );

  return Object.freeze({
    feature: "source-fragments",
    picks: sourcePicks,
  } satisfies SourceFragmentsImplementation);
};

/** Deliver selected scalar source text without constructing its complete recovered value. */
export const sourceFragments: SourceFragmentsFeature = /* @__PURE__ */ sourceFeature();
