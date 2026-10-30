// SPDX-License-Identifier: Apache-2.0

/**
 * The root public entry. Explicit names prevent newly exported implementation declarations from
 * silently expanding this entry's supported surface.
 */

import type { Exact, Given, ParserOptions } from "./options";
import type { ManyOutcome, Overridden, ParseOutcome, RepairOutcome, SpanOutcome } from "./parser";
import type { Parser } from "./parser-configuration";
import { closedParserIterator, configuredCall, isParser } from "./parser-configuration";
import type { Input, ParserClosedFailure } from "./types";
import { DEFAULT_OPTIONS, resolveOptions } from "./options";
import { parseResolved, repairResolved, spanResolved } from "./whole-input";
import { parseManyResolved } from "./whole-iteration";

export type {
  DangerousKeyPolicy,
  ParserOptions,
  ParserSettings,
  StreamOnlyOptions,
  StreamParserOptions,
} from "./options";
export type {
  ManyOutcome,
  ParseOutcome,
  Parser,
  RepairOutcome,
  SnapshotResult,
  SpanOutcome,
  StreamItem,
  StreamParser,
} from "./parser";
export type {
  BigIntConversionFailure,
  CleanupFailure,
  CloseFailure,
  ConfigurationFailure,
  Completed,
  Completion,
  Cut,
  CutKind,
  Diagnostics,
  DiagnosticsFeature,
  DiagnosticsSettings,
  LocationsFeature,
  SelectFeature,
  SkipFeature,
  EncodingFailure,
  ErrorKind,
  FailureKind,
  Fragment,
  SourceFragment,
  SourceFragmentsFeature,
  DecodedFragmentsFeature,
  Input,
  Match,
  NonJsonValueFailure,
  NumberConversionFailure,
  ParserClosedFailure,
  ParseError,
  ParseFailure,
  Position,
  Recovery,
  Repair,
  RepairFailure,
  RepairKind,
  SwitchableRepair,
  Reportable,
  Reported,
  Result,
  Selected,
  Shaped,
  SignalFailure,
  Snapshot,
  SnapshotFailure,
  SourcePath,
  Span,
  StreamFailure,
  StreamSummary,
  Value,
  ViewMode,
  ViewFeature,
} from "./types";

export { ownedView } from "./snapshot-owned";
export { sharedView } from "./snapshot-shared";

export { initParser, createStreamParser } from "./parser";
export type { PathSegment, SelectorPath } from "./selector";
export { ANY, ANY_DEPTH } from "./selector";
export type { SelectSettings } from "./selection-feature";
export { select, skip } from "./selection-feature";
export { sourceFragments } from "./source-fragments";
export { decodedFragments } from "./decoded-fragments";
export { diagnostics } from "./report";
export { locations } from "./positions";
export type { StreamOptions } from "./stream";
export type { ChunkSource, ParsedStream } from "./transport";
export type { StopSignal } from "./stop-signal";
export { parseStream } from "./stream";
export { COMPAT, LLM_BALANCED, LLM_FULL, STRICT } from "./presets";
export { REPAIR_PENALTY, confidenceOf } from "./types";
export type { ExactNumber } from "./exact-number";
export { isExactNumber } from "./exact-number";
export type { StringifyOptions } from "./stringify";
export { stringify } from "./stringify";
export type { CustomParser, TryParsersFailure, TryParsersOptions } from "./try-parsers";
export { tryParsers } from "./try-parsers";
export type { MetricsParser, ParseMetrics } from "./metrics";
export { createMetrics } from "./metrics";

// Imported verbs select the implementation; a configuration handle carries no operation methods.
// Resolve before returning an iterator so later option mutations cannot change its policy.
const forCall = (options?: ParserOptions) =>
  options === undefined ? DEFAULT_OPTIONS : resolveOptions(options);

/** The first value in the text, using the default settings. */
export function parse<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): ParseOutcome<Overridden<O, C>, ParserClosedFailure>;
export function parse<O extends ParserOptions, C extends ParserOptions | undefined = undefined>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): ParseOutcome<Overridden<O, C>, ParserClosedFailure>;
export function parse(input: Input): ParseOutcome<Record<never, never>>;
export function parse<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): ParseOutcome<Given<O>>;
export function parse(
  input: Input,
  options?: ParserOptions | Parser,
  overrides?: ParserOptions,
): unknown {
  if (isParser(options)) return configuredCall(options, input, overrides, parseResolved);
  return parseResolved(forCall(options), input);
}

/** Every value in the text, lazily. `[...parseMany(t)]` is the array. */
export function parseMany<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): IterableIterator<ManyOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function parseMany<O extends ParserOptions, C extends ParserOptions | undefined = undefined>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): IterableIterator<ManyOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function parseMany(input: Input): IterableIterator<ManyOutcome<Record<never, never>>>;
export function parseMany<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): IterableIterator<ManyOutcome<Given<O>>>;
export function parseMany(
  input: Input,
  options?: ParserOptions | Parser,
  overrides?: ParserOptions,
): unknown {
  if (isParser(options)) {
    return configuredCall(options, input, overrides, parseManyResolved, closedParserIterator);
  }
  return parseManyResolved(forCall(options), input);
}

/** The repaired candidate as strict JSON text. An unchanged candidate comes back byte-identical. */
export function repair<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): RepairOutcome<Overridden<O, C>, ParserClosedFailure>;
export function repair<O extends ParserOptions, C extends ParserOptions | undefined = undefined>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): RepairOutcome<Overridden<O, C>, ParserClosedFailure>;
export function repair(input: Input): RepairOutcome<Record<never, never>>;
export function repair<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): RepairOutcome<Given<O>>;
export function repair(
  input: Input,
  options?: ParserOptions | Parser,
  overrides?: ParserOptions,
): unknown {
  if (isParser(options)) return configuredCall(options, input, overrides, repairResolved);
  return repairResolved(forCall(options), input);
}

/** Where the first candidate value sits in the source, for a caller who wants the text rather than the value. */
export function findJsonSpan<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): SpanOutcome<Overridden<O, C>, ParserClosedFailure>;
export function findJsonSpan<
  O extends ParserOptions,
  C extends ParserOptions | undefined = undefined,
>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): SpanOutcome<Overridden<O, C>, ParserClosedFailure>;
export function findJsonSpan(input: Input): SpanOutcome<Record<never, never>>;
export function findJsonSpan<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): SpanOutcome<Given<O>>;
export function findJsonSpan(
  input: Input,
  options?: ParserOptions | Parser,
  overrides?: ParserOptions,
): unknown {
  if (isParser(options)) return configuredCall(options, input, overrides, spanResolved);
  return spanResolved(forCall(options), input);
}
