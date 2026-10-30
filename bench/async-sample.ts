// SPDX-License-Identifier: Apache-2.0

import type { AsyncWorkload } from "./async-cases";
import type { AsyncRoute } from "./async-routes";
import { canonical } from "../scripts/corpus/canonical";

type Cpu = { readonly user: number; readonly system: number };
export type SampleSettings = {
  readonly budgetMilliseconds: number;
  readonly cancelAfterFirst: boolean;
  readonly concurrency?: number; // Time the complete batch; verify each call against its own oracle.
  readonly cpuUsage?: () => Cpu;
  readonly progress?: (stage: "first call" | "bounded samples") => void;
};
export type SampleVerifier = {
  readonly capture: (value: unknown) => void;
  readonly finish: (count: number) => void | Promise<void>;
};
type Sample = {
  readonly elapsed: number;
  readonly recoveryMilliseconds?: number;
  readonly longestHostGap: number;
  readonly longestHostGapCpu?: number;
  readonly cancellationMilliseconds?: number;
  readonly status: "passed";
};
type Unavailable = {
  readonly reason: string;
  readonly unsupported: boolean;
  readonly status: "unavailable";
};
const STABLE_SAMPLES = 25;

const unavailableOutcome = (actual: unknown): Unavailable | undefined => {
  const outcomes = Array.isArray(actual) ? actual : [actual];
  for (const outcome of outcomes) {
    if (typeof outcome !== "object" || outcome === null || Reflect.get(outcome, "ok") !== false)
      continue;
    const failure = Reflect.get(outcome, "failure");
    if (typeof failure !== "object" || failure === null) continue;
    const kind = Reflect.get(failure, "kind");
    if (kind === "execution-unavailable" || kind === "engine-unavailable")
      return {
        reason: canonical(failure),
        unsupported:
          kind === "execution-unavailable" && Reflect.get(failure, "reason") === "unsupported",
        status: "unavailable",
      };
  }
  return undefined;
};

export const concurrentResults = async <Value>(
  count: number,
  run: () => Promise<Value>,
): Promise<Awaited<Value>[]> => {
  // A rejected member must not leave siblings running after the observation or host is released.
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => Promise.resolve().then(run)),
  );
  const results: Awaited<Value>[] = [];
  const failures: unknown[] = [];
  for (const item of settled) {
    if (item.status === "fulfilled") results.push(item.value);
    else failures.push(item.reason);
  }
  if (failures.length > 0) throw new AggregateError(failures, "concurrent route calls rejected");
  return results;
};

// Host adapters supply identity and verification; the measured task boundaries stay identical.
const once = async (
  workload: AsyncWorkload,
  route: AsyncRoute,
  recordResult: SampleVerifier["capture"],
  settings: SampleSettings,
): Promise<Sample | Unavailable> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  let previousTurn: number;
  let longestHostGap = 0;
  // CPU is an optional diagnostic, never a subtraction from the caller's observed gap.
  let previousCpu: Cpu | undefined;
  let longestHostGapCpu = 0;
  const observeGap = (now = performance.now()) => {
    const cpu = settings.cpuUsage?.();
    const gap = now - previousTurn;
    if (gap > longestHostGap) {
      longestHostGap = gap;
      if (cpu !== undefined && previousCpu !== undefined)
        longestHostGapCpu = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000;
    }
    previousTurn = now;
    previousCpu = cpu;
  };
  const controller = settings.cancelAfterFirst ? new AbortController() : undefined;
  let cancellationStarted: number | undefined;
  let recoveryMilliseconds: number | undefined;
  let actual: unknown;
  let concurrent: readonly unknown[] | undefined;
  const concurrency = settings.concurrency ?? 1;
  let started: number;
  let settled: number;
  const call = () =>
    route.run(
      workload,
      controller?.signal,
      controller === undefined
        ? undefined
        : () => {
            if (cancellationStarted !== undefined) return;
            cancellationStarted = performance.now();
            controller.abort("benchmark stop");
          },
      route.id === "cooperative-worker-preparation"
        ? () => {
            recoveryMilliseconds = performance.now() - started;
          }
        : undefined,
    );
  // Observer setup and cleanup can block too; they are not time spent running the route.
  previousCpu = settings.cpuUsage?.();
  const timer = setInterval(observeGap, 0);
  try {
    started = performance.now();
    previousTurn = started;
    if (concurrency === 1) actual = await call();
    else concurrent = await concurrentResults(concurrency, call);
    settled = performance.now();
    observeGap(settled);
  } finally {
    clearInterval(timer);
  }
  let unavailable: Unavailable | undefined;
  let refused = 0;
  for (let index = 0; index < concurrency; index++) {
    const output = concurrent === undefined ? actual : concurrent[index];
    const failure = unavailableOutcome(output);
    if (failure === undefined) recordResult(output);
    else {
      if (unavailable !== undefined && unavailable.unsupported !== failure.unsupported)
        throw new Error("route failures differ within a batch", { cause: [unavailable, failure] });
      unavailable ??= failure;
      refused++;
    }
  }
  if (unavailable !== undefined) {
    if (refused !== concurrency) throw new Error("route availability changed within a batch");
    return unavailable;
  }
  if (settings.cancelAfterFirst && cancellationStarted === undefined)
    throw new Error("cancellation probe never reached its first delivery");
  return {
    elapsed: settled - started,
    ...(recoveryMilliseconds === undefined ? {} : { recoveryMilliseconds }),
    longestHostGap,
    ...(settings.cpuUsage === undefined ? {} : { longestHostGapCpu }),
    ...(cancellationStarted === undefined
      ? {}
      : { cancellationMilliseconds: settled - cancellationStarted }),
    status: "passed",
  };
};

// Capture every outcome, then verify after sampling: verification garbage must not pause later calls.
export const sampleRoute = async (
  workload: AsyncWorkload,
  route: AsyncRoute,
  verification: SampleVerifier,
  settings: SampleSettings,
) => {
  if (settings.cancelAfterFirst && (settings.concurrency ?? 1) !== 1)
    throw new Error("after-first cancellation requires one call per sample");
  settings.progress?.("first call");
  const first = await once(workload, route, verification.capture, settings);
  if (first.status === "unavailable") return first;
  let fastestMilliseconds = Infinity;
  let longestHostGapMilliseconds = 0;
  let longestHostGapCpuMilliseconds: number | undefined;
  let longestCancellationMilliseconds = first.cancellationMilliseconds;
  settings.progress?.("bounded samples");
  // Bound warmup and convergence separately; invocation counts expose how much tiering ran.
  const warmupEnd = performance.now() + settings.budgetMilliseconds / 3;
  let warmupCalls = 0;
  const retain = (sample: Sample) => {
    if (sample.cancellationMilliseconds !== undefined)
      longestCancellationMilliseconds = Math.max(
        longestCancellationMilliseconds ?? 0,
        sample.cancellationMilliseconds,
      );
    // A fast minimum never erases a stall, including one during warmup.
    if (sample.longestHostGap > longestHostGapMilliseconds) {
      longestHostGapMilliseconds = sample.longestHostGap;
      longestHostGapCpuMilliseconds = sample.longestHostGapCpu;
    }
  };
  for (; warmupCalls < 100 && performance.now() < warmupEnd; warmupCalls++) {
    // oxlint-disable-next-line no-await-in-loop
    const warmed = await once(workload, route, verification.capture, settings);
    if (warmed.status === "unavailable")
      throw new Error(`${workload.id}: ${route.id} became unavailable during warmup`);
    retain(warmed);
  }
  const sampleEnd = performance.now() + (settings.budgetMilliseconds * 2) / 3;
  let stable = 0;
  let timedCalls = 0;
  // A budget limits extra samples; host preemption must not erase the timed phase entirely.
  for (
    ;
    timedCalls < 200 &&
    stable < STABLE_SAMPLES &&
    (timedCalls === 0 || performance.now() < sampleEnd);
    timedCalls++
  ) {
    // Sequential calls prevent a route from contending with itself.
    // oxlint-disable-next-line no-await-in-loop
    const measured = await once(workload, route, verification.capture, settings);
    if (measured.status === "unavailable")
      throw new Error(`${workload.id}: ${route.id} became unavailable after its first sample`);
    stable = measured.elapsed < fastestMilliseconds ? 0 : stable + 1;
    fastestMilliseconds = Math.min(fastestMilliseconds, measured.elapsed);
    retain(measured);
  }
  if (!Number.isFinite(fastestMilliseconds))
    throw new Error(`${workload.id}: ${route.id} produced no timed call`);
  await verification.finish((1 + warmupCalls + timedCalls) * (settings.concurrency ?? 1));
  return {
    firstMilliseconds: first.elapsed,
    ...(first.recoveryMilliseconds === undefined
      ? {}
      : { firstRecoveryMilliseconds: first.recoveryMilliseconds }),
    firstHostGapMilliseconds: first.longestHostGap,
    ...(first.cancellationMilliseconds === undefined
      ? {}
      : { firstCancellationMilliseconds: first.cancellationMilliseconds }),
    ...(first.longestHostGapCpu === undefined
      ? {}
      : { firstHostGapCpuMilliseconds: first.longestHostGapCpu }),
    fastestMilliseconds,
    warmupCalls,
    timedCalls,
    converged: stable >= STABLE_SAMPLES,
    samplingBudgetMilliseconds: settings.budgetMilliseconds,
    longestHostGapMilliseconds,
    ...(longestCancellationMilliseconds === undefined ? {} : { longestCancellationMilliseconds }),
    ...(longestHostGapCpuMilliseconds === undefined ? {} : { longestHostGapCpuMilliseconds }),
    status: "passed" as const,
  };
};
