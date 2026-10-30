/**
 * The estimator is the one kernel behind every number this project publishes, so a defect in it is
 * not a wrong test — it is a wrong table in `docs/PRIOR-ART.md` and a wrong row in `baseline.json`,
 * with nothing anywhere to contradict it.
 *
 * Timing is deliberately absent from every case here. What is asserted is the arithmetic that turns
 * samples into a printed figure, which is pure, instant and exactly where a silent lie can live: a
 * rounding that claims precision the samples never earned.
 */
import { describe, expect, it } from "vitest";

import { combine, estimate, stable } from "../bench/estimator";

/** Count actual subject calls with patience disabled, varying only the requested stopping bound. */
const callsUnder = (maxBatches: number, budgetMs = Number.POSITIVE_INFINITY): number => {
  let calls = 0;
  estimate(
    () => {
      calls++;
    },
    { minBatchMs: 0, maxBatches, patience: Number.MAX_SAFE_INTEGER, budgetMs },
  );
  return calls;
};

describe("estimate", () => {
  /**
   * A subject slower than the batch floor satisfies calibration on its FIRST call, so the loop that
   * grows `k` cannot double as warm-up for it. MEASURED on a damaged document: 15 warm-up calls read
   * 25% slower than 40, and a harness measures each subject once per process and never sees the
   * second, warm reading.
   *
   * `minBatchMs: 0` reproduces that shape with no clock involved at all — calibration returns on the
   * first call whatever the subject costs. The assertion is that warm-up does not scale with
   * `batches`; the exact floor is the estimator's to choose.
   */
  it("warms far past calibration when calibration returns immediately", () => {
    let calls = 0;
    estimate(
      () => {
        calls++;
      },
      { minBatchMs: 0, maxBatches: 1 },
    );
    expect(calls).toBeGreaterThan(50);
  });

  /**
   * Asserted as a DIFFERENCE between two caps, which pins the cap exactly without this test knowing
   * the warm-up floor — a constant it has no business restating.
   */
  it("times exactly as many batches as the cap allows", () => {
    expect(callsUnder(11) - callsUnder(1)).toBe(10);
  });

  it("stops after the first timed batch when its time budget has expired", () => {
    // A positive subnormal budget rounds the deadline to its starting clock reading. Count work,
    // not elapsed test time: host descheduling cannot establish an estimator budget violation.
    expect(callsUnder(1_000_000, Number.MIN_VALUE)).toBe(callsUnder(1, Number.MIN_VALUE));
  });
});

/** Significant digits in a printed figure, read off the exponential form so place-holding and
 *  trailing zeros cannot be miscounted. `0.030` and `12000` both carry two. */
const significantDigits = (s: string): number =>
  (Number(s).toExponential().split("e")[0] ?? "")
    .replace("-", "")
    .replace(".", "")
    .replace(/0+$/u, "").length;

/** A geometric sweep across four decades, so every rung and every gap between rungs is exercised. */
const SWEEP = Array.from({ length: 400 }, (_, i) => 0.005 * 1.02 ** i);

describe("stable", () => {
  /**
   * The whole output set is the ladder, and that is what makes a figure stable: a value drifting
   * inside one rung's catchment renders identically, so no diff is produced. Idempotence over a
   * dense sweep says exactly that, and it fails the moment a value can land off-ladder.
   */
  it("only ever emits ladder rungs", () => {
    for (const value of SWEEP) {
      const once = stable(value);
      expect(stable(Number(once))).toBe(once);
    }
  });

  /**
   * Both bounds, because the upper one alone passes for any FINER ladder — so on its own it cannot
   * catch someone putting back the precision these tables were deliberately stripped of.
   *
   * 1.6x steps, so a value landing midway between rungs moves half that in log terms: 26% at most,
   * and a dense sweep must actually reach it.
   */
  it("rounds to a magnitude: at most 26% off, and coarse enough to prove it", () => {
    const offBy = SWEEP.map((value) => Math.abs(Number(stable(value)) - value) / value);
    expect(Math.max(...offBy)).toBeLessThan(0.27);
    expect(Math.max(...offBy)).toBeGreaterThan(0.2);
  });

  /** Every rung is exactly two figures, so no rendering can suggest a precision the ladder lacks. */
  it("never prints more than two significant digits", () => {
    for (const value of SWEEP) {
      expect(significantDigits(stable(value))).toBeLessThanOrEqual(2);
    }
  });

  /**
   * Nearest is measured in LOG space. 5.1 tells the two rules apart: by subtraction it is nearer 4
   * (1.1 against 1.2), by ratio nearer 6.3 (1.24 against 1.28). Ratio is what a reader of these
   * figures compares; a linear rule would round values just above each gap's geometric midpoint
   * down to the lower rung.
   */
  it("picks the nearest rung by ratio, not by subtraction", () => {
    expect(stable(5.1)).toBe("6.3");
  });

  /**
   * 1 must survive every re-cut of the ladder, because a whole column of `baseline.json` is the
   * reference divided by itself. A ladder that lost it would render every reference cell as
   * something other than 1.0 and read as though the denominator had moved.
   */
  it("renders the reference exactly", () => {
    expect(stable(1)).toBe("1.0");
  });

  it("survives values a measurement should never produce", () => {
    expect(stable(0)).toBe("0");
    expect(stable(Number.NaN)).toBe("NaN");
  });
});

describe("combine", () => {
  /** The median resists one unlucky process; a mean would let it drag the published figure. */
  it("takes the median, not the mean", () => {
    expect(combine([1, 1, 1, 1, 100]).value).toBe(1);
  });

  it("averages the middle pair on an even count", () => {
    expect(combine([1, 2, 4, 5]).value).toBe(3);
  });

  /**
   * One process cannot produce a spread. Reporting zero is right only because a single sample is
   * refused elsewhere; what must never happen is a small non-zero bar that looks like evidence.
   */
  it("reports no bar for a single sample", () => {
    expect(combine([42]).error).toBe(0);
  });

  it("widens the bar with the spread", () => {
    expect(combine([1, 2, 3, 4, 5]).error).toBeGreaterThan(combine([2, 2.5, 3, 3.5, 4]).error);
  });
});
