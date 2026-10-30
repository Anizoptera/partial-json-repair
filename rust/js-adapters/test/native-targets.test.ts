// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { installedNativePackages } from "../src/native-route";
import { nativeTargetsForHost } from "../src/native-targets";

describe("native target selection", () => {
  test("does not inspect libc outside Linux", () => {
    expect(
      installedNativePackages({
        arch: "x64",
        platform: "win32",
        report: {
          getReport: () => {
            throw new Error("non-Linux target read a process report");
          },
        },
      }),
    ).toEqual(["partial-json-repair-native-win32-x64"]);
  });

  test("keeps both Linux libc candidates when the runtime cannot identify libc", () => {
    expect(nativeTargetsForHost("linux", "x64", undefined).map(({ id }) => id)).toEqual([
      "linux-x64-gnu",
      "linux-x64-musl",
    ]);
  });

  test("normalizes Deno's Windows and architecture names", () => {
    expect(nativeTargetsForHost("windows", "x86_64", undefined).map(({ id }) => id)).toEqual([
      "win32-x64",
    ]);
    expect(nativeTargetsForHost("linux", "aarch64", true).map(({ id }) => id)).toEqual([
      "linux-arm64-gnu",
    ]);
  });
});
