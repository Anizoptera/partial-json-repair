// SPDX-License-Identifier: Apache-2.0

/**
 * The speed measurement as a browser page or a workerd isolate runs it, bundled by `web.ts`. The
 * same documents, adapters and estimator as `compare.ts`, so a browser row compares with a Node or
 * Bun row; only the host differs (HLD P7: each runtime is measured on its own).
 */
import type { Emitted } from "./speed-docs.ts";
import { PORTABLE_LIBS } from "./libs.ts";
import { speed } from "./speed-docs.ts";

/**
 * The smallest step `performance.now` takes here. Hosts coarsen it differently (a cross-origin
 * isolated page: 5-20 µs; workerd: 1 ms), and a batch shorter than a few hundred steps reads the
 * clock rather than the code.
 */
const clockStep = (): number => {
  let step = Infinity;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    let t1 = t0;
    while (t1 === t0) t1 = performance.now();
    step = Math.min(step, t1 - t0);
  }
  return step;
};

/** Every library's rate per case on this host, as the `Emitted` record `baseline.ts` reads. */
export const measure = (runtime: string): Emitted => {
  // The estimator's defaults assume a microsecond clock; 25 steps keep one batch's rounding near 4%,
  // far inside the ladder's 26% rung, and the budget grows with the batch so it still buys several.
  const minBatchMs = Math.max(0.5, 25 * clockStep());
  const rates = speed(PORTABLE_LIBS, { minBatchMs, budgetMs: Math.max(200, 10 * minBatchMs) });
  return { runtime, rates: Object.fromEntries(rates) };
};
