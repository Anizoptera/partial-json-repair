// SPDX-License-Identifier: Apache-2.0

/**
 * The value a stream is still assembling, viewed the way the stream was told to view it: shared
 * frozen branches with a copied spine, or a deep copy the caller owns.
 *
 * **What is frozen, and why only that.** A shared view hands every FINISHED branch to every snapshot
 * and to the caller's own later snapshots, so those are frozen — once, as they close (see
 * `Builder.freezeOnClose`). The copies made for ONE snapshot — the open path, the match list — are
 * not frozen on any runtime. A caller writing to one never reaches parser state or another frame's
 * snapshot (HLD: later input never mutates a held snapshot; caller writes never reach parser state),
 * though a `shared` pull with no input since returns the same object, so `shared` is read-only by
 * contract. Freezing them bought only a louder error for a caller mutating a copy, and on
 * JavaScriptCore it cost ~0.13 us per element: 17 ms of a 30 ms snapshot of a 100 000-wide open
 * array (Bun 1.4.2, M4 Max), against nothing on V8. A guarantee may be weakened where the gain is
 * that large, so the copies stay unfrozen. A capability probe that froze
 * only where cheap was rejected: browsers coarsen `performance.now()` to about 1 ms, so a probe of a
 * sub-millisecond freeze reads noise there, and the frozen-ness of a snapshot would differ by runtime
 * and by run. One rule everywhere is predictable; Object.isFrozen answers the same on every host.
 */
import type { Pending, Scanner, SnapshotState } from "./scan-contract";
import type { Picks } from "./picks";
import type { Builder } from "./builder";
import { BUILT } from "./builder";
import type { Match, ViewFeature, ViewMode } from "./types";
import { defineOwn } from "./tree";

/** Settled occurrences precede the still-open match, without changing the delivery queue. */
const heldMatches = (picks: Picks): Match[] => {
  const out: Match[] = [];
  for (const held of picks.heldOccurrences)
    if (typeof held !== "function" && !held.open) out.push(picks.matchOf(held, held.value));
  return out;
};

/** An open container's preview span ends where it started; its extent is not settled yet. */
const openMatch = (picks: Picks): { frame: number; match: Match } | undefined => {
  const held = picks.openOccurrence;
  if (held === undefined) return undefined;
  return {
    frame: picks.openMatchFrame,
    // An open occurrence keeps end equal to start until its closer arrives.
    match: picks.matchOf(held, held.value),
  };
};

// Root strings are candidates only when standalone or fenced; a prose quote is not a preview.
const pendingString = ({
  build,
  scalars,
  cutSuffix,
}: Pick<Scanner, "build" | "scalars" | "cutSuffix">): Pending | undefined =>
  scalars.pending === undefined ||
  (build.stack.length > 0 && (!build.innermostBuilt || build.picks?.retainsScalar() === false))
    ? undefined
    : // The suffix belongs to the snapshot copy, never the live tree.
      { key: build.keys[build.stack.length - 1], text: scalars.pending + cutSuffix };

/**
 * Places the string still arriving into the COPY. The live tree receives the finished token
 * through the scanner's ordinary insertion path; grafting there would place it twice.
 */
export const graftPending = (tip: unknown, pending: Pending | undefined): void => {
  if (pending === undefined) return;
  if (Array.isArray(tip)) tip.push(pending.text);
  else if (pending.key !== undefined && typeof tip === "object" && tip !== null) {
    defineOwn(tip as Record<string, unknown>, pending.key, pending.text);
  }
};

/** Builds the configured view without exposing the live tree to the caller. */
export class Snapshotter {
  private source: Pick<Scanner, "build" | "scalars" | "cutSuffix" | "candidate"> | undefined;
  private detached: SnapshotState | undefined;
  constructor(
    scanner: Scanner,
    shared: boolean,
    private readonly copyOpen: (state: SnapshotState) => unknown,
    private readonly copyFinished: (value: unknown) => unknown,
  ) {
    this.source = scanner;
    // Sharing is only safe when nothing shared can change, so under `shared` every container is
    // frozen the moment it closes — from the first chunk, so no branch ever needs a catch-up walk.
    if (shared) scanner.build.freezeOnClose = true;
  }

  // Keep only view inputs after disposal; copying values remains lazy and follows the requested mode.
  detach(): void {
    const state = this.state();
    // Copy the stack records before scanner disposal; value copying remains lazy at each pull.
    this.detached = { ...state, spine: state.spine.slice(), labels: state.labels.slice() };
    this.source = undefined;
  }

  private state(): SnapshotState {
    const source = this.source;
    // detach stores every view input before releasing the scanner reference.
    if (source === undefined) return this.detached as SnapshotState;
    const build = source.build;
    if (build.picks?.delivery?.selecting === true) return this.selectedState(source);
    // Excluded frames must stay absent instead of reappearing as empty containers.
    const depth = this.builtDepth(build);
    const spine = depth === build.stack.length ? build.stack : build.stack.slice(0, depth);
    return {
      spine,
      labels: build.labels,
      pending: pendingString(source),
      // A finished root stays visible while what follows it is undecided: whether it stands alone,
      // or whether the comma after it starts a list.
      value: spine.length === 0 && build.hasOpenRoot ? build.recovery()?.value : undefined,
    };
  }

  /** A view copies only built frames; transit and dead frames contain no caller-visible container. */
  private builtDepth(build: Builder): number {
    let depth = 0;
    while (depth < build.modes.length && build.modes[depth] === BUILT) depth++;
    return depth;
  }

  private selectedState(source: NonNullable<Snapshotter["source"]>): SnapshotState {
    // Matches form the view's root; copying their unfinished value uses the ordinary open path.
    // Keep this view-only assembly here so selection without a view retains no new machinery.
    const { build, scalars, cutSuffix } = source;
    const picks = build.picks?.delivery;
    const frames = build.stack;
    let matches = picks === undefined ? [] : heldMatches(picks);
    const open = frames.length === 0 || picks === undefined ? undefined : openMatch(picks);
    if (open !== undefined) {
      const index = matches.length;
      matches.push(open.match);
      return {
        spine: [matches, open.match, ...frames.slice(open.frame)],
        labels: [0, index, "value", ...build.labels.slice(open.frame + 1)],
        pending: pendingString(source),
        value: undefined,
      };
    }
    const reading =
      scalars.pending === undefined || picks === undefined
        ? undefined
        : this.pendingMatch(picks, build, scalars.pending + cutSuffix, scalars.partialStart);
    if (reading !== undefined) {
      // In an open object an arriving duplicate replaces the earlier held value.
      const path = reading.path;
      if (frames.length > 0)
        matches = matches.filter(
          (match) =>
            match.path.length !== path.length || match.path.some((label, i) => label !== path[i]),
        );
      matches.push(reading);
    }
    return {
      spine: [],
      labels: [],
      pending: undefined,
      value: matches.length === 0 && frames.length === 0 ? undefined : matches,
    };
  }

  /** Preview a string without recording it; its zero-width span starts at the opening quote. */
  private pendingMatch(
    picks: Picks,
    build: Builder,
    text: string,
    quote: number,
  ): Match | undefined {
    // Inside an open selected container, its ordinary spine already carries the string prefix.
    if (picks.openMatchFrame >= 0) return undefined;
    const slot = picks.selectedSlot();
    if (slot === undefined) return undefined;
    const at = build.positionAt(quote);
    return {
      value: text,
      path: slot.path,
      valueIndex: build.completed,
      span: { start: at, end: at },
      selectors: slot.hits,
    };
  }

  /** The root being assembled, or `undefined` between roots and before the first one. */
  open(): unknown {
    const state = this.state();
    const { spine, pending, value } = state;
    // No container open: the root is the string still arriving, a finished root held to see what
    // follows it, or there is no root yet.
    if (spine.length === 0) {
      if (pending !== undefined) return pending.text;
      return value === undefined ? undefined : this.finished(value);
    }
    return this.copyOpen(state);
  }

  /** A finished root as the same view: already frozen when shared, a fresh copy when owned. */
  finished(value: unknown): unknown {
    return this.copyFinished(value);
  }
}

export type RuntimeView<Mode extends ViewMode = ViewMode> = ViewFeature<Mode> & {
  readonly open: (scanner: Scanner) => Snapshotter;
};

// Strategies arrive through the requested import, so neither ownership algorithm retains its sibling.
export const createView = <Mode extends ViewMode>(
  mode: Mode,
  copyOpen: (state: SnapshotState) => unknown,
  copyFinished: (value: unknown) => unknown,
): RuntimeView<Mode> =>
  Object.freeze({
    feature: "view" as const,
    mode,
    open: (scanner: Scanner) => new Snapshotter(scanner, mode === "shared", copyOpen, copyFinished),
  });
