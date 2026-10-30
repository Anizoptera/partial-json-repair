// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { loadNativeFrom, selectNativeCandidate } from "../src/native-route";

const failure = (reason: "load" | "exports" | "initialization") => ({
  kind: "native-engine-load-failed" as const,
  reason,
});

describe("native route ladder", () => {
  test("refuses an unsupported target without invoking a loader", () => {
    let attempted = false;
    const loaded = loadNativeFrom(
      "node",
      [],
      {
        napi: () => {
          attempted = true;
          return { ok: false, failure: failure("load") };
        },
        bunFfi: () => ({ ok: false, failure: failure("load") }),
        denoFfi: () => ({ ok: false, failure: failure("load") }),
        nodeFfi: () => ({ ok: false, failure: failure("load") }),
      },
      () => true,
    );

    expect(loaded).toEqual({
      ok: false,
      failure: { kind: "native-engine-load-failed", reason: "target" },
    });
    expect(attempted).toBe(false);
  });

  test.each([
    ["node", ["napi:a", "napi:b", "node-ffi:a", "node-ffi:b"]],
    ["bun", ["bun-ffi:a", "bun-ffi:b", "napi:a", "napi:b"]],
    ["deno", ["deno-ffi:a", "deno-ffi:b", "napi:a", "napi:b"]],
  ] as const)("tries %s loaders in contract order", (host, expected) => {
    const attempted: string[] = [];
    const unavailable = (name: string) => {
      attempted.push(name);
      return { ok: false as const, failure: failure("load") };
    };

    const loaded = loadNativeFrom(
      host,
      [
        { specifier: "a", url: new URL("file:///a") },
        { specifier: "b", url: new URL("file:///b") },
      ],
      {
        napi: (specifier) => unavailable(`napi:${specifier}`),
        bunFfi: (url) => unavailable(`bun-ffi:${url.pathname.slice(1)}`),
        denoFfi: (url) => unavailable(`deno-ffi:${url.pathname.slice(1)}`),
        nodeFfi: (url) => unavailable(`node-ffi:${url.pathname.slice(1)}`),
      },
      () => true,
    );

    expect(loaded).toEqual({ ok: false, failure: failure("load") });
    expect(attempted).toEqual(expected);
  });

  test("advances in order through load and capability failures", () => {
    const attempted: string[] = [];
    const closed: string[] = [];
    const candidate = (name: string, background: boolean) => ({
      name,
      background,
      close: () => {
        closed.push(name);
        return true;
      },
    });

    const selected = selectNativeCandidate(
      [
        () => {
          attempted.push("ffi");
          return { ok: false as const, failure: failure("load") };
        },
        () => {
          attempted.push("napi");
          return { ok: true as const, value: candidate("napi", false) };
        },
        () => {
          attempted.push("fallback-ffi");
          return { ok: true as const, value: candidate("fallback-ffi", true) };
        },
      ],
      (value) => value.background,
    );

    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.name).toBe("fallback-ffi");
    expect(attempted).toEqual(["ffi", "napi", "fallback-ffi"]);
    expect(closed).toEqual(["napi"]);
  });

  test("returns the last typed failure after every candidate fails", () => {
    expect(
      selectNativeCandidate(
        [
          () => ({ ok: false, failure: failure("load") }),
          () => ({ ok: false, failure: failure("exports") }),
        ],
        () => true,
      ),
    ).toEqual({ ok: false, failure: failure("exports") });
  });

  test("stops when declining a candidate cannot release it", () => {
    let laterAttempted = false;
    const selected = selectNativeCandidate(
      [
        () => ({
          ok: true,
          value: { name: "napi", background: false, close: (): boolean => false },
        }),
        () => {
          laterAttempted = true;
          return {
            ok: true,
            value: { name: "ffi", background: true, close: (): boolean => true },
          };
        },
      ],
      (value) => value.background,
    );

    expect(selected).toEqual({
      ok: false,
      failure: { kind: "native-engine-load-failed", reason: "teardown" },
    });
    expect(laterAttempted).toBe(false);
  });
});
