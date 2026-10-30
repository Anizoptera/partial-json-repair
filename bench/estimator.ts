// SPDX-License-Identifier: Apache-2.0

/**
 * How a timing becomes a number a reader may act on, and how many of its digits are real.
 *
 * Two levels, and the split is the whole point.
 *
 * **Inside one process**, {@link estimate} takes the MINIMUM of many timed batches. Everything else
 * on the machine can only ADD time, so the minimum converges on what the code costs uncontended
 * while a mean tracks how busy the box was. Measured here: on a loaded machine the median of
 * repeated runs spread 2x while the minimum held to a few percent.
 *
 * **Across processes**, {@link combine} takes the median of several such estimates and their spread
 * becomes the error bar. This level is not optional and cannot be faked by looping harder, which is
 * the trap this file exists to close. Batches within one process share a JIT profile, a heap layout
 * and a GC phase, so they are not independent samples of the quantity anyone wants to reproduce.
 * MEASURED: five bun processes reported one parser at 360, 368, 370, 380 and 384 ns/op while each
 * process put its own error at ±0.5% — an error bar six times too small, and a rounding built on it
 * printed five different numbers with total confidence. This is why JMH forks the JVM rather than
 * adding iterations, and the reason is the same here.
 *
 * **There is a reproducibility ceiling and no estimator choice moves it** — a few percent on a fast
 * operation, roughly ten on a slow one, measured on a desktop carrying other work. Five paired
 * processes on both runtimes put min-of-samples and median-of-samples within 1-3% of each other,
 * smaller than the noise in that comparison, and one node process ran EVERY library low together. So
 * what varies is the machine, not the code. Two consequences follow, and they are the API: report
 * RATIOS against a reference measured in the same process, because a machine that slows moves both
 * sides; and publish on a FIXED ladder COARSER than the instrument, which is {@link LADDER}'s job.
 * These figures answer "what order is this" and nothing finer, so a cell moves when the code did
 * rather than on every re-run.
 */

/** A quantity and the precision it has actually earned. */
export type Estimate = {
  readonly value: number;
  /** Three deviations of the cross-process samples. Digits finer than this are noise. */
  readonly error: number;
};

/**
 * The next batch size after a batch of `k` read `ms`.
 *
 * Aims straight at the target, doubling at minimum, so a function far below the clock's resolution
 * does not spend dozens of rounds creeping up on it. A reading of ZERO only says the batch took less
 * than one clock step, so it doubles instead of aiming. On a 1 ms clock (workerd) aiming from an
 * assumed 0.01 ms multiplies `k` by 2500 at once: a batch of the 32 KB `JSON.parse` reference then
 * lasts ~200 ms, the budget has room for one timed batch, and the minimum has one sample.
 */
const grow = (k: number, ms: number, minBatchMs: number): number =>
  ms === 0 ? k * 2 : Math.max(k * 2, Math.ceil((k * minBatchMs) / Math.max(ms, 0.01)));

/**
 * Iterations per timed batch, grown until a batch clears `minBatchMs`.
 *
 * Calibrated rather than passed in because the rivals measured here span more than an order of
 * magnitude: one fixed count that keeps the slowest above the clock's resolution makes the fastest
 * run for seconds, and one that suits the fastest reads the timer rather than the code on the
 * slowest.
 */
const calibrate = (fn: () => void, minBatchMs: number): number => {
  let k = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < k; i++) fn();
    const ms = performance.now() - t0;
    if (ms >= minBatchMs) return k;
    k = grow(k, ms, minBatchMs);
  }
};

export type EstimateOptions = {
  /** Lower bound on one batch. Below this the clock's own resolution is what gets read. */
  readonly minBatchMs?: number;
  /** Stop once the running minimum has survived this many batches unbeaten. */
  readonly patience?: number;
  /** Hard cap on timed batches. */
  readonly maxBatches?: number;
  /** Wall-clock cap on the timed phase — a runaway guard, not the usual reason to stop. */
  readonly budgetMs?: number;
};

/**
 * MANY SHORT batches, and as many of them as CONVERGENCE asks for rather than a fixed count.
 *
 * The minimum is only as good as the number of chances it had at an uncontended run. A 5 ms floor
 * gives a slow parser one or two calls per batch, so 15 batches buy 15 chances; the same wall-clock
 * spent on 0.5 ms batches buys fifty. MEASURED across six processes on a damaged document: the long
 * shape spread 11.4% and cost 139 ms, the short shape 8.9% at 84 ms. Half a millisecond still sits
 * ~500x above `performance.now`'s resolution on both runtimes, so nothing is traded for it.
 *
 * **How many chances is not a constant, because how many a subject NEEDS is not.** `patience` stops
 * once the running minimum has survived that many batches unbeaten, which is a statement about the
 * subject rather than about the harness. MEASURED, 21 paired processes, both estimators timing the
 * same subject in the same process so machine state is shared: on a damaged document a fixed 51
 * batches read 658 ns/B against 519 — a 27% BIAS, not noise, because 51 chances never found the
 * uncontended run — and its cross-process spread was 27.7% against 4.6%. The two undamaged subjects
 * moved the same way and less sharply (8.0→5.2%, 12.4→8.6%).
 *
 * The trade, stated: a fast subject now costs 1.5-2x more wall-clock per estimate, since patience
 * keeps buying chances where a fixed count stopped. `budgetMs` caps that, and is a runaway guard
 * only — a fixed count had no bound at all, so a pathologically slow subject was unbounded work.
 *
 * The instrument's own limit: at FIVE processes this comparison could not be made. Two such runs
 * ranked the estimators oppositely, and one of them was nearly written down as a result. The 27%
 * bias is decisive because it is a first moment; the spread figures are a second moment carrying
 * roughly 16% of their own value even at 21 processes.
 */
const DEFAULTS = { minBatchMs: 0.5, patience: 25, maxBatches: 200, budgetMs: 200 } as const;

/**
 * Invocations before the clock starts, floored — a tiering JIT counts CALLS, and `calibrate` is
 * measured in milliseconds.
 *
 * The two disagree exactly where it hurts: a subject slower than `minBatchMs` satisfies calibration
 * on its FIRST call, so without a floor it would be timed after two invocations. MEASURED on a
 * damaged 32 KB document, one level per fresh process: 0, 5 and 15 warm-up calls all read ~660 ns/B
 * while 40, 100, 300 and 1000 all read ~520-550 — a 25% pessimism that repeats in every process,
 * because a harness measures each subject once and never gets the second, warm reading. The same
 * curve on node/V8 is FLAT, so this cost is real on one engine and invisible on the other, which is
 * how it survives a sanity check on the wrong runtime. The control is the other end of the same
 * measurement: a subject fast enough for calibration to run it thousands of times shows no effect on
 * either engine, which is what says the cause is invocation count rather than elapsed time.
 *
 * 100 rather than the ~40 where the knee sat: the margin is nearly free, since it binds only on
 * subjects where `k` is small.
 *
 * **The floor is honoured only for subjects cheaper than `budgetMs / 2 / WARMUP` per call** — 1 ms
 * at the defaults — because warm-up may spend at most half the budget (see {@link estimate}). A
 * subject above `budgetMs / 2 / 40` (2.5 ms) gets fewer calls than the knee above, and one slower
 * than `budgetMs / 2` (100 ms), such as a re-parsing rival's 1 MB streaming session in 16-character
 * chunks (`prior-art/stream.ts`), is timed after two invocations: the case this floor exists to
 * prevent. They do carry the Bun pessimism: a damaged 600 KB `parse` (~20 ms a call) read 32-36 ns/B
 * at the default budget against 23-30 after 40 or more warm-up calls (bun 1.4.2, M4 Max at load
 * 16-28, three or four fresh processes each, read 2026-10-06), so on Bun those cells read about 25%
 * slow, one rung at most. Honouring the floor for them would cost 40 calls each, tens of seconds per
 * 1 MB streaming cell and fork.
 */
const WARMUP = 100;

/**
 * One process's estimate of `fn`, in nanoseconds per call.
 *
 * Alone it carries no error bar — its own batch spread describes contention during this process, not
 * the reproducibility of the number. Pass several processes' results to {@link combine} for that.
 */
export const estimate = (fn: () => void, options: EstimateOptions = {}): number => {
  const { minBatchMs, patience, maxBatches, budgetMs } = { ...DEFAULTS, ...options };
  const k = calibrate(fn, minBatchMs);
  const start = performance.now();
  // Warm-up shares the budget and may take at most half of it. A COUNT of invocations is the right
  // floor (see {@link WARMUP}) but is unbounded work on its own: 100 calls of a 5 ms parser is half
  // a second per estimate, before a single batch is timed. Half, not all, so a subject slow enough
  // to spend the budget warming still leaves something to measure. Reading the clock here cannot
  // affect accuracy — nothing in this loop is timed.
  const warmUntil = start + budgetMs / 2;
  for (let i = 0, warm = Math.max(k, WARMUP); i < warm && performance.now() < warmUntil; i++) fn();
  const deadline = start + budgetMs;
  let best = Infinity;
  let unbeaten = 0;
  for (let b = 0; b < maxBatches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < k; i++) fn();
    const ms = performance.now() - t0;
    if (ms < best) {
      best = ms;
      unbeaten = 0;
    } else if (++unbeaten >= patience) break;
    if (performance.now() > deadline) break;
  }
  return (best * 1e6) / k;
};

/**
 * {@link estimate} for a subject whose only API is asynchronous, in nanoseconds per call.
 *
 * The same calibration, warm-up floor, patience and budget, each call awaited before the next. A
 * rival such as `jsonriver` consumes an `AsyncIterable` and cannot be driven synchronously, so its
 * microtask hops ARE part of its natural cost; timing a synchronous imitation would measure a
 * library nobody can call. Kept beside {@link estimate} so a change to the sequence reaches both.
 */
export const estimateAsync = async (
  fn: () => Promise<unknown>,
  options: EstimateOptions = {},
): Promise<number> => {
  const { minBatchMs, patience, maxBatches, budgetMs } = { ...DEFAULTS, ...options };
  let k = 1;
  for (;;) {
    const t0 = performance.now();
    // Serial by definition: a batch times calls one after another, never overlapping.
    // oxlint-disable-next-line eslint/no-await-in-loop
    for (let i = 0; i < k; i++) await fn();
    const ms = performance.now() - t0;
    if (ms >= minBatchMs) break;
    k = grow(k, ms, minBatchMs);
  }
  const start = performance.now();
  const warmUntil = start + budgetMs / 2;
  for (let i = 0, warm = Math.max(k, WARMUP); i < warm && performance.now() < warmUntil; i++)
    // oxlint-disable-next-line eslint/no-await-in-loop
    await fn();
  const deadline = start + budgetMs;
  let best = Infinity;
  let unbeaten = 0;
  for (let b = 0; b < maxBatches; b++) {
    const t0 = performance.now();
    // oxlint-disable-next-line eslint/no-await-in-loop
    for (let i = 0; i < k; i++) await fn();
    const ms = performance.now() - t0;
    if (ms < best) {
      best = ms;
      unbeaten = 0;
    } else if (++unbeaten >= patience) break;
    if (performance.now() > deadline) break;
  }
  return (best * 1e6) / k;
};

/**
 * How many standard deviations the reported bar spans.
 *
 * Two independent reasons land on the same number, which is the only reason to trust it. It is the
 * conventional threshold for calling a difference real rather than sampling luck. And MEASURED here,
 * the variation BETWEEN whole runs is about three times the variation between forks inside one run —
 * whole runs differ by machine state that every fork within a run shares, so a one-sigma bar drawn
 * from forks systematically under-reports what a re-run will actually differ by.
 */
const SIGMAS = 3;

/**
 * Samples from independent processes into one figure and its error bar.
 *
 * The median resists a single unlucky process; the deviation reports what a re-run may legitimately
 * differ by. Fewer than about five samples makes the deviation itself a guess.
 *
 * **The bar still under-reports, and no arrangement of samples inside one run fixes that.** Two
 * things were tried and measured: interleaving the forks so a row's samples span the whole run
 * (churn did not fall), and taking many short batches instead of few long ones (a real but partial
 * gain). What remains is a machine state that persists across a whole run — MEASURED, two re-runs
 * agreed with each other and disagreed with the first, while load climbed throughout. So this
 * instrument resolves a few percent on a fast operation and roughly ten on a slow one, and it
 * CANNOT decide a small regression. That job needs the old and new build measured against each other
 * in ONE run, where machine state cancels the way {@link Estimate} ratios already cancel it.
 */
export const combine = (samples: readonly number[]): Estimate => {
  const sorted = samples.toSorted((a, b) => a - b);
  // The middle one or two elements, whichever the parity gives; averaging them is the median either
  // way. Taken as a slice rather than by index so no bound has to be asserted.
  const middle = sorted.slice(
    Math.floor((sorted.length - 1) / 2),
    Math.floor(sorted.length / 2) + 1,
  );
  const value = middle.reduce((a, b) => a + b, 0) / middle.length;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance =
    samples.reduce((total, x) => total + (x - mean) ** 2, 0) / Math.max(1, samples.length - 1);
  return { value, error: SIGMAS * Math.sqrt(variance) };
};

/**
 * How coarse every published figure is. Change this number and nothing else to re-cut the ladder.
 *
 * **Published figures are magnitudes, not digits** — a maintainer ruling. A reader asks "materially
 * faster or not"; nobody acts on 2.5 against 3.2. Finer figures only churn: the same value gets
 * rewritten every run, and readers stop reading the diff.
 *
 * MEASURED, 56 cells over three runs — cells changed per run: 68% at two significant figures, 57%
 * on a grid derived from the error bar, 23% at one significant figure, 5% at ten rungs, 0% at five.
 * The grid must be fixed: a bar-derived one moves between runs, so it rewrites values that did not
 * change.
 *
 * That 0% does not hold on a busy machine. Two back-to-back baseline runs at load 8.2 of 16 cores
 * disagreed on 4 cells of 77, each by one rung. Five rungs cut the churn (the same comparison at ten
 * rungs gave 17 and 28) without removing it.
 * Noise on those same cells was 6.7% median, 16% p90, so five rungs are coarser than the instrument
 * on purpose.
 *
 * **Log-uniform rungs, not fewer digits.** One significant figure loses on both axes at once (23%
 * churn, 19.6% p90 distortion) because decimal steps are uneven in log terms: 1→2 is 100%, 8→9 is
 * 12%. So it over-rounds the bottom of each decade and under-rounds the top.
 *
 * Two costs: a real change under ~25% is invisible, and 2.0 sits on a rung boundary, so a true
 * doubling prints as 1.6 or 2.5. Accepted — this file cannot resolve a small regression anyway
 * ({@link combine}); `bench/ab.ts` is the instrument for that.
 */
const RUNGS_PER_DECADE = 5;

/**
 * The rungs: equal ratios across one decade, each rounded to two significant figures so no printed
 * figure suggests a third. At five that is 1, 1.6, 2.5, 4, 6.3 (the Renard R5 series).
 *
 * Computed, not typed out — a hand-written ladder can be uneven by a typo and nobody would see it.
 */
const LADDER = Array.from({ length: RUNGS_PER_DECADE }, (_, k) =>
  Number((10 ** (k / RUNGS_PER_DECADE)).toPrecision(2)),
);

/** The nearest rung, rendered without inventing a third significant figure. */
export const stable = (value: number): string => {
  if (!Number.isFinite(value) || value === 0) return String(value);
  const magnitude = Math.abs(value);
  const decade = 10 ** Math.floor(Math.log10(magnitude));
  const mantissa = magnitude / decade;
  // Nearest in LOG space. The ladder is geometric, so linear distance would round values just
  // above each gap's geometric midpoint down to the lower rung: 5.1 sits closer to 4 than to 6.3 by
  // subtraction (1.1 against 1.2) and closer to 6.3 by ratio (1.24 against 1.28), and ratio is what
  // a reader of these figures compares.
  const closest = (a: number, b: number): number =>
    Math.abs(Math.log(b / mantissa)) < Math.abs(Math.log(a / mantissa)) ? b : a;
  // The next decade's first rung is a candidate too: 9.5 belongs to 10, not to 6.3.
  const rung = [...LADDER, 10].reduce((a, b) => closest(a, b));
  const rounded = Math.sign(value) * rung * decade;
  return rounded.toFixed(Math.max(0, -Math.floor(Math.log10(Math.abs(rounded))) + 1));
};
