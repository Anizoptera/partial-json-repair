// SPDX-License-Identifier: Apache-2.0

import type { RootInfo } from "./builder";
import type { Delivery } from "./picks";
import type { ScalarReader } from "./scalar-reader";
import type { Scanner, ScanEnd, ScanResult } from "./scan-contract";
import type { FinishedRoot } from "./root-log";
import type { ScanCursor } from "./scan-cursor";
import type { Limit, ScanDiagnostics, Verdict } from "./scan-diagnostics";
import type { Cut } from "./types";

// Only the full internal collector needs empty logs; ordinary scanner readers keep no report state.
const NO_ENTRIES: readonly never[] = /* @__PURE__ */ Object.freeze([]);

/** Collect the full internal probe only when requested; public readers already consume live logs. */
export const collectScan = (scanner: Scanner, ended: ScanEnd): ScanResult => ({
  ...ended,
  repairs: retainedEntries(scanner.repairs),
  errors: retainedEntries(scanner.errors),
  spans: ended.values.map((_, index) => scanner.spanAt(ended.first + index)),
  edits: scanner.edits,
});

// RootLog empties only a prefix; a populated first slot proves the remaining storage is dense.
const retainedEntries = <Entry extends { readonly valueIndex: number }>(
  entries: readonly (Entry | undefined)[] | undefined,
): readonly Entry[] =>
  entries === undefined
    ? NO_ENTRIES
    : entries.length === 0 || entries[0] !== undefined
      ? (entries as readonly Entry[])
      : entries.filter((entry) => entry !== undefined);

/** The members of a `Scanner` the scan loop answers itself: they drive it or read its closure state. */
type Driving =
  | "supply"
  | "compactInput"
  | "positionAt"
  | "valueStart"
  | "finishChunk"
  | "close"
  | "releaseInput"
  | "end"
  | "pull"
  | "stopped"
  | "cut"
  | "recovery"
  | "stopPending"
  | "candidate";

/**
 * The read-only half of a scanner: what a reader may ask about a scan without driving it. Apart
 * from the scan loop in `scan.ts` because no answer here touches the loop's state; each comes from
 * the builder, the selection delivery, the diagnostics, the cursor or the scalar reader.
 */
export const scanReaders = (
  diagnostics: ScanDiagnostics,
  cursor: ScanCursor,
  scalars: ScalarReader,
  cutSuffix: string,
): Omit<Scanner, Driving> => {
  const build = diagnostics.build;
  const ledger = diagnostics.ledger;
  const picks = build.picks?.delivery;
  return {
    // Snapshotter projects the existing owners without view-reader closures on ordinary scans.
    build,
    scalars,
    cutSuffix,
    deliveries: (): Delivery[] => picks?.takeDeliveries() ?? [],
    selectionRoots: picks?.selecting === true ? picks : undefined,
    selecting: picks?.selecting ?? false,
    delivered: (): number => picks?.delivered ?? 0,
    unmatched: (): number[] => picks?.unmatched() ?? [],
    buffered: (): number => cursor.length,
    spanAt(valueIndex: number): FinishedRoot["span"] {
      const span = ledger.at(valueIndex)?.span;
      if (span === undefined)
        throw new RangeError(`missing span for completed value ${valueIndex}`);
      return span;
    },
    rootInfoAt: (valueIndex: number): RootInfo | undefined => ledger.at(valueIndex)?.info,
    cutAt: (valueIndex: number): Cut | undefined => ledger.at(valueIndex)?.cut,
    verdictAt: (valueIndex: number): Verdict | undefined => diagnostics.verdictAt(valueIndex),
    scanCompleteAt: (valueIndex: number): boolean => diagnostics.scanCompleteAt(valueIndex),
    tallyAt: diagnostics.report?.tallyAt,
    failure: (): Limit | undefined => diagnostics.terminalFailure,
    releaseBefore(upTo, logs): void {
      diagnostics.releaseBefore(upTo, logs);
    },
    // Only the requested report owns logs; the full collector supplies its empty fallback.
    repairs: diagnostics.report?.repairs.items,
    errors: diagnostics.report?.errors.items,
    edits: build.edits,
  };
};
