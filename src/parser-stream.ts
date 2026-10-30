// SPDX-License-Identifier: Apache-2.0

/** Build and drive mutable per-stream parser state. */
import type { Delivery } from "./picks";
import { MODE_FRAGMENTS, MODE_STREAM } from "./stream-scalars";
import type { StreamParser, StreamItem, SnapshotResult } from "./parser";
import type {
  Exact,
  Given,
  ParserOptions,
  ResolvedOptions,
  StreamOnlyOptions,
  StreamParserOptions,
} from "./options";
import type { Parser } from "./parser-configuration";
import { isParser, ParserConfiguration } from "./parser-configuration";
import { isParseOption, resolveOptions } from "./options";
import {
  resolveSignal,
  configurationError,
  copyOwnOptions,
  isPlainObject,
  ownOption,
} from "./configuration-error";
import {
  RELEASED,
  bareFailure,
  matchesOf,
  outcomeAt,
  recovered,
  reportOf,
  shaped,
  type Outcome,
} from "./parser-outcome";
import { PositionMap } from "./positions";
import { acceptsRoot, noMatch } from "./root-filter";
import { createScanner } from "./scan";
import { ScanCursor } from "./scan-cursor";
import type { Limit, Verdict } from "./scan-diagnostics";
import type { RuntimeView, Snapshotter } from "./snapshot";
import { retainedUnits } from "./tree";
import type { StopSignal } from "./stop-signal";
import type { ChunkSource, ParsedStream } from "./transport";
import { describeInput, drive, isBytes } from "./transport";
import type {
  CloseFailure,
  ConfigurationFailure,
  Cut,
  Diagnostics,
  Recovery,
  Result,
  StreamFailure,
  StreamSummary,
} from "./types";
import type { DecodedBytes, DeclaredEncoding } from "./utf8";
import { Utf8Decoder } from "./utf8";

/**
 * Mints the mutable scan state for one stream, for the caller who has one stream and one
 * configuration. The state is one per stream, never shared.
 *
 * Invalid options throw a `TypeError` before any input is read (HLD); see `configurationError`.
 *
 * Many streams over the same configuration call `createStreamParser(parser, streamOptions)` instead,
 * which validates once. That is not a style preference: validating the parse options costs more
 * than minting the state, a visible share of a whole stream at LLM tool-call sizes, and
 * re-validating options that cannot have changed is the one thing the capability rule forbids
 * charging for.
 *
 * A separate controls argument preserves per-stream settings such as `view` without revalidating
 * the immutable parse configuration or retaining unrelated operations on the handle.
 */
export function createStreamParser<O extends ParserOptions, S extends StreamOnlyOptions>(
  parser: Parser<O>,
  options: Exact<S, StreamOnlyOptions>,
): StreamParser<O & S>;
export function createStreamParser<
  O extends ParserOptions,
  S extends StreamOnlyOptions | undefined,
>(parser: Parser<O>, options: Exact<S, StreamOnlyOptions>): StreamParser<O & Given<S>>;
export function createStreamParser<O extends ParserOptions>(parser: Parser<O>): StreamParser<O>;
export function createStreamParser<O extends ParserOptions, S extends StreamOnlyOptions = never>(
  parser: Parser<O>,
  options?: Exact<NoInfer<S>, StreamOnlyOptions>,
): StreamParser<O & S>;
export function createStreamParser<O extends StreamParserOptions>(
  options: Exact<O, StreamParserOptions>,
): StreamParser<O>;
export function createStreamParser<O extends StreamParserOptions | undefined>(
  options: Exact<O, StreamParserOptions>,
): StreamParser<Given<O>>;
export function createStreamParser<
  O extends StreamParserOptions = Record<never, never>,
>(): StreamParser<O>;
export function createStreamParser<O extends StreamParserOptions = never>(
  options?: Exact<NoInfer<O>, StreamParserOptions>,
): StreamParser<O>;
export function createStreamParser(
  options?: StreamParserOptions | Parser,
  streamOptions?: StreamOnlyOptions,
): StreamParser {
  if (isParser(options)) {
    const state = ParserConfiguration.state(options);
    if (state.closed)
      return closedStreamParser(
        streamSettings(streamOptions, state.options).view,
        state.options.diagnostics,
      );
    if (state.observer === undefined) return buildStreamParser(streamOptions, state.options).parser;
    return state.observer
      .stream((cursorFor) => buildStreamParser(streamOptions, state.options, cursorFor))
      .parser();
  }
  return buildStreamParser(options).parser;
}

/**
 * Builds a stream parser and drives it over a source — the ONE mechanism behind every transport
 * door, so ordinary and configured `parseStream` calls differ only in
 * whether the parse options were already validated.
 *
 * `resolved` is what makes that difference: supplied, the parse options are not re-checked, which is
 * the whole point of holding a parser. Absent, this is the one-shot form.
 *
 * Invalid options throw before the source is touched (HLD): they are the caller's bug, not an
 * ending. Every way the stream itself can end short of its input is an item.
 */
export const driveStream = <O extends StreamParserOptions>(
  source: ChunkSource,
  options?: O & { signal?: StopSignal },
  resolved?: ResolvedOptions,
): ParsedStream<O> => {
  const [streamOptions, signal] = splitSignal(options);
  return drive(buildStreamParser<O>(streamOptions, resolved), source, signal);
};

/**
 * `signal` belongs to the drive, the rest to the stream. The same `O` the items are typed by:
 * `signal` is the only key removed, and it shapes nothing. Checked as an object first, or `null`
 * would pass as no options and a string as its characters.
 */
export const splitSignal = <O extends StreamParserOptions>(
  options: (O & { signal?: StopSignal }) | undefined,
): readonly [O | undefined, StopSignal | undefined] => {
  if (options === undefined) return [undefined, undefined];
  if (!isPlainObject(options)) refuse("options", "object");
  const streamOptions = copyOwnOptions(options);
  const signal = resolveSignal(streamOptions.signal);
  delete streamOptions.signal;
  return [streamOptions, signal];
};

/**
 * A stream that cannot start because its parser was released, as a one-item stream. Worded here
 * rather than by a driver because the failure is that no driver may be built.
 *
 * `snapshot` answers `undefined` — "no root exists" — which is what the type already means before
 * the first chunk and is exactly true here, permanently. Reporting the failure a second time through
 * that channel would need `SnapshotFailure` widened with a variant no live stream can ever produce,
 * taxing every healthy consumer to restate what the one item already said.
 */
const nothingToClose = (): Promise<Result<undefined, CloseFailure>> =>
  Promise.resolve({ ok: true, value: undefined });

/** Frozen once: a fixed-shape record, so this is O(1) and no caller pays per refusal. */
const noRootYet = /* @__PURE__ */ Object.freeze({ ok: true, value: undefined } as const);

export const rejectedStream = <O extends StreamParserOptions>(
  failure: StreamFailure,
  options: (O & { signal?: StopSignal }) | undefined,
  reported: ResolvedOptions["diagnostics"],
): ParsedStream<O> => {
  // An async generator is async by protocol, not by awaiting: the interface `ParsedStream` promises
  // is what forces the keyword here, and the body has one item and nothing to wait for.
  // oxlint-disable-next-line typescript/require-await
  const items = (async function* one(): AsyncGenerator<StreamItem<O>, void, undefined> {
    yield shaped(bareFailure(failure, reported));
  })();
  // Attached on the same condition the driver uses, so a refused stream carries exactly the members
  // a built one would have carried for these options.
  const viewed =
    options === undefined || ownOption(options, "view") === undefined
      ? {}
      : { snapshot: (): SnapshotResult<O> => noRootYet };
  return Object.assign(items, { close: nothingToClose }, viewed) as ParsedStream<O>;
};

/**
 * The manual-stream twin of `rejectedStream`: a stream asked of a released parser. Every `feed` and
 * `end` answers `parser-closed`, the same typed answer every other verb of that parser gives, and
 * no scanner is built because nothing may be scanned.
 */
export const closedStreamParser = <O extends StreamParserOptions>(
  view: unknown,
  reported: ResolvedOptions["diagnostics"],
): StreamParser<O> => {
  const answer = (): IterableIterator<StreamItem<O>> =>
    [shaped<StreamItem<O>>(bareFailure({ kind: "parser-closed" }, reported))].values();
  const parser = { feed: answer, end: answer, close: () => RELEASED };
  return (
    view === undefined ? parser : { ...parser, snapshot: (): SnapshotResult<O> => noRootYet }
  ) as StreamParser<O>;
};

/**
 * Everything the transport needs from a stream parser, and nothing else.
 *
 * It carries the tally behind the `summary` item because the transport ends a stream itself — after
 * an abort or a failed source, where the tail is never drained — and still owes the caller the same
 * summary the manual parser would have written. One tally, one writer; the transport asks for it
 * rather than counting a second time.
 */
export type StreamBuild<O extends StreamParserOptions> = {
  parser: StreamParser<O>;
  /** Feed one bounded slice while preserving the source chunk's caller-visible coordinates. */
  feedSlice: (
    chunk: string | Uint8Array,
    sourceOffset: number,
    finalSlice: boolean,
  ) => IterableIterator<StreamItem<O>>;
  summary: boolean;
  summarise: (complete: boolean) => StreamItem<O>;
  /** A failure as an item; only the parser knows whether a report was asked for. */
  failed: (failure: StreamFailure, report?: Diagnostics) => StreamItem<O>;
  /**
   * Whether the stream is over. The transport asks THIS rather than classifying failure kinds: a
   * root that hit `maxDepth` is a failed root and the stream goes on, while a buffer or scalar
   * bound ends it — and only the parser knows which, since it is what closed.
   */
  closed: () => boolean;
  /** Leaving a drain is cancellation, not a delivered terminal parser cause. */
  abandoned: () => boolean;
  /**
   * Ends a stopped stream and recovers only its received prefix, as a whole parse of the same
   * text recovers it: under `select` every match with the ROOT's
   * completion, which no single match item carries when the cut falls between them.
   */
  recoverOpen: () => { recovered?: Recovery; diagnostics?: Diagnostics };
  /** Recovery already built when processing stops, including an item not yet delivered. */
  recovery: (pending?: StreamItem<O>) => {
    recovered?: Recovery;
    diagnostics?: Diagnostics | undefined;
  };
};

/** Stream-only options are validated here; the parse options go through `resolveOptions`. */
const refuse = (field: string, reason: ConfigurationFailure["reason"]): never => {
  throw configurationError({ kind: "invalid-options", field, reason });
};

/** The value an item hands over, which is what holding it unread costs. */
const itemUnits = (item: StreamItem): number => {
  if ("ok" in item) {
    if (item.ok) return retainedUnits(item.value);
    const held = (item.failure as { recovered?: { value: unknown } }).recovered;
    return held === undefined ? 1 : retainedUnits(held.value);
  }
  return 1;
};

/**
 * `resolved` is the parse options already validated by the configuration handle. Supplying
 * it skips their validation and keeps ONE code path for the stream-only half: a second branch per
 * entry point lets the two forms drift apart.
 *
 * The stream-only check stays here even so: a `fragments` selection may not be paired with a
 * `view`, and only the resolved options say whether the selection asks for fragments. A released
 * parser runs this too, without building a stream: a bad option is a bug at its call site, which
 * answering `parser-closed` would hide until the same call reaches an open parser.
 */
export const streamSettings = (
  requested: StreamParserOptions | undefined,
  resolved?: ResolvedOptions,
): {
  readonly opts: ResolvedOptions;
  readonly view: RuntimeView | undefined;
  readonly summary: boolean;
  readonly fragments: boolean;
} => {
  if (requested !== undefined && !isPlainObject(requested)) refuse("options", "object");
  const given = requested ?? {};
  const parseOptions = copyOwnOptions(given);
  const { view, summary } = parseOptions;
  delete parseOptions.view;
  delete parseOptions.summary;
  // A parse option here is a caller who thinks this stream can still change how parsing works.
  // Ignoring it would silently drop what they asked for, so name it and where it belongs. Any other
  // key is a misspelling or belongs to another call, and saying "set it in `initParser`" would send
  // the caller to a second refusal.
  if (resolved !== undefined) {
    const stray = Object.keys(parseOptions)[0];
    if (stray !== undefined)
      refuse(stray, isParseOption(stray) ? "parse-option-on-stream" : "unknown");
  }
  if (view !== undefined) {
    if (typeof view !== "object" || view === null) refuse("view", "view");
    const mode = ownOption(view, "mode");
    if (
      ownOption(view, "feature") !== "view" ||
      (mode !== "shared" && mode !== "owned") ||
      typeof ownOption(view, "open") !== "function"
    )
      refuse("view", "view");
  }
  if (summary !== undefined && typeof summary !== "boolean") refuse("summary", "boolean");
  const opts = resolved ?? resolveOptions(parseOptions, undefined, undefined, true);
  if (opts.fragments && view !== undefined) refuse("view", "fragments-view");
  return {
    opts,
    view: view as RuntimeView | undefined,
    summary: summary ?? false,
    fragments: opts.fragments,
  };
};

export function buildStreamParser<O extends StreamParserOptions = Record<never, never>>(
  requested?: O,
  resolved?: ResolvedOptions,
  cursorFor?: (positionAt: PositionMap["positionAt"]) => ScanCursor,
): StreamBuild<O> {
  const { opts, view, summary, fragments } = streamSettings(requested, resolved);
  const reported = opts.diagnostics;
  /** Matches leave as they close: `occurrences`, or `fragments`, which implies it. */
  const eager = opts.occurrences || fragments;
  // Fragment contents leave before the root closes; source mappings must follow that ownership too.
  const positions = new PositionMap();
  const history = fragments ? opts.selection?.picks.openFragmentHistory?.(positions) : undefined;
  const positionAt = history?.positionAt ?? positions.positionAt;
  const scanCursor =
    cursorFor?.(positionAt) ??
    (fragments ? new ScanCursor(positionAt, undefined, "stream") : undefined);
  const scanner = createScanner(
    opts,
    positionAt,
    fragments ? MODE_FRAGMENTS : MODE_STREAM,
    scanCursor,
  );
  const views = view?.open(scanner);
  // Decoder state lives beside scan state so split characters survive and malformed provenance is
  // not erased before the scanner can attach its eventual value path.
  const decoder = new Utf8Decoder();
  const cursor = { repair: 0, error: 0 };
  /** Roots handed out as items, values and refusals alike; also the index of the root in progress. */
  let delivered = 0;
  /** Roots whose success or failure is relevant under the configured acceptance filter. */
  let matched = 0;
  /** First object candidate retained when required keys reject every root. */
  let compatible: { recovered: Recovery; diagnostics: Diagnostics | undefined } | undefined;
  /** Recognised roots: every delivered one, plus a root a bound cut short. */
  let roots = 0;
  /** The last delivered root, kept for the view until the next root begins. */
  let last:
    | { value: unknown; index: number; verdict: Verdict | undefined; cut: Cut | undefined }
    | undefined;
  let closed = false;
  let abandoned = false;
  let disposed = false;
  let scanReleased = false;
  /**
   * The drain of the last `feed` or `end`, until something settles it. A caller may skip reading
   * one; the next `feed`, `end` or `snapshot` then runs its rest into `unread`, so no value and
   * no chunk is lost (HLD: each completed value is delivered exactly once).
   */
  let pendingDrain: Generator<StreamItem<O>, void, undefined> | undefined;
  /** Items a skipped drain produced, delivered first by whichever iteration is read next. */
  const unread: ({ readonly item: StreamItem<O>; readonly units: number } | undefined)[] = [];
  let unreadHead = 0;
  /** `retainedUnits` of everything in `unread`, bounded by `maxRetained`. */
  let unreadUnits = 0;
  /** The typed stop once `unread` passed `maxRetained`: delivered after every held item. */
  let unreadStop: StreamItem<O> | undefined;
  /** Ordinal of the next chunk `feed` receives; every chunk counts, an empty one included. */
  let chunkIndex = 0;
  /**
   * Bumped by everything that can change what `snapshot()` would answer: supplied input, every pull
   * of a drain, the end of a chunk or of the stream, and `close()`.
   */
  let revision = 0;
  /**
   * The last shared snapshot and the revision it was taken at. A pull with nothing new returns the
   * SAME object: a reactive store compares snapshots by identity (React's `useSyncExternalStore`
   * re-renders forever on a fresh object per call), and an unchanged view costs nothing to hand back.
   * `owned` is never reused, because its caller may have modified the previous copy.
   */
  let memo: { readonly revision: number; readonly result: SnapshotResult } | undefined;
  let closedSnapshot: (() => SnapshotResult) | undefined;

  const failed = (failure: StreamFailure, report?: Diagnostics): StreamItem<O> =>
    shaped<StreamItem<O>>(
      report === undefined
        ? bareFailure(failure, reported)
        : { ok: false, failure, diagnostics: report },
    );
  const one = (failure: StreamFailure): IterableIterator<StreamItem<O>> =>
    [failed(failure)].values();
  const none = (): IterableIterator<StreamItem<O>> => ([] as StreamItem<O>[]).values();
  // Only the imported selection feature can produce and shape match or fragment deliveries.
  const selection = scanner.selectionRoots;
  const piecewise = fragments ? selection?.fragmentDelivery?.fragmentPieces : undefined;
  const deliveryItem =
    selection === undefined
      ? undefined
      : (delivery: Delivery, report: Diagnostics | undefined): StreamItem<O> => {
          // Fragments describe scalar occurrences, so only a match receives value-completion facts.
          const outcome: Outcome<Delivery, StreamFailure, unknown> =
            "kind" in delivery
              ? delivery.kind === "non-scalar-selection"
                ? { ok: false, failure: delivery }
                : { ok: true, value: delivery }
              : selection.outcome(delivery, scanner);
          if (report !== undefined) outcome.diagnostics = report;
          return shaped<StreamItem<O>>(outcome);
        };
  function* deliveryItems(): Generator<StreamItem<O>> {
    if (deliveryItem === undefined) return;
    for (const delivery of scanner.deliveries()) {
      const parts = piecewise?.(delivery);
      if (parts === undefined)
        yield deliveryItem(
          delivery,
          reported === false ? undefined : reportOf(scanner, opts, reported, delivered, cursor),
        );
      else
        for (const part of parts) {
          if (closed) return;
          yield deliveryItem(
            part,
            reported === false ? undefined : reportOf(scanner, opts, reported, delivered, cursor),
          );
        }
    }
  }
  /**
   * The items a completed root contributes: its value, or under `select` its deliveries. A
   * refused root under final delivery carries its matches as `recovered` on the one failure item,
   * since they are not final; under `occurrences` they are source occurrences and leave as items
   * before the failure.
   */
  function* rootItems(value: unknown): Generator<StreamItem<O>> {
    const index = delivered;
    // Nothing reads a root once the next one is delivered: `last` carries what the view needs.
    scanner.releaseBefore(index, cursor);
    delivered++;
    roots++;
    const verdict = scanner.verdictAt(index);
    if (verdict === undefined && !acceptsRoot(scanner, index, opts)) {
      const selected = scanner.selecting ? matchesOf(scanner.deliveries()) : value;
      if (matched === 0 && compatible === undefined && scanner.rootInfoAt(index)?.object === true) {
        // Later roots release their scan logs; the fallback owns its report until acceptance.
        const diagnostics =
          reported === false ? undefined : reportOf(scanner, opts, reported, index, cursor);
        compatible = { recovered: recovered(selected, scanner.cutAt(index)), diagnostics };
        scanner.build.heldContent =
          retainedUnits(selected) +
          (diagnostics === undefined ? 0 : diagnostics.repairs.length + diagnostics.errors.length);
        scanner.build.charge(0, scanner.spanAt(index).end);
      }
      return;
    }
    if (compatible !== undefined) {
      compatible = undefined;
      scanner.build.heldContent = undefined;
    }
    matched++;
    if (deliveryItem === undefined) {
      last = { value, index, verdict, cut: scanner.cutAt(index) };
      yield shaped<StreamItem<O>>(outcomeAt(scanner, opts, index, value, cursor));
      return;
    }
    const deliveries = scanner.deliveries();
    if (verdict !== undefined && !eager) {
      const matches = matchesOf(deliveries);
      last = { value: matches, index, verdict, cut: scanner.cutAt(index) };
      yield shaped<StreamItem<O>>(outcomeAt(scanner, opts, index, matches, cursor));
      return;
    }
    const report =
      reported === false ? undefined : reportOf(scanner, opts, reported, index, cursor);
    last = { value: matchesOf(deliveries), index, verdict, cut: scanner.cutAt(index) };
    // Publish the view before the first item; only delivery pieces, never the scalar, are sliced.
    for (const delivery of deliveries) {
      const parts = piecewise?.(delivery);
      if (parts === undefined) yield deliveryItem(delivery, report);
      else {
        let first = true;
        for (const part of parts) {
          if (closed) return;
          // Additional pieces must not multiply the original delivery's repair entries.
          const partReport = first
            ? report
            : reported === false
              ? undefined
              : reportOf(scanner, opts, reported, index, cursor);
          first = false;
          yield deliveryItem(part, partReport);
        }
      }
    }
    if (verdict !== undefined) {
      const refusal: Outcome<never, StreamFailure> = { ok: false, failure: verdict };
      if (report !== undefined) refusal.diagnostics = report;
      yield shaped<StreamItem<O>>(refusal);
    }
  }
  const releaseScan = (): void => {
    // Scan ownership can end while unread items still await delivery; disposal must not drop them.
    if (scanReleased) return;
    scanReleased = true;
    // Keep the requested recovery view, not the decoder and replay source that produced it.
    if (views !== undefined) {
      const state = {
        verdict: scanner.failure() ?? scanner.verdictAt(delivered),
        cut: scanner.cut(),
      };
      views.detach();
      closedSnapshot = () => takeSnapshot(views, state);
    }
    scanner.close();
    // Outcomes and the detached view have captured their positions before history is released.
    positions.runs.length = 0;
    history?.clear();
    compatible = undefined;
    if (views === undefined) last = undefined;
    memo = undefined;
  };
  const stopRecovery = (open: Recovery | undefined): ReturnType<StreamBuild<O>["recovery"]> => {
    // Selection can return an empty list without an open root; it must not hide the fallback.
    // With no open tree, a between-items cut is idle; missing/string cuts still own scalar source.
    if (
      open === undefined ||
      (scanner.selecting &&
        !scanner.build.hasOpenRoot &&
        Array.isArray(open.value) &&
        open.value.length === 0 &&
        !open.complete &&
        open.cut.kind === "between")
    ) {
      if (compatible !== undefined) return compatible;
      open = undefined;
    }
    return {
      ...(open === undefined ? {} : { recovered: open }),
      ...(reported === false
        ? {}
        : { diagnostics: reportOf(scanner, opts, reported, delivered, cursor) }),
    };
  };
  /** A live prefix takes precedence; otherwise root filtering still owes its stored fallback. */
  const terminal = (limit: Limit, open: Recovery | undefined): StreamItem<O> => {
    closed = true;
    const held = stopRecovery(open);
    if (open !== undefined && held.recovered === open) roots++;
    const item = failed(
      { ...limit, ...(held.recovered === undefined ? {} : { recovered: held.recovered }) },
      held.diagnostics,
    );
    releaseScan();
    return item;
  };
  const summarise = (complete: boolean): StreamSummary => ({
    kind: "summary",
    complete,
    roots,
    matches: scanner.delivered(),
    unmatched: scanner.unmatched(),
  });
  // `complete` is whether the scanner read the whole source. Once every root is delivered,
  // "the root at index `delivered` was read to its end" holds exactly when nothing stopped the scan.
  const summaryItem = (): StreamItem<O> =>
    summarise(scanner.scanCompleteAt(delivered)) as unknown as StreamItem<O>;
  const supplyDecoded = (decoded: DecodedBytes): void => {
    for (const run of decoded.runs) {
      positions.add(decoded.start + run.start, run.chunk, "byte", run.byte, run.width);
    }
    scanner.supply(decoded.text, decoded.malformed);
    revision++;
  };
  /** A leading UTF-16 or UTF-32 mark ends the stream before any byte of it is read as data. */
  const refuseEncoding = (encoding: DeclaredEncoding): IterableIterator<StreamItem<O>> => {
    closed = true;
    releaseScan();
    return one({ kind: "unsupported-encoding", encoding: encoding.unsupported });
  };
  const halt = (): Result<undefined, never> => {
    if (!closed) {
      abandoned = true;
      closed = true;
      revision++;
      scanner.releaseInput();
    }
    return RELEASED;
  };
  const close = (): Result<undefined, never> => {
    if (disposed) return RELEASED;
    disposed = true;
    // Capture the cut before halt releases input; terminal stops already detached their view.
    releaseScan();
    halt();
    const rest = pendingDrain;
    pendingDrain = undefined;
    unread.length = 0;
    unreadHead = 0;
    unreadUnits = 0;
    unreadStop = undefined;
    rest?.return();
    return RELEASED;
  };
  /**
   * One root per pull. `exhausted` is set only by reaching the end of the body, so a consumer who
   * leaves the loop arrives in `finally` without it — and a drain left early closes the stream,
   * because the input it held is neither replayed nor resumed.
   */
  function* drain(
    ending: boolean,
    includeSummary = true,
  ): Generator<StreamItem<O>, void, undefined> {
    let exhausted = false;
    try {
      for (;;) {
        // `closed` can flip between pulls: `close()` during a drain ends it here.
        if (closed) break;
        const pulled = scanner.pull();
        revision++;
        if (pulled === undefined) break;
        const items = pulled.root === undefined ? deliveryItems() : rootItems(pulled.root.value);
        for (const item of items) {
          if (closed) break;
          yield item;
        }
        if (!ending && pulled.root !== undefined) {
          // Pending deliveries still need their root for cancellation; a drained root has no reader.
          scanner.releaseBefore(delivered, cursor);
          if (views === undefined) last = undefined;
        }
      }
      if (closed) {
        exhausted = true;
        return;
      }
      // A spent error budget ends at the token boundary. Finalize that prefix now: waiting for
      // source EOF would keep pulling input the scanner cannot read and withhold its failure.
      ending ||= scanner.stopped();
      revision++;
      let open: Recovery | undefined;
      if (ending) {
        const rest = scanner.end();
        open = rest.open;
        for (; delivered < rest.first + rest.values.length;) {
          for (const item of rootItems(rest.values[delivered - rest.first])) yield item;
        }
      } else scanner.finishChunk();
      // Established fragment roots need anchors, not history for delivered or unselected content.
      const valueStart = scanner.valueStart();
      if (
        history !== undefined &&
        scanCursor !== undefined &&
        scanner.build.picks?.delivery?.established() === true
      ) {
        history.retain(scanCursor.base - scanner.scalars.quoteReplayCarry, [
          valueStart,
          scanner.scalars.continuation?.open,
          ...(scanCursor.window.pinnedOffsets ?? []),
          scanCursor.window.inWord ? scanCursor.window.wordStart : undefined,
          scanCursor.window.inWord ? scanCursor.window.wordSpaceMark?.at : undefined,
          scanCursor.window.inNumber ? scanCursor.window.numberStart : undefined,
        ]);
      }
      // Other paths may still hold undecided occurrences whose spans need the full open range.
      let keep = 0;
      while (
        keep + 1 < positions.runs.length &&
        (positions.runs[keep + 1] as PositionMap["runs"][number]).start <= valueStart
      )
        keep++;
      if (keep > 0) positions.runs = positions.runs.slice(keep);
      const limit = scanner.failure();
      if (limit !== undefined) {
        // Only a bound hands back the open root, so only a bound builds it: its cut reads the token
        // still being read, and building it after every chunk made a long word quadratic.
        if (!fragments) {
          // Preserve a readable string prefix in the failure even without a requested live view.
          scanner.stopPending();
          open = scanner.recovery();
        } else if (!ending) open = scanner.recovery();
        // Occurrences that left before the bound are the caller's; what is still held is recovery.
        for (const item of deliveryItems()) yield item;
        yield terminal(limit, open);
        if (summary && includeSummary) yield summaryItem();
      } else if (ending) {
        // EOF recovery still serves transport source failures; its owner closes the scan afterwards.
        closed = true;
        if (delivered === 0)
          yield shaped<StreamItem<O>>(bareFailure({ kind: "no-json-found" }, reported));
        else if (matched === 0)
          yield failed(noMatch(opts, compatible?.recovered), compatible?.diagnostics);
        if (summary && includeSummary) yield summaryItem();
      }
      exhausted = true;
    } finally {
      if (!exhausted) halt();
    }
  }
  /**
   * Runs a drain the caller left unread to its end, holding what it yields for the next iteration.
   * Past `maxRetained` the stream stops with a typed reason: holding more would grow without bound
   * for a caller who never reads, and dropping would lose data.
   */
  const settle = (): void => {
    const rest = pendingDrain;
    pendingDrain = undefined;
    if (rest === undefined) return;
    // An unread report is retained with its result (HLD: input buffering alone does not bound
    // reports). One root's matches share one report object, so it is charged once.
    let charged: Diagnostics | undefined;
    for (let next = rest.next(); next.done !== true; next = rest.next()) {
      const report = "diagnostics" in next.value ? next.value.diagnostics : undefined;
      const units =
        itemUnits(next.value) +
        (report === undefined || report === charged
          ? 0
          : report.repairs.length + report.errors.length);
      charged = report ?? charged;
      // Compact only after at least half was consumed: delivery stays amortized constant time,
      // and interleaved feeds cannot grow an array of cleared slots without bound.
      if (unreadHead > 0 && 2 * unreadHead >= unread.length) {
        unread.copyWithin(0, unreadHead);
        unread.length -= unreadHead;
        unreadHead = 0;
      }
      unread.push({ item: next.value, units });
      unreadUnits += units;
      if (unreadUnits > opts.maxRetained) {
        unreadStop = failed({ kind: "limit-reached", resource: "unread", limit: opts.maxRetained });
        rest.return();
        halt();
        return;
      }
    }
  };
  /**
   * What one `feed` or `end` hands back: the held items first, then its own drain. A consumer who
   * leaves early closes the stream, as with any drain (HLD: stop when the consumer stops).
   */
  function* deliver(
    own: Generator<StreamItem<O>, void, undefined> | undefined,
  ): Generator<StreamItem<O>, void, undefined> {
    let exhausted = false;
    try {
      // The queue is re-read before every pull of `own`: a `snapshot()` or `feed()` between two reads
      // of this iterator may have settled the rest of `own` into the queue, in order.
      for (;;) {
        if (disposed) break;
        const held = unread[unreadHead];
        if (held !== undefined) {
          unread[unreadHead++] = undefined;
          if (unreadHead === unread.length) {
            unread.length = 0;
            unreadHead = 0;
          }
          unreadUnits -= held.units;
          yield held.item;
          continue;
        }
        if (unreadStop !== undefined) {
          const stop = unreadStop;
          unreadStop = undefined;
          yield stop;
          break;
        }
        const next = own?.next();
        if (next === undefined || next.done === true) {
          if (pendingDrain === own) pendingDrain = undefined;
          break;
        }
        // A terminal drain has no more input work; retain its summary, not its suspended scan frame.
        if (closed && pendingDrain === own) settle();
        yield next.value;
      }
      exhausted = true;
    } finally {
      if (!exhausted) {
        own?.return();
        close();
      }
    }
  }
  /** Settles the previous drain, then hands back the held items followed by `own`. */
  const start = (
    own: () => Generator<StreamItem<O>, void, undefined>,
  ): IterableIterator<StreamItem<O>> => {
    pendingDrain = own();
    return deliver(pendingDrain);
  };
  /**
   * After the stream closed, whatever is still held — values from an unread drain and the stop that
   * ended it — goes to the next caller; only then does the stream answer `stream-closed`.
   */
  const closedAnswer = (): IterableIterator<StreamItem<O>> =>
    unreadHead < unread.length || unreadStop !== undefined
      ? deliver(undefined)
      : one({ kind: "stream-closed" });
  // Built from the view itself, so a stream without one has no `snapshot` to call at all.
  const snapshotOf = (viewer: Snapshotter) => (): SnapshotResult => {
    if (closedSnapshot !== undefined) {
      if (view?.mode === "shared" && memo !== undefined) return memo.result;
      const result = closedSnapshot();
      if (view?.mode === "shared") memo = { revision, result };
      return result;
    }
    settle();
    if (memo?.revision === revision) return memo.result;
    const result = takeSnapshot(viewer);
    if (view?.mode === "shared") memo = { revision, result };
    return result;
  };
  // Closed views reuse their cut record; an owned pull must also own this mutable metadata.
  const snapshotCut = (viewer: Snapshotter, cut: Cut): Cut => viewer.finished(cut) as Cut;
  const takeSnapshot = (
    viewer: Snapshotter,
    state?: { verdict: Verdict | Limit | undefined; cut: Cut | undefined },
  ): SnapshotResult => {
    const open = viewer.open();
    if (open !== undefined) {
      // A bound that ended the stream, or the verdict already standing against the root in progress
      // — under `STRICT` the first refusal stops the scan while the root is still open.
      const verdict =
        state === undefined ? (scanner.failure() ?? scanner.verdictAt(delivered)) : state.verdict;
      const live = state === undefined ? scanner.cut() : state.cut;
      // No cut: the root is finished, held only until a comma could start a list.
      const cut = live === undefined ? undefined : snapshotCut(viewer, live);
      if (verdict !== undefined) {
        return { ok: false, failure: { ...verdict, recovered: recovered(open, cut) } };
      }
      return {
        ok: true,
        value:
          cut === undefined
            ? { value: open, valueIndex: delivered, complete: true }
            : { value: open, valueIndex: delivered, complete: false, cut },
      };
    }
    if (last === undefined) return { ok: true, value: undefined };
    const value = viewer.finished(last.value);
    const cut = last.cut === undefined ? undefined : snapshotCut(viewer, last.cut);
    if (last.verdict !== undefined)
      return { ok: false, failure: { ...last.verdict, recovered: recovered(value, cut) } };
    return {
      ok: true,
      value:
        cut === undefined
          ? { value, valueIndex: last.index, complete: true }
          : { value, valueIndex: last.index, complete: false, cut },
    };
  };

  const feedSlice = (
    chunk: string | Uint8Array,
    sourceOffset: number,
    finalSlice: boolean,
    includeSummary = false,
  ): IterableIterator<StreamItem<O>> => {
    settle();
    if (closed) return closedAnswer();
    const index = chunkIndex;
    if (finalSlice) chunkIndex++;
    if (typeof chunk === "string") {
      if (chunk.length === 0) return none();
      // Only a byte chunk can leave a sequence pending or the byte-order mark undecided; flush that
      // before the text. The first text chunk settles the mark, so later ones skip the flush.
      if (!decoder.idle) {
        const flushed = decoder.decode(new Uint8Array(0), index, true);
        if ("unsupported" in flushed) return refuseEncoding(flushed);
        supplyDecoded(flushed);
      }
      positions.add(decoder.decoded, index, "utf16", sourceOffset, 1);
      decoder.advance(chunk);
      scanner.supply(chunk);
      revision++;
    } else {
      const decoded = decoder.decode(chunk, index, false, sourceOffset);
      if ("unsupported" in decoded) return refuseEncoding(decoded);
      supplyDecoded(decoded);
    }
    // The transport emits its terminal summary after upstream cleanup; manual drains own theirs.
    return start(() => drain(false, includeSummary));
  };
  const parser = {
    // A string chunk flushes an incomplete byte sequence first: those bytes arrived earlier, and a
    // string cannot supply their continuation without reordering two source channels.
    feed(chunk: string | Uint8Array): IterableIterator<StreamItem<O>> {
      settle();
      if (closed) return closedAnswer();
      if (typeof chunk !== "string" && !isBytes(chunk)) {
        return one({ kind: "invalid-input", received: describeInput(chunk) });
      }
      return feedSlice(chunk, 0, true, true);
    },
    end(): IterableIterator<StreamItem<O>> {
      settle();
      if (closed) return closedAnswer();
      const flushed = decoder.decode(new Uint8Array(0), chunkIndex, true);
      if ("unsupported" in flushed) return refuseEncoding(flushed);
      supplyDecoded(flushed);
      return start(() => drain(true));
    },
    close,
  };
  // The member exists only when a view does: a stream built without one must not carry a method
  // whose every call would fail, and the type already says it is absent.
  const build: StreamBuild<O> = {
    parser: (views === undefined
      ? parser
      : { ...parser, snapshot: snapshotOf(views) }) as StreamParser<O>,
    feedSlice,
    summary,
    summarise: (complete) => summarise(complete) as StreamItem<O>,
    closed: () => closed,
    abandoned: () => abandoned,
    failed,
    recovery: (pending) => {
      const diagnostics =
        pending !== undefined && "diagnostics" in pending ? pending.diagnostics : undefined;
      if (
        pending !== undefined &&
        "ok" in pending &&
        !pending.ok &&
        "recovered" in pending.failure
      ) {
        const held = pending.failure.recovered;
        return held === undefined ? { diagnostics } : { recovered: held, diagnostics };
      }
      if (pending !== undefined && !("kind" in pending) && pending.ok) {
        if (!scanner.selecting)
          return { recovered: recovered(pending.value, last?.cut), diagnostics };
        if (Array.isArray(last?.value)) {
          // Match identity locates the unread suffix without charging every successful delivery.
          const matches: readonly unknown[] = last.value;
          const index = matches.indexOf(pending.value);
          if (index >= 0)
            return { recovered: recovered(matches.slice(index), last.cut), diagnostics };
        }
      }
      // Cancellation transfers decoded text without EOF repair, just as a storage-bound stop does.
      if (!fragments) scanner.stopPending();
      return stopRecovery(scanner.recovery());
    },
    recoverOpen: () => {
      const open = delivered;
      const result: ReturnType<StreamBuild<O>["recoverOpen"]> = {};
      for (const item of parser.end()) {
        if ("kind" in item) continue;
        // The emitted report survives after finishing the drain releases scanner diagnostics.
        if (reported !== false && "diagnostics" in item) result.diagnostics ??= item.diagnostics;
        if (!item.ok) {
          const held = "recovered" in item.failure ? item.failure.recovered : undefined;
          if (held !== undefined) {
            result.recovered = held;
            return result;
          }
        } else if (!scanner.selecting) {
          result.recovered = recovered(item.value, "cut" in item ? item.cut : undefined);
          return result;
        }
      }
      // A selected root drains as one item per match; `last` holds them all with the root's cut.
      if (scanner.selecting && last?.index === open)
        result.recovered = recovered(last.value, last.cut);
      return result;
    },
  };
  return build;
}
