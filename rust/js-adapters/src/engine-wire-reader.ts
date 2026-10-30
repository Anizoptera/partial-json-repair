// SPDX-License-Identifier: Apache-2.0

/** Read typed values from the shared native and WASM response protocol. */

import { ExactNumber } from "./exact-number";
import { RECOVERY_FLAG } from "./options";
import { REPAIR_PENALTY } from "./types";
import type {
  AbortedFailure,
  ConfigurationFailure,
  Diagnostics,
  ParseError,
  ParseFailure,
  RepairKind,
  RepairFailure,
  Result,
  SourcePath,
  Snapshot,
  Span,
  SwitchableRepair,
  Value,
} from "./types";

const isSwitchableRepair = (value: string): value is SwitchableRepair =>
  Object.hasOwn(RECOVERY_FLAG, value);
const OPTION_REASONS = ["selector", "skip-tail", "root-filter"] as const;
const ERROR_KINDS = ["depth-budget", "dangerous-key", "invalid-utf8", "unparsable-span"] as const;
const memberOf = <T extends string>(values: readonly T[], value: string): value is T =>
  values.some((candidate) => candidate === value);
const isRepairKind = (value: string): value is RepairKind => Object.hasOwn(REPAIR_PENALTY, value);

export type EngineOutcome<T, F> = Result<T, F> & {
  readonly span?: Span;
  readonly diagnostics?: Diagnostics;
};
export class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly nullPrototype = false,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  done(): boolean {
    return this.at === this.bytes.length;
  }

  byte(): number {
    const value = this.bytes[this.at];
    if (value === undefined) throw new RangeError("truncated response");
    this.at++;
    return value;
  }

  expect(expected: number): void {
    if (this.byte() !== expected) throw new RangeError("unsupported protocol version");
  }

  value(): Value {
    const tag = this.byte();
    if (tag === 0) return null;
    if (tag === 1) return false;
    if (tag === 2) return true;
    if (tag === 3) return undefined;
    if (tag === 4) {
      this.take(8);
      const value = this.view.getFloat64(this.at - 8, true);
      return value;
    }
    if (tag === 5) return new ExactNumber(this.utf8());
    if (tag === 6 || tag === 7) return this.string(tag);
    if (tag === 8) {
      const values: Value[] = [];
      const count = this.length();
      for (let i = 0; i < count; i++) values.push(this.value());
      return values;
    }
    if (tag === 9) {
      const value: Record<string, Value> = {};
      if (this.nullPrototype) Object.setPrototypeOf(value, null);
      const count = this.length();
      for (let i = 0; i < count; i++) {
        const keyTag = this.byte();
        if (keyTag !== 6 && keyTag !== 7) throw new RangeError("invalid key tag");
        Object.defineProperty(value, this.string(keyTag), {
          value: this.value(),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return value;
    }
    if (tag === 10) {
      const value = this.value();
      const path = this.path();
      const valueIndex = this.length();
      const span = this.span();
      const selectors: number[] = [];
      const count = this.length();
      for (let i = 0; i < count; i++) selectors.push(this.length());
      return { value, path, valueIndex, span, selectors };
    }
    if (tag === 11) return this.span();
    throw new RangeError("invalid value tag");
  }

  span(): Span {
    return { start: this.position(), end: this.position() };
  }

  boolean(): boolean {
    return this.flag();
  }

  stringValue(): string {
    const value = this.value();
    if (typeof value !== "string") throw new RangeError("response value is not text");
    return value;
  }

  snapshot(): Snapshot {
    const value = this.value();
    const valueIndex = this.length();
    const complete = this.flag();
    const partialPath = this.flag() ? this.path() : undefined;
    return partialPath === undefined
      ? { value, valueIndex, complete }
      : { value, valueIndex, complete, partialPath };
  }

  success<T>(value: T): EngineOutcome<T, never> {
    const outcome: { ok: true; value: T; span?: Span; diagnostics?: Diagnostics } = {
      ok: true,
      value,
    };
    if (this.flag()) outcome.span = this.span();
    const diagnostics = this.report();
    if (diagnostics !== undefined) outcome.diagnostics = diagnostics;
    return outcome;
  }

  failed<F>(failure: F): EngineOutcome<never, F> {
    const outcome: { ok: false; failure: F; diagnostics?: Diagnostics } = { ok: false, failure };
    const diagnostics = this.report();
    if (diagnostics !== undefined) outcome.diagnostics = diagnostics;
    return outcome;
  }

  private report(): Diagnostics | undefined {
    if (!this.flag()) return undefined;
    const repairs: Diagnostics["repairs"][number][] = [];
    const repairCount = this.length();
    for (let i = 0; i < repairCount; i++) {
      const kind = this.text();
      if (!isRepairKind(kind)) throw new RangeError("invalid repair kind");
      repairs.push({ kind, at: this.position(), path: this.path(), valueIndex: this.length() });
    }
    const errors: ParseError[] = [];
    const errorCount = this.length();
    for (let i = 0; i < errorCount; i++) errors.push(this.parseError());
    const counts = { repairs: this.length(), errors: this.length() };
    const entriesComplete = this.flag();
    const scanComplete = this.flag();
    const scopeTag = this.byte();
    if (scopeTag > 1) throw new RangeError("invalid diagnostics scope");
    this.take(8);
    const confidence = this.view.getFloat64(this.at - 8, true);
    return {
      repairs,
      errors,
      counts,
      entriesComplete,
      scanComplete,
      scope: scopeTag === 0 ? "all" : "selected",
      confidence,
    };
  }

  nonJsonValue(): Extract<RepairFailure, { kind: "non-json-value" }> {
    const kinds = ["undefined", "nan", "infinity"] as const;
    const valueKind = kinds[this.byte()];
    if (valueKind === undefined) throw new RangeError("invalid non-JSON value tag");
    return { kind: "non-json-value", valueKind, path: this.path() };
  }

  path(): SourcePath {
    const path: (string | number)[] = [];
    const count = this.length();
    for (let i = 0; i < count; i++) {
      const tag = this.byte();
      if (tag === 0) {
        const keyTag = this.byte();
        if (keyTag !== 6 && keyTag !== 7) throw new RangeError("invalid path key tag");
        path.push(this.string(keyTag));
      } else if (tag === 1) path.push(this.length());
      else throw new RangeError("invalid path segment tag");
    }
    return path;
  }

  noMatch(): Extract<ParseFailure, { kind: "no-match" }> {
    const requiredKeys: string[] = [];
    const count = this.length();
    for (let i = 0; i < count; i++) requiredKeys.push(this.text());
    const failure: Extract<ParseFailure, { kind: "no-match" }> = {
      kind: "no-match",
      expected: "object",
      requiredKeys,
    };
    if (this.flag()) failure.recovered = { value: this.value() };
    return failure;
  }

  invalidOptions(): Extract<ConfigurationFailure, { kind: "invalid-options" }> {
    const field = this.text();
    const reason = this.text();
    if (!memberOf(OPTION_REASONS, reason)) throw new RangeError("invalid option reason");
    return { kind: "invalid-options", field, reason };
  }

  policyRefused(): Extract<ParseFailure, { kind: "policy-refused" }> {
    const failure: Extract<ParseFailure, { kind: "policy-refused" }> = {
      kind: "policy-refused",
      issue: this.parseError(),
    };
    if (this.flag()) failure.recovered = { value: this.value() };
    return failure;
  }

  aborted(): AbortedFailure {
    const failure: AbortedFailure = { kind: "aborted", reason: undefined };
    return this.flag() ? { ...failure, recovered: { value: this.value() } } : failure;
  }

  private parseError(): ParseError {
    const kind = this.text();
    if (!memberOf(ERROR_KINDS, kind)) throw new RangeError("invalid parse error kind");
    const valueIndex = this.length();
    const path = this.path();
    const at = this.position();
    const line = this.length();
    const column = this.length();
    const context = this.text();
    const refused = this.flag() ? this.text() : undefined;
    if (refused !== undefined && !isSwitchableRepair(refused))
      throw new RangeError("invalid refused repair kind");
    return { kind, at, line, column, context, refused, path, valueIndex };
  }

  limit(): Extract<ParseFailure, { kind: "limit-reached" }> {
    const resources = ["errors", "buffer", "depth", "scalar", "retained"] as const;
    const resource = resources[this.byte()];
    if (resource === undefined) throw new RangeError("invalid resource tag");
    const failure: {
      kind: "limit-reached";
      resource: (typeof resources)[number];
      limit: number;
      at?: { offset: number; unit: "utf16" | "byte"; chunk?: number };
      recovered?: { value: Value };
    } = { kind: "limit-reached", resource, limit: this.length() };
    if (this.flag()) failure.at = this.position();
    if (this.flag()) failure.recovered = { value: this.value() };
    return failure;
  }

  private position(): Span["start"] {
    const offset = this.length();
    const unitTag = this.byte();
    if (unitTag > 1) throw new RangeError("invalid position unit");
    const position: { offset: number; unit: "utf16" | "byte"; chunk?: number } = {
      offset,
      unit: unitTag === 0 ? "utf16" : "byte",
    };
    if (this.flag()) position.chunk = this.length();
    return position;
  }

  private flag(): boolean {
    const value = this.byte();
    if (value > 1) throw new RangeError("invalid flag");
    return value === 1;
  }

  private string(tag: 6 | 7): string {
    if (tag === 6) return this.utf8();
    const count = this.length();
    const bytes = this.take(count * 2);
    let value = "";
    for (let start = 0; start < count; start += 0x2000) {
      const end = Math.min(start + 0x2000, count);
      const units = new Uint16Array(end - start);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = start; i < end; i++) units[i - start] = view.getUint16(i * 2, true);
      value += String.fromCharCode(...units);
    }
    return value;
  }

  private text(): string {
    const tag = this.byte();
    if (tag !== 6 && tag !== 7) throw new RangeError("invalid text tag");
    return this.string(tag);
  }

  private utf8(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(this.length()));
  }

  length(): number {
    this.take(8);
    const value = this.view.getBigUint64(this.at - 8, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("oversized response field");
    return Number(value);
  }

  private take(length: number): Uint8Array {
    const end = this.at + length;
    if (!Number.isSafeInteger(length) || end > this.bytes.length)
      throw new RangeError("truncated response");
    const value = this.bytes.subarray(this.at, end);
    this.at = end;
    return value;
  }
}
