// SPDX-License-Identifier: Apache-2.0

import type { BuildMode, Builder } from "./builder";
import { BUILT, DEAD, IN_ARRAY, IN_OBJECT, TRANSIT } from "./builder";
import type { CompiledSelection } from "./options";
import type { Fragment, Match, SourcePath, SourceFragment } from "./types";
import type { FragmentDelivery } from "./decoded-picks";
import type { Scanner } from "./scan-contract";
import { Selection } from "./selector";
import { isExactNumber } from "./exact-number";
import { cloneJson } from "./tree";
import { matchesOf, success } from "./parser-outcome";
import type { Outcome } from "./parser-outcome";
import { selectionCopy } from "./selection-copy";
import { scalarIsWanted } from "./path-filter";

/** What the builder hands the consumer besides whole values: a match, a fragment, or the refusal of a container selected under `fragments`. */
export type Delivery =
  | Match
  | Fragment
  | SourceFragment
  | { kind: "non-scalar-selection"; path: SourcePath };

type PreparedSelectionRoot = { value: unknown; matches: Match[] };

/** A selected node between being seen and being delivered: its span is filled in when it closes. */
type Occurrence = {
  value: unknown;
  path: SourcePath;
  valueIndex: number;
  start: number;
  end: number;
  selectors: readonly number[];
  /** Recorded while an enclosing match was open, so its value is part of that match's tree and must be copied before it is handed out. */
  nested: boolean;
  /** A container still receiving members. Held from its opener so ancestors precede descendants. */
  open: boolean;
  /** How many edits were on the log when it closed; only inserts before that can belong inside it. */
  closeEdit: number;
  /** `content` charged when it opened, so what it retained can be released when it leaves under `occurrences`. */
  chargedAt: number;
};

/**
 * What `select` and `skip` add to a build: classifying each node against the selection, holding
 * selected nodes until they may leave, and handing them out as matches or fragments.
 *
 * Its own object, made only when a selection was given, because none of it runs otherwise: the
 * builder asks `picks?.` at the points a node opens, is placed or closes, and a build without a
 * selection pays that one check. Selection lives beside the builder rather than in the scanner
 * because the decision not to build a subtree must be taken before its first member arrives, and
 * the builder is the one place that sees every member arrive. It reads the builder's frames and
 * never writes them; the builder applies the frame mode each call answers.
 */
// Shared predicates avoid webpack keeping this unused class when package metadata is absent.
export class Picks {
  declare readonly fragmentDelivery?: FragmentDelivery;
  private readonly selection: Selection;
  /** Matches leave as source occurrences, before their ancestors close; `fragments` implies it. */
  private readonly occurrences: boolean;
  private readonly fragments: boolean;
  /** The match a container opening under `open` will hold, until `opened` registers it. */
  private opening: Occurrence | undefined;
  /**
   * Where a value the end of input stopped inside ends, set by the scalar reader: the one value placed
   * with that end is the cut one. A position rather than a flag, so a value placed again after a
   * rewind is judged by where it ends, not by the order in which tokens were read.
   */
  cutEnd = -1;

  /**
   * Selected nodes seen but not yet handed out: until the root closes, or until the candidate is
   * established as JSON. A held fragment triple is the function that emits it.
   */
  protected pending: (Occurrence | (() => void))[] = [];
  // Whole-input readers stop at each completed root, so final membership can transfer without
  // copying the queue. Preparation then yields between batches; streams still flush immediately.
  deferFinal = false;
  private ready: (Occurrence | (() => void) | undefined)[] | undefined;
  private readyAt = 0;
  private copying: Generator<void, { value: unknown; spent: number }, number> | undefined;
  private recoveryCopy:
    | { from: number; steps: Generator<void, { value: unknown; spent: number }, number> }
    | undefined;
  // This state exists only on the imported selection feature; ordinary roots need no drain state.
  private preparedRoot: PreparedSelectionRoot | undefined;
  private unread: { matches: (Match | undefined)[]; at: number; root: number | "open" } | undefined;
  /** What the consumer may take, in delivery order. The parser empties it. */
  readonly out: Delivery[] = [];
  /** Stack index of the outermost open matched container, or -1 when none is open. */
  private matchFrame = -1;
  /** The occurrence of each open matched container, by stack index. */
  private readonly openMatches: (Occurrence | undefined)[] = [];
  /** Per `select` path, whether it has delivered anything — the summary's `unmatched` is the zeros. */
  protected readonly hit: Uint8Array;
  /**
   * Per object frame, the keys under which a pending match was recorded. Made only where a match
   * exists below, so a transit object with a million members and one selected child costs one
   * entry. A duplicate of such a key replaces that subtree, and the matches beneath it go with it.
   */
  private readonly matchedKeys: (Set<string> | undefined)[] = [];
  /** Deliveries so far, for the summary: matches, or started occurrences under `fragments`. */
  delivered = 0;
  /**
   * Whether the candidate has shown a mark of data. Set by the scanner. An occurrence leaves only
   * once the bytes around it are known to be JSON: `[1]` in `see [1] for` is prose, and a match
   * delivered out of it would be a value manufactured from punctuation.
   */
  established: () => boolean = () => true;
  /** Set by the scanner: a delivery was queued, so a pull may stop here. */
  onDelivery: () => void = () => undefined;

  constructor(
    protected readonly b: Builder,
    compiled: CompiledSelection,
    occurrences: boolean,
    mode: BuildMode,
  ) {
    this.selection = new Selection(compiled.select, compiled.skip);
    this.occurrences = occurrences || mode.fragments;
    this.fragments = mode.fragments;
    this.hit = new Uint8Array(this.selection.selectors);
  }

  /** Whether `select` was given: every verb then hands back matches instead of values. */
  get selecting(): boolean {
    return this.selection.selecting;
  }

  /** The filter also owns selected output; skip-only filters expose no delivery capability. */
  get delivery(): Picks {
    return this;
  }

  /** How many selected nodes are held, for a builder mark. */
  get held(): number {
    return this.pending.length;
  }

  /** Drops what was held after a mark, for a builder retraction: a candidate rejected as prose takes its matches with it. */
  truncate(held: number): void {
    this.pending.length = held;
  }

  // Summary counters remain meaningful after disposal; pending trees and fragment closures do not.
  dispose(): void {
    this.selection.dispose();
    this.pending.length = 0;
    this.ready = undefined;
    this.readyAt = 0;
    this.preparedRoot = undefined;
    this.unread = undefined;
    this.copying = undefined;
    this.recoveryCopy = undefined;
    this.out.length = 0;
    this.openMatches.length = 0;
    this.matchedKeys.length = 0;
    this.opening = undefined;
  }

  /** Whether an unmatched node is built: no `select` at all, or inside a match. */
  private buildsUnmatched(): boolean {
    return !this.selection.selecting || this.matchFrame >= 0;
  }

  /** A dead parent's members never stepped down, so only live ancestors unwind the matcher. */
  leave(parent: number): void {
    if (parent >= 0 && this.b.modes[parent] !== DEAD) this.selection.ascend();
  }

  retainsScalar(): boolean {
    return scalarIsWanted(this.b, this.selection, this.matchFrame >= 0);
  }

  /**
   * Classifies a container about to open as child `label` of a live `parent`, and answers its frame
   * mode. A selected container's match is remembered for `opened`, which registers it once the
   * container exists. The matcher steps back up at `close`.
   */
  open(label: string | number, at: number, parent: number): number {
    if (parent >= 0) this.selection.descend(label);
    const placement = this.selection.placement();
    if (typeof label === "string" && parent >= 0) this.supersedeIfDuplicate(parent, label);
    // `dead` says no selector can reach this node or anything under it, which is a reason to
    // decline the subtree only OUTSIDE a match. Inside one the contents are the matched value
    // itself, and declining them truncated it to a single level while reporting nothing. `skipped`
    // is unconditional by contrast: the caller wrote that selector, and a skip beats a select
    // wherever the two overlap.
    if (placement.skipped || (placement.dead && !this.buildsUnmatched())) return DEAD;
    if (placement.hits !== undefined) {
      if (this.fragments) {
        // A root has no label: its path is `[]`, as on every other delivery, never `[""]`.
        const path = parent < 0 ? [] : this.b.pathTo(label);
        this.out.push({ kind: "non-scalar-selection", path: Object.freeze(path) });
        this.onDelivery();
        return DEAD;
      }
      this.opening = this.occurrence(undefined, label, at, at, placement.hits, parent);
      return BUILT;
    }
    return this.buildsUnmatched() ? BUILT : TRANSIT;
  }

  /**
   * The container `open` classified now sits at `frame`. Answers whether that frame must be dead: a
   * member the policy dropped, or anything inside an object it refused, is not in the final tree, so
   * under final delivery neither it nor anything selected inside it is a match, and its members are only
   * counted. Under `occurrences` the source occurrences beneath it are still the caller's to have.
   */
  opened(container: unknown, frame: number, dropped: boolean): boolean {
    const occurrence = this.opening;
    this.opening = undefined;
    if ((dropped || this.b.refusedFrom >= 0) && !this.occurrences) return true;
    if (occurrence === undefined) return false;
    occurrence.value = container;
    this.openMatches[frame] = occurrence;
    if (this.matchFrame < 0) this.matchFrame = frame;
    // Held from the opener, so a match is ordered by where it STARTS: ancestors before
    // descendants. Under `occurrences` it leaves when it closes, after everything inside it.
    if (!this.occurrences) this.hold(occurrence);
    return false;
  }

  /** Frame `i` closes at `end`; its match, if it holds one, is complete. */
  close(i: number, end: number): void {
    const occurrence = this.openMatches[i];
    if (occurrence !== undefined) {
      this.openMatches[i] = undefined;
      occurrence.end = end;
      occurrence.open = false;
      occurrence.closeEdit = this.b.edits.length;
      if (this.matchFrame === i) this.matchFrame = -1;
      if (this.occurrences) this.settle(occurrence);
    }
    this.matchedKeys[i] = undefined;
  }

  /**
   * Classifies a finished scalar placed as child `label` of a live `parent`, records or streams it
   * if selected, and answers whether the builder writes it into its parent.
   */
  value(
    v: unknown,
    label: string | number,
    at: number,
    end: number,
    parent: number,
    write: boolean,
    stopped: boolean,
  ): boolean {
    if (parent >= 0) this.selection.descend(label);
    const placement = this.selection.placement();
    if (typeof label === "string" && parent >= 0) this.supersedeIfDuplicate(parent, label);
    if (placement.skipped) return false;
    const selectingRoot = parent < 0 && this.selection.selecting;
    // Inside an object refused whole, nothing reaches the final tree, so nothing is a final match.
    if (placement.hits === undefined || (this.b.refusedFrom >= 0 && !this.occurrences))
      return selectingRoot ? false : write;
    if (selectingRoot) write = true;
    if (this.fragments)
      this.fragmentDelivery?.emitScalar(v, label, at, end, placement.hits, parent);
    else {
      const occurrence = this.occurrence(v, label, at, end, placement.hits, parent);
      occurrence.open = false;
      // Retained by the match alone when no parent holds it. Charged BEFORE `settle`, which
      // releases back to `chargedAt` on delivery: charged after, a delivered value stayed charged.
      if (!write) this.b.chargeValue(v, at);
      // A root scalar is held even under `occurrences`: its quote is a mark of data, yet prose
      // after it can still make it no value, so it leaves with its root (see `emitScalar`).
      // A stopped prefix belongs only to failed recovery, never to a successful occurrence.
      if (this.occurrences && parent >= 0 && !stopped) this.settle(occurrence);
      else this.hold(occurrence);
    }
    return write;
  }

  /** An object at `frame` was refused whole: everything selected inside it leaves the final tree with it. */
  refused(frame: number): void {
    if (!this.occurrences) this.supersede(frame, undefined);
  }

  /** A selected node as first seen; a scalar's extent is complete, a container's `end` waits for `close`. */
  private occurrence(
    value: unknown,
    label: string | number,
    start: number,
    end: number,
    selectors: readonly number[],
    parent: number,
  ): Occurrence {
    return {
      value,
      path: Object.freeze(parent < 0 ? [] : this.b.pathTo(label)),
      valueIndex: this.b.completed,
      start,
      end,
      selectors,
      nested: this.matchFrame >= 0,
      open: true,
      closeEdit: this.b.edits.length,
      chargedAt: this.b.content,
    };
  }

  /**
   * Under `occurrences`, a selected node is complete: it leaves as soon as the candidate is
   * established as JSON, and waits for that otherwise.
   */
  private settle(occurrence: Occurrence): void {
    if (!this.established()) {
      this.pending.push(occurrence);
      return;
    }
    this.flush();
    this.deliver(occurrence);
    // Handed out, so no longer retained here — unless it is part of a larger match still open.
    if (!occurrence.nested) {
      this.b.content = Math.min(this.b.content, occurrence.chargedAt);
    }
  }

  /**
   * Under final delivery, a selected node waits for the root: a later duplicate key can still
   * replace an ancestor and take it out of the final tree. The keys on the way to it are
   * remembered so such a duplicate can find it.
   */
  private hold(occurrence: Occurrence): void {
    this.pending.push(occurrence);
    const frames = Math.min(this.b.stack.length, occurrence.path.length);
    for (let j = 0; j < frames; j++) {
      if (this.b.kinds[j] !== IN_OBJECT) continue;
      (this.matchedKeys[j] ??= new Set()).add(occurrence.path[j] as string);
    }
  }

  finish(): void {
    if (!this.deferFinal || this.occurrences) {
      this.flush();
      return;
    }
    if (this.pending.length === 0) return;
    this.ready = this.pending;
    this.pending = [];
    this.readyAt = 0;
  }

  prepareRoot(value: unknown, units: number | undefined): PreparedSelectionRoot | "checkpoint" {
    const root = { value, matches: matchesOf(this.takeDeliveries(units)) };
    if (this.ready === undefined) return root;
    // The reader stops before consuming another root, so final membership cannot change here.
    this.preparedRoot = root;
    return "checkpoint";
  }

  resumeRoot(units: number | undefined): PreparedSelectionRoot | "checkpoint" | undefined {
    const root = this.preparedRoot;
    if (root === undefined) return undefined;
    this.appendRoot(root, units);
    if (this.ready !== undefined) return "checkpoint";
    this.preparedRoot = undefined;
    return root;
  }

  private appendRoot(root: PreparedSelectionRoot, units: number | undefined): void {
    // Retain the first owned batch and append later batches without call-argument limits.
    for (const match of matchesOf(this.takeDeliveries(units))) root.matches.push(match);
  }

  /** Hands out every pending occurrence, in the order recorded: source order, ancestors first. */
  flush(): void {
    if (this.pending.length === 0) return;
    for (const held of this.pending) {
      if (typeof held === "function") held();
      else this.deliver(held);
    }
    this.pending.length = 0;
  }

  private deliver(
    occurrence: Occurrence,
    value = occurrence.nested && !this.b.freezeOnClose
      ? cloneJson(occurrence.value)
      : occurrence.value,
  ): void {
    // A match inside another match shares that match's tree. Copied unless both are frozen: a
    // frozen tree cannot be written through either handle, so sharing it aliases nothing.
    const match = this.matchOf(occurrence, value);
    this.b.editLog?.recordMatch(occurrence);
    this.out.push(match);
    for (const s of occurrence.selectors) this.hit[s] = 1;
    this.delivered++;
    this.onDelivery();
  }

  matchOf(occurrence: Readonly<Occurrence>, value: unknown): Match {
    return {
      value,
      path: occurrence.path,
      valueIndex: occurrence.valueIndex,
      span: { start: this.b.positionAt(occurrence.start), end: this.b.positionAt(occurrence.end) },
      selectors: occurrence.selectors,
    };
  }

  // Raw readonly records let Snapshotter own projection without duplicating selection state.
  get heldOccurrences(): readonly (Readonly<Occurrence> | (() => void))[] {
    return this.pending;
  }

  get openMatchFrame(): number {
    return this.matchFrame;
  }

  get openOccurrence(): Readonly<Occurrence> | undefined {
    return this.matchFrame < 0 ? undefined : this.openMatches[this.matchFrame];
  }

  outcome(match: Match, scanner: Pick<Scanner, "cutAt">): Outcome<Match, never> {
    // Selection owns match completion so ordinary recovery retains none of this projection.
    // Only a cut at or below a match's path makes that match incomplete.
    // Other matches closed before the cut; deliveries from an open root have no cut yet.
    let cut = scanner.cutAt(match.valueIndex);
    if (cut !== undefined) {
      if (match.path.length > cut.path.length) cut = undefined;
      else
        for (let i = 0; i < match.path.length; i++) {
          if (match.path[i] !== cut.path[i]) {
            cut = undefined;
            break;
          }
        }
    }
    return success(match, cut);
  }

  /** The matches gathered and not yet delivered, as they would have been delivered: what a failed root still holds. */
  recovery(): Match[] {
    const matches: Match[] = [];
    this.recoverInto(matches, 0, Infinity);
    return matches;
  }

  retainDeliveries(matches: Match[], root: number | "open"): void {
    // Iteration can stop between matches; keep its unread suffix in the recovery owner.
    this.unread = matches.length === 0 ? undefined : { matches, at: 0, root };
  }

  consumeDelivery(): void {
    const unread = this.unread;
    if (unread === undefined) return;
    unread.matches[unread.at++] = undefined;
    if (unread.at === unread.matches.length) this.unread = undefined;
  }

  recoveryRoot(): number | "open" | undefined {
    return this.unread?.root;
  }

  recoverInto(matches: Match[], from: number, units: number): number | undefined {
    // Sync and stopped async recovery use the same membership and record construction.
    // Charge skipped fragment callbacks too, so a sparse selection cannot hide an unbounded walk.
    const unread = this.unread;
    const remaining = unread === undefined ? 0 : unread.matches.length - unread.at;
    const count = remaining + this.pending.length;
    let left = units;
    for (; from < count && left > 0; from++) {
      if (unread !== undefined && from < remaining) {
        matches.push(unread.matches[unread.at + from] as Match);
        left--;
        continue;
      }
      const held = this.pending[from - remaining] as Occurrence | (() => void);
      if (
        typeof held !== "function" &&
        held.nested &&
        (!this.b.freezeOnClose || held.open) &&
        typeof held.value === "object" &&
        held.value !== null &&
        !isExactNumber(held.value)
      ) {
        // Synchronous recovery cannot service checkpoints; use the existing direct copier unless
        // a bounded recovery already owns a partial copy that must finish without restarting.
        if (units === Infinity && this.recoveryCopy === undefined) {
          matches.push(this.matchOf(held, cloneJson(held.value)));
          continue;
        }
        // Failed recovery has the same isolation promise as delivery. Open containers are not
        // frozen even in snapshot mode; copy only the nested match and keep its walk resumable.
        // A fresh recovery walk may restart at zero; never apply another match's partial copy.
        if (this.recoveryCopy?.from !== from)
          this.recoveryCopy = { from, steps: selectionCopy(held.value, left) };
        let copied = this.recoveryCopy.steps.next(left);
        if (units === Infinity)
          while (copied.done !== true) copied = this.recoveryCopy.steps.next(Infinity);
        if (copied.done !== true) break;
        this.recoveryCopy = undefined;
        left -= copied.value.spent + 1;
        matches.push(this.matchOf(held, copied.value.value));
      } else {
        if (typeof held !== "function") matches.push(this.matchOf(held, held.value));
        left--;
      }
    }
    return from === count ? undefined : from;
  }

  /** Everything queued since the last take, in delivery order; the queue is then empty. */
  takeDeliveries(limit = Infinity): Delivery[] {
    const ready = this.ready;
    if (ready !== undefined) {
      let left = limit - this.out.length;
      while (this.readyAt < ready.length && left > 0) {
        const held = ready[this.readyAt];
        if (typeof held === "object" && held.nested && !this.b.freezeOnClose) {
          if (
            this.copying === undefined &&
            limit !== Infinity &&
            typeof held.value === "object" &&
            held.value !== null &&
            !isExactNumber(held.value)
          )
            this.copying = selectionCopy(held.value, left);
          if (this.copying !== undefined) {
            let copied = this.copying.next(left);
            // A synchronous stop must still retain all built recovery; ordinary bounded takes
            // leave the current occurrence in place until its independent copy is complete.
            if (limit === Infinity)
              while (copied.done !== true) copied = this.copying.next(Infinity);
            if (copied.done !== true) break;
            this.copying = undefined;
            left -= copied.value.spent + 1;
            ready[this.readyAt++] = undefined;
            this.deliver(held, copied.value.value);
            continue;
          }
        }
        // Release each consumed payload before the next checkpoint, not after queue compaction.
        ready[this.readyAt++] = undefined;
        left--;
        if (typeof held === "function") held();
        else if (held !== undefined) this.deliver(held);
      }
      if (this.readyAt === ready.length) {
        this.ready = undefined;
        this.readyAt = 0;
      }
    }
    return this.out.splice(0);
  }

  /** The `select` indexes that have delivered nothing so far. */
  unmatched(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.hit.length; s++) if (this.hit[s] === 0) out.push(s);
    return out;
  }

  /**
   * A key already used under an object that has matches beneath it: last wins, so the earlier
   * subtree — and every pending match inside it — leaves the final tree.
   */
  private supersedeIfDuplicate(frame: number, key: string): void {
    if (this.occurrences) return;
    if (this.matchedKeys[frame]?.has(key) === true) this.supersede(frame, key);
  }

  /** Drops the pending matches under the frame's path, narrowed to the member `key` when given. */
  private supersede(frame: number, key: string | undefined): void {
    if (frame < 0) return;
    let kept = 0;
    for (const held of this.pending) {
      // Fragments are source occurrences by contract and are never superseded.
      let under = typeof held !== "function" && held.path.length > frame;
      for (let j = 1; under && j <= frame; j++) {
        under = (held as Occurrence).path[j - 1] === this.b.labels[j];
      }
      if (under && key !== undefined) under = (held as Occurrence).path[frame] === key;
      if (!under) this.pending[kept++] = held;
      // Nested matches share their parent's charge; only standalone matches own this storage.
      else if (typeof held !== "function" && !held.nested) this.b.releaseValue(held.value);
    }
    this.pending.length = kept;
  }

  /**
   * Where a string read at the innermost slot sits and which selectors hit it, or `undefined` when
   * none does: a dead parent, a skip, or an object whose key is still being read (no member yet).
   * With no container open the string is the root, matched where the matcher already stands, as
   * `value()` matches a root scalar. Otherwise steps the matcher down and back up, so the matcher is
   * where it was.
   */
  selectedSlot(): { path: SourcePath; hits: readonly number[] } | undefined {
    const b = this.b;
    const parent = b.stack.length - 1;
    if (parent < 0) {
      const root = this.selection.placement();
      return root.skipped || root.hits === undefined
        ? undefined
        : { path: Object.freeze([]), hits: root.hits };
    }
    if (b.modes[parent] === DEAD) return undefined;
    const label = b.kinds[parent] === IN_ARRAY ? (b.counts[parent] as number) : b.keys[parent];
    if (label === undefined) return undefined;
    this.selection.descend(label);
    const placement = this.selection.placement();
    this.selection.ascend();
    if (placement.skipped || placement.hits === undefined) return undefined;
    return { path: Object.freeze(b.pathTo(label)), hits: placement.hits };
  }
}
