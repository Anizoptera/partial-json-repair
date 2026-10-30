// SPDX-License-Identifier: Apache-2.0

import type { AsyncWorkload } from "./async-cases";
import { canonicalDigest } from "./async-oracle";
import { concurrentResults } from "./async-sample";

export type ConcurrencyMetrics = {
  readonly concurrency: number;
  readonly fastestMilliseconds: number;
  readonly lowestCpuMilliseconds: number;
  readonly lowestPeakRssDeltaBytes: number;
  readonly highestPeakRssDeltaBytes: number;
  readonly lowestRetainedRssDeltaBytes: number;
  readonly longestHostGapMilliseconds: number;
};

const collectGarbage = (): void => {
  const bun = (globalThis as { Bun?: { gc?(force: boolean): void } }).Bun;
  bun?.gc?.(true);
};

export const measureConcurrencySample = async (
  workload: AsyncWorkload,
  expected: () => string,
  concurrency: number,
  run: () => Promise<unknown>,
): Promise<ConcurrencyMetrics> => {
  collectGarbage();
  const baselineRss = process.memoryUsage.rss();
  let peakRss = baselineRss;
  let previousTurn: number;
  let longestHostGapMilliseconds = 0;
  const cpuStart = process.cpuUsage();
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    const now = performance.now();
    longestHostGapMilliseconds = Math.max(longestHostGapMilliseconds, now - previousTurn);
    previousTurn = now;
  }, 0);
  let started: number;
  let settled: number;
  let outcomes: readonly unknown[];
  try {
    // Match the call interval; setup and post-call counter reads are observer work.
    started = performance.now();
    previousTurn = started;
    outcomes = await concurrentResults(concurrency, run);
    settled = performance.now();
    longestHostGapMilliseconds = Math.max(longestHostGapMilliseconds, settled - previousTurn);
  } finally {
    clearInterval(timer);
  }
  const fastestMilliseconds = settled - started;
  const cpu = process.cpuUsage(cpuStart);
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  // The caller still owns these results; oracle construction and validation are not route storage.
  collectGarbage();
  const retainedRss = process.memoryUsage.rss();
  peakRss = Math.max(peakRss, retainedRss);
  const expectedResult = expected();
  for (const outcome of outcomes)
    if (canonicalDigest(outcome) !== expectedResult)
      throw new Error(`${workload.id}: concurrent operation disagreed with the public result`);
  return {
    concurrency,
    fastestMilliseconds,
    lowestCpuMilliseconds: (cpu.user + cpu.system) / 1000,
    lowestPeakRssDeltaBytes: Math.max(0, peakRss - baselineRss),
    highestPeakRssDeltaBytes: Math.max(0, peakRss - baselineRss),
    lowestRetainedRssDeltaBytes: Math.max(0, retainedRss - baselineRss),
    longestHostGapMilliseconds,
  };
};
