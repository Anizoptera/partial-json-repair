// SPDX-License-Identifier: Apache-2.0

import type { PositionAt } from "./positions";
import { utf16At } from "./positions";
import type { ResolvedOptions } from "./options";
import type { Cut, Recovery, RepairKind, SwitchableRepair } from "./types";
import { cutNow } from "./cut";
import { DEFAULT_OPTIONS } from "./options";
import type { BuildMode } from "./builder";
import { IN_ARRAY, IN_OBJECT, MODE_VALUE, newMark } from "./builder";
import type { Pulled, ScanEnd, Scanner } from "./scan-contract";
import { scanReaders } from "./scan-readers";
export { collectScan } from "./scan-readers";
import {
  CANDIDATE_ACCEPT,
  CANDIDATE_HOLD,
  CANDIDATE_REJECT,
  COMMA_WAIT,
  CandidateReader,
  NO_COMMA,
} from "./candidate-reader";
import { ScanDiagnostics } from "./scan-diagnostics";
import { ScanCursor } from "./scan-cursor";
import { ScalarReader } from "./scalar-reader";
import { TriviaRun } from "./trivia-run";
import {
  APOSTROPHE,
  CLOSE_BRACE,
  CLOSE_BRACKET,
  COLON,
  COMMA,
  OPEN_BRACE,
  OPEN_BRACKET,
  QUOTE,
  ST_AFTER,
  ST_COLON,
  ST_KEY,
  ST_VALUE,
  ZERO,
} from "./chars";

/**
 * The scanner and the builder: one pass over the source, calling the builder directly.
 *
 * **Why one pass.** Every duplicated guard, divergent security check and re-parse in the package this
 * was extracted from existed because a second mechanism read the same bytes and disagreed with the
 * first. There is no event bus and no emitter: a seam with one consumer is a seam where nothing
 * varies, and a second consumer SHAPE makes every per-token call polymorphic — measured at 3.6x in
 * `bench/primitives.bench.ts`.
 *
 * **Why iterative.** `parseObject -> parseValue -> parseObject` recursion puts the nesting limit on
 * the JavaScript call stack, so the ceiling is a crash boundary rather than a budget and cannot be
 * raised safely. An explicit stack makes depth an ordinary number, and lets the scan stop between any
 * two characters — which is what streaming needs and what recursion cannot give.
 *
 * **Why the shapes are what they are** (all measured, `bench/AGENTS.md` carries the table): classification
 * through a `Uint8Array` beats regex `.test` per character by 10.3x and `switch` by 1.5x; a
 * `Uint8Array` depth stack beats `number[]` by 4.3x; `charCodeAt` beats indexing by only 1.09x but is
 * never worse and code-point ranges need the integer.
 */

/** The defaults are what a scanner does when nothing asks for more: no edit log, no fragments, no retained bound. */
export function createScanner(
  opts: ResolvedOptions = DEFAULT_OPTIONS,
  positionAt: PositionAt = utf16At,
  mode: BuildMode = MODE_VALUE,
  cursor: ScanCursor = new ScanCursor(
    positionAt,
    undefined,
    mode.streamReader ? "stream" : "whole",
  ),
  deferFinalSelections = false,
): Scanner {
  const relative = (absolute: number): number => cursor.relative(absolute);
  const maxDepth = opts.maxDepth;
  const diagnostics = new ScanDiagnostics(opts, cursor.window, mode);
  const build = diagnostics.build;
  const ledger = diagnostics.ledger;
  const reader =
    mode.streamReader === undefined
      ? ScalarReader
      : (opts.selection?.picks.streamReader ?? mode.streamReader);
  const scalars = new reader(cursor, diagnostics, opts);
  const candidate = new CandidateReader(cursor, diagnostics, scalars, opts);
  const trivia = new TriviaRun(cursor, build, diagnostics, candidate, opts);
  // A HELD root is undecided too: what follows its tail can still make it prose or a key, so a
  // refusal in that tail waits for the verdict instead of stopping before the next chunk is read.
  diagnostics.undecided = () => !candidate.established || candidate.held;
  /** Whether `settle` should pause the scan. Off unless a caller is pulling values one at a time. */
  let pausing = false;
  let paused = false;
  const picks = build.picks?.delivery;
  if (picks !== undefined) {
    picks.deferFinal = deferFinalSelections;
    picks.established = () => candidate.established;
    // A queued match or fragment is a stop for a consumer pulling one at a time, like a finished root.
    picks.onDelivery = () => {
      if (pausing) paused = true;
    };
  }

  const recordError = diagnostics.record.bind(diagnostics);
  const refuse = diagnostics.refuse.bind(diagnostics);
  const fail = diagnostics.fail.bind(diagnostics);

  /**
   * A leniency the options refused. The construct is consumed either way and reported as an error
   * instead of a repair, so the tree a caller gets does not change shape when they tighten a flag —
   * only the diagnostics do. See `ParserOptions`' leniency block for why that is the contract.
   */
  const lenient = (kind: SwitchableRepair, at: number): void => {
    if (opts.recover[kind]) repair(kind, at);
    else fail("unparsable-span", at, kind);
  };

  const repair = (kind: RepairKind, at: number): void => {
    build.repair(kind, at + cursor.base);
  };
  const edit = (start: number, end: number, text: string): void => {
    build.edit(start + cursor.base, end + cursor.base, text);
  };
  const open = (kind: number, at: number): boolean => build.open(kind, at + cursor.base);
  const placeValue = (item: unknown, at: number): boolean =>
    build.value(item, at + cursor.base, cursor.pos + cursor.base);
  const native = mode.nativeSlice?.(opts);
  /**
   * Units failed native attempts have read. A defect under k open containers fails each of their
   * attempts, so without a bound one defect costs k re-reads of the text. Capped at twice the input
   * seen so far, about two `JSON.parse` passes beside the scanner's own cost. Measured against what
   * has arrived, not the first slice: whole input reaches the scanner in slices, and a cap sized to
   * the first one was spent by a few ancestors before any later member could be built natively.
   */
  let nativeWaste = 0;
  /** Container kinds, innermost last. Capacity follows reached depth, not an untrusted declared cap. */
  let stack = new Uint8Array(Math.min(maxDepth, 32));
  const growStack = (): void => {
    if (depth < stack.length) return;
    const grown = new Uint8Array(Math.min(maxDepth, Math.max(1, stack.length * 2)));
    grown.set(stack);
    stack = grown;
  };
  let depth = 0;
  let state = ST_VALUE;
  /** Where the top-level value being assembled began, for its span. */
  let valueStart = 0;
  /**
   * Whether a comma was the last thing consumed. A closer arriving here means the comma had nothing
   * after it; `depth > 0` cannot answer that question, because a just-opened container has the same
   * depth as one sitting after a comma and `[]` would be charged for a trailing comma it never had.
   */
  let afterComma = false;
  /**
   * Where the comma that set `afterComma` sits. The closer that reveals it to be trailing is several
   * characters later — `[1, ,\n]` — so `cursor.pos - 1` names the bracket, not the comma `repair(text)`
   * has to remove.
   */
  let commaAt: number | undefined;
  /**
   * Where the key currently awaiting a value began, or -1. A key whose value never arrives is
   * DROPPED from the tree, so `repair(text)` has to drop it from the text too — and that needs the
   * key's start, which is several tokens behind by the time the closer reveals the problem.
   */
  let keyStart: number | undefined;
  let valueKeyStart: number | undefined;
  let valueCommaAt: number | undefined;
  type DroppedMember = { start: number; end: number; leadingComma: boolean };
  let pendingDrop: DroppedMember | undefined;
  const droppedContainers: (DroppedMember | undefined)[] = [];

  const droppedMember = (dropped: boolean, end: number): DroppedMember | undefined => {
    if (!dropped || valueKeyStart === undefined) return undefined;
    return {
      start: valueCommaAt ?? valueKeyStart,
      end,
      leadingComma: valueCommaAt !== undefined,
    };
  };

  /**
   * Drops the member whose key starts at absolute `keyAt` and whose value never arrived: from the
   * tree, the report and the repaired text, deleting through relative `end` and taking the comma
   * before the key with it, or `{"a":1,"b":}` would repair to a trailing comma.
   *
   * **The drop is itself a repair, and recording it AFTER the retraction is the whole point.**
   * Retracting is right — those entries described a member that is not in the tree — but on its own
   * it left the loss unreported: measured, `{"a":1, b}` returned `{"a":1}` at confidence 1.0 with
   * an empty repair log, while `STRICT` reported an `unparsable-span` for the same bytes. The
   * pending key is still set, so the repair's path names the member that went.
   */
  const dropMember = (keyAt: number, end: number): void => {
    build.retractMember();
    lenient("dropped-member", relative(keyAt));
    edit(relative(valueCommaAt ?? valueKeyStart ?? keyAt), end, "");
  };

  /**
   * A comma the input wrote and no member followed — `[1,2,]`, or `[1,2,` at the end. It is in
   * no value, so the repaired text loses it; otherwise the closer lands after it.
   */
  /**
   * A `{` or `[` where an object's NEXT member belongs: the object was cut and a new value began —
   * a truncated JSONL record followed by the next one, or `[{"x":1,` + `{"x":2}]` from a model that
   * dropped a closer. Read as a key, the opener became a zero-length unquoted key and the new value
   * nested under `""`, a key the source never wrote, swallowing every later record into the cut one
   * (`{"id":2,` + `{"id":3}` landed `{"id":2,"":{"id":3}}`). Closing here invents nothing: the
   * inserted `}` is reported like the one finalization adds at EOF, and the opener is read again by
   * the parent, as the next array element or the next root.
   *
   * Not the object's FIRST member: `{{name}}` is a template marker, judged by candidacy instead.
   */
  const closeInterrupted = (): void => {
    afterComma = false;
    lenient("unclosed-object", cursor.pos);
    edit(cursor.pos, cursor.pos, "}");
  };

  const dropTrailingComma = (): void => {
    if (!afterComma || commaAt === undefined) return;
    lenient("trailing-comma", relative(commaAt));
    edit(relative(commaAt), relative(commaAt) + 1, "");
  };

  // One record per site, reused: marking is several times a token in the object loop, and a fresh
  // object there is a measured 8% of a damaged-document parse. The scanner has no recursion, so a
  // site's mark cannot be live twice.
  const keyMark = newMark();
  const valueMark = newMark();
  build.startMember();

  /**
   * Skips whatever separates two tokens: whitespace, and comments JSON forbids and models emit.
   *
   * Comments are handled HERE rather than in a pre-pass over the text, which is what the extracted
   * package did. A pre-pass cannot tell `//` inside a string from a comment without parsing the
   * string, so it either strips inside string literals or re-implements string scanning to avoid it.
   * Between tokens is the only place a comment can begin, so this is the only place that has to ask.
   */
  /**
   * A token the input cut short goes back to the next pass with everything it recorded, and stays
   * in progress (`rewound`) until that pass begins it again: the budget stops between tokens, never
   * inside one, and a stop landing first dropped a token one whole read finishes — `{name "Joh` +
   * `n"}` under `STRICT` recovered `{}` against `{name: "John"}`. Its marks stay: a mark is not unseen.
   */
  let rewound = false;
  const rewindToken = (to: number): void => {
    cursor.pos = to;
    build.rewindToken();
    diagnostics.retractToken();
    rewound = true;
  };
  /**
   * Keeps a finished ROOT scalar out of the results until the input ends, because it is complete
   * and still not a value: text in the next chunk can make it prose, and a delivered value cannot
   * be withdrawn. Held exactly as a standalone container is, so a stream can only ever answer what
   * the whole document answers.
   *
   * Without it the answer depended on chunk SIZE: `"just a ` + `string"` + ` and more` delivered
   * `"just a string"` and could not take it back, while `"just` + ` a string"` + ` and more` and
   * the whole text at once both answer `no-json-found`. Banking a resumable string needs ~8
   * characters, so the accident was invisible on short cases.
   */
  const holdRoot = (): void => {
    candidate.hold(cursor.pos + cursor.base, true);
    cursor.needMore = true;
  };

  /** Closes off whatever was just finished: a top-level value and its span, or a container member. */
  const settle = (end = cursor.pos + cursor.base): void => {
    if (depth === 0) {
      // Absolute, like every other position: a caller's offsets refer to the text they fed, not to
      // the slice of it the parser still holds after compaction.
      // Only a root scalar the reader saw reach the end of input can be cut here (`"abc`).
      const cut = scalars.cut !== undefined && end === cursor.length + cursor.base;
      diagnostics.finishRoot(valueStart, end, cut ? openCut() : undefined);
      diagnostics.decide();
      candidate.afterRoot(end);
      state = ST_VALUE;
      valueStart = cursor.pos + cursor.base;
      candidate.begin();
      // `parseMany` promises a generator that has NOT already parsed the rest, which is a promise
      // only the scan can keep — an iterator over a finished array would be a lie in the signature.
      // The pause is what makes it true, and it costs one boolean on a path that runs once per value.
      if (pausing) paused = true;
    } else {
      state = ST_AFTER;
    }
    // Cleared where a member is PLACED, never where one is merely attempted. `afterComma` answers
    // "did the input write a separator that no member ever followed", which is what decides both the
    // trailing-comma repair and the dangling comma at end of input. Clearing it when a token begins
    // made a stray character swallow the question: `[2,}` skipped the brace, lost the flag, and
    // repaired to `[2,]`.
    afterComma = false;
  };

  /**
   * Whether this character ends the innermost open container, WHATEVER its shape. Each state used to
   * test for one shape and let the other fall through into ordinary-character handling, which is how
   * `{"a":2,]` grew a member under an empty key and `{]` repaired to `{"":}`. A closer is a closer;
   * `closeShape` is what makes the repaired text agree with the reading.
   */
  const closesContainer = (c: number): boolean =>
    depth > 0 && (c === CLOSE_BRACE || c === CLOSE_BRACKET);

  /**
   * A closer of the wrong shape still closes the container it lands in — `[{"b":2]` is an array
   * holding an object, not an array holding a brace, and every lenient parser reads it that way.
   * The VALUE has always been read like this; what was missing is the edit, so `repair` produced
   * `[{"b":2]]` — the appended closer for the container this one failed to close, with the wrong
   * bracket still sitting there. Rewriting the character is the smallest edit that makes the
   * repaired text say what the value says.
   *
   * Reported, because the parser read a character as something other than what it is, and a
   * consumer must always be able to tell that from a document that was written correctly. Same
   * axis as `quote-mismatch`, which is this rule for the two quote styles.
   */
  const closeShape = (c: number, at: number): void => {
    const object = stack[depth - 1] === IN_OBJECT;
    if (object === (c === CLOSE_BRACE)) return;
    lenient("bracket-mismatch", at);
    edit(at, at + 1, object ? "}" : "]");
  };

  /**
   * Closes the innermost container, judging it if that leaves nothing open. False means the scan
   * must return: the candidate is standing alone so far and only more input can settle it.
   *
   * The judgement asks whether the candidate just finished is data rather than punctuation that
   * happened to balance; CandidateReader owns the evidence and verdict. The standalone exemption
   * needs the text to end here as well as to start at trimmed input, and in a stream that is
   * unanswerable until the text ends — the same asymmetry the standalone-scalar rule lives with.
   * `HOLD` is that third answer: rewind and wait rather than guess, or a one-shot parse of
   * `{} and prose` and a chunked one would disagree, which the corpus-wide chunking property would
   * catch as a defect and would BE one.
   */
  const closeContainer = (): boolean => {
    const dropped = droppedContainers[depth];
    droppedContainers[depth] = undefined;
    depth--;
    build.close(cursor.pos + cursor.base);
    if (depth === 0) {
      const verdict = candidate.judge(valueStart);
      if (verdict !== CANDIDATE_ACCEPT) {
        if (verdict === CANDIDATE_HOLD) {
          candidate.hold(cursor.pos + cursor.base, false);
          keyStart = undefined;
          state = ST_VALUE;
          return resolveHeld();
        }
        // The candidate is not a value, so nothing it recorded describes one. Both logs go back with
        // it, or `repair(text)` would splice changes into prose that no result explains.
        candidate.reject();
        keyStart = undefined;
        state = ST_VALUE;
        valueStart = cursor.pos + cursor.base;
        return true;
      }
      // Accepted, and held only until the next character shows whether a list begins.
      if (candidate.lists) {
        candidate.hold(cursor.pos + cursor.base, false, true);
        keyStart = undefined;
        state = ST_VALUE;
        return resolveHeld();
      }
    }
    if (dropped !== undefined) pendingDrop = { ...dropped, end: cursor.pos + cursor.base };
    settle();
    return true;
  };

  /**
   * A U+FEFF opening the source is a byte-order mark: an encoding declaration, never content, and
   * one `JSON.parse` refuses. It is dropped with a free repair and an edit, so repaired text starts
   * where JSON does. Only the FIRST character of the logical source — a later U+FEFF is data.
   */
  let bomDecided = false;
  const stripBom = (): void => {
    if (bomDecided || cursor.length === 0) return;
    bomDecided = true;
    if (cursor.base !== 0 || cursor.text.charCodeAt(0) !== 0xfeff) return;
    lenient("bom-removed", 0);
    if (opts.recover["bom-removed"]) build.edit(0, 1, "");
    // Consumed before the loop starts, and the source's start moves past it, so the value after
    // it is judged standalone: the mark is not prose in front of the value.
    cursor.pos = 1;
    valueStart = 1;
    candidate.startAt(1);
  };

  /** Reads the window, then each queued piece in turn, until input, a pause or a stop ends it. */
  const run = (): void => {
    // A limit's decoded prefix still serves failed recovery; no later pull may clear it.
    if (diagnostics.terminalFailure !== undefined) return;
    do {
      do {
        runWindow();
        if (paused || diagnostics.exhausted || diagnostics.terminalFailure !== undefined) return;
        // An ambiguous string batch has no deliverable text; it is not a request for more input.
      } while (scalars.deliveryPaused);
      const malformed = cursor.takeMalformed();
      if (malformed !== undefined) diagnostics.malformedUtf8(malformed, state === ST_KEY);
    } while (cursor.advance());
  };

  /** Consume a held root's trailing trivia now; wait only when the source has not settled. */
  const resolveHeld = (): boolean => {
    cursor.needMore = false;
    const held = candidate.resolveHeld(trivia.skip);
    if (held.kind === "wait") {
      cursor.needMore = true;
      return false;
    }
    if (held.kind === "completed") settle(held.end);
    else if (held.kind === "rejected") valueStart = cursor.pos + cursor.base;
    else if (held.kind === "list") openList(held.end as number);
    return true;
  };

  /**
   * Values separated by commas with no brackets around them (`1,2,3`, `{..},{..}`, MongoDB shell
   * output) are one array the source forgot to bracket: P1 finishes missing structure, and reading
   * them as separate roots returned only the first, silently. A finished root touched by a comma
   * (`CandidateReader.commaAfter`) opens a list, and the list becomes real only when a second value
   * begins after that comma: the root is then wrapped in place as element 0 of an open array frame
   * (`Builder.wrapRoot`), the brackets are inserted as edits and reported once as
   * `missing-brackets`, and the ordinary array states read the rest. Wrapping no earlier means a
   * list of one never exists, so no view ever shows `[root]` that must later turn back into `root`.
   *
   * The list continues only while a comma touches each element and each next element is spelled as
   * JSON spells a value, so prose ends it. A comma that no value follows leaves the root alone. A
   * list led by a root with a mark of data settles whatever follows it; one led by a markless root
   * (`1, 2 and 3`) must stand alone exactly as that root had to, or it is prose.
   */
  type List = { marked: boolean; rootEnd: number; memberEnd: number; wrapped: boolean };
  let list: List | undefined;

  /** A comma touched the finished root ending at absolute `rootEnd`; the cursor is on it. */
  const openList = (rootEnd: number): void => {
    list = { marked: candidate.heldMarked, rootEnd, memberEnd: rootEnd, wrapped: false };
    // Before any refusal in the list, so a spent budget waits for a markless list's verdict.
    candidate.pendingList = !list.marked;
    cursor.pos++;
    state = ST_VALUE;
  };

  /** A second value begins at the cursor: the root becomes element 0 of the list. */
  const wrapList = (current: List): void => {
    current.wrapped = true;
    diagnostics.nestOpenRoot();
    lenient("missing-brackets", cursor.pos);
    build.wrapRoot(cursor.pos + cursor.base, valueStart, candidate.rootEdits);
    build.startMember();
    growStack();
    stack[depth++] = IN_ARRAY;
  };

  /** Ends the list, closing a wrapped one after its last element; answers where the root ends. */
  const closeList = (current: List): number => {
    list = undefined;
    candidate.pendingList = false;
    if (current.wrapped) {
      depth = 0;
      build.close(current.memberEnd);
      build.edit(current.memberEnd, current.memberEnd, "]");
      return current.memberEnd;
    }
    return current.rootEnd;
  };

  /** Ends the list mid-scan; false means the scan must wait, as `resolveHeld` does. */
  const endList = (current: List): boolean => {
    state = ST_VALUE;
    const end = closeList(current);
    if (current.marked) settle(end);
    else if (current.wrapped) {
      candidate.hold(end, false);
      return resolveHeld();
    } else {
      // A markless value, a comma, then no value: `1, and so on` is a sentence.
      candidate.reject();
      valueStart = cursor.pos + cursor.base;
    }
    return true;
  };

  const LIST_READ = 0;
  const LIST_NEXT = 1;
  const LIST_WAIT = 2;
  /**
   * The list step where the ordinary array states cannot decide: after an element, whether a comma
   * touches it (read before trivia, which could cross a line); after a comma, whether a value
   * follows. Answers whether the token loop reads on, re-enters, or returns.
   */
  const listStep = (current: List): number => {
    if (state === ST_AFTER) {
      const comma = candidate.commaAfter();
      if (comma === COMMA_WAIT) {
        cursor.needMore = true;
        return LIST_WAIT;
      }
      current.memberEnd = cursor.pos + cursor.base;
      if (comma !== NO_COMMA) {
        cursor.pos = comma;
        return LIST_READ;
      }
    } else {
      const next = candidate.rootStartsAt(cursor.pos);
      if (next === CANDIDATE_HOLD) {
        cursor.needMore = true;
        return LIST_WAIT;
      }
      if (next !== CANDIDATE_REJECT) {
        if (!current.wrapped) wrapList(current);
        return LIST_READ;
      }
    }
    return endList(current) ? LIST_NEXT : LIST_WAIT;
  };

  const stopped = (): boolean => {
    // A budget spent while the candidate was undecided lands the moment it shows a mark of data, so
    // a document keeps its one refusal under `STRICT` exactly as if the stop had never waited.
    // Never while a finished root is HELD: what follows can still show it to be prose, which takes
    // its errors with it. `" // c\n"key"` + `: 1` under `STRICT` stopped on `"key"` mid-hold, where
    // the whole text answers `no-json-found`.
    if (diagnostics.deferring && candidate.established && !candidate.held) diagnostics.decide();
    return (
      diagnostics.exhausted &&
      !rewound &&
      scalars.continuation === undefined &&
      !cursor.window.inComment &&
      !cursor.window.inWord &&
      !cursor.window.inNumber
    );
  };

  /**
   * Continues a pending string until completion or a delivery/input boundary. Kept outside
   * `runWindow` so the main token loop stays within its JIT budget.
   */
  const resumeString = (openedAt: number, quote: number): boolean => {
    const token = scalars.readQuoted(quote, state, depth);
    if (token.status === "wait") return false;
    candidate.noteQuoted(token.quoted);
    if (state === ST_KEY) {
      afterComma = false;
      build.key(token.value, openedAt);
      diagnostics.keyRead();
      valueKeyStart = keyStart;
      valueCommaAt = commaAt;
      state = ST_COLON;
      return true;
    }
    // A root string that waited never reached the reader's `start`, so its span began where the
    // scan did, leading whitespace included.
    if (depth === 0) valueStart = openedAt;
    // Quote replay can rebase the window; locate the preserved absolute opener after that read.
    const openAt = openedAt - cursor.base;
    pendingDrop = droppedMember(placeValue(token.value, openAt), cursor.pos + cursor.base);
    if (depth === 0 && !cursor.atEnd) {
      holdRoot();
      return false;
    }
    settle();
    return true;
  };

  /**
   * An opener past `maxDepth`; whether the scan goes on.
   *
   * **The budget is a resource bound, not a crash boundary. Nothing throws.** The container is placed
   * EMPTY and its contents are skipped: dropping it outright would leave the parent's pending key
   * waiting and silently shift every later member, and building it would defeat the bound.
   * Structure kept, contents dropped, caller told — which is the honest reading of a budget being
   * exhausted.
   */
  const skipTooDeep = (kind: number): boolean => {
    fail("depth-budget", cursor.pos);
    const dropped = open(kind, cursor.pos);
    // The placeholder is empty, so its extent is its opener; the skipped content belongs to nothing
    // that was built, and the `depth-budget` error names where it began.
    build.close(cursor.pos + 1 + cursor.base);
    candidate.startSkip();
    if (!candidate.finishSkip()) return false;
    pendingDrop = droppedMember(dropped, cursor.pos + cursor.base);
    settle();
    return true;
  };

  /** Deletes a dropped member's text; whether it took the separator `c` with it. */
  const takePendingDrop = (drop: DroppedMember, c: number): boolean => {
    const consumeComma = !drop.leadingComma && c === COMMA;
    if (consumeComma) build.rewindTrivia();
    edit(
      relative(drop.start),
      relative(consumeComma ? cursor.pos + cursor.base + 1 : drop.end),
      "",
    );
    pendingDrop = undefined;
    if (!consumeComma) return false;
    // This separator went with the dropped member, so the next member starts HERE and not at the
    // shared mark the caller sets, which still stands before the deletion just emitted. Two governed
    // keys in a row otherwise retract the first one's deletion with the second member:
    // `{"__proto__":1,"constructor":2,"ok":3}` kept `"__proto__":1` in the text.
    build.startMember();
    cursor.pos++;
    state = stack[depth - 1] === IN_OBJECT ? ST_KEY : ST_VALUE;
    return true;
  };

  /**
   * The input ended inside a literal or number it never finished (`{"a": tru`, `[1, 1e`). No value
   * is placed and nothing the token logged survives; the member or element is dropped exactly as if
   * its value had never arrived, and the drop is reported. The repaired text loses the token too —
   * and, in an object, the key that announced it.
   */
  const dropCutToken = (scalarStart: number): void => {
    build.retract(valueMark);
    build.rewindToken();
    diagnostics.retractToken();
    // `valueKeyStart`, not `keyStart`: a token the previous chunk left unfinished is re-read from
    // its own start, and that rewind does not restore `keyStart`.
    if (valueKeyStart !== undefined && stack[depth - 1] === IN_OBJECT) {
      dropMember(valueKeyStart, cursor.length);
    } else {
      lenient("dropped-member", scalarStart);
      edit(scalarStart, cursor.length, "");
    }
    cursor.pos = cursor.length;
  };

  /**
   * Scans as far as the buffer allows, then returns. Called once for a one-shot parse and once per
   * chunk for a stream — one loop, never two, because a second scan of the same bytes by a second
   * mechanism is the root cause under most of the defect register.
   *
   * **Keep its bytecode cost under JavaScriptCore's inlining limit (10 000), with headroom.** Above it
   * the optimising JIT inlines nothing into this function, and every cursor, reader and builder call
   * in the loop stays a real call: crossing it by a few units made `scan` 1.3-1.9x slower on Bun.
   * Move a branch that runs at most once per token or per window into its own function, as
   * `resumeString`, `skipTooDeep`, `takePendingDrop` and `dropCutToken` are. `jit:check` measures it.
   */
  const runWindow = (): void => {
    scalars.beginRun();
    if (!resolveHeld()) return;
    if (candidate.hasSkip) {
      if (!candidate.finishSkip()) return;
      settle();
      if (paused || diagnostics.exhausted) return;
    }
    candidate.trim();
    // A string continuation can sit exactly at the end of the text: a decoded prefix ending in an
    // escape is banked with its resume point past the last character, so no character is left to
    // enter the loop. At end of input it must still run once, or the open string — and the member
    // holding it — vanished without a report: `{"a":"x\u00e9` parsed to `{}`.
    while (
      cursor.pos < cursor.length ||
      cursor.window.inWord ||
      cursor.window.inNumber ||
      (cursor.atEnd && scalars.continuation !== undefined)
    ) {
      // The budget is a stop, not a throw: whatever was built so far is still handed back. Tested
      // here rather than in the loop condition because `fail` sets it, which no static reader of
      // the condition can see.
      //
      // It stops the scan BETWEEN tokens, never inside one. A token whose own first character was
      // the refusal would otherwise be abandoned half-read, losing the data the refusal is about:
      // `'; DROP TABLE users; --` under `maxErrors: 1` spent the budget on its opening quote and
      // came back `no-json-found` — no value, and not even the refusal that explained it, since a
      // scan that read nothing has nothing to report. Finishing the token costs no further errors;
      // `record` is already closed.
      if (stopped() || paused || diagnostics.terminalFailure !== undefined) return;
      const continuation = scalars.continuation;
      if (continuation !== undefined) {
        if (resumeString(continuation.open, continuation.quote)) continue;
        return;
      }
      if (list !== undefined && depth === 1 && state === ST_AFTER) {
        const step = listStep(list);
        if (step === LIST_WAIT) return;
        if (step === LIST_NEXT) continue;
      }
      /**
       * Where this token began, so a reader that runs out of input mid-token can be undone. EVERY
       * token rewinds here, strings included.
       *
       * **The rewind prevents an escape from deciding on absent input.** Quote ambiguity separately
       * banks its undecidable suffix until a true closer settles which reading wins.
       *
       * **Its price is paid in full only by short tokens, and `strResume` is why.** Rewinding one
       * long string on every chunk is quadratic, so a string banks the prefix it has already decided
       * and rewinds only its last `LOOKAHEAD` characters. Keys are strings and resume with them. What
       * still re-reads in full is a literal, at most five characters. Numbers resume after their
       * scanned prefix even when root candidacy requires retaining that prefix; their unbounded
       * grammar is still constrained by the scalar or retained-source limit.
       */
      const continuingWord = cursor.window.inWord;
      const continuingNumber = cursor.window.inNumber;
      if (continuingWord || continuingNumber) cursor.pos = cursor.window.cursor;
      // The trivia run is the first of the scan's two rewind points (`TriviaRun`). On the
      // continuing-token path it only marks: `cursor.pos` is the TOKEN's end there, and reading that
      // as the end of a trivia run would move the document's start past the very value being read.
      trivia.begin(
        continuingWord
          ? relative(cursor.window.wordStart)
          : continuingNumber
            ? relative(cursor.window.numberStart)
            : cursor.pos,
      );
      if (!continuingWord && !continuingNumber && !trivia.read(depth === 0)) return;
      // Checked between the trivia and the token too, or a whole read took one token more than a
      // stream whose chunk ended inside that trivia: `{"a": 1 /* c */}` under `STRICT`.
      if (stopped()) return;
      // Before the token's rewind point: the list's own records belong to no token, and a token cut
      // by the chunk end would otherwise take the brackets' report back with it.
      if (
        list !== undefined &&
        depth === (list.wrapped ? 1 : 0) &&
        state === ST_VALUE &&
        cursor.pos < cursor.length &&
        !continuingWord &&
        !continuingNumber
      ) {
        const step = listStep(list);
        if (step === LIST_WAIT) return;
        if (step === LIST_NEXT) continue;
      }
      // The TOKEN's rewind point sits AFTER the trivia, and the separation is what keeps a re-read
      // honest: rewinding THROUGH consumed trivia lexes it again, and once a chunk boundary has
      // split a comment the second reading differs — `/*a*//*b*/42` cut inside the first comment
      // rewound onto its middle, where the two slashes that remain open a LINE comment and swallow
      // the rest of the document. The trivia keeps its own mark above, so nothing is logged twice.
      const tokenStart = continuingWord
        ? relative(cursor.window.wordStart)
        : continuingNumber
          ? relative(cursor.window.numberStart)
          : cursor.pos;
      build.beginToken();
      diagnostics.beginToken();
      rewound = false;
      if (cursor.pos >= cursor.length && !continuingWord && !continuingNumber) break;
      const c = continuingWord
        ? 0x61
        : continuingNumber
          ? ZERO
          : cursor.text.charCodeAt(cursor.pos);

      if (state === ST_AFTER) {
        if (pendingDrop !== undefined && takePendingDrop(pendingDrop, c)) continue;
        build.startMember();
        if (c === COMMA) {
          commaAt = cursor.pos + cursor.base;
          cursor.pos++;
          afterComma = true;
          state = stack[depth - 1] === IN_OBJECT ? ST_KEY : ST_VALUE;
          continue;
        }
        if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
          closeShape(c, cursor.pos);
          cursor.pos++;
          if (!closeContainer()) return;
          continue;
        }
        if ((c === OPEN_BRACE || c === OPEN_BRACKET) && stack[depth - 1] === IN_OBJECT) {
          closeInterrupted();
          if (!closeContainer()) return;
          continue;
        }
        // Anything else where a separator belongs is a member the input forgot to punctuate.
        commaAt = undefined;
        lenient("missing-comma", cursor.pos);
        edit(cursor.pos, cursor.pos, ",");
        state = stack[depth - 1] === IN_OBJECT ? ST_KEY : ST_VALUE;
        continue;
      }

      if ((state === ST_KEY || state === ST_VALUE) && c === COMMA && depth > 0) {
        // A second separator where a member belongs. `{"a":1,,"b":2}` otherwise reads the empty span
        // as a key and lands `{"a":1,"":2}` — a member the input never wrote, under a key it never
        // named. Free, like every other repair that guessed nothing.
        cursor.pos++;
        // Same leniency axis: an extra comma is an extra comma wherever it sits, and RFC 8259
        // forbids both spellings, so one flag governing one of them would be arbitrary.
        lenient("trailing-comma", cursor.pos - 1);
        edit(cursor.pos - 1, cursor.pos, "");
        continue;
      }

      if (state === ST_KEY) {
        if (closesContainer(c)) {
          closeShape(c, cursor.pos);
          cursor.pos++;
          dropTrailingComma();
          if (!closeContainer()) return;
          continue;
        }
        // A comma already committed this object to another member, so this is not its first key.
        if (afterComma && (c === OPEN_BRACE || c === OPEN_BRACKET)) {
          dropTrailingComma();
          closeInterrupted();
          if (!closeContainer()) return;
          continue;
        }
        // A `{` or `[` where the root object's FIRST key belongs — `{{name}}` and friends. No
        // leniency reads a container opener as a key, which is why this overrides the marks-of-data
        // rule instead of joining it. The member is still read, so the tree stays the shape every
        // other preset gives it and only the candidacy verdict changes.
        //
        // `placed === 0` is what keeps it to the FIRST key, and it is load-bearing. Once members
        // have been placed, an opener where a key belongs is the reader having landed with the
        // wrong expectation — an ordinary recovery mistake — not proof the text holds no JSON.
        // Without it one bad guess rejected the WHOLE document: a mis-read unquoted value shifted
        // the reader by one member, so `tags: [...]` five lines later arrived in key position, and
        // the candidate was retracted along with its repairs and errors. Seven recoverable fields
        // came back as `no-json-found` with nothing to say why.
        if (depth === 1 && build.placed === 0 && (c === OPEN_BRACE || c === OPEN_BRACKET))
          candidate.noteBraceKey();
        build.markInto(keyMark);
        keyStart = continuingWord ? cursor.window.wordStart : cursor.pos + cursor.base;
        const token =
          c === QUOTE || c === APOSTROPHE
            ? scalars.readQuoted(c, state, depth)
            : scalars.readWord(state, depth);
        const name = token.value;
        candidate.noteQuoted(token.quoted);
        if (token.status === "stopped") return;
        if (cursor.needMore) {
          if (scalars.continuation !== undefined || cursor.window.inWord) return;
          // A chunk boundary inside a KEY. Without this the half-read name becomes a real key and
          // the rest of it is parsed as structure: `{"a":1} {"b` + `":2}` landed `{"":":2}"}`.
          // `afterComma` is cleared only below, so rewinding leaves it exactly as this chunk found it.
          // The half-read NAME is dropped with it: see `partial` for why a key is not shown.
          scalars.clearPending();
          build.retract(keyMark);
          rewindToken(tokenStart);
          return;
        }
        afterComma = false;
        if (c !== QUOTE && c !== APOSTROPHE) {
          // A bare word where a key belongs. Recorded before the key is placed, so the repair's path
          // does not name the very key it is reporting.
          const start = relative(cursor.window.wordStart);
          if (opts.recover["unquoted-key"]) repair("unquoted-key", start);
          else recordError(cursor.window.tokenError("unparsable-span", "unquoted-key"));
          edit(start, cursor.pos, JSON.stringify(name));
        }
        build.key(name, keyStart ?? cursor.pos + cursor.base);
        diagnostics.keyRead();
        valueKeyStart = build.memberStart(keyStart);
        valueCommaAt = commaAt;
        state = ST_COLON;
        continue;
      }

      if (state === ST_COLON) {
        if (c === COLON) {
          // A colon the SOURCE wrote is a mark of data in a way an inferred one is not
          // — `{{placeholder}}` gets its colon from the repair below and must not qualify on it.
          candidate.noteColon();
          cursor.pos++;
        } else if (c === COMMA) {
          // A key with no value is not a member. `{a: 12 34, b: 2}` otherwise made a key of `34`,
          // and the missing colon let `b: 2` become its value — destroying the member outright.
          // The separator is the proof: whatever the source wrote, it wrote nothing between this
          // token and the next member, so there is no value here to keep. The same holds when a
          // closer follows instead, which `ST_VALUE` below has always handled; this is that rule
          // reaching the other delimiter.
          //
          // NOT "the comma before it was inferred too" — measured against the corpus, that drops
          // `"age" 30` on the line after a member that forgot its comma, which is an ordinary
          // member missing both marks and every byte of it is real.
          dropMember(keyStart ?? cursor.pos + cursor.base, cursor.pos);
          keyStart = undefined;
          state = ST_AFTER;
          continue;
        } else {
          lenient("missing-colon", cursor.pos);
          edit(cursor.pos, cursor.pos, ":");
        }
        state = ST_VALUE;
        continue;
      }

      // ST_VALUE
      if (closesContainer(c) && stack[depth - 1] === IN_OBJECT) {
        // `{"a":}` — the key was announced and the value never arrived. Closing here rather than
        // letting the brace fall through as prose keeps every later container at the right depth.
        const closerAt = cursor.pos;
        cursor.pos++;
        lenient("missing-comma", cursor.pos - 1);
        // The brace closes the object and the dangling key is dropped from the TREE, so the repaired
        // TEXT drops it too — a comma here would leave `{"a": ,}`.
        if (keyStart !== undefined) dropMember(keyStart, cursor.pos - 1);
        // AFTER the retraction above, never before: `retract` takes everything logged since the
        // member began, and a shape edit recorded first went with it — `{"a" ]` repaired to `{]`.
        closeShape(c, closerAt);
        keyStart = undefined;
        if (!closeContainer()) return;
        continue;
      }
      if (closesContainer(c) && stack[depth - 1] === IN_ARRAY) {
        closeShape(c, cursor.pos);
        cursor.pos++;
        dropTrailingComma();
        if (!closeContainer()) return;
        continue;
      }
      keyStart = undefined;
      // No value begins with a colon, so one here, inside a container, is a doubled separator:
      // `{"a"::1}` means `{"a":1}`. Read as a word instead it became the string `":1"` at near-full
      // confidence, a wrong value that looks right. Decided by this character alone, so every
      // chunk split agrees. Mid-word it is content (`{a: b:c}`); at the root it is prose.
      if (c === COLON && depth > 0 && !continuingWord && !continuingNumber) {
        lenient("extra-colon", cursor.pos);
        edit(cursor.pos, cursor.pos + 1, "");
        cursor.pos++;
        continue;
      }
      if (c === OPEN_BRACE || c === OPEN_BRACKET) {
        const kind = c === OPEN_BRACE ? IN_OBJECT : IN_ARRAY;
        // A member that closes undamaged is valid JSON: build it natively (`native-slice.ts`). Not
        // at the root, whose candidacy and settling the whole-text route already owns, nor before
        // the root is known to be data, since prose candidacy reads every mark a member holds. Nor
        // once the error budget is spent or a spent budget waits to land: the scan stops after the
        // next token, and a member read whole would make that token the member instead of its
        // opener (`{"a":1},{"b":2}` under STRICT).
        if (
          native !== undefined &&
          depth > 0 &&
          state === ST_VALUE &&
          candidate.established &&
          !diagnostics.deferring &&
          !diagnostics.exhausted
        ) {
          const sliced =
            nativeWaste < 2 * (cursor.base + cursor.length)
              ? native(
                  cursor.text,
                  cursor.pos,
                  cursor.length,
                  maxDepth - depth,
                  stack[depth - 1] === IN_ARRAY,
                )
              : undefined;
          if (typeof sliced === "number") nativeWaste += sliced;
          else if (sliced !== undefined) {
            const at = cursor.pos;
            cursor.pos = sliced.end;
            if (sliced.run) for (const value of sliced.value as unknown[]) placeValue(value, at);
            else
              pendingDrop = droppedMember(placeValue(sliced.value, at), cursor.pos + cursor.base);
            settle();
            continue;
          }
        }
        if (depth >= maxDepth) {
          if (skipTooDeep(kind)) continue;
          return;
        }
        if (depth === 0) {
          valueStart = cursor.pos + cursor.base;
          candidate.begin();
        }
        growStack();
        stack[depth++] = kind;
        const policyDropped = open(kind, cursor.pos);
        cursor.pos++;
        const dropped = droppedMember(policyDropped, cursor.pos + cursor.base);
        if (dropped !== undefined) droppedContainers[depth] = dropped;
        // A container's FIRST member has no separator before it, so nothing has set these for it.
        // Set here rather than left stale, or dropping a dangling key in `{{invalid}}` retracts the
        // enclosing object's own key edits and repairs `{"":{}}` back to `{{}}`. `commaAt` is the
        // same hazard one level out: it is the separator of the container being FILLED, and leaving
        // the parent's behind made the drop in `[1, {x}, 2]` delete from the ARRAY's comma, repairing
        // the text to `[1}, 2]`.
        build.startMember();
        commaAt = undefined;
        // Opening a container COMMITS the member the separator was waiting for. Without this the
        // inner container inherits the outer's pending separator: `[1,[}]` read the inner `}` as a
        // close after a comma and deleted the OUTER comma, repairing the text to nothing.
        afterComma = false;
        state = kind === IN_OBJECT ? ST_KEY : ST_VALUE;
        continue;
      }
      if (depth === 0) {
        const fence = candidate.readFence();
        if (fence === "wait") return;
        if (fence === "consumed") continue;
        const result = candidate.readTopLevelScalar(c, state, depth);
        if (result.kind === "wait") return;
        if (result.kind === "skip") continue;
        valueStart = result.start;
        placeValue(result.value, relative(valueStart));
        if (result.hold === true) {
          holdRoot();
          if (!resolveHeld()) return;
          continue;
        }
        settle();
        continue;
      }
      const scalarStart = continuingWord
        ? relative(cursor.window.wordStart)
        : continuingNumber
          ? relative(cursor.window.numberStart)
          : cursor.pos;
      build.markInto(valueMark);
      // Noted BEFORE the read: a quoted value is a mark of data the moment it opens, and a selected
      // string streamed as fragments must know the candidate is established before its first piece.
      if (c === QUOTE || c === APOSTROPHE) candidate.noteQuoted(true);
      const token = scalars.read(c, state, depth);
      candidate.noteQuoted(token.quoted);
      if (token.status === "stopped") return;
      if (token.status === "cut") {
        dropCutToken(scalarStart);
        continue;
      }
      // No `none` arrives here: inside a container every character that ends a word is dispatched
      // above or consumed as trivia (a backslash before a delimiter too), so a word read takes at
      // least one character. Only root candidacy, which skips the character, sees `none`.
      if (cursor.needMore) {
        if (scalars.continuation !== undefined || cursor.window.inWord || cursor.window.inNumber)
          return;
        build.retract(valueMark);
        rewindToken(tokenStart);
        return;
      }
      pendingDrop = droppedMember(placeValue(token.value, scalarStart), cursor.pos + cursor.base);
      settle();
    }
  };

  /**
   * Drops the consumed prefix of the buffer once nothing is open.
   *
   * Not an optimisation — without it a long stream of small values grows the buffer until it trips
   * the size limit, which is a functionality loss dressed as a simplification. Measured at 23x on
   * top of the 53x for not rescanning: `buf += chunk` builds a rope and `charCodeAt` forces a
   * flatten, so even a correct non-compacting loop re-flattens the whole buffer every chunk.
   */
  const compact = (): void => {
    if (cursor.pos === 0) return;
    // BEFORE the drop, because the range it asks about is the one about to leave the buffer. Asked
    // after, `wsOnly` starts and ends at the new base — an empty loop answering "whitespace only"
    // about bytes it can no longer read — so a fence outlived the value that filled it and a
    // trailing ``` came back as a second value, where `parseMany` on the same bytes whole yields
    // one. A stream must answer what the whole document answers.
    candidate.compact(cursor.pos + cursor.base, depth > 0 ? valueStart : undefined);
    // Completed members and roots need no anchors; only pending members or a trailing comma can
    // still report their released source. Their next member establishes its own anchors.
    cursor.drop(
      depth > 0 && (state !== ST_AFTER || afterComma)
        ? [commaAt, keyStart, valueCommaAt, valueKeyStart, build.pendingKeyAt]
        : undefined,
    );
    // Stored positions are absolute. Compaction changes only the retained window and local cursor;
    // rebasing every structural mark was both work and a source of plausible coordinate drift.
  };

  const release = (): void => {
    if (cursor.length === 0) return;
    // A terminal cut must outlive raw token state just as a stopped string prefix does.
    if (diagnostics.terminalFailure !== undefined) scalars.cut ??= openCut();
    cursor.clear();
  };

  /** Where the open root stops now; see `cut.ts`. */
  const openCut = (): Cut =>
    cutNow(
      build,
      scalars,
      cursor,
      state === ST_KEY,
      keyStart !== undefined && stack[depth - 1] === IN_OBJECT,
    );
  /** The open root as recovery: whatever a bound or a stop left of it, never complete. */
  /**
   * The open root's cut, or none once the root itself is finished: a root that is open with no
   * container open is held, or waits after a comma for a second list value. Only its standing or
   * its list is undecided, never its own value. A root string a stop cut short has its cut.
   */
  const liveCut = (): Cut | undefined =>
    depth === 0 && build.hasOpenRoot && scalars.cut === undefined ? undefined : openCut();
  const recovery = (): Recovery | undefined => {
    const root = build.recovery();
    if (root === undefined) return undefined;
    const cut = liveCut();
    return cut === undefined
      ? { value: root.value, complete: true }
      : { value: root.value, complete: false, cut };
  };
  const readers = scanReaders(diagnostics, cursor, scalars, opts.cutSuffix);
  /** Everything the scan finished; `unfinished` is the root a bound stopped, handed back as recovery. */
  const result = (unfinished: Recovery | undefined): ScanEnd => ({
    values: ledger.map((root) => root.value),
    first: ledger.start,
    open: unfinished,
  });

  return {
    supply(chunk: string, malformedUtf8: readonly number[] = []): void {
      if (diagnostics.terminalFailure !== undefined) return;
      cursor.supply(chunk, malformedUtf8);
      stripBom();
    },

    positionAt,
    valueStart: (): number => valueStart,
    ...readers,
    cut: liveCut,
    recovery,
    candidate,

    compactInput: compact,
    finishChunk(): void {
      compact();
      if (
        diagnostics.terminalFailure === undefined &&
        cursor.length + scalars.quoteReplayCarry > opts.maxBuffer
      ) {
        refuse("buffer", opts.maxBuffer, cursor.base);
      }
      if (diagnostics.terminalFailure !== undefined) release();
    },
    releaseInput: release,
    close: () => {
      cursor.clear();
      scalars.dispose();
      diagnostics.dispose();
    },

    stopped,

    stopPending(): void {
      if (state !== ST_VALUE || scalars.pending === undefined) return;
      // The cut names the pending slot before the writer clears its key and selection state.
      scalars.cut ??= openCut();
      scalars.stopPending();
    },

    pull(): Pulled | undefined {
      pausing = true;
      paused = false;
      const before = build.completed;
      run();
      // Compaction is deliberately NOT run here. It drops the consumed prefix, and a caller pulling
      // values is also the caller most likely to be holding `spans` into the cursor.window they passed.
      if (build.completed > before)
        return { root: { value: ledger.at(build.completed - 1)?.value } };
      return (picks?.out.length ?? 0) > 0 ? { root: undefined } : undefined;
    },

    end(): ScanEnd {
      pausing = false;
      paused = false;
      // Queued pieces are read with the end still unknown: a piece boundary is a malformed byte,
      // not the end of the input, and a string cut there must wait for its closing quote.
      if (cursor.queued) run();
      cursor.atEnd = true;
      cursor.needMore = false;
      run();
      if (diagnostics.terminalFailure !== undefined) {
        // The open root is handed back as recovery, not closed: closing would repair input the
        // scanner refused to read, and the refusal is the whole point of the bound.
        const refused = result(recovery());
        release();
        return refused;
      }
      // An error budget may leave a suffix unread. Finalization can close only the prefix it actually
      // interpreted; including unseen bytes would make the repaired text describe a different parse.
      const finalAt = diagnostics.exhausted ? cursor.pos : cursor.length;
      // Read before the closing below moves `Builder.kept` and drops the dangling key.
      let cut = depth > 0 ? openCut() : undefined;
      // Input ended with containers still open. Closing them is the package's promise that a partial
      // result beats dropped content; the repair is what keeps it from being a silent invention. The
      // extracted package reached this code only through a `catch` that nothing ever threw into, so
      // 49 of its 50 recorded stream cases emitted nothing at all from `finalize()`.
      // A key whose value never arrived is dropped from the tree, so the repaired TEXT drops it too
      // — otherwise `{"a":1,"b":` closes to `{"a":1,"b":}`. Only the innermost container can have one.
      if (keyStart !== undefined && depth > 0 && stack[depth - 1] === IN_OBJECT) {
        dropMember(keyStart, finalAt);
        keyStart = undefined;
      }
      // Only the innermost container can end in a dangling comma, which is why `commaAt` and
      // `afterComma` still describe it here. Mutually exclusive with the dropped member above:
      // reading a key clears `afterComma`.
      if (depth > 0) dropTrailingComma();
      const wrapped = list?.wrapped === true;
      // A list needs no closer, so one whose last element ended with the input is as finished as a
      // root that did (`1,2` like `2`). After a trailing comma more elements were on their way.
      if (wrapped && depth === 1 && !afterComma) cut = undefined;
      afterComma = false;
      const forced = depth > 0 && !wrapped;
      // The list frame is closed below as the list it is, not as an array the input left open.
      while (depth > (wrapped ? 1 : 0)) {
        const object = stack[depth - 1] === IN_OBJECT;
        // A container held by a key the dangerous-key policy dropped. Mid-scan the next token
        // settles its extent; here the input ended inside it, so the extent is the rest of the text.
        const dropped = droppedContainers[depth];
        droppedContainers[depth] = undefined;
        lenient(object ? "unclosed-object" : "unclosed-array", finalAt);
        edit(finalAt, finalAt, object ? "}" : "]");
        depth--;
        build.close(finalAt + cursor.base);
        // AFTER the close, which retracts everything the dropped container logged — the closer just
        // written for it included. Without this deletion `repair(text)` hands back the member the
        // tree dropped: `{"__proto__": {"x":1` recovered `{}` and repaired to
        // `{"__proto__": {"x":1}`, which re-parses WITH the prototype key the policy removed.
        // `SECURITY.md` rules that a repair parsing to a different value than the recovery is a
        // defect, and truncation is the only path that reached this state.
        if (dropped !== undefined) edit(relative(dropped.start), finalAt, "");
      }
      // A container the input never closed gets judged exactly like one it did — `Hello {name`
      // must no more become `{}` than `Hello {name}` does. `judge` reads `cursor.atEnd`, which is now set,
      // so its HOLD answer is unreachable here and every candidate is decided.
      //
      // A spent error budget cannot stop the scan before this verdict: it waits while the candidate
      // is undecided (`ScanDiagnostics.deferred`), so the marks judged here are what the input shows,
      // never how far the scanner chose to read. Measured before that: `{a:1}` under `STRICT`
      // stopped at the unquoted key, short of the colon that proves the text is data.
      if (forced && candidate.judge(valueStart) !== CANDIDATE_ACCEPT) candidate.reject();
      // A list at the end of the input stands alone, whatever led it. A comma no value followed
      // leaves its root finished where it ended: `{"a":1},` and `1,` read as their root.
      let rootEnd = finalAt + cursor.base;
      if (list !== undefined) {
        list.memberEnd = rootEnd;
        rootEnd = closeList(list);
      }
      // A root the input left open was closed above without passing through `settle`, so its
      // books are closed here; a rejected candidate was popped and has none to close.
      if (build.hasOpenRoot) {
        diagnostics.finishRoot(valueStart, rootEnd, cut);
      }
      const finished = result(undefined);
      release();
      return finished;
    },
  };
}
