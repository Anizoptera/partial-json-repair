// SPDX-License-Identifier: Apache-2.0

/**
 * The value tree and frames — what the scanner produces but does not itself
 * decide. The report (`report.ts`) and selection delivery (`picks.ts`) are separate objects that
 * exist only when asked for; the builder calls into them where a value is placed.
 *
 * Split from the scanner because the seam is real, not to satisfy a line count: the scanner owns
 * positions and the state machine and calls straight into this, one shape, no event bus. The
 * measured cost of a SECOND call shape at that boundary is 3.6x per token, which is why nothing here
 * is an interface with two implementations.
 *
 * Selection is decided here, through the imported filter, because this is where a node is allocated: the
 * decision not to build a subtree has to be taken before its first member arrives, and this is the
 * one place that sees every member arrive.
 */

import type { PositionAt } from "./positions";
import type { FinishedRoot } from "./root-log";
import type { ResolvedOptions } from "./options";
import type { Overflow, Report } from "./report";
import type { BuildFilter } from "./path-filter";
import type { Edit, EditLog, RecordedEdits } from "./edit-log";
import type { ScalarReader } from "./scalar-reader";
import type { NativeSlice } from "./native-slice";
import type { ErrorKind, RepairKind, SwitchableRepair } from "./types";
import { defineOwn, scalarUnits } from "./tree";
import type { retainedUnits } from "./tree";

export { defineOwn } from "./tree";

const NO_EDITS: readonly Edit[] = /* @__PURE__ */ Object.freeze([]);

/**
 * A point the edit log, the pending matches and — when a report is kept — its repair log, counts,
 * score and overflow can be rewound to. The report fields are written by `Report.markInto`.
 */
export type Mark = {
  r: number;
  e: number;
  c: number;
  p: number;
  m: number;
  o: Overflow | undefined;
};

/**
 * A rewind point the CALLER owns and the builder writes into.
 *
 * Marks are taken per member, per key and per value — several times a token in the object loop — and
 * they never outlive the frame that took them, so one record per call site is enough. Returning a
 * fresh object instead cost 8% of a damaged-document parse, named by `bun --cpu-prof`: at two fields
 * the engine could sink the allocation, and at five it allocated per member.
 */
export const newMark = (): Mark => ({ r: 0, e: 0, c: 0, p: 0, m: 0, o: undefined });

/** Container kinds on the depth stack. */
export const IN_OBJECT = 1;
export const IN_ARRAY = 2;

/**
 * How a frame relates to the selection. BUILT frames hold a real container receiving members: with
 * no `select`, everywhere but under a `skip`; with one, a matched container and everything inside
 * it. A TRANSIT frame is not built, but a selector may still match beneath it, so its members are
 * classified one by one. A DEAD frame is not built and nothing beneath it can match, so its
 * members are only counted — which keeps paths right for a report that audits skipped content.
 */
export const BUILT = 0;
export const TRANSIT = 1;
export const DEAD = 2;

/** Stands in on the stack for a container that was not built. Frozen, so a stray write throws in strict code rather than leaking. */
const UNBUILT = /* @__PURE__ */ Object.freeze({}) as Record<string, unknown>;
/** No top-level value is open: distinct from every value, `undefined` and `UNBUILT` included. */
const NO_ROOT: unique symbol = /* @__PURE__ */ Symbol("no root");

/**
 * The dangerous-key set. Exactly these six, defined once, and **not publicly exported**.
 *
 * The extracted package exported it as a mutable `Set`, so any code in the process could empty it.
 * Unexported is the guard, and `Object.freeze` would not have been: freezing a `Set` freezes its own
 * properties and leaves the internal slots alone, so `.add()` still works on a frozen one. A reader
 * seeing `Object.freeze` here would believe in a protection that does not exist.
 */
export const DANGEROUS_KEY_NAMES = [
  "__proto__",
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
] as const;
const DANGEROUS_KEYS: ReadonlySet<string> = /* @__PURE__ */ new Set(DANGEROUS_KEY_NAMES);

/** The root facts needed by acceptance filters, retained without keeping an unselected tree. */
export type RootInfo = { readonly object: boolean; readonly missingRequired: number };

/** Composition selects optional storage implementations without importing them into ordinary readers. */
export type BuildMode = {
  /** Deliver selected scalars as fragments rather than retaining them. Stream only. */
  readonly fragments: boolean;
  // Presence selects streaming storage accounting and its scalar bound together, without a second flag.
  readonly streamReader: typeof ScalarReader | undefined;
  // Only streams need to recount discarded subtrees; ordinary parse bundles must omit that walk.
  readonly retainedUnits: typeof retainedUnits | undefined;
  // Only whole input may hand clean members to `JSON.parse`; streams and their bundles omit it.
  readonly nativeSlice: ((opts: ResolvedOptions) => NativeSlice | undefined) | undefined;
} & (
  | { readonly edits: false; readonly openEdits: undefined }
  | { readonly edits: true; readonly openEdits: () => EditLog }
);

/*
 * Modes are SHARED FROZEN constants rather than object literals at the call sites.
 *
 * Not tidiness: mode fields are read on hot paths, and
 * a frozen object and a fresh literal are different hidden classes. One `parse(text, options)` call
 * ahead of a damaged-document parse cost 26% (82 -> 61 MB/s, bun 1.4.1) because those loads went
 * polymorphic; the same probe on the build before modes existed showed no penalty at all (76 -> 78).
 * One map per property load, and no allocation per call either.
 */
/** No edits, no fragments, not a stream: `parse`, `parseMany` and `findJsonSpan`. */
export const MODE_VALUE: BuildMode = /* @__PURE__ */ Object.freeze({
  edits: false,
  fragments: false,
  streamReader: undefined,
  retainedUnits: undefined,
  nativeSlice: undefined,
  openEdits: undefined,
});

/**
 * Builds the value tree, and is the ONLY place a key enters an object.
 *
 * Inherited keys use `Object.defineProperty`: plain `obj[key] = value` can invoke any setter installed
 * above the object and silently lose the member. Keys absent from the prototype chain keep the fast
 * assignment path.
 */
export class Builder {
  /** The dangerous-key set for THIS parse: the six built in, plus whatever the caller added. */
  private readonly dangerous: ReadonlySet<string>;
  /**
   * The parser-owned content `maxRetained` bounds, for the root in progress, in the logical units
   * the contract names — one per value or container entry, one per UTF-16 unit of a string or key,
   * one per character of an exact-number token, a number still being read, or retained repaired
   * text.
   */
  content = 0;
  // Only stream readers set this: filtered fallback data remains owned across root completion.
  declare heldContent: number | undefined;
  /** Requested path filtering; only its selected-output owner also carries delivery state. */
  readonly picks: BuildFilter | undefined;
  private readonly required: ReadonlySet<string> | undefined;
  private matchedRequired: Set<string> | undefined;
  private rootObject = false;

  constructor(
    private readonly opts: ResolvedOptions,
    /** Records a recoverable error. The scanner owns positions, so the builder asks rather than derives. */
    private readonly onError: (kind: ErrorKind, at: number, refused?: SwitchableRepair) => void,
    /** Stops the scan: `maxRetained` was exceeded at `at`. */
    private readonly onRetained: (at: number) => void,
    /** How an absolute offset is reported; the source's owner knows its chunks and units. */
    readonly positionAt: PositionAt,
    private readonly mode: BuildMode,
    /** The report, when one was asked for. Without it no repair is recorded or counted. */
    private readonly report: Report | undefined,
    /** Makes the requested node filter; only selection also owns delivery state. */
    picks: ((builder: Builder) => BuildFilter) | undefined,
  ) {
    this.editLog = mode.openEdits?.();
    this.edits = this.editLog?.edits ?? NO_EDITS;
    this.dangerous =
      opts.customDangerousKeys.length === 0
        ? DANGEROUS_KEYS
        : new Set([...DANGEROUS_KEYS, ...opts.customDangerousKeys]);
    this.required = opts.requiredKeys.length === 0 ? undefined : new Set(opts.requiredKeys);
    this.picks = picks?.(this);
  }

  /**
   * Per frame, whether its object was refused whole, so a later member cannot quietly repopulate it.
   * Per frame rather than per object: an unbuilt frame has no object of its own, yet its refusal
   * still decides what selection may deliver from inside it.
   */
  private readonly refused: (true | undefined)[] = [];
  /** The outermost refused frame still open, or -1: nothing inside it reaches the final tree. */
  refusedFrom = -1;
  /**
   * Per frame, the keys of members it did not write, for duplicate-key policy where `Object.hasOwn`
   * has no object to ask. Kept only while the policy can still answer: refused, or reported in scope.
   */
  private readonly unwrittenKeys: (Set<string> | undefined)[] = [];

  /**
   * Open containers, root first, innermost last. Object references, so this cannot be a typed array.
   * Readable so a snapshot can copy the spine and share every finished branch; frames that were not
   * built hold `UNBUILT`; views use frame modes to exclude them from the copied spine.
   */
  readonly stack: (Record<string, unknown> | unknown[])[] = [];
  /** The key each open object is waiting to receive a value for. Parallel to `stack`. */
  readonly keys: (string | undefined)[] = [];
  /**
   * Where each pending key STARTS in the source. Parallel to `keys`.
   *
   * A repair about a member points at the key, never at the value that followed it: a reader shown
   * "a dangerous key was dropped" or "this key was written twice" wants the key underlined, and the
   * edit that deletes the member already spans from the key. Kept here rather than passed in,
   * because `place` is reached through `write` and only the key's own arrival knows this offset.
   */
  private readonly keyAts: number[] = [];
  /**
   * Where both logs stood when each frame's current member began. Parallel to `stack`.
   *
   * A member the policy DROPS takes its repairs and edits with it, or `repair(text)` splices a
   * rewrite that lands inside a span another edit deletes. MEASURED: `{"__proto__":[1,2,],"ok":2}`
   * returned `{],"ok"` — the trailing-comma edit sat inside the deleted member, the two spliced
   * spans overlapped, and a successful result carried text `JSON.parse` refuses. Per FRAME because
   * the member being dropped may hold whole containers whose own members marked over a shared one.
   * Taken as a member ENDS rather than as its key arrives, so an inserted separator — zero width,
   * before the key — goes with it: `{"a":1 "__proto__":2}` otherwise repairs to `{"a":1,}`.
   */
  private readonly memberMarks: Mark[] = [];
  /**
   * For each open frame that is ITSELF a dropped member, where the logs stood just after the drop
   * was recorded. Parallel to `stack`, and `undefined` for every ordinary frame.
   *
   * A container is placed when it OPENS, so the drop is decided before a byte of its contents has
   * been read and the retraction above reaches none of them. They are undone when it closes. A mark
   * of its own rather than the frame's `memberMarks` entry, which its own members overwrite:
   * `{"__proto__":{"a":1,"b":2},"ok":3}` would otherwise retract only its LAST member.
   */
  private readonly dropMarks: (Mark | undefined)[] = [];
  /** `IN_OBJECT` or `IN_ARRAY` per frame, since an unbuilt frame cannot be asked. */
  readonly kinds: number[] = [];
  /** `BUILT`, `TRANSIT` or `DEAD` per frame. */
  readonly modes: number[] = [];
  /** Members placed so far per frame: the next index of an array, built or not. */
  readonly counts: number[] = [];

  /**
   * Where each open container LIVES in its parent — its key or its index. Distinct from `keys`, which
   * is cleared as soon as a value is placed: a container's own position must survive for as long as
   * its children are being scanned, or a repair deep inside it reports a path missing every ancestor.
   *
   * Readable, because it is also the parent→child link a spine copy needs. Searching the parent for
   * the child instead costs an allocation and a scan per frame, to rediscover what this already
   * knows — and gets it wrong for an array holding the same value twice.
   */
  readonly labels: (string | number)[] = [];
  /** The top-level value in progress, `UNBUILT` where it is not built under `select`. */
  private openRoot: unknown = NO_ROOT;
  /** Top-level values FINISHED so far, which is what a repair's `valueIndex` counts. */
  completed = 0;

  /**
   * Closes the books on the top-level value just placed, so its report is fixed before the next one
   * starts. Answers the builder's half of the root's record; the scanner adds the rest and keeps it.
   */
  finish(): Pick<FinishedRoot, "value" | "info"> {
    this.picks?.delivery?.finish();
    const root = {
      value: this.openRoot,
      info:
        this.opts.objectOnly || this.required !== undefined
          ? // Presence is a set property: repeated requirements cannot create missing members.
            {
              object: this.rootObject,
              missingRequired: (this.required?.size ?? 0) - (this.matchedRequired?.size ?? 0),
            }
          : undefined,
    };
    this.openRoot = NO_ROOT;
    this.listBracket = -1;
    this.completed++;
    this.rootObject = false;
    this.matchedRequired = undefined;
    // Delivered content is the consumer's; the charge covers the root in progress.
    this.content = 0;
    return root;
  }
  /**
   * Values written INSIDE the top-level candidate being scanned — the scanner resets it per
   * candidate. It counts every depth, not just the root's own members, which is the whole point:
   * it is one of the three marks that tell a container holding data from a bracket pair that
   * happened to appear in a sentence (judged in `scan.ts`).
   */
  placed = 0;

  /** Path to the position currently being written. Derived from the frames, never stored twice. */
  path(): (string | number)[] {
    const i = this.stack.length - 1;
    if (i < 0) return [];
    if (this.kinds[i] === IN_ARRAY) return this.pathTo(this.counts[i] as number);
    const key = this.keys[i];
    const out = this.ancestors();
    if (key !== undefined) out.push(key);
    return out;
  }

  /** The labels of every open frame below the root: the path of the innermost open container. */
  ancestors(): (string | number)[] {
    const out: (string | number)[] = [];
    // Frame 0 is the root value itself, which has no label.
    for (let i = 1; i < this.stack.length; i++) out.push(this.labels[i] ?? "");
    return out;
  }

  /** The path of the child `label` of the innermost open container. */
  pathTo(label: string | number): (string | number)[] {
    const out = this.ancestors();
    out.push(label);
    return out;
  }

  /**
   * The source rewrites that would turn the input into the value this parse produced.
   *
   * Appended by `repair()` and by nothing else, so an edit cannot exist without the repair that
   * explains it and the two cannot describe different things — the failure measured when recovery
   * counters were maintained beside the repair list by hand.
   *
   * Not every repair has one, and the absence is a decision rather than an omission:
   * `duplicate-key` needs none, because last-wins is what `JSON.parse` does with the same text.
   */
  readonly edits: RecordedEdits;
  // Repair readers reach the imported owner directly; the shared scanner needs no repair methods.
  readonly editLog: EditLog | undefined;

  // Readers must decide before producing JSON text; discarding an already serialized edit is too late.
  get editsEnabled(): boolean {
    return this.mode.edits;
  }

  /**
   * Undoes every repair recorded since `mark`, AND the edits that came with them, AND the matches
   * — a candidate rejected as prose takes its matches with it.
   *
   * One method rather than two assignments at a dozen retraction sites: a rewind that dropped the
   * repair but kept the edit would leave `repair(text)` splicing a change nothing in the result
   * explains, and the scanner rewinds constantly -- every chunk boundary mid-token is a retraction.
   */
  retract(mark: Mark): void {
    this.rewind(mark);
    this.picks?.delivery?.truncate(mark.m);
  }

  /** Whether a repair or error at the current position belongs in the report's scope. */
  get inScope(): boolean {
    // Avoiding storage for refused content must not narrow an unfiltered report.
    return (
      this.picks === undefined ||
      this.report?.auditing === true ||
      this.modes[this.stack.length - 1] !== DEAD
    );
  }

  /**
   * Records an alteration. `at` is an absolute source offset; the scanner alone owns its live
   * buffer and translates buffer positions before crossing this seam. `key` is the member's key,
   * for the overflow count of a `dangerous-key` repair.
   *
   * Nothing is recorded unless a report was asked for — that is the whole cost of the default path.
   * The report owns counting and entry construction; path and position are computed only for
   * entries it stores. The builder takes the rewind mark before either operation.
   */
  repair(kind: RepairKind, at: number, key = ""): void {
    const report = this.report;
    if (report === undefined || !this.inScope) return;
    this.touch();
    report.recordRepair(kind, at, key, this);
  }

  /**
   * Records a source rewrite for `repair(text)`: replace `[start, end)` with `text`. `end === start`
   * inserts, an empty `text` deletes.
   *
   * Deliberately NOT derived from the repair list. A repair says what changed about the VALUE and is
   * located where a human wants to look; an edit says what to write and is located where the bytes
   * are, and for an unclosed string those are the opening quote and the end of the input. Forcing one
   * to be a function of the other made a rewind that dropped a single-quote edit also drop the
   * unclosed-string repair that a different reader had recorded.
   *
   * Nothing is recorded unless the verb is `repair`: every other verb would retain a log it never
   * reads, per root, for the life of a stream.
   */
  edit(start: number, end: number, text: string): void {
    if (!this.mode.edits) return;
    this.touch();
    this.editLog?.record(start, end, text);
    this.charge(text.length, start);
  }

  get hasOpenRoot(): boolean {
    return this.openRoot !== NO_ROOT;
  }

  /**
   * Makes the finished root the first element of an open array frame, so the values after it are
   * read as that array's elements (`1,2,3`, `{..},{..}`: the scanner's `missing-brackets`). The
   * root is already built and may be large or partly released from the buffer, so it is wrapped in
   * place rather than read again. The scanner allows this only without selection or root filters,
   * so the root is always built and the frame is a plain BUILT array.
   */
  wrapRoot(at: number, start: number, rootEdits: number): void {
    // The opening bracket goes ahead of the root's own edits but never before `rootEdits`, the edits
    // earlier roots recorded (`insertFirst`). Every mark that could rewind past it was taken by the
    // candidate before its first edit (`rootEdits` itself), so a rejected candidate takes it along.
    this.listBracket = this.editLog?.insertFirst(start, "[", rootEdits) ?? -1;
    if (this.listBracket >= 0) this.charge(1, at);
    const list = [this.openRoot];
    this.openRoot = list;
    this.charge(1, at);
    this.stack.push(list);
    this.dropMarks.push(undefined);
    this.keys.push(undefined);
    this.labels.push("");
    this.kinds.push(IN_ARRAY);
    this.modes.push(BUILT);
    this.counts.push(1);
  }

  /** Where `wrapRoot` put the list's opening bracket in the edit log, or -1 without one. */
  listBracket = -1;

  /** The open root was prose; it never becomes a value. */
  discardOpenRoot(): void {
    this.openRoot = NO_ROOT;
    // Its edits, the bracket among them, go with the candidate's retraction.
    this.listBracket = -1;
  }

  /** Records where the logs, the report's counters and the pending matches stand, into the caller's {@link newMark}. */
  markInto(into: Mark): void {
    this.report?.markInto(into);
    into.e = this.edits.length;
    into.m = this.picks?.delivery?.held ?? 0;
  }

  /** The same undo as `retract`, without the matches. */
  private rewind(mark: Mark): void {
    this.report?.rewind(mark);
    this.editLog?.rewind(mark.e);
  }

  /*
   * Rewind points for the token loop's two scopes, the trivia run and the token after it (`scan.ts`
   * says why they are two). Taken LAZILY, at the scope's first repair or edit: nearly every token
   * records neither, and a mark taken then equals one taken when the scope began, since nothing was
   * recorded in between. Retractions inside a scope (`retractMember` lowers the logs below its start)
   * are never followed by a rewind of that scope, so the equality is all the rewind needs. The scope
   * rewinds never touch the matches: they undo only tokens that never completed, and a match is
   * recorded only when its node has. `ScanDiagnostics` marks its errors the same way.
   */
  private readonly triviaMark = newMark();
  private readonly tokenMark = newMark();
  private triviaUnmarked = true;
  private tokenUnmarked = true;

  beginTrivia(): void {
    this.triviaUnmarked = true;
    this.tokenUnmarked = false;
  }

  beginToken(): void {
    this.tokenUnmarked = true;
  }

  /** Called before anything a scope rewind must undo is recorded. */
  private touch(): void {
    if (this.triviaUnmarked) {
      this.triviaUnmarked = false;
      this.markInto(this.triviaMark);
    }
    if (this.tokenUnmarked) {
      this.tokenUnmarked = false;
      this.markInto(this.tokenMark);
    }
  }

  /** Undoes what the trivia run recorded; nothing to undo while it is unmarked. */
  rewindTrivia(): void {
    if (!this.triviaUnmarked) this.rewind(this.triviaMark);
  }

  rewindToken(): void {
    if (!this.tokenUnmarked) this.rewind(this.tokenMark);
  }

  get retainedRoom(): number {
    // Whole-input calls already own their input; only streams enforce this storage ledger.
    // JSON.parse cannot charge it, so enforcing it here would give the same input two answers.
    return this.mode.streamReader
      ? Math.max(0, this.opts.maxRetained - this.content - (this.heldContent ?? 0))
      : Infinity;
  }

  /** Charges only parser-owned content; unbuilt or delivered values cost nothing. */
  charge(units: number, at: number): void {
    if (!this.mode.streamReader) return;
    this.content += units;
    if (this.content + (this.heldContent ?? 0) > this.opts.maxRetained) this.onRetained(at);
  }

  /**
   * Charges what a scalar retains. Guarded here rather than at the four call sites so its size — a
   * type test plus an `isExactNumber` call — is never computed for a bound that only streams apply.
   */
  chargeValue(v: unknown, at: number): void {
    if (this.mode.streamReader) this.charge(scalarUnits(v), at);
  }

  /** Refund an owned value only when no retained parent or match still holds it. */
  releaseValue(v: unknown): void {
    if (this.mode.retainedUnits !== undefined) this.content -= this.mode.retainedUnits(v);
  }

  /** The key the innermost object waits on next; `at` is where it starts, for a bound tripped by it. */
  key(name: string, at: number): void {
    const i = this.stack.length - 1;
    // A discarded key still names later repairs until its replacement releases that context.
    const previous = this.keys[i];
    if (previous !== undefined && this.modes[i] === BUILT) this.charge(-previous.length, at);
    this.keys[i] = name;
    this.keyAts[i] = at;
    if (this.modes[i] === BUILT) this.charge(name.length, at);
  }

  open(kind: number, at: number): boolean {
    const parent = this.stack.length - 1;
    if (parent < 0) {
      this.rootObject = kind === IN_OBJECT;
      if (this.rootObject && this.required !== undefined) this.matchedRequired = new Set();
    }
    // Read the label BEFORE placing the container: `value()` clears the pending key, and an array's
    // index is its length before the push.
    let label: string | number = "";
    if (parent >= 0) {
      label =
        this.kinds[parent] === IN_ARRAY
          ? (this.counts[parent] as number)++
          : (this.keys[parent] ?? "");
    }
    const picks = this.picks;
    let mode = parent >= 0 && this.modes[parent] === DEAD ? DEAD : BUILT;
    if (mode === BUILT && picks !== undefined) mode = picks.open(label, at, parent);
    const container =
      mode === BUILT
        ? kind === IN_ARRAY
          ? []
          : this.opts.nullPrototype
            ? (Object.create(null) as Record<string, unknown>)
            : {}
        : UNBUILT;
    // Written into the parent only when the parent is real; a matched container under a transit
    // parent is retained by its occurrence alone, and charged here since no write charges it.
    const written = mode === BUILT && (parent < 0 || this.modes[parent] === BUILT);
    const before = this.content;
    const dropped = this.write(container, at, parent, written);
    if (mode === BUILT && !written) this.charge(1, at);
    this.stack.push(container);
    // Taken here, after the drop repair the write above recorded, so the retraction at close keeps
    // the loss reported while taking everything the container went on to log.
    let dropMark: Mark | undefined;
    if (dropped) this.markInto((dropMark = newMark()));
    this.dropMarks.push(dropMark);
    this.keys.push(undefined);
    this.labels.push(label);
    this.kinds.push(kind);
    this.modes.push(mode);
    this.counts.push(0);
    const frame = this.stack.length - 1;
    if (
      picks === undefined
        ? dropped || this.refusedFrom >= 0
        : picks.opened(container, frame, dropped)
    ) {
      this.modes[frame] = DEAD;
      this.stack[frame] = UNBUILT;
      // Not retained after all: a dead frame holds nothing, whatever opening it charged.
      this.content = Math.min(this.content, before);
    }
    return dropped;
  }

  /**
   * Freeze each container as it closes. Off until a caller asks for a shared view, and then on
   * for the rest of the stream.
   *
   * This is what makes a shared snapshot cost O(depth + width of the open containers) rather than
   * O(size): the snapshot shares
   * every finished branch, so those branches must be deeply immutable, and freezing them AT CLOSE
   * pays once per container instead of re-walking them on every chunk. It also makes the guarantee
   * true at every level by construction — a container's children were frozen when they closed, so
   * freezing it completes the subtree.
   *
   * Off by default because it is only owed to a caller who asked for it: a parse that never takes a
   * frozen snapshot must not pay a freeze per container, and must not hand back frozen values to a
   * consumer who expects to be able to edit them.
   */
  freezeOnClose = false;

  /** Closes the innermost container; `end` is the absolute offset just past its closer. */
  close(end: number): void {
    const i = this.stack.length - 1;
    const done = this.stack[i];
    // A key with no value never entered the tree; closing its frame releases that pending text.
    const pendingKey = this.keys[i];
    if (pendingKey !== undefined && this.modes[i] === BUILT) this.charge(-pendingKey.length, end);
    if (this.freezeOnClose && done !== undefined && this.modes[i] === BUILT) Object.freeze(done);
    if (this.refused[i] === true) {
      this.refused[i] = undefined;
      if (this.refusedFrom === i) this.refusedFrom = -1;
    }
    // Read first: only selection fills it, and a write would grow the array on every plain close.
    if (this.unwrittenKeys[i] !== undefined) this.unwrittenKeys[i] = undefined;
    this.picks?.delivery?.close(i, end);
    // Everything a dropped container logged goes back with it, now that the last of it has arrived.
    const dropMark = this.dropMarks.pop();
    if (dropMark !== undefined) this.retract(dropMark);
    this.stack.pop();
    this.keys.pop();
    this.labels.pop();
    this.kinds.pop();
    this.modes.pop();
    this.counts.pop();
    this.picks?.leave(i - 1);
  }

  /**
   * Places a finished value wherever the scan currently is: an array slot, an object key, or the
   * root. `at` and `end` are the value's absolute source extent; `at` is also where placing it
   * reports a repair.
   */
  value(v: unknown, at: number, end: number, stopped = false): boolean {
    const parent = this.stack.length - 1;
    if (parent < 0) this.rootObject = false;
    if (parent >= 0) this.placed++;
    let label: string | number = "";
    if (parent >= 0) {
      if (this.kinds[parent] === IN_ARRAY) label = (this.counts[parent] as number)++;
      else {
        const key = this.keys[parent];
        // A value with no key: the scanner reports the missing colon.
        if (key === undefined) return false;
        label = key;
      }
    }
    const picks = this.picks;
    let write = parent < 0 || this.modes[parent] === BUILT;
    const before = this.content;
    // Terminal prefixes must remain failed recovery even when selection normally delivers eagerly.
    if (picks !== undefined && (parent < 0 || this.modes[parent] !== DEAD))
      write = picks.value(v, label, at, end, parent, write, stopped);
    const dropped = this.write(v, at, parent, write);
    // A match held for a dropped member left with it (the member retraction), so its charge does too.
    if (dropped) this.content = Math.min(this.content, before);
    picks?.leave(parent);
    return dropped;
  }

  /**
   * The write itself, into the parent frame — or nothing, when the parent is not built. The
   * pending key is cleared ONCE, after the write, so every repair recorded below still has it in
   * scope and can name the key it is about. Clearing first cost the path its last segment, and a
   * `dangerous-key` repair that cannot say WHICH key is barely a report at all.
   */
  private write(v: unknown, at: number, parent: number, write: boolean): boolean {
    if (parent < 0) {
      this.openRoot = write ? v : UNBUILT;
      if (write) this.chargeValue(v, at);
      return false;
    }
    const top = this.stack[parent];
    if (this.kinds[parent] === IN_ARRAY) {
      if (write) {
        (top as unknown[]).push(v);
        this.chargeValue(v, at);
      }
      return false;
    }
    const key = this.keys[parent] as string;
    if (
      parent === 0 &&
      this.required?.has(key) === true &&
      (!this.dangerous.has(key) || this.opts.onDangerousKey === "keep")
    ) {
      this.matchedRequired?.add(key);
    }
    let dropped = false;
    // Key policy governs every member, written or not: a selection decides what is built, never
    // whether a violation in unselected content is accepted (API.md "Diagnostics describe…").
    if (this.refused[parent] !== true) {
      dropped = this.place(
        this.modes[parent] === BUILT ? (top as Record<string, unknown>) : undefined,
        key,
        v,
        at,
        parent,
        write,
      );
      if (write && !dropped && this.refused[parent] !== true) this.chargeValue(v, at);
    }
    // A pending key becomes owned by the object only if its value was inserted.
    if (this.modes[parent] === BUILT && (!write || dropped || this.refused[parent] === true))
      this.charge(-key.length, at);
    this.keys[parent] = undefined;
    return dropped;
  }

  /**
   * Marks where the innermost frame's next member begins, so dropping that member can take exactly
   * its own log — the separator before it included.
   *
   * Driven by the SCANNER, at the two points a member can begin: a container opening, and the token
   * after a completed member. Not from `write`, which runs a member too early — the deletion for a
   * member dropped just before is emitted later still, once the next token says whether it also
   * takes the following comma, and a mark taken at `write` precedes it. MEASURED:
   * `{"__proto__":1,"constructor":2,"ok":3}` kept the first member, the second member's retraction
   * having swallowed the first's deletion.
   *
   * Retracting to a mark is exact where a deletion span cannot be: a key whose value never arrives
   * takes an INSERTED comma with it, and that comma is not in the source text at all — `{"a":1 "b`
   * would otherwise repair to `{"a":1,}`.
   *
   * One `Mark` per depth, reused: the scanner has no recursion, so a frame's mark cannot be live
   * twice, and a fresh object per member is the hottest allocation in a damaged-document parse.
   */
  startMember(): void {
    const frame = this.stack.length - 1;
    if (frame < 0) return;
    this.markInto((this.memberMarks[frame] ??= newMark()));
  }

  /** Undoes everything the innermost frame's current member logged. See {@link startMember}. */
  retractMember(): void {
    const mark = this.memberMarks[this.stack.length - 1];
    if (mark !== undefined) this.retract(mark);
  }

  /** A dropped member must also delete source trivia whose repair its mark will retract. */
  memberStart(keyAt: number): number {
    const mark = this.memberMarks[this.stack.length - 1];
    return mark === undefined ? keyAt : (this.editLog?.memberStart(mark.e, keyAt) ?? keyAt);
  }

  /**
   * The write itself, with the key policy applied. Split out only so the clear above happens once.
   * Keep the parent even when skipping a member: refusal must clear the containing object.
   */
  private place(
    top: Record<string, unknown> | undefined,
    key: string,
    v: unknown,
    at: number,
    frame: number,
    write: boolean,
  ): boolean {
    // Every report below names the KEY's position, never the value's: all of them are about the
    // member, `dropped-member` already points there, and the edit that removes a dropped member
    // spans from the key too. Pointing at the value put two halves of one decision on opposite
    // sides of the colon.
    const keyAt = this.keyAts[frame] ?? at;
    // Last wins, as `JSON.parse` does — but the caller is TOLD, including for a governed key kept as
    // ordinary data. Checking after the policy made every dangerous name bypass duplicate reporting.
    const duplicate =
      top === undefined || !write ? this.unwrittenSeen(frame, key) : Object.hasOwn(top, key);
    if (duplicate) {
      if (this.opts.recover["duplicate-key"]) this.repair("duplicate-key", keyAt);
      // Refused: the LAST value still wins, because which value survives is not a policy question.
      // A caller switching this off is saying their source should not repeat a key at all.
      else this.onError("unparsable-span", keyAt, "duplicate-key");
    }
    if (this.dangerous.has(key)) {
      // **The one place policy is applied.** The extracted package asked this question in three
      // places with three different answers, and the WEAKEST one ran. There is now one place to
      // diverge from.
      //
      // Each outcome reports through the channel that describes it, and `keep` reports through
      // neither. A repair means the output differs from a literal reading of the input; under `keep`
      // it does not, and charging a repair would drop `confidence` for a document that parsed
      // perfectly — which is exactly the defect that made the old `confidence` report the caller's
      // schema instead of the parser's certainty.
      if (this.opts.onDangerousKey === "drop") {
        // The member leaves the tree, so its repairs and edits leave with it — they describe bytes
        // the repaired text will not contain, and an edit inside the deleted span makes two splices
        // overlap. Retract FIRST, then record the loss: a retraction alone leaves it unreported,
        // which is the same order the dangling-key drop in `scan.ts` keeps. See `memberMarks`.
        const mark = this.memberMarks[frame];
        if (mark !== undefined) this.retract(mark);
        this.repair("dangerous-key", keyAt, key); // data was dropped: a real alteration
        return true;
      }
      if (this.opts.onDangerousKey === "reject") {
        // A policy refused, which is an error and not a repair — nothing was fixed. Recoverable: the
        // scan continues and the other values still arrive.
        this.onError("dangerous-key", keyAt);
        // Refused PERMANENTLY: without the mark, members arriving after this key would repopulate an
        // object the policy already declined.
        this.refused[frame] = true;
        if (this.refusedFrom < 0) this.refusedFrom = frame;
        if (top !== undefined) {
          this.releaseValue(top);
          // The refused object remains as empty recovery; only its former members leave.
          this.charge(1, at);
          for (const k of Object.keys(top)) delete top[k];
        }
        // Everything selected inside the refused object leaves the final tree with it.
        this.picks?.delivery?.refused(frame);
        return false;
      }
      // `keep`, written with `defineProperty`. Assignment would walk `__proto__`'s setter and mutate
      // the prototype, so a correct guard sitting beside a plain `top[key] = v` still pollutes —
      // which is why the check and the write must be the same statement's business, not neighbours.
    }

    if (top !== undefined && write) {
      if (duplicate) {
        this.releaseValue(top[key]);
        // key() charged the incoming spelling while the previous member still owned its key.
        this.charge(-key.length, at);
      }
      defineOwn(top, key, v);
    }
    return false;
  }

  /**
   * Whether an unwritten member's key already appeared in its frame. A set per frame costs memory
   * an unbuilt frame otherwise avoids, so it is kept only while the answer matters: the duplicate is
   * refused, or a report would record it at this position.
   */
  private unwrittenSeen(frame: number, key: string): boolean {
    if (this.opts.recover["duplicate-key"] && (this.report === undefined || !this.inScope))
      return false;
    const seen = (this.unwrittenKeys[frame] ??= new Set());
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  }

  /**
   * What a failed root still holds for the caller: under `select`, the matches gathered and not
   * yet delivered, as they would have been delivered; otherwise the root value. `undefined` when
   * nothing was built.
   */
  recovery(): { value: unknown } | undefined {
    const delivery = this.picks?.delivery;
    if (delivery?.selecting === true) return { value: delivery.recovery() };
    const root = this.openRoot;
    return root === NO_ROOT || root === UNBUILT ? undefined : { value: root };
  }

  // Detach owned references without changing containers already handed to the caller.
  dispose(): void {
    this.openRoot = NO_ROOT;
    this.matchedRequired = undefined;
    this.stack.length = 0;
    this.keys.length = 0;
    this.labels.length = 0;
    this.unwrittenKeys.length = 0;
    this.memberMarks.length = 0;
    this.dropMarks.length = 0;
    this.refused.length = 0;
    this.keyAts.length = 0;
    this.kinds.length = 0;
    this.modes.length = 0;
    this.counts.length = 0;
    this.editLog?.dispose();
    this.triviaMark.o = undefined;
    this.tokenMark.o = undefined;
    this.picks?.dispose();
    if (this.report !== undefined) {
      this.report.repairs.truncate(this.report.repairs.start);
      this.report.errors.truncate(this.report.errors.start);
      this.report.overflow = undefined;
    }
  }

  /**
   * Where the innermost object's pending key starts, while its value has not arrived: a key policy
   * that refuses the member reports there once the value lands, possibly chunks later. Outer frames
   * hold no pending key, since a key clears when its container opens, and that is when it was judged.
   */
  get pendingKeyAt(): number | undefined {
    const i = this.stack.length - 1;
    return this.keys[i] === undefined ? undefined : this.keyAts[i];
  }

  /** Whether the innermost open frame is a real container — the one a string still arriving would land in. */
  get innermostBuilt(): boolean {
    return this.modes[this.stack.length - 1] === BUILT;
  }
}
