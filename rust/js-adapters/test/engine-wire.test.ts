// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  decodeEngineManyResponse,
  decodeEngineRepairResponse,
  decodeEngineResponse,
  decodeEngineSpanResponse,
} from "../src/engine-wire";
import { encodeEngineChunk, encodeEngineRequest } from "../src/engine-request";
import { isExactNumber } from "../src/exact-number";

const length = (value: number): number[] => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return [...bytes];
};
const double = (value: number): number[] => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...bytes];
};
const text = (value: string): number[] => {
  const bytes = new TextEncoder().encode(value);
  return [6, ...length(bytes.length), ...bytes];
};

describe("engine response decoding", () => {
  it("frames byte and UTF-16 input without transcoding source units", () => {
    expect(encodeEngineRequest(new Uint8Array([0xff]))).toEqual(new Uint8Array([1, 0, 0, 0xff]));
    expect(encodeEngineRequest("\uD800", "parseMany")).toEqual(new Uint8Array([1, 1, 1, 0, 0xd8]));
    expect(encodeEngineChunk("x", false)).toEqual(new Uint8Array([1, 0, 1, 0x78, 0]));
  });

  it("preserves exact numbers, special doubles, lone surrogates and dangerous keys", () => {
    const response = new Uint8Array([
      1,
      0,
      8,
      ...length(4),
      5,
      ...length(16),
      ...new TextEncoder().encode("9007199254740993"),
      4,
      ...double(Number.NaN),
      7,
      ...length(1),
      0,
      0xd8,
      9,
      ...length(1),
      ...text("__proto__"),
      0,
      0,
      0,
    ]);
    const outcome = decodeEngineResponse(response);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !Array.isArray(outcome.value)) return;
    expect(isExactNumber(outcome.value[0])).toBe(true);
    expect(outcome.value[1]).toSatisfy(Number.isNaN);
    expect(outcome.value[2]).toBe("\uD800");
    expect(Object.hasOwn(outcome.value[3] as object, "__proto__")).toBe(true);
    const nullPrototype = decodeEngineResponse(response, {
      nullPrototype: true,
      selected: false,
    });
    expect(nullPrototype.ok).toBe(true);
    if (!nullPrototype.ok || !Array.isArray(nullPrototype.value)) return;
    expect(Object.getPrototypeOf(nullPrototype.value[3])).toBeNull();
  });

  it("turns malformed and boundary responses into typed failures", () => {
    expect(decodeEngineResponse(new Uint8Array([1, 4, 3]))).toEqual({
      ok: false,
      failure: { kind: "engine-protocol-failed", reason: "invalid-boundary" },
    });
    expect(decodeEngineResponse(new Uint8Array([1, 0, 8, ...length(1)]))).toEqual({
      ok: false,
      failure: { kind: "engine-protocol-failed", reason: "malformed-response" },
    });
  });

  it("decodes every parseMany outcome from one response", () => {
    expect(
      decodeEngineManyResponse(new Uint8Array([1, 6, ...length(2), 0, 2, 0, 0, 0, 0, 0, 0])),
    ).toEqual([
      { ok: true, value: true },
      { ok: true, value: null },
    ]);
  });

  it("keeps repaired text, non-JSON refusal paths and source spans typed", () => {
    expect(decodeEngineRepairResponse(new Uint8Array([1, 0, ...text('{"a":1}'), 0, 0]))).toEqual({
      ok: true,
      value: '{"a":1}',
    });
    expect(
      decodeEngineRepairResponse(new Uint8Array([1, 7, 0, ...length(1), 0, ...text("value"), 0])),
    ).toEqual({
      ok: false,
      failure: { kind: "non-json-value", valueKind: "undefined", path: ["value"] },
    });
    expect(
      decodeEngineSpanResponse(
        new Uint8Array([1, 8, ...length(2), 0, 0, ...length(9), 0, 0, 0, 0]),
      ),
    ).toEqual({
      ok: true,
      value: {
        start: { offset: 2, unit: "utf16" },
        end: { offset: 9, unit: "utf16" },
      },
    });
  });
});
