// SPDX-License-Identifier: Apache-2.0

/**
 * Turns the scanner's one coordinate — an absolute UTF-16 offset in the decoded source — into the
 * position a report states: which chunk, counted in that chunk's own unit.
 *
 * The scanner reads one decoded text and never learns where a chunk ended or whether it arrived as
 * bytes, and it should not: a second coordinate system inside the hot loop is a second mechanism.
 * So every place an offset becomes a `Position` asks a `PositionAt`, and the caller that fed the
 * source supplies one that knows the chunks.
 */
import type { LocationsFeature, Position } from "./types";

/**
 * The `locations` feature: pass it as `{ locations }` to add each value's source `span`. A value with
 * no code behind it, because span arithmetic is the position code every refusal already needs; it is
 * an import anyway so every optional feature has one spelling, and so `true` can be refused with a
 * message naming the import rather than accepted under one key and refused under the next.
 */
export const locations: LocationsFeature = /* @__PURE__ */ Object.freeze({
  feature: "locations",
});

export type PositionAt = (absolute: number) => Position;

/** The one-shot string case: the caller's own offsets, in the caller's own units. */
export const utf16At: PositionAt = (offset) => ({ offset, unit: "utf16" });

/**
 * A stretch of decoded text whose units map to source at a constant width: `width` source units
 * per UTF-16 code unit. A text chunk is one run of width 1; decoded bytes are runs of width 1, 2
 * and 3 for BMP characters, 2 for each half of a surrogate pair, and the bytes a malformed sequence
 * consumed for its one replacement character.
 */
type Run = {
  /** Absolute UTF-16 offset where the run begins. */
  readonly start: number;
  readonly chunk: number | undefined;
  readonly unit: "utf16" | "byte";
  /** Source offset of `start`, in `unit`, local to `chunk`. */
  readonly source: number;
  readonly width: number;
};

/**
 * Maps retained decoded ranges to caller chunks and units. The owner releases obsolete ranges;
 * fragment delivery preserves a few older anchors separately instead of keeping a whole value's
 * chunk history alive.
 */
export class PositionMap {
  runs: Run[] = [];

  add(
    start: number,
    chunk: number | undefined,
    unit: "utf16" | "byte",
    source: number,
    width: number,
  ): void {
    const last = this.runs[this.runs.length - 1];
    // Extend the last run when this continues it at the same width; otherwise a new run.
    if (
      last !== undefined &&
      last.chunk === chunk &&
      last.unit === unit &&
      last.width === width &&
      source === last.source + (start - last.start) * width
    ) {
      return;
    }
    this.runs.push({ start, chunk, unit, source, width });
  }

  at(absolute: number): Position {
    let low = 0;
    let high = this.runs.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.runs[mid] as Run).start <= absolute) low = mid;
      else high = mid - 1;
    }
    const run = this.runs[low];
    // Before any run — an empty source — there is only the origin.
    if (run === undefined) return { offset: absolute, unit: "utf16" };
    const offset = run.source + (absolute - run.start) * run.width;
    return run.chunk === undefined
      ? { offset, unit: run.unit }
      : { offset, unit: run.unit, chunk: run.chunk };
  }

  /** Bound as a `PositionAt` for the scanner. */
  readonly positionAt: PositionAt = (absolute) => this.at(absolute);
}

// A fragment can outlive its opening chunk while all its intervening source has been delivered.
// Keep only live anchors plus mappings for retained/replay source; never expose cached records.
export const fragmentPositions = (map: PositionMap) => {
  let pins = new Map<number, Position>();
  return {
    positionAt: (absolute: number): Position => {
      const pinned = pins.get(absolute);
      return pinned === undefined ? map.at(absolute) : { ...pinned };
    },
    retain(before: number, anchors: Iterable<number | undefined>): void {
      const next = new Map<number, Position>();
      for (const at of anchors) {
        if (at !== undefined && at < before && !next.has(at))
          next.set(at, pins.get(at) ?? map.at(at));
      }
      let keep = 0;
      while (keep + 1 < map.runs.length && (map.runs[keep + 1] as Run).start <= before) keep++;
      if (keep > 0) map.runs = map.runs.slice(keep);
      pins = next;
    },
    clear(): void {
      pins.clear();
    },
  };
};
