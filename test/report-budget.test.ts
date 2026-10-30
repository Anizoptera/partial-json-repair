// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createStreamParser, parseMany, diagnostics } from "../src/index";

/** A root whose report overflows the default cap: one `trailing-comma` repair per member. */
const ROOT = `[${"[1,],".repeat(1500)}]`;
const TEXT = `${ROOT}\n${ROOT}\n${ROOT}`;

const shape = (report: { repairs: readonly unknown[]; entriesComplete: boolean } | undefined) => [
  report?.repairs.length,
  report?.entriesComplete,
];

describe("maxEntries bounds each report, never the call", () => {
  // `maxEntries` "caps the entries one report retains" (docs/API.md). A cap shared by the call
  // left the second and third roots of a stream or `parseMany` with empty reports.
  const expected = [
    [1000, false],
    [1000, false],
    [1000, false],
  ];

  it("in parseMany", () => {
    const reports = [...parseMany(TEXT, { diagnostics })].map((r) => shape(r.diagnostics));
    expect(reports).toEqual(expected);
  });

  // A per-report cap leaves each unread report up to `maxEntries` entries, so the entries count
  // toward `maxRetained` with the result they belong to (HLD: input buffering alone does not bound
  // retained reports). This root's value is a few units and its report forty entries.
  it("counts an unread report's entries toward maxRetained", () => {
    const root = `{"a":[${"/*c*/".repeat(40)}1]}`;
    const sp = createStreamParser({ diagnostics, maxRetained: 30 });
    // Settled by the space, so the first feed completes it and leaves it unread.
    sp.feed(`${root} `);
    const items = [...sp.feed(" ")];
    expect(items.at(-1)).toMatchObject({ failure: { kind: "limit-reached", resource: "unread" } });
    // Control: the same unread root without its report fits, so the report is what crossed it.
    const plain = createStreamParser({ maxRetained: 30 });
    plain.feed(`${root} `);
    expect([...plain.feed(" ")]).toMatchObject([{ ok: true, value: { a: [1] } }]);
  });

  it("in a stream", () => {
    const sp = createStreamParser({ diagnostics });
    const reports: unknown[] = [];
    for (const item of [...sp.feed(TEXT), ...sp.end()])
      if (!("kind" in item)) reports.push(shape(item.diagnostics));
    expect(reports).toEqual(expected);
  });
});
