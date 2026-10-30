// SPDX-License-Identifier: Apache-2.0

import type { Position } from "./types";
import type { PositionAt } from "./positions";
import { widthOf } from "./utf8";

const CHECKPOINT = 4096;

/**
 * Byte positions for whole byte input, which keeps its decoded text for the whole call. A unit's
 * width follows from the unit (`widthOf`), so only anchors where the text cannot predict the bytes
 * are stored (a decoder in `derived` mode emits exactly those), and a query sums widths forward from
 * the nearest anchor or checkpoint. Checkpoints, one per `CHECKPOINT` units, are filled in order as
 * queries reach them, so each unit's width is read at most once on the way and a query reads at most
 * `CHECKPOINT` more. Storage is the anchors and checkpoints, never a record per width change.
 */
export class DerivedBytePositions {
  private starts: number[] = [];
  private bytes: number[] = [];
  private widths: number[] = [];
  /** Byte offset of unit `k * CHECKPOINT`, for each `k` reached so far. */
  private checkpoints: number[] = [];

  /** Decoded text between two absolute offsets; set by the owner once the text exists. */
  read: ((from: number, until: number) => string) | undefined;

  anchor(start: number, byte: number, width: number): void {
    this.starts.push(start);
    this.bytes.push(byte);
    this.widths.push(width);
  }

  release(): void {
    this.read = undefined;
    this.starts = this.bytes = this.widths = this.checkpoints = [];
  }

  /** Index of the last anchor at or before `absolute`; the first anchor is at the origin. */
  private anchorAt(absolute: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] as number) <= absolute) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /**
   * The byte offset of `absolute`: from its anchor, or from the latest filled checkpoint when that
   * lies after the anchor (an anchor at the checkpoint's own unit wins: its width may be irregular).
   */
  private sum(absolute: number): number {
    const anchor = this.anchorAt(absolute);
    const start = this.starts[anchor] as number;
    if (absolute === start) return this.bytes[anchor] as number;
    let from = start + 1;
    let byte = (this.bytes[anchor] as number) + (this.widths[anchor] as number);
    const k = Math.min(Math.floor(absolute / CHECKPOINT), this.checkpoints.length - 1);
    if (k >= 0 && k * CHECKPOINT > start) {
      from = k * CHECKPOINT;
      byte = this.checkpoints[k] as number;
    }
    const text = this.read?.(from, absolute) ?? "";
    for (let i = 0; i < text.length; i++) byte += widthOf(text.charCodeAt(i));
    return byte;
  }

  at(absolute: number): Position {
    // Before any anchor (an empty source) there is only the origin, as in `PositionMap`.
    if (this.starts.length === 0) return { offset: absolute, unit: "utf16" };
    // Fill checkpoints up to this unit in order; each reads one block from the one before it.
    for (let k = this.checkpoints.length; k * CHECKPOINT <= absolute; k++)
      this.checkpoints[k] = this.sum(k * CHECKPOINT);
    return { offset: this.sum(absolute), unit: "byte" };
  }

  /** Bound as a `PositionAt` for the scanner. */
  readonly positionAt: PositionAt = (absolute) => this.at(absolute);
}
