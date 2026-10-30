// SPDX-License-Identifier: Apache-2.0

/**
 * Decides, for every node the scanner reaches, whether a `select` path names it, whether a `skip`
 * path removes it, and whether any selector could still match beneath it — so the builder can
 * decline to allocate a subtree BEFORE its first member arrives.
 *
 * Paths are lists of segments rather than a string grammar: a key is a string, an index a number,
 * and the two wildcards are symbols, so a document whose key is literally `*` or `items.name` needs
 * no escaping. Segment matching is exact and typed — the string `"0"` is a key, never index `0`.
 *
 * The matcher is the textbook automaton for glob paths, kept one level per depth: a level holds
 * the (path, segment) pairs still alive at that depth, a descent derives the next level from the
 * current one, and an ascent discards it. Work per node is bounded by the number of selector
 * segments, never by the document. `ANY_DEPTH` is the one segment that stays alive across levels,
 * and a stamp dedupes the states it produces: without one, `[ANY_DEPTH, "a", ANY_DEPTH]` gained a
 * duplicate state on every level below the first `a`.
 */

/** Matches exactly one key or index. */
export const ANY: unique symbol = /* @__PURE__ */ Symbol("partial-json-repair.ANY");
/** Matches zero or more keys or indexes. */
export const ANY_DEPTH: unique symbol = /* @__PURE__ */ Symbol("partial-json-repair.ANY_DEPTH");

export type PathSegment = string | number | typeof ANY | typeof ANY_DEPTH;
/** One `select` or `skip` entry: the segments from the root down, `[]` being the root itself. */
export type SelectorPath = readonly PathSegment[];

type SelectorFailure = {
  kind: "invalid-options";
  field: "select" | "skip";
  reason: "selector" | "skip-tail";
};

/** Paths with consecutive `ANY_DEPTH` collapsed, and the stride that packs (path, position) into one integer. */
export type Compiled = { readonly paths: readonly SelectorPath[]; readonly stride: number };

const validSegment = (segment: unknown): segment is PathSegment =>
  typeof segment === "string" ||
  (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) ||
  segment === ANY ||
  segment === ANY_DEPTH;

/**
 * Validates and normalises one path list. A `skip` path must end in a key: a wildcard or index tail
 * could name an array element, and removing one would shift every later index, which the
 * contract refuses to do silently. `[]` cannot be skipped for the same reason it cannot be a
 * member: it is the root.
 */
export const compileSelectors = (
  field: "select" | "skip",
  paths: unknown,
): Compiled | SelectorFailure => {
  if (!Array.isArray(paths)) return { kind: "invalid-options", field, reason: "selector" };
  const out: SelectorPath[] = [];
  let longest = 0;
  for (const path of paths as unknown[]) {
    if (!Array.isArray(path)) return { kind: "invalid-options", field, reason: "selector" };
    const segments: PathSegment[] = [];
    for (const segment of path as unknown[]) {
      if (!validSegment(segment)) return { kind: "invalid-options", field, reason: "selector" };
      if (segment === ANY_DEPTH && segments[segments.length - 1] === ANY_DEPTH) continue;
      segments.push(segment);
    }
    if (field === "skip" && typeof segments[segments.length - 1] !== "string") {
      return { kind: "invalid-options", field, reason: "skip-tail" };
    }
    longest = Math.max(longest, segments.length);
    out.push(Object.freeze(segments));
  }
  // Positions run 0..length inclusive, and a state may sit one past a trailing wildcard.
  return { paths: Object.freeze(out), stride: longest + 2 };
};

/** Whether the state names the node at its own level: every segment consumed, or only a trailing `ANY_DEPTH` left. */
const terminal = (path: SelectorPath, i: number): boolean =>
  i >= path.length || (i === path.length - 1 && path[i] === ANY_DEPTH);

/** One automaton over one path list, its levels reused across the whole scan. */
type Matcher = {
  dispose(): void;
  descend(depth: number, label: string | number): void;
  /** Path indexes whose state names the node at `depth`, ascending. `undefined` when none. */
  hits(depth: number): readonly number[] | undefined;
  /** Whether any state at `depth` can still consume a further segment. */
  reachable(depth: number): boolean;
};

const matcher = (compiled: Compiled): Matcher => {
  const { paths, stride } = compiled;
  const levels: number[][] = [[]];
  // Singleton membership is immutable and bounded by selector count, not source width. Reuse it
  // without interning arbitrary combinations, whose cache could grow with the input.
  const singletons: (readonly number[] | undefined)[] = [];
  let stamps = new Uint32Array(paths.length * stride);
  let stamp = 0;
  const root = levels[0] as number[];
  for (let s = 0; s < paths.length; s++) root.push(s * stride);
  return {
    dispose(): void {
      levels.length = 0;
      root.length = 0;
      singletons.length = 0;
      stamps = new Uint32Array(0);
    },
    descend(depth, label): void {
      const from = levels[depth] as number[];
      const to = (levels[depth + 1] ??= []);
      to.length = 0;
      stamp++;
      // Marks must fit their storage; clear stale generations before reusing one on long streams.
      if (stamp > 0xffff_ffff) {
        stamps.fill(0);
        stamp = 1;
      }
      const push = (state: number): void => {
        if (stamps[state] === stamp) return;
        stamps[state] = stamp;
        to.push(state);
      };
      for (const state of from) {
        const s = Math.trunc(state / stride);
        const i = state - s * stride;
        const path = paths[s] as SelectorPath;
        if (i >= path.length) continue;
        const segment = path[i];
        if (segment === ANY_DEPTH) {
          push(state); // the wildcard keeps consuming
          // ...or consumes nothing, and the segment after it must name this node.
          if (i + 1 < path.length) {
            const next = path[i + 1];
            if (next === ANY || next === label) push(state + 2);
          }
        } else if (segment === ANY || segment === label) push(state + 1);
      }
    },
    hits(depth): readonly number[] | undefined {
      let first = -1;
      let out: number[] | undefined;
      for (const state of levels[depth] as number[]) {
        const s = Math.trunc(state / stride);
        if (!terminal(paths[s] as SelectorPath, state - s * stride)) continue;
        if (first < 0) first = s;
        else (out ??= [first]).push(s);
      }
      if (first < 0) return undefined;
      if (out === undefined) return (singletons[first] ??= Object.freeze([first]));
      out.sort((a, b) => a - b);
      // Frozen like a match's path: this array becomes `selectors` on every record of the match
      // (each view of it and the delivered item), so a write to one would reach the others.
      return Object.freeze(out);
    },
    reachable(depth): boolean {
      for (const state of levels[depth] as number[]) {
        const s = Math.trunc(state / stride);
        if (state - s * stride < (paths[s] as SelectorPath).length) return true;
      }
      return false;
    },
  };
};

/** What the selection says about the node the builder is about to place. */
type Placement = {
  /** Selector indexes naming this node; `undefined` when none does. */
  readonly hits: readonly number[] | undefined;
  /** A `skip` path names it: not built, nothing beneath it matters. */
  readonly skipped: boolean;
  /** No selector can match this node or anything beneath it. */
  readonly dead: boolean;
};

/**
 * The `select` and `skip` automata walked together, one level per depth. `select` absent means
 * everything is wanted except what `skip` removes; `select` present means nothing is wanted except
 * what it names, `skip` still winning where the two overlap.
 */
export class Selection {
  private readonly select: Matcher | undefined;
  private readonly skip: Matcher | undefined;
  /** How many `select` paths there are, for the tally of the ones that never matched. */
  readonly selectors: number;
  private depth = 0;

  constructor(select: Compiled | undefined, skip: Compiled | undefined) {
    this.select = select === undefined ? undefined : matcher(select);
    this.skip = skip === undefined ? undefined : matcher(skip);
    this.selectors = select?.paths.length ?? 0;
  }

  /** Whether `select` was given at all — the switch between whole values and matches. */
  get selecting(): boolean {
    return this.select !== undefined;
  }

  // Compiled paths are shared configuration; per-scan automaton storage is no longer useful.
  dispose(): void {
    this.select?.dispose();
    this.skip?.dispose();
  }

  /** Steps into the child named `label`; `placement()` then describes that child. */
  descend(label: string | number): void {
    this.select?.descend(this.depth, label);
    this.skip?.descend(this.depth, label);
    this.depth++;
  }

  ascend(): void {
    this.depth--;
  }

  placement(): Placement {
    const skipped = this.skip?.hits(this.depth) !== undefined;
    if (skipped || this.select === undefined) return { hits: undefined, skipped, dead: skipped };
    const hits = this.select.hits(this.depth);
    return { hits, skipped: false, dead: hits === undefined && !this.select.reachable(this.depth) };
  }
}
