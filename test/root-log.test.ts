// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { expect, it } from "vitest";
import { RootLog } from "../src/root-log";
import { diagnostics } from "../src/index";
import { resolveOptions } from "../src/options";
import { collectScan, createScanner } from "../src/scan";

it("releases delivered records and preserves absolute positions", () => {
  const log = new RootLog<{ valueIndex: number; payload: object }>();
  const roots = [0, 1, 2].map((valueIndex) => ({ valueIndex, payload: {} }));
  for (const root of roots) log.push(root);

  // Storage must release the payload whether or not this prefix triggers compaction.
  let compacted = log.releaseBefore(1);
  expect(log.items).not.toContain(roots[0]);
  expect(log.at(0)).toBeUndefined();
  expect(log.start).toBe(1);
  expect(log.end).toBe(3);
  expect(log.at(1)).toBe(roots[1]);
  expect(log.map((root) => root.valueIndex)).toEqual([1, 2]);
  expect(roots.map((root) => root.valueIndex)).toEqual([0, 1, 2]);

  compacted += log.releaseBefore(2);
  expect(log.start).toBe(2);
  expect(log.end).toBe(3);
  expect(log.at(2)).toBe(roots[2]);
  compacted += log.releaseBefore(3);
  expect(log.start).toBe(3);
  expect(log.end).toBe(3);
  expect(log.map((root) => root.valueIndex)).toEqual([]);
  expect(compacted).toBe(roots.length);
});

it("releases reports independently of root compaction and preserves unread cursors", () => {
  const scanner = createScanner(resolveOptions({ diagnostics }));
  scanner.supply("{a:1} {b:2} {c:3}\n");
  for (let index = 0; index < 3; index++) expect(scanner.pull()?.root).toBeDefined();
  expect(scanner.repairs).toHaveLength(3);
  const firstReport = scanner.repairs?.[0];
  const cursor = { repair: 1, error: 0 };

  // The cursor must still address the next report under any compaction policy.
  scanner.releaseBefore(1, cursor);
  expect(scanner.repairs).not.toContain(firstReport);
  expect(scanner.repairs?.[cursor.repair]?.valueIndex).toBe(1);
  cursor.repair++;
  scanner.releaseBefore(2, cursor);
  expect(scanner.repairs?.[cursor.repair]?.valueIndex).toBe(2);

  const ended = scanner.end();
  // Collection must begin at the remaining root and retain only its report.
  const result = collectScan(scanner, ended);
  expect(result.first).toBe(2);
  expect(result.values).toEqual([{ c: 3 }]);
  expect(result.repairs.map((repair) => repair.valueIndex)).toEqual([2]);
});
