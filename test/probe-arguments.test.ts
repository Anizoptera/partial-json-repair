// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { probeArguments } from "../scripts/probe-arguments";

const spec = { usage: "probe [--json <file>] [--keep]", flags: ["--keep"], options: ["--json"] };

it("refuses any argument the probe does not declare, before it can start the full matrix", () => {
  for (const unknown of ["--help", "--jsn", "-k", "receipt.json"])
    expect(() => probeArguments([unknown], spec)).toThrow(`unknown argument ${unknown}`);
  // A stray value after a flag is not silently dropped either.
  expect(() => probeArguments(["--keep", "x"], spec)).toThrow("unknown argument x");
});

it("refuses a missing option value without swallowing the following flag", () => {
  for (const args of [["--json"], ["--json", "--keep"]])
    expect(() => probeArguments(args, spec)).toThrow("--json requires a value");
  const parsed = probeArguments(["--json", "receipt.json", "--keep"], spec);
  expect(parsed.option("--json")).toBe("receipt.json");
  expect(parsed.flag("--keep")).toBe(true);
  expect(probeArguments([], spec).option("--json")).toBeUndefined();
});
