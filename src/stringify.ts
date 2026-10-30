// SPDX-License-Identifier: Apache-2.0

/**
 * Encodes a recovered value as JSON text, exact numbers included, or says exactly why it cannot.
 *
 * `JSON.stringify` is not used because it lies in four ways this package must not: it rounds an
 * exact number or throws on it, drops an `undefined` member and writes `null` for an array hole,
 * calls getters and `toJSON` (so the text describes a value nobody handed it), and recurses (so a
 * deep enough value throws instead of failing). This walks with an explicit stack, reads every
 * member through its property descriptor so an accessor is refused rather than run, and bounds
 * the output the way the parser bounds its input.
 */
import type { EncodingFailure, Result } from "./types";
import { checkHelperOptions, configurationError, isPlainObject } from "./configuration-error";
import { isExactNumber } from "./exact-number";
import { DEFAULT_MAX_BUFFER } from "./options";
import type { Exact } from "./options";

export type StringifyOptions = {
  /** Output bound in UTF-16 code units. Defaults to the parser's `maxBuffer`. */
  readonly maxOutput?: number;
};

type Path = (string | number)[];
type NonJson = Extract<EncodingFailure, { kind: "non-json-value" }>["valueKind"];

/** An open container: what remains to be written from it and how it closes. */
type Frame = {
  readonly value: object;
  /** Own enumerable keys of an object; `undefined` for an array, which is read by index. */
  readonly keys: readonly string[] | undefined;
  readonly length: number;
  index: number;
};

const digitsFrom = (text: string, at: number): number => {
  while (at < text.length && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at++;
  return at;
};

/** RFC 8259 `number`: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`, whole string. */
const isJsonNumber = (text: unknown): boolean => {
  if (typeof text !== "string") return false;
  let at = text.charCodeAt(0) === 0x2d ? 1 : 0;
  if (text.charCodeAt(at) === 0x30) at++;
  else {
    const end = digitsFrom(text, at);
    if (end === at) return false;
    at = end;
  }
  if (text.charCodeAt(at) === 0x2e) {
    const end = digitsFrom(text, at + 1);
    if (end === at + 1) return false;
    at = end;
  }
  if (text.charCodeAt(at) === 0x65 || text.charCodeAt(at) === 0x45) {
    at++;
    if (text.charCodeAt(at) === 0x2b || text.charCodeAt(at) === 0x2d) at++;
    const end = digitsFrom(text, at);
    if (end === at) return false;
    at = end;
  }
  return at === text.length;
};

/**
 * A member read that refuses accessors. `undefined` is a hole (array) or a proxy that denied a key it
 * reported, both of which the caller treats as the value `undefined`, which JSON cannot spell.
 */
const readMember = (
  container: object,
  key: string | number,
): { value: unknown } | { accessor: true } => {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) return { value: undefined };
  // Descriptor prototypes are caller-mutable too; inherited value must not disguise an accessor.
  return Object.hasOwn(descriptor, "value") ? { value: descriptor.value } : { accessor: true };
};

export function stringify<O extends StringifyOptions | undefined>(
  value: unknown,
  options: Exact<O, StringifyOptions>,
): Result<string, EncodingFailure>;
// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- Explicit generic forwarding needs this non-inferred overload; optional inference hides union typos.
export function stringify<O extends StringifyOptions = never>(
  value: unknown,
  options?: Exact<NoInfer<O>, StringifyOptions>,
): Result<string, EncodingFailure>;
export function stringify(
  value: unknown,
  options?: StringifyOptions,
): Result<string, EncodingFailure> {
  const requested =
    options === undefined ? undefined : checkHelperOptions(options, ["maxOutput"]).maxOutput;
  const maxOutput = requested === undefined ? DEFAULT_MAX_BUFFER : requested;
  if (typeof maxOutput !== "number" || !Number.isSafeInteger(maxOutput) || maxOutput < 1)
    throw configurationError({
      kind: "invalid-options",
      field: "maxOutput",
      reason: "positive-integer",
    });
  const out: string[] = [];
  let size = 0;
  const emit = (text: string): void => {
    out.push(text);
    size += text.length;
  };
  const path: Path = [];
  const ancestors = new Set<object>();
  const frames: Frame[] = [];
  const nonJson = (valueKind: NonJson): EncodingFailure => ({
    kind: "non-json-value",
    valueKind,
    path: [...path],
  });
  const outputLimit = (): EncodingFailure => ({
    kind: "limit-reached",
    resource: "output",
    limit: maxOutput,
  });

  /** Writes a scalar, or opens a container and answers `true` so the caller leaves its path entry. */
  const place = (v: unknown): EncodingFailure | boolean => {
    switch (typeof v) {
      case "string":
        // Escaping can only grow text: refuse an impossible fit before allocating the escaped copy.
        if (size + v.length + 2 > maxOutput) return outputLimit();
        emit(JSON.stringify(v));
        return false;
      case "number":
        if (Number.isNaN(v)) return nonJson("nan");
        if (!Number.isFinite(v)) return nonJson("infinity");
        emit(String(v));
        return false;
      case "boolean":
        emit(v ? "true" : "false");
        return false;
      case "undefined":
        return nonJson("undefined");
      case "bigint":
        return nonJson("bigint");
      case "function":
        return nonJson("function");
      case "symbol":
        return nonJson("symbol");
      case "object":
        break;
    }
    const object = v;
    if (object === null) {
      emit("null");
      return false;
    }
    if (ancestors.has(object)) return { kind: "cycle", path: [...path] };
    let frame: Frame;
    // Inspecting a proxy runs its traps, which may throw — from the first property read (the
    // exact-number brand) on. That is the one place a caller's code runs during encoding, and its
    // failure is reported at the path, never propagated.
    try {
      if (isExactNumber(object)) {
        // The brand is a registry symbol, so any object can carry it: emitting its `text` unchecked
        // let `{ text: '1,"x":true' }` write members into the output. A real exact number's text is
        // always a canonical JSON number; anything else is a branded impostor. Accessors must be
        // refused before reading their value, just as for ordinary members.
        const member = readMember(object, "text");
        if ("accessor" in member) return { kind: "accessor", path: [...path, "text"] };
        const text = member.value;
        if (!isJsonNumber(text)) return nonJson("non-plain-object");
        emit(text as string);
        return false;
      }
      if (Array.isArray(object)) {
        frame = { value: object, keys: undefined, length: object.length, index: 0 };
      } else {
        if (!isPlainObject(object)) return nonJson("non-plain-object");
        const keys = Object.keys(object);
        frame = { value: object, keys, length: keys.length, index: 0 };
      }
    } catch (cause) {
      return { kind: "invalid-value", path: [...path], cause };
    }
    emit(frame.keys === undefined ? "[" : "{");
    ancestors.add(object);
    frames.push(frame);
    return true;
  };

  const first = place(value);
  if (typeof first === "object") return { ok: false, failure: first };
  while (frames.length > 0) {
    const frame = frames[frames.length - 1] as Frame;
    if (frame.index === frame.length) {
      emit(frame.keys === undefined ? "]" : "}");
      frames.pop();
      ancestors.delete(frame.value);
      path.pop();
      if (size > maxOutput) break;
      continue;
    }
    const i = frame.index++;
    if (i > 0) emit(",");
    const key = frame.keys === undefined ? i : (frame.keys[i] as string);
    if (typeof key === "string") {
      if (size + key.length + 3 > maxOutput) return { ok: false, failure: outputLimit() };
      emit(`${JSON.stringify(key)}:`);
    }
    let member: ReturnType<typeof readMember>;
    try {
      member = readMember(frame.value, key);
    } catch (cause) {
      return { ok: false, failure: { kind: "invalid-value", path: [...path, key], cause } };
    }
    if ("accessor" in member)
      return { ok: false, failure: { kind: "accessor", path: [...path, key] } };
    path.push(key);
    const placed = place(member.value);
    if (typeof placed === "object") return { ok: false, failure: placed };
    if (!placed) path.pop();
    if (size > maxOutput) break;
  }
  if (size > maxOutput) {
    return { ok: false, failure: { kind: "limit-reached", resource: "output", limit: maxOutput } };
  }
  return { ok: true, value: out.join("") };
}
