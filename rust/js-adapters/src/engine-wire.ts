// SPDX-License-Identifier: Apache-2.0

/** Decode the versioned, length-delimited response shared by native and WASM engines. */

import { Reader } from "./engine-wire-reader";
import type { EngineOutcome } from "./engine-wire-reader";
import type {
  AbortedFailure,
  ConfigurationFailure,
  EngineBoundaryFailure,
  Match,
  ParseFailure,
  RepairFailure,
  Result,
  Snapshot,
  SnapshotFailure,
  Span,
  StreamFailure,
  StreamSummary,
  Value,
} from "./types";
export type { EngineBoundaryFailure } from "./types";

export type EngineParseOutcome = EngineOutcome<
  Value,
  ParseFailure | AbortedFailure | EngineBoundaryFailure
>;
export type EngineRepairOutcome = EngineOutcome<
  string | readonly Match<string>[],
  RepairFailure | AbortedFailure | EngineBoundaryFailure
>;
export type EngineSpanOutcome = EngineOutcome<
  Span | readonly Match<Span>[],
  ParseFailure | AbortedFailure | EngineBoundaryFailure
>;
export type EngineStreamOutcome = EngineOutcome<unknown, StreamFailure | EngineBoundaryFailure>;
export type EngineStreamItem = EngineStreamOutcome | StreamSummary;
export type EngineSnapshotOutcome = Result<
  Snapshot | undefined,
  SnapshotFailure | EngineBoundaryFailure
>;

export type EngineDecodeContext = {
  readonly nullPrototype: boolean;
  readonly selected: boolean;
};

export const DEFAULT_ENGINE_DECODE_CONTEXT: EngineDecodeContext = {
  nullPrototype: false,
  selected: false,
};

export const decodeEngineResponse = (
  bytes: Uint8Array,
  context = DEFAULT_ENGINE_DECODE_CONTEXT,
): EngineParseOutcome => {
  try {
    const reader = new Reader(bytes, context.nullPrototype);
    reader.expect(1);
    const outcome = readOutcome(reader);
    if (!reader.done()) throw new RangeError("trailing response bytes");
    return outcome;
  } catch {
    return malformed();
  }
};

export const decodeEngineManyResponse = (
  bytes: Uint8Array,
  context = DEFAULT_ENGINE_DECODE_CONTEXT,
): readonly EngineParseOutcome[] => {
  try {
    const reader = new Reader(bytes, context.nullPrototype);
    reader.expect(1);
    reader.expect(6);
    const outcomes: EngineParseOutcome[] = [];
    const count = reader.length();
    for (let i = 0; i < count; i++) outcomes.push(readOutcome(reader));
    if (!reader.done()) throw new RangeError("trailing response bytes");
    return outcomes;
  } catch {
    return [malformed()];
  }
};

export const decodeEngineStreamResponse = (
  bytes: Uint8Array,
  context = DEFAULT_ENGINE_DECODE_CONTEXT,
): readonly EngineStreamItem[] => {
  try {
    const reader = new Reader(bytes, context.nullPrototype);
    reader.expect(1);
    reader.expect(6);
    const outcomes: EngineStreamItem[] = [];
    const count = reader.length();
    for (let i = 0; i < count; i++) outcomes.push(readStreamOutcome(reader.byte(), reader));
    if (!reader.done()) throw new RangeError("trailing response bytes");
    return outcomes;
  } catch {
    return [malformed()];
  }
};

export const decodeEngineRepairResponse = (
  bytes: Uint8Array,
  context = DEFAULT_ENGINE_DECODE_CONTEXT,
): EngineRepairOutcome => {
  try {
    const reader = new Reader(bytes, context.nullPrototype);
    reader.expect(1);
    const tag = reader.byte();
    let outcome: EngineRepairOutcome;
    if (context.selected && tag === 0) {
      const value = reader.value();
      if (!selectedValuesAre(value, (item) => typeof item === "string"))
        throw new RangeError("selected repair response is not text");
      outcome = reader.success(value);
    } else if (tag === 0) {
      const value = reader.value();
      if (typeof value !== "string") throw new RangeError("repair response is not text");
      outcome = reader.success(value);
    } else if (tag === 7) outcome = reader.failed(reader.nonJsonValue());
    else {
      const parsed = readConfiguredParseOutcome(tag, reader);
      if (parsed.ok) throw new RangeError("invalid repair success tag");
      outcome = parsed;
    }
    if (!reader.done()) throw new RangeError("trailing response bytes");
    return outcome;
  } catch {
    return malformed();
  }
};

export const decodeEngineSpanResponse = (
  bytes: Uint8Array,
  context = DEFAULT_ENGINE_DECODE_CONTEXT,
): EngineSpanOutcome => {
  try {
    const reader = new Reader(bytes, context.nullPrototype);
    reader.expect(1);
    const tag = reader.byte();
    let outcome: EngineSpanOutcome;
    if (context.selected && tag === 0) {
      const value = reader.value();
      if (!selectedValuesAre(value, isSpan))
        throw new RangeError("selected span response is not a span");
      outcome = reader.success(value);
    } else if (tag === 8) outcome = reader.success(reader.span());
    else {
      const parsed = readConfiguredParseOutcome(tag, reader);
      if (parsed.ok) throw new RangeError("invalid span success tag");
      outcome = parsed;
    }
    if (!reader.done()) throw new RangeError("trailing response bytes");
    return outcome;
  } catch {
    return malformed();
  }
};

const selectedValuesAre = <T>(
  value: Value,
  accepts: (value: unknown) => value is T,
): value is readonly Match<T>[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "value" in item &&
      accepts(Reflect.get(item, "value")),
  );

const isSpan = (value: unknown): value is Span =>
  typeof value === "object" && value !== null && "start" in value && "end" in value;

export const decodeEngineSnapshotResponse = (
  bytes: Uint8Array,
  context = DEFAULT_ENGINE_DECODE_CONTEXT,
): EngineSnapshotOutcome => {
  try {
    const reader = new Reader(bytes, context.nullPrototype);
    reader.expect(1);
    const tag = reader.byte();
    let outcome: EngineSnapshotOutcome;
    if (tag === 18) outcome = { ok: true, value: undefined };
    else if (tag === 19) outcome = { ok: true, value: reader.snapshot() };
    else {
      const parsed = readExtendedOutcome(tag, reader);
      if (parsed.ok) throw new RangeError("invalid snapshot success tag");
      if (parsed.failure.kind !== "limit-reached" && parsed.failure.kind !== "policy-refused")
        throw new RangeError("invalid snapshot failure tag");
      outcome = { ok: false, failure: parsed.failure };
    }
    if (!reader.done()) throw new RangeError("trailing response bytes");
    return outcome;
  } catch {
    return malformed();
  }
};

const readOutcome = (reader: Reader): EngineParseOutcome => {
  return readConfiguredParseOutcome(reader.byte(), reader);
};

const readConfiguredParseOutcome = (tag: number, reader: Reader): EngineParseOutcome => {
  if (tag <= 5) return readParseOutcome(tag, reader);
  if (tag === 9) return reader.failed(reader.noMatch());
  if (tag === 13) return reader.failed(reader.policyRefused());
  if (tag === 20) return reader.failed(reader.aborted());
  throw new RangeError("invalid configured outcome tag");
};

const readParseOutcome = (tag: number, reader: Reader): EngineParseOutcome => {
  if (tag === 0) return reader.success(reader.value());
  if (tag === 1) return reader.failed({ kind: "no-json-found" });
  if (tag === 2) {
    const encoding = ["utf-16be", "utf-16le", "utf-32be", "utf-32le"] as const;
    const selected = encoding[reader.byte()];
    if (selected === undefined) throw new RangeError("invalid encoding tag");
    return reader.failed({ kind: "unsupported-encoding", encoding: selected });
  }
  if (tag === 3) return reader.failed(reader.limit());
  if (tag === 4) {
    if (reader.byte() > 6) throw new RangeError("invalid boundary reason");
    return { ok: false, failure: { kind: "engine-protocol-failed", reason: "invalid-boundary" } };
  }
  if (tag === 5)
    return { ok: false, failure: { kind: "engine-protocol-failed", reason: "internal-failure" } };
  throw new RangeError("invalid outcome tag");
};

const readStreamOutcome = (tag: number, reader: Reader): EngineStreamItem => {
  if (tag === 10) return reader.failed({ kind: "stream-closed" });
  if (tag === 14) {
    const complete = reader.boolean();
    const roots = reader.length();
    const matches = reader.length();
    const unmatched: number[] = [];
    const count = reader.length();
    for (let i = 0; i < count; i++) unmatched.push(reader.length());
    return { kind: "summary", complete, roots, matches, unmatched };
  }
  if (tag === 15) {
    const id = reader.length();
    const valueIndex = reader.length();
    const path = reader.path();
    const selectors: number[] = [];
    const count = reader.length();
    for (let i = 0; i < count; i++) selectors.push(reader.length());
    const scalar = ["string", "number", "literal"] as const;
    const kind = scalar[reader.byte()];
    if (kind === undefined) throw new RangeError("invalid fragment scalar tag");
    return reader.success({ kind: "start", id, valueIndex, path, selectors, scalar: kind });
  }
  if (tag === 16)
    return reader.success({ kind: "data", id: reader.length(), text: reader.stringValue() });
  if (tag === 17) return reader.success({ kind: "end", id: reader.length(), span: reader.span() });
  const outcome = readExtendedOutcome(tag, reader);
  return outcome;
};

const readExtendedOutcome = (
  tag: number,
  reader: Reader,
): Result<Value, ParseFailure | ConfigurationFailure | StreamFailure | EngineBoundaryFailure> => {
  if (tag <= 5) return readParseOutcome(tag, reader);
  if (tag === 9) return reader.failed(reader.noMatch());
  if (tag === 11) return reader.failed(reader.invalidOptions());
  if (tag === 12) return reader.failed({ kind: "non-scalar-selection", path: reader.path() });
  if (tag === 13) return reader.failed(reader.policyRefused());
  throw new RangeError("invalid extended outcome tag");
};

const malformed = (): { readonly ok: false; readonly failure: EngineBoundaryFailure } => ({
  ok: false,
  failure: { kind: "engine-protocol-failed", reason: "malformed-response" },
});
