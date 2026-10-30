// SPDX-License-Identifier: Apache-2.0

import type { Builder, Mark } from "./builder";
import type { ResolvedOptions } from "./options";
import { IS_WS } from "./chars";
import type { LogCursor } from "./parser-outcome";
import { spanOf } from "./parser-outcome";
import type { Scanner } from "./scan-contract";
import type { ScanDiagnostics } from "./scan-diagnostics";
import type {
  ConfigurationFailure,
  Diagnostics,
  DiagnosticsFeature,
  DiagnosticsSettings,
  Input,
  ParseError,
  Repair,
  RepairKind,
  Span,
} from "./types";
import type { ReaderResult, WholeInputReader } from "./whole-reader";
import { REPAIR_PENALTY } from "./types";
import { configurationError } from "./configuration-error";
import { RootLog } from "./root-log";

// Released roots have no report totals; default scans must not retain this report-only state.
const NO_TALLY: Tally = /* @__PURE__ */ Object.freeze({
  repairs: 0,
  errors: 0,
  certainty: 1,
  overflow: undefined,
});

// Empty reports belong to the imported feature too; unreported failures must retain no report data.
const CLEAN_DIAGNOSTICS: Diagnostics = /* @__PURE__ */ Object.freeze({
  repairs: /* @__PURE__ */ Object.freeze([]),
  errors: /* @__PURE__ */ Object.freeze([]),
  counts: /* @__PURE__ */ Object.freeze({ repairs: 0, errors: 0 }),
  entriesComplete: true,
  scanComplete: true,
  scope: "all",
  confidence: 1,
  laterValues: /* @__PURE__ */ Object.freeze([]),
});

/**
 * Repairs counted past the entry cap, which the report no longer stores: per kind, and per blocked
 * key for `dangerous-key`. Immutable and replaced on each overflow repair, so a mark keeps the one in
 * force when it was taken and a rewind restores it by reference. `keys` has a null prototype: the keys
 * counted are `__proto__` and its kin.
 */
export type Overflow = Readonly<Partial<Record<RepairKind, number>>> & {
  readonly keys: Readonly<Record<string, number>>;
};

// Metrics needs capped repairs without adding a public field to every report. Weak keys keep this
// accounting alive only as long as its report; the imported diagnostics feature owns projection.
const OVERFLOW = /* @__PURE__ */ new WeakMap<Diagnostics, Overflow>();

/** Repairs beyond the entry cap that a metrics consumer must still count. */
export const overflowOf = (report: Diagnostics): Overflow | undefined => OVERFLOW.get(report);

/** One delivery's overflow delta; earlier deliveries of the same root already counted the rest. */
const overflowDelta = (now: Overflow, before: Overflow | undefined): Overflow => {
  if (before === undefined) return now;
  const keys = Object.create(null) as Record<string, number>;
  for (const [key, n] of Object.entries(now.keys)) keys[key] = n - (before.keys[key] ?? 0);
  const delta: Partial<Record<RepairKind, number>> & { keys: typeof keys } = { keys };
  for (const kind of Object.keys(now) as (RepairKind | "keys")[])
    if (kind !== "keys") delta[kind] = (now[kind] ?? 0) - (before[kind] ?? 0);
  return delta;
};

/** Slice optional report logs once per delivery; occurrence streams consume cursor deltas. */
const project = (
  scanner: Scanner,
  opts: ResolvedOptions,
  valueIndex: number,
  cursor: LogCursor,
): Diagnostics => {
  const repairLog = scanner.repairs ?? CLEAN_DIAGNOSTICS.repairs;
  const errorLog = scanner.errors ?? CLEAN_DIAGNOSTICS.errors;
  const repairs: Repair[] = [];
  for (let r = repairLog[cursor.repair]; r?.valueIndex === valueIndex;) {
    repairs.push(r);
    cursor.repair++;
    r = repairLog[cursor.repair];
  }
  const errors: ParseError[] = [];
  for (let e = errorLog[cursor.error]; e?.valueIndex === valueIndex;) {
    errors.push(e);
    cursor.error++;
    e = errorLog[cursor.error];
  }
  const tally = scanner.tallyAt?.(valueIndex) ?? NO_TALLY;
  const counts = { repairs: tally.repairs, errors: tally.errors };
  const report: Diagnostics = {
    repairs,
    errors,
    counts,
    entriesComplete: repairs.length === counts.repairs && errors.length === counts.errors,
    scanComplete: scanner.scanCompleteAt(valueIndex),
    scope:
      opts.selection === undefined ||
      (opts.diagnostics !== false && opts.diagnostics.scope === "all")
        ? "all"
        : "selected",
    confidence: tally.certainty,
    // Only a single-value verb finds later values, by a scan of its own after this projection.
    laterValues: CLEAN_DIAGNOSTICS.laterValues,
  };
  const overflow = tally.overflow;
  if (overflow !== undefined) {
    const seen = cursor.overflowSeen?.index === valueIndex ? cursor.overflowSeen.counts : undefined;
    if (seen !== overflow) OVERFLOW.set(report, overflowDelta(overflow, seen));
    cursor.overflowSeen = { index: valueIndex, counts: overflow };
  }
  return report;
};

// Built inside a function: Rspack keeps a nested annotated call at module level, which kept this
// module in import-only bundles built without the `sideEffects` field.
const NO_KEYS: Readonly<Record<string, number>> = /* @__PURE__ */ (() =>
  Object.freeze(Object.create(null) as Record<string, number>))();

const overflowed = (prev: Overflow | undefined, kind: RepairKind, key: string): Overflow => {
  // Keep immutable rewind snapshots in one object rather than allocate a wrapper per repair.
  const next = { ...prev, [kind]: (prev?.[kind] ?? 0) + 1, keys: prev?.keys ?? NO_KEYS };
  if (kind !== "dangerous-key") return next;
  const keys = Object.assign(Object.create(null) as Record<string, number>, prev?.keys);
  keys[key] = (keys[key] ?? 0) + 1;
  next.keys = keys;
  return next;
};

/** One root's report totals, stored or not, and its confidence score. */
export type Tally = {
  readonly repairs: number;
  readonly errors: number;
  /** `∏(1 - penalty)` over every repair of the root. */
  readonly certainty: number;
  readonly overflow: Overflow | undefined;
};

/**
 * The report a caller asked for: the retained repair and error entries, the counts behind them, the
 * confidence score, and what overflowed the entry cap.
 *
 * Its own object because nothing in it decides an outcome. Refusals, limits and the error budget
 * stay with the scanner's verdict book, since a default call still reports where it was refused; a
 * call without a report never constructs this, and pays one `undefined` check per repair or error.
 * One instance per scan, shared by the builder (repairs) and the scanner's diagnostics (errors),
 * because the entry cap bounds the two logs together.
 */
export class Report {
  readonly repairs = new RootLog<Repair>();
  readonly errors = new RootLog<ParseError>();
  /** Entries retained for the root in progress, both logs together. */
  private retained = 0;
  /**
   * Repairs recorded for the root in progress, stored or not, and the score they leave. Kept as the
   * repairs arrive rather than derived from the log afterwards: the log may be capped, and a cap must
   * not raise the score. A rewind restores both from its mark.
   */
  repairCount = 0;
  certainty = 1;
  /** In-scope errors of the root in progress, stored or not. */
  errorCount = 0;
  /** Repairs of the root in progress counted past the cap; `undefined` until the first one. */
  overflow: Overflow | undefined = undefined;

  // Read the existing root ledger; a second report index would duplicate ownership and cleanup.
  // A real own slot prevents a polluted prototype from intercepting the constructor assignment.
  readonly tallyAt: (valueIndex: number) => Tally;

  constructor(
    /**
     * `scope: "all"`: repairs and errors inside skipped and unselected subtrees are recorded too.
     * Otherwise they are neither recorded nor counted: the caller wrote the selector, and a
     * confidence lowered by content they declined would describe data they never receive.
     */
    readonly auditing: boolean,
    /** The cap on entries each report retains; every root's report starts empty. */
    private readonly maxEntries: number,
    owner: Pick<ScanDiagnostics, "build" | "ledger">,
  ) {
    this.tallyAt = (valueIndex) =>
      valueIndex === owner.build.completed
        ? this.live()
        : (owner.ledger.at(valueIndex)?.tally ?? NO_TALLY);
  }

  /**
   * Count every repair, but construct an entry only under the cap. Past the cap it still changes
   * the score; `key` names the blocked key a dangerous-key repair overflows under. Entry construction
   * belongs to the imported report so callers without diagnostics retain no repair-entry constructor.
   */
  recordRepair(kind: RepairKind, at: number, key: string, build: Builder): void {
    this.repairCount++;
    this.certainty *= 1 - REPAIR_PENALTY[kind];
    if (this.retained >= this.maxEntries) {
      // Counted, not stored: the count must survive the cap, and a rewind must take it back.
      this.overflow = overflowed(this.overflow, kind, key);
      return;
    }
    this.retained++;
    this.repairs.push({
      kind,
      at: build.positionAt(at),
      path: build.path(),
      valueIndex: build.completed,
    });
  }

  /** Counts an in-scope error, and answers whether its entry fits under the cap. */
  countError(): boolean {
    this.errorCount++;
    if (this.retained >= this.maxEntries) return false;
    this.retained++;
    return true;
  }

  /** Records where the repair half stands into a mark the builder takes. */
  markInto(into: Mark): void {
    into.r = this.repairs.end;
    into.c = this.repairCount;
    into.p = this.certainty;
    into.o = this.overflow;
  }

  /** Undoes every repair recorded since `mark`, counts and score included. */
  rewind(mark: Mark): void {
    this.retained -= this.repairs.truncate(mark.r);
    this.repairCount = mark.c;
    this.certainty = mark.p;
    this.overflow = mark.o;
  }

  /** Undoes the errors recorded since the log stood at `kept` with `counted` of them in scope. */
  rewindErrors(kept: number, counted: number): void {
    this.retained -= this.errors.truncate(kept);
    this.errorCount = counted;
  }

  /**
   * Closes the books on the root just finished and starts the next one clean. The cap is per report
   * and a report is per root: one cap shared by the call emptied every later report. A stream still
   * holds only bounded entries, because delivered roots release theirs.
   */
  finish(): Tally {
    const tally = this.live();
    this.retained = 0;
    this.repairCount = 0;
    this.certainty = 1;
    this.errorCount = 0;
    this.overflow = undefined;
    return tally;
  }

  /** The root in progress, answered from the live counters. */
  live(): Tally {
    return {
      repairs: this.repairCount,
      errors: this.errorCount,
      certainty: this.certainty,
      overflow: this.overflow,
    };
  }
}

/**
 * Fills a single-value report's `laterValues`: the roots `parseMany` would deliver after the returned
 * one. `rescan` is a second plain reader over the same input, made by the whole-input driver that
 * already owns source and reader construction, so this report-only loop ships with the imported
 * feature and pulls no whole-input code into stream bundles. A second reader, because continuing the
 * first would leave later roots' edits, selection ranges and logs in the scanner that repair and span
 * projection still read; same policy and root filters, so detection and root numbering are
 * `parseMany`'s and `valueIndex` identifies the returned root without comparing offsets across
 * readers.
 */
function* later(
  input: Input,
  result: ReaderResult,
  rescan: () => WholeInputReader | undefined,
): Generator<void, void> {
  const report = result.outcome.diagnostics;
  if (!result.root || report === undefined || result.options.diagnostics === false) return;
  // The second scan reads the returned value again, so skip it where nothing but whitespace follows:
  // the common single-document reply then pays nothing. `positionAt` turns the scanner's offset into
  // the input's own unit, a string index or a byte offset, and JSON's four whitespace characters are
  // single ASCII units in both.
  if (!result.scanner.selecting) {
    const unitAt =
      typeof input === "string" ? (i: number) => input.charCodeAt(i) : (i: number) => input[i];
    let at = result.scanner.positionAt(result.scanner.spanAt(result.valueIndex).end).offset;
    for (let c = unitAt(at); c !== undefined && c < 128 && IS_WS[c] === 1; c = unitAt(at)) at++;
    if (at === input.length) return;
  }
  const reader = rescan();
  if (reader === undefined) return;
  const cap = result.options.diagnostics.maxEntries;
  const spans: Span[] = [];
  try {
    while (true) {
      const step = reader.next();
      if (step.kind === "checkpoint") {
        yield;
        continue;
      }
      if (step.kind === "root") {
        if (step.valueIndex <= result.valueIndex) continue;
        // The cap bounds what a hostile input of tiny values makes the report hold.
        if (spans.length === cap) {
          report.entriesComplete = false;
          break;
        }
        spans.push(spanOf(reader.scanner.spanAt(step.valueIndex), reader.scanner.positionAt));
        continue;
      }
      if (step.kind === "deliveries") continue;
      // A limit or the error budget ended the scan, so values may follow that nothing listed;
      // `scanCompleteAt` past every root answers whether the scanner stopped anywhere.
      if (!reader.scanner.scanCompleteAt(Infinity)) report.scanComplete = false;
      break;
    }
  } finally {
    reader.close();
  }
  if (spans.length > 0) report.laterValues = spans;
}

/** What the core calls on the `diagnostics` feature it was handed: the only route to `Report`. */
export type ReportFeature = DiagnosticsFeature & {
  readonly empty: Diagnostics;
  readonly open: (owner: Pick<ScanDiagnostics, "build" | "ledger">) => Report;
  readonly project: typeof project;
  readonly later: typeof later;
};

/** The report entry cap when none is set: `maxDiagnostics`' default before features were imports. */
const MAX_ENTRIES = 1000;
const SCOPES: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["all", "selected"]);
const SETTINGS: ReadonlySet<string> = /* @__PURE__ */ new Set(["maxEntries", "scope"]);

const settingsFailure = (field: string, reason: ConfigurationFailure["reason"]): TypeError =>
  configurationError({ kind: "invalid-options", field: `diagnostics.${field}`, reason });

/**
 * One configured feature value. Callable, so `diagnostics` alone and `diagnostics({ maxEntries })`
 * are the same feature: the bare export is the default settings, and a call derives a new value
 * from this one's settings plus the given ones, so settings layer the way option objects do.
 * Frozen, because one value is shared by every call that passes it.
 */
const configured = (maxEntries: number, scope: DiagnosticsSettings["scope"]): ReportFeature => {
  const derive = (settings: DiagnosticsSettings): DiagnosticsFeature => {
    if (typeof settings !== "object" || settings === null || Array.isArray(settings))
      throw settingsFailure("settings", "object");
    for (const key of Object.getOwnPropertyNames(settings))
      if (!SETTINGS.has(key)) throw settingsFailure(key, "unknown");
    // An own `undefined` resets a setting to its default, as it does in an options object.
    const entries = Object.hasOwn(settings, "maxEntries") ? settings.maxEntries : maxEntries;
    if (entries !== undefined && (!Number.isSafeInteger(entries) || entries < 1))
      throw settingsFailure("maxEntries", "positive-integer");
    const next = Object.hasOwn(settings, "scope") ? settings.scope : scope;
    if (next !== undefined && !SCOPES.has(next)) throw settingsFailure("scope", "scope");
    return configured(entries ?? MAX_ENTRIES, next);
  };
  return Object.freeze(
    Object.assign(derive, {
      feature: "diagnostics" as const,
      maxEntries,
      scope,
      empty: CLEAN_DIAGNOSTICS,
      open: (owner: Pick<ScanDiagnostics, "build" | "ledger">) =>
        new Report(scope === "all", maxEntries, owner),
      project,
      later,
    }),
  );
};

/**
 * The report feature: pass it as `{ diagnostics }`, or call it for other settings. Built by a pure
 * factory call so importing the package does no work for it and a bundler drops it when unused.
 */
export const diagnostics: DiagnosticsFeature = /* @__PURE__ */ configured(MAX_ENTRIES, undefined);
