// SPDX-License-Identifier: Apache-2.0

/**
 * How many times longer `slow` takes than `fast`: the best of `rounds` interleaved timings of each.
 *
 * Ratios reduce shared machine effects; independent scheduling and collection pauses can still skew
 * them. Prefer a work counter when it reaches the defect; use timings for costs hidden in native
 * operations. Interleaving reduces one-sided noise but does not prove its absence.
 */
export const costRatio = (slow: () => unknown, fast: () => unknown, rounds = 3): number => {
  // Warm both routes to reduce first-touch and compilation noise; measure startup separately.
  fast();
  slow();
  let slowBest = Infinity;
  let fastBest = Infinity;
  for (let round = 0; round < rounds; round++) {
    let start = performance.now();
    fast();
    fastBest = Math.min(fastBest, performance.now() - start);
    start = performance.now();
    slow();
    slowBest = Math.min(slowBest, performance.now() - start);
  }
  return slowBest / fastBest;
};
