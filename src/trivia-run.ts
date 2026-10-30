// SPDX-License-Identifier: Apache-2.0

import type { Builder } from "./builder";
import type { CandidateReader } from "./candidate-reader";
import type { ResolvedOptions } from "./options";
import type { ScanCursor } from "./scan-cursor";
import type { ScanDiagnostics } from "./scan-diagnostics";
import type { SwitchableRepair } from "./types";
import {
  TRIVIA_END,
  TRIVIA_ESCAPE,
  TRIVIA_READY,
  TRIVIA_SPACE,
  TRIVIA_START,
  TRIVIA_WAIT,
} from "./lexical-window";

/**
 * The whitespace and comments between two tokens, read as one run that can be undone.
 *
 * The scan keeps TWO rewind points, each marked where it rewinds TO, which is the whole correctness
 * argument. This run is the first: reading records a repair per comment, and a run that runs out
 * of input is read again from its start, so what it logged goes back with it. A mark taken later,
 * at the key branch say, cannot undo that, and the comment was counted twice for no reason but
 * where a chunk happened to end. The token's own rewind point sits after the run (`scan.ts`).
 *
 * A comment the run CLOSED is never read again. Re-reading a comment whose opener an earlier chunk
 * held lexes its tail as content: a block comment holding `a`, cut after the `a` and followed by a
 * lone slash, recovered the comment's tail and the slash as one word, where the whole text
 * recovered the slash alone. So a closed comment commits the run so far: the rewind point, both
 * logs' marks and the document's start move past it.
 */
export class TriviaRun {
  /** Where the run rewinds to: its start, or the end of the last comment it closed. Relative. */
  private from = 0;

  constructor(
    private readonly cursor: ScanCursor,
    private readonly build: Builder,
    private readonly diagnostics: ScanDiagnostics,
    private readonly candidate: CandidateReader,
    private readonly opts: ResolvedOptions,
  ) {}

  /** A run, or a word or number resuming from an earlier chunk, begins at relative `at`. */
  begin(at: number): void {
    this.from = at;
    this.build.beginTrivia();
    this.diagnostics.beginTrivia();
  }

  /**
   * Reads the run; false when the input ran out inside it and the scan must wait for more.
   *
   * `atRoot`: the run sits between roots, before the first or after a completed one, so trivia the
   * reader consumed is not content and a value after it still stands alone, the rule a byte-order
   * mark already gets.
   * Without it a scalar behind a comment was unreachable while an object behind the same comment
   * parsed: a container carries its own marks of data, and a scalar's only route is standing alone.
   * Reported while still inside a comment too, because the bytes read so far are trivia whatever the
   * rest turns out to be, and a comment split across chunks otherwise loses its own start once the
   * buffer drops the consumed prefix. Not for any other unfinished run: a lone `/` at a chunk's end
   * may be content.
   */
  read(atRoot: boolean): boolean {
    const cursor = this.cursor;
    this.consume(atRoot, true);
    if (atRoot && (!cursor.needMore || cursor.window.inComment))
      this.candidate.consumedLeading(this.from + cursor.base, cursor.pos + cursor.base);
    if (!cursor.needMore) return true;
    // Inside a comment the window carries the comment itself, so the next chunk continues it.
    if (!cursor.window.inComment) {
      cursor.pos = this.from;
      this.build.rewindTrivia();
      this.diagnostics.retractTrivia();
    }
    return false;
  }

  /**
   * Reads trivia after a held root. That read resumes where it stopped, never rewinding, so a closed
   * comment has nothing to commit, and the tail keeps its own marks (`beginTail`).
   */
  readonly skip = (): void => {
    this.consume(false, false);
  };

  private consume(atRoot: boolean, commit: boolean): void {
    const { cursor, build, opts } = this;
    for (;;) {
      const status = cursor.window.trivia(cursor.pos, cursor.atEnd);
      cursor.pos = cursor.window.cursor;
      if (status === TRIVIA_READY) return;
      if (status === TRIVIA_WAIT) {
        cursor.needMore = true;
        return;
      }
      if (status === TRIVIA_START) {
        this.lenient("comment-removed", cursor.window.commentStart);
        continue;
      }
      if (status === TRIVIA_ESCAPE) {
        this.lenient("escaped-delimiter", cursor.pos - 1 + cursor.base);
        build.edit(cursor.pos - 1 + cursor.base, cursor.pos + cursor.base, "");
        continue;
      }
      if (status === TRIVIA_SPACE) {
        this.lenient("non-json-whitespace", cursor.pos - 1 + cursor.base);
        build.edit(cursor.pos - 1 + cursor.base, cursor.pos + cursor.base, " ");
        continue;
      }
      if (status !== TRIVIA_END) continue;
      if (opts.recover["comment-removed"])
        build.edit(cursor.window.commentStart, cursor.window.commentEnd, "");
      if (!commit) continue;
      if (atRoot) this.candidate.consumedLeading(this.from + cursor.base, cursor.pos + cursor.base);
      this.begin(cursor.pos);
    }
  }

  /** Absolute `at`: a repair when the policy allows the construct, else its refusal. */
  private lenient(kind: SwitchableRepair, at: number): void {
    if (this.opts.recover[kind]) this.build.repair(kind, at);
    else this.diagnostics.fail("unparsable-span", at - this.cursor.base, kind);
  }
}
