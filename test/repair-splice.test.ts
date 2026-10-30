// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { describe, expect, it } from "vitest";
import { spliceSteps } from "../src/repair-splice";

type Span = { start: number; end: number; until: number };
const span = (start: number, end: number, until = Infinity): Span => ({ start, end, until });
const flat = Array.from({ length: 64 }, (_, index) => span(index * 8, index * 8 + 6));
const shapes: Record<string, Span[]> = {
  flat,
  nested: flat.flatMap(({ start, end }) => [span(start, end), span(start + 1, end - 1)]),
  deep: Array.from({ length: 64 }, (_, index) => span(index, 512 - index)),
  "shared end": Array.from({ length: 64 }, (_, index) => span(index, 510, 256 - index)),
  "mixed closers": Array.from({ length: 64 }, (_, index) =>
    span(index, 510, index % 2 === 0 ? 256 - index / 2 : Math.floor(index / 2)),
  ),
  crossing: Array.from({ length: 32 }, (_, index) => [
    span(index * 8, index * 8 + 16),
    span(index * 8 + 4, index * 8 + 12),
  ]).flat(),
  reversed: flat.toReversed(),
  empty: flat.flatMap(({ start, end }) => [span(start, end), span(end, end, 0)]),
};

describe("repair span projection", () => {
  it.each([
    ["odd runs", [4, 6, 8, 2, 4, 7, 0, 2, 4, 10, 10]],
    ["even runs", [6, 8, 10, 4, 6, 9, 2, 4, 8, 0, 2, 6, 10]],
  ] as const)("keeps equal-offset insertions stable through %s", (_name, positions) => {
    const source = "abcdefghij";
    const edits = positions.map((start, index) => ({
      start,
      end: start,
      text: String.fromCharCode(65 + index),
    }));
    // Equal offsets cross run boundaries; ties within one run cannot expose an unstable merge.
    // Group by source position without sorting or merging: recording order breaks ties.
    const expected = Array.from(
      { length: source.length + 1 },
      (_, at) =>
        edits
          .filter((edit) => edit.start === at)
          .map((edit) => edit.text)
          .join("") + (source[at] ?? ""),
    ).join("");
    const steps = spliceSteps(source, edits, [span(0, source.length)], 1);
    try {
      let step = steps.next();
      expect(step.done).toBe(false);
      while (step.done !== true) step = steps.next();
      expect(step.value).toBe(expected);
    } finally {
      steps.return("");
    }
  });

  it.each(Object.keys(shapes))("matches independent per-span edits for %s boundaries", (name) => {
    // Enough edits make production choose its indexed sweep. The oracle deliberately applies
    // every edit to each original span independently, so it shares no ordering implementation.
    const edits = Array.from({ length: 256 }, (_, index) => ({
      start: index * 2,
      end: index * 2,
      text: "x",
    }));
    const originals = shapes[name] as Span[];
    const expected = originals.map((original) => {
      const projected = { ...original };
      for (const edit of edits) {
        if (edit.end <= original.start) {
          projected.start++;
          projected.end++;
        } else if (
          edit.end < original.end ||
          (edit.end === original.end && edit.start / 2 < original.until)
        ) {
          projected.end++;
        }
      }
      return projected;
    });
    const projected = originals.map(({ start, end, until }) => ({ start, end, until }));
    const steps = spliceSteps("_".repeat(512), edits, projected, 8);
    try {
      let step = steps.next();
      expect(step.done).toBe(false);
      while (step.done !== true) step = steps.next();
      expect(step.value).toBe("x__".repeat(256));
      expect(projected).toEqual(expected);
    } finally {
      steps.return("");
    }
  });
});
