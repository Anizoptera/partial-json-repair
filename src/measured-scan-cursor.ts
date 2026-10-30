// SPDX-License-Identifier: Apache-2.0

import { ScanCursor } from "./scan-cursor";

/**
 * What a metrics scope reads from one stream's buffer. A separate object from the cursor, so the
 * scope can keep it without keeping the cursor and its buffer alive when a caller abandons a stream.
 * Quote recovery can restore released source directly into the window. Sample when scanning
 * resumes, before a recovered value can be delivered or the restored source released.
 */
export type BufferMetrics = { cleanups: number; peak: number; size: number };

/** A cursor used only by the opt-in metrics surface; the ordinary cursor has no observer branch. */
export class MeasuredScanCursor extends ScanCursor {
  readonly metrics: BufferMetrics = { cleanups: 0, peak: 0, size: 0 };

  override append(chunk: string): void {
    super.append(chunk);
    this.metrics.size = this.length;
    this.metrics.peak = Math.max(this.metrics.peak, this.length);
  }

  override drop(pins?: readonly (number | undefined)[]): void {
    const before = this.length;
    super.drop(pins);
    this.metrics.size = this.length;
    if (this.length < before) this.metrics.cleanups++;
  }

  override clear(): void {
    super.clear();
    this.metrics.size = 0;
  }

  override resumeAt(pos: number): void {
    super.resumeAt(pos);
    this.metrics.size = this.length;
    this.metrics.peak = Math.max(this.metrics.peak, this.length);
  }
}
