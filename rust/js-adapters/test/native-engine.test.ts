// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { NativeEngine } from "../src/native-engine";
import type { NativeFactories } from "../src/native-engine";

const length = (value: number): number[] => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return [...bytes];
};

const success = (value: readonly number[]): Uint8Array => new Uint8Array([1, 0, ...value, 0, 0]);

const ready = success([9, ...length(1), 6, ...length(5), ...new TextEncoder().encode("ready"), 2]);
const readyStream = new Uint8Array([1, 6, ...length(1), ...ready.slice(1)]);

const factories = (
  parse: () => Uint8Array,
  release: () => void = () => undefined,
): NativeFactories => ({
  parse,
  createParser: () => ({
    execute: parse,
    createStream: () => ({
      feed: () => readyStream,
      end: () => new Uint8Array([1, 6, ...length(0)]),
      snapshot: () => new Uint8Array([1, 18]),
      summary: () => new Uint8Array([1, 6, ...length(0)]),
      close: () => undefined,
    }),
  }),
  createStream: () => ({
    feed: () => readyStream,
    end: () => new Uint8Array([1, 6, ...length(0)]),
    snapshot: () => new Uint8Array([1, 18]),
    summary: () => new Uint8Array([1, 6, ...length(0)]),
    close: () => undefined,
  }),
  release,
});

describe("native engine startup", () => {
  test("rejects a binding with missing symbols", () => {
    expect(NativeEngine.bind({})).toEqual({
      ok: false,
      failure: { kind: "native-engine-load-failed", reason: "exports" },
    });
  });

  test.each([
    [
      "abi",
      () =>
        factories(() => {
          throw new Error("call failed");
        }),
    ],
    ["protocol", () => factories(() => new Uint8Array([2]))],
    ["initialization", () => factories(() => success([2]))],
  ] as const)("classifies %s failure before accepting the engine", (reason, build) => {
    let releases = 0;
    const candidate = build();
    const loaded = NativeEngine.fromFactories({
      ...candidate,
      release: () => {
        releases++;
      },
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.kind).toBe("native-engine-load-failed");
    expect(loaded.failure.reason).toBe(reason);
    expect(releases).toBe(1);
  });

  test("reports teardown when failed startup cannot release the library", () => {
    const loaded = NativeEngine.fromFactories(
      factories(
        () => success([2]),
        () => {
          throw new Error("release failed");
        },
      ),
    );

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.reason).toBe("teardown");
    expect(loaded.failure.cause).toEqual({
      kind: "native-engine-load-failed",
      reason: "initialization",
    });
  });
});
