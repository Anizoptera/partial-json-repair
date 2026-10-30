// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { expect, it } from "vitest";
import { diagnostics, parse } from "../src/index";
import { LexicalWindow } from "../src/lexical-window";

it("does not build unrequested UTF-8 error contexts or bypass their budget", () => {
  const input = new Uint8Array([123, 34, 97, 34, 58, 34, 255, 255, 255, 34, 125]);
  // eslint-disable-next-line typescript/unbound-method -- Preserve the method for explicit receiver calls and restoration.
  const locate = LexicalWindow.prototype.locate;
  let contexts = 0;
  // Count real context construction, not elapsed time: reports are optional even for bad bytes.
  LexicalWindow.prototype.locate = function (...args) {
    if (args[0] === "invalid-utf8") contexts++;
    return locate.call(this, ...args);
  };
  try {
    expect(parse(input)).toEqual({ ok: true, value: { a: "���" }, complete: true });
    expect(contexts).toBe(0);
    const stopped = parse(input, { maxErrors: 1 });
    expect(stopped).toMatchObject({
      ok: false,
      failure: {
        kind: "limit-reached",
        resource: "errors",
        at: { offset: 6, unit: "byte" },
        recovered: { complete: false },
      },
    });
    expect(contexts).toBe(0);
    const reported = parse(input, { diagnostics });
    expect(reported).toMatchObject({ ok: true, value: { a: "���" } });
    expect(
      reported.diagnostics.errors.map((error) => [error.kind, error.at.offset, error.path]),
    ).toEqual([
      ["invalid-utf8", 6, ["a"]],
      ["invalid-utf8", 7, ["a"]],
      ["invalid-utf8", 8, ["a"]],
    ]);
    expect(contexts).toBe(3);
    // Requesting explanations must not change where the same error budget stops recovery.
    const { diagnostics: report, ...reportedStop } = parse(input, { maxErrors: 1, diagnostics });
    expect(report.counts.errors).toBe(1);
    expect(stopped).toEqual(reportedStop);
  } finally {
    LexicalWindow.prototype.locate = locate;
  }
});
