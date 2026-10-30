// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";

import { tryParsers } from "../src/index";
import { configurationCause } from "./configuration-error";

describe("tryParsers", () => {
  it("preserves order, advances after parser failures, and returns the accepted value unchanged", () => {
    const accepted = { format: "third" };
    const calls: number[] = [];
    const result = tryParsers("source", [
      () => {
        calls.push(0);
        throw new Error("wrong format");
      },
      () => {
        calls.push(1);
        return 1;
      },
      () => {
        calls.push(2);
        return accepted;
      },
      () => {
        calls.push(3);
        return {};
      },
    ]);

    expect(result).toEqual({ ok: true, value: accepted });
    if (result.ok) expect(result.value).toBe(accepted);
    expect(calls).toEqual([0, 1, 2]);
  });

  it("stops with typed failures for async results, predicate errors, and exhaustion", () => {
    const predicateCause = new Error("predicate failed");
    const inspectionCause = new Error("inspection failed");
    // Rejecting: the failure is returned synchronously, and the rejection it carries must not then
    // reach the host as unhandled, which exits Node.
    const promise = Promise.reject(new Error("async parser failed"));

    expect(tryParsers("", [() => promise])).toEqual({
      ok: false,
      failure: { kind: "async-parser", parserIndex: 0 },
    });
    expect(
      tryParsers("", [() => ({})], {
        isResult: () => {
          throw predicateCause;
        },
      }),
    ).toEqual({
      ok: false,
      failure: { kind: "acceptance-failed", parserIndex: 0, cause: predicateCause },
    });
    expect(
      tryParsers("", [
        () =>
          new Proxy(
            {},
            {
              get(_target, key) {
                if (key === "then") throw inspectionCause;
                return undefined;
              },
            },
          ),
      ]),
    ).toEqual({
      ok: false,
      failure: { kind: "result-inspection-failed", parserIndex: 0, cause: inspectionCause },
    });
    expect(tryParsers("", [() => null, () => 1])).toEqual({
      ok: false,
      failure: { kind: "parsers-exhausted", attempts: 2 },
    });
  });

  it("refuses an `isResult` that is not a function, before any parser runs", () => {
    let calls = 0;
    const parser = () => {
      calls++;
      return {};
    };
    expect(configurationCause(() => tryParsers("{}", [parser], { isResult: 1 } as never))).toEqual({
      kind: "invalid-options",
      field: "isResult",
      reason: "function",
    });
    expect(calls).toBe(0);
  });

  it("refuses native promises without trusting their public then property", () => {
    for (const then of [
      undefined,
      () => {
        throw new Error("caller then must not run");
      },
    ]) {
      // oxlint-disable-next-line unicorn/no-thenable -- exercise shadowing on a real Promise.
      const promise = Object.defineProperty(Promise.resolve({}), "then", { value: then });
      expect(tryParsers("", [() => promise])).toEqual({
        ok: false,
        failure: { kind: "async-parser", parserIndex: 0 },
      });
    }
  });

  it("observes rejected promises from another realm without invoking custom thenables", () => {
    // An unhandled rejection fails the runner, independently of the synchronous result assertion.
    const foreign: unknown = runInNewContext('Promise.reject(new Error("foreign parser failed"))');
    expect(foreign instanceof Promise).toBe(false);
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- a caller parser can return a custom thenable.
      then() {
        throw new Error("custom then must not run");
      },
    };
    for (const value of [foreign, thenable])
      expect(tryParsers("", [() => value])).toEqual({
        ok: false,
        failure: { kind: "async-parser", parserIndex: 0 },
      });
  });

  it.each(["constructor", "species"] as const)(
    "preserves a foreign Promise's %s inspection failure",
    (hook) => {
      const cause = new Error("Promise construction failed");
      const foreign: unknown = runInNewContext("Promise.resolve({})");
      if (typeof foreign !== "object" || foreign === null) throw new Error("missing Promise");
      Object.defineProperties(foreign, {
        constructor:
          hook === "constructor"
            ? {
                get() {
                  throw cause;
                },
              }
            : {
                value: {
                  get [Symbol.species]() {
                    throw cause;
                  },
                },
              },
      });
      expect(tryParsers("", [() => foreign])).toEqual({
        ok: false,
        failure: { kind: "result-inspection-failed", parserIndex: 0, cause },
      });
    },
  );

  it("accepts ordinary objects without reading their constructor hooks", () => {
    let reads = 0;
    let nativeProbes = 0;
    // eslint-disable-next-line typescript/unbound-method -- Delegate with an explicit receiver and restore this exact intrinsic.
    const nativeThen = Promise.prototype.then;
    const value = Object.defineProperty({ data: 1 }, "constructor", {
      get() {
        reads++;
        throw new Error("data constructor must not run");
      },
    });
    // eslint-disable-next-line no-extend-native, unicorn/no-thenable -- Observe the real native method without faking its result.
    void Object.defineProperty(Promise.prototype, "then", {
      value(this: Promise<unknown>, ...handlers: Parameters<Promise<unknown>["then"]>) {
        if (Object.is(this, value)) nativeProbes++;
        return nativeThen.call(this, ...handlers);
      },
    });
    try {
      const result = tryParsers("", [() => value]);
      expect(result).toEqual({ ok: true, value });
      if (result.ok) expect(result.value).toBe(value);
      expect(reads).toBe(0);
      expect(nativeProbes).toBe(0);
    } finally {
      // eslint-disable-next-line no-extend-native, unicorn/no-thenable -- Restore the native method without changing its attributes.
      void Object.defineProperty(Promise.prototype, "then", { value: nativeThen });
    }
  });
});
