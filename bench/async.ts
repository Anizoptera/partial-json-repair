#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/** Measure async production operations, checkpoints, and terminal work from one workload matrix. */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateOptions } from "../src/options";
import { wholeOperation } from "../src/whole-operation";
import { repairOperation } from "../src/repair-operation";
import { spanOperation } from "../src/span-operation";
import { manySteps } from "../src/whole-reader";
import { canonical } from "../scripts/corpus/canonical";
import { packConsumer } from "../scripts/consumer-package";
import { captureHostContext, runtime } from "./async-host";
import {
  createSampleVerifier,
  isolatedOracle,
  oracleRecord,
  outcomeOracle,
  workloadIdentity,
} from "./async-oracle";
import type { AsyncWorkload } from "./async-cases";
import type { AsyncRoute } from "./async-routes";
import { sampleRoute } from "./async-sample";
import { measureConcurrencySample } from "./async-rss-sample";
import type { ConcurrencyMetrics } from "./async-rss-sample";
import { PLATFORM_HOSTS, platformMembers } from "./async-platform-protocol";
import type { AsyncRuntime } from "./async-platform-protocol";
import {
  supportedBunRuntimes,
  supportedDenoRuntime,
  supportedDenoVersion,
  supportedNodeRuntimes,
} from "./prior-art/runtimes";

const nativeOnlyProbe =
  ["--quanta", "--scaling", "--route-concurrency", "--profile", "--gap-cpu"].some((flag) =>
    process.argv.includes(flag),
  ) || argumentAfter("--route") === "cooperative-worker-preparation";
if (
  nativeOnlyProbe &&
  argumentAfter("--runtime") !== undefined &&
  platformMembers(argumentAfter("--runtime")).length > 0
)
  throw new Error(
    "checkpoint, RSS concurrency, profile and CPU probes require a native runtime; use ordinary route timings for browser and edge hosts",
  );
// Delivery is an observable active-operation boundary; a delay cannot prove that scanning began.
const cancelAfterFirst = process.argv.includes("--cancel-after-first");
if (
  cancelAfterFirst &&
  (argumentAfter("--workload") !== "many-roots" ||
    ["--quanta", "--scaling", "--route-concurrency", "--profile"].some((flag) =>
      process.argv.includes(flag),
    ) ||
    argumentAfter("--route") === "cooperative-worker-preparation")
)
  throw new Error("--cancel-after-first requires --workload many-roots and ordinary route timings");

// Validate before building fixtures: an invalid control must not leave unused build output behind.
// Slow selected calls can buy more samples; broad probes retain their short budget.
const samplingBudgetMilliseconds = positiveInteger(
  process.argv.includes("--sampling-budget")
    ? (argumentAfter("--sampling-budget") ?? "")
    : undefined,
  300,
  "--sampling-budget in milliseconds",
);
const sampleConcurrency = positiveInteger(
  process.argv.includes("--concurrency") ? (argumentAfter("--concurrency") ?? "") : undefined,
  1,
  "--concurrency",
);
if (
  (argumentAfter("--concurrency") !== undefined || argumentAfter("--workload") === "concurrent") &&
  ["--quanta", "--scaling", "--profile"].some((flag) => process.argv.includes(flag))
)
  throw new Error(
    "--concurrency and --workload concurrent require ordinary route timings or --route-concurrency",
  );
if (
  sampleConcurrency > 1 &&
  (cancelAfterFirst || argumentAfter("--route") === "cooperative-worker-preparation")
)
  throw new Error("cancellation and preparation probes require --concurrency 1");
if (
  process.argv.includes("--sampling-budget") &&
  ["--quanta", "--scaling", "--route-concurrency", "--profile"].some((flag) =>
    process.argv.includes(flag),
  )
)
  throw new Error(
    "--sampling-budget applies to ordinary route timings; omit it for other probe modes",
  );

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const cleanupBuild = (): void => {
  const cleaned = spawnSync("bash", ["scripts/clean-generated.sh", "--build"], {
    cwd: ROOT,
    stdio: ["ignore", 2, 2],
  });
  if (cleaned.status !== 0) {
    console.error("async benchmark build cleanup failed");
    process.exitCode = 1;
  }
};

// A clean tree has no self-importable package yet. Build before loading public-call fixtures;
// observers already have the packed package and must never rebuild their measured subject.
const loadFixtures = async () => {
  const observer = process.argv.includes("--observe");
  try {
    if (!observer) {
      const build = spawnSync(process.execPath, ["run", "build"], {
        cwd: ROOT,
        stdio: ["ignore", 2, 2],
      });
      if (build.status !== 0) throw new Error("async benchmark package build failed");
      // Harness types read the shipped declarations, so validation must follow this build.
      const checked = spawnSync(process.execPath, ["run", "typecheck"], {
        cwd: ROOT,
        stdio: ["ignore", 2, 2],
      });
      if (checked.status !== 0) throw new Error("async benchmark typecheck failed");
    }
    return await Promise.all([import("./async-cases"), import("./async-routes")]);
  } catch (error) {
    if (!observer) cleanupBuild();
    throw error;
  }
};
const [{ asyncWorkloadIds, asyncWorkloads, expectedAsyncOutcome }, { asyncRoutes }] =
  await loadFixtures();

type Measurement = {
  readonly advances: number;
  readonly checkpoints: number;
  readonly finalMilliseconds: number;
  readonly longestCheckpointMilliseconds: number;
  readonly longestMilliseconds: number;
  readonly totalMilliseconds: number;
};

type RouteIdentity = {
  readonly boundary: AsyncRoute["boundary"];
  readonly cancellationPhase: "none" | "after-first-delivery";
  readonly cell: string;
  readonly concurrency: number;
  readonly execution: "auto" | NonNullable<AsyncRoute["execution"]>["kind"];
  readonly implementation: AsyncRoute["implementation"];
  readonly input: "bytes" | "text";
  readonly inputDigest: string;
  readonly operation: AsyncWorkload["operation"];
  readonly options: string;
  readonly placement: AsyncRoute["placement"];
  readonly route: string;
  readonly runtime: string;
  readonly size: number;
  readonly target: string;
  readonly workload: string;
};

type RouteMeasurement = RouteIdentity & {
  readonly firstMilliseconds: number;
  readonly firstRecoveryMilliseconds?: number;
  readonly firstHostGapMilliseconds: number;
  readonly firstHostGapCpuMilliseconds?: number;
  readonly firstCancellationMilliseconds?: number;
  readonly fastestMilliseconds: number;
  // A budget can expire before tiering settles; timings alone cannot prove convergence.
  readonly warmupCalls: number;
  readonly timedCalls: number;
  readonly converged: boolean;
  readonly samplingBudgetMilliseconds: number;
  readonly longestHostGapMilliseconds: number;
  readonly longestHostGapCpuMilliseconds?: number;
  readonly longestCancellationMilliseconds?: number;
  readonly status: "passed";
};

type RouteFailure = RouteIdentity & {
  readonly reason: string;
  readonly status: "failed";
};

type RouteUnavailable = RouteIdentity & {
  readonly reason: string;
  readonly unsupported: boolean;
  readonly status: "unavailable";
};

type RouteResult = RouteFailure | RouteMeasurement | RouteUnavailable;

// Eligibility includes startup: a fast warmed worker does not erase its first caller's stall.
const observedRouteGap = (row: RouteMeasurement): number =>
  Math.max(row.firstHostGapMilliseconds, row.longestHostGapMilliseconds);

type ConcurrencySummary = ConcurrencyMetrics & {
  // Ready-worker eligibility must not charge startup to reuse or hide startup behind warm samples.
  readonly firstPeakRssDeltaBytes: number;
  readonly repeatedPeakRssDeltaBytes: number;
};

type RouteConcurrencyMeasurement = ConcurrencySummary &
  Omit<RouteIdentity, "cancellationPhase" | "concurrency"> & {
    readonly cancellationPhase: "none";
    readonly status: "passed";
  };

const SIZE = 64 * 1024;

const BUDGETS = [512, 1024, 2048, 4096, 8192, 16_384, 32_768] as const;
const CONCURRENT_WORKLOADS = new Set([
  "candidate-noise",
  "clean-array",
  "dense-repair",
  "malformed-bytes",
  "many-roots",
  "selected-scalar",
  "selected-array",
]);
const TOTAL_SIZES = [SIZE, 256 * 1024, 1024 * 1024] as const;
const TOTAL_BUDGET = 4096;
const SAMPLES = 3;

const routeIdentity = (workload: AsyncWorkload, route: AsyncRoute): RouteIdentity => {
  const identity = workloadIdentity(workload);
  return {
    ...identity,
    boundary: route.boundary,
    cancellationPhase: cancelAfterFirst ? "after-first-delivery" : "none",
    cell: [identity.runtime, identity.target, route.id, workload.id].join("/"),
    concurrency: sampleConcurrency,
    execution: route.execution?.kind ?? "auto",
    implementation: route.implementation,
    placement: route.placement,
    route: route.id,
  };
};

const measureRoute = async (
  workload: AsyncWorkload,
  route: AsyncRoute,
  expectedResult: () => string,
): Promise<RouteMeasurement | RouteUnavailable> => {
  const sample = await sampleRoute(
    workload,
    route,
    createSampleVerifier(workload.id, route.id, expectedResult),
    {
      budgetMilliseconds: samplingBudgetMilliseconds,
      cancelAfterFirst,
      concurrency: sampleConcurrency,
      ...(process.argv.includes("--gap-cpu") ? { cpuUsage: () => process.cpuUsage() } : {}),
      progress: (stage) => {
        console.error(runtime() + ": " + workload.id + "/" + route.id + ": " + stage);
      },
    },
  );
  // Hash input and options only after sampling, so validation cannot warm the first measured read.
  return { ...routeIdentity(workload, route), ...sample };
};

const operationAdvance = (
  workload: AsyncWorkload,
  units: number,
  expectedResult = expectedAsyncOutcome(workload),
): Measurement => {
  // Private checkpoints use source code; validate cross-copy features instead of asserting identity.
  const options = validateOptions(workload.options);
  if ("kind" in options) throw new Error(`invalid checkpoint options: ${canonical(options)}`);
  const operation = wholeOperation(
    workload.operation === "repair"
      ? repairOperation
      : workload.operation === "findJsonSpan"
        ? spanOperation
        : workload.operation === "parseMany"
          ? manySteps
          : workload.operation,
    workload.input,
    options,
    undefined,
    units,
  );
  let advances = 0;
  let checkpoints = 0;
  let finalMilliseconds = 0;
  let longestCheckpointMilliseconds = 0;
  let longestMilliseconds = 0;
  let totalMilliseconds = 0;
  let terminal: unknown;
  const items: unknown[] = [];
  while (true) {
    const started = performance.now();
    const step = operation.next();
    const elapsed = performance.now() - started;
    advances++;
    longestMilliseconds = Math.max(longestMilliseconds, elapsed);
    totalMilliseconds += elapsed;
    if (step.done === true) {
      terminal = step.value;
      finalMilliseconds = elapsed;
      break;
    }
    if (step.value.kind === "checkpoint") {
      checkpoints++;
      longestCheckpointMilliseconds = Math.max(longestCheckpointMilliseconds, elapsed);
    } else items.push(step.value.value);
  }
  const actual = workload.operation === "parseMany" ? items : terminal;
  if (canonical(actual) !== expectedResult)
    throw new Error(`${workload.id}: bounded operation disagrees with the public result`);
  return {
    advances,
    checkpoints,
    finalMilliseconds,
    longestCheckpointMilliseconds,
    longestMilliseconds,
    totalMilliseconds,
  };
};

const fastest = (run: () => Measurement): Measurement => {
  const first = run();
  let finalMilliseconds = first.finalMilliseconds;
  let longestCheckpointMilliseconds = first.longestCheckpointMilliseconds;
  let longestMilliseconds = first.longestMilliseconds;
  let totalMilliseconds = first.totalMilliseconds;
  for (let sample = 1; sample < SAMPLES; sample++) {
    const measured = run();
    if (measured.advances !== first.advances || measured.checkpoints !== first.checkpoints)
      throw new Error("benchmark work changed between identical samples");
    finalMilliseconds = Math.min(finalMilliseconds, measured.finalMilliseconds);
    longestCheckpointMilliseconds = Math.min(
      longestCheckpointMilliseconds,
      measured.longestCheckpointMilliseconds,
    );
    longestMilliseconds = Math.min(longestMilliseconds, measured.longestMilliseconds);
    totalMilliseconds = Math.min(totalMilliseconds, measured.totalMilliseconds);
  }
  return {
    ...first,
    finalMilliseconds,
    longestCheckpointMilliseconds,
    longestMilliseconds,
    totalMilliseconds,
  };
};

type Observation = {
  readonly census: {
    readonly attempted: number;
    readonly expected: number;
    readonly failed: number;
    readonly passed: number;
    readonly selected: number;
    readonly unavailable: number;
  };
  readonly checkpointBudgets: Record<string, Record<string, Measurement>>;
  readonly host: ReturnType<typeof captureHostContext>;
  readonly routes: readonly RouteResult[];
  readonly runtime: string;
  readonly totalSizes: Record<string, Record<string, Record<string, Measurement>>>;
};

const maximum = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

// Timing targets guide later optimization; only outcome or execution failures reject this run.
const GAP_WARNING_MS = 8;
const GAP_OPTIMIZATION_MS = 32;
const gapVerdict = (ms: number): string =>
  ms > GAP_OPTIMIZATION_MS ? "optimization warning" : ms > GAP_WARNING_MS ? "warning" : "ok";

const summarize = (observation: Observation): string => {
  const checkpointRows = Object.values(observation.checkpointBudgets).flatMap((budgets) =>
    Object.values(budgets),
  );
  const scalingRows = Object.values(observation.totalSizes).flatMap((workloadRows) =>
    Object.values(workloadRows).flatMap((budgets) => Object.values(budgets)),
  );
  const rows = [...checkpointRows, ...scalingRows];
  const routeGap = maximum(
    observation.routes.flatMap((row) => (row.status === "passed" ? [observedRouteGap(row)] : [])),
  );
  return [
    observation.runtime,
    `routes=${String(observation.census.passed)}/${String(observation.census.attempted)}`,
    `expected=${String(observation.census.expected)}`,
    `unavailable=${String(observation.census.unavailable)}`,
    `failed=${String(observation.census.failed)}`,
    `unconverged=${String(observation.routes.filter((row) => row.status === "passed" && !row.converged).length)}`,
    `checkpoint-max=${maximum(rows.map((row) => row.longestCheckpointMilliseconds)).toFixed(3)}ms`,
    `final-max=${maximum(rows.map((row) => row.finalMilliseconds)).toFixed(3)}ms`,
    `route-delay-max=${routeGap.toFixed(3)}ms (${gapVerdict(routeGap)})`,
    ...observation.routes.flatMap((row) =>
      row.status === "passed" &&
      row.firstCancellationMilliseconds !== undefined &&
      row.longestCancellationMilliseconds !== undefined
        ? [
            `${row.cell}: cancel-after-first: cold=${row.firstCancellationMilliseconds.toFixed(3)}ms/max=${row.longestCancellationMilliseconds.toFixed(3)}ms`,
          ]
        : [],
    ),
    ...observation.routes.flatMap((row) =>
      row.status === "passed" &&
      row.firstHostGapCpuMilliseconds !== undefined &&
      row.longestHostGapCpuMilliseconds !== undefined
        ? [
            `${row.cell}: first-gap=${row.firstHostGapMilliseconds.toFixed(3)}ms/process-cpu=${row.firstHostGapCpuMilliseconds.toFixed(3)}ms`,
            `${row.cell}: warm-gap=${row.longestHostGapMilliseconds.toFixed(3)}ms/process-cpu=${row.longestHostGapCpuMilliseconds.toFixed(3)}ms`,
          ]
        : [],
    ),
  ].join("\t");
};

const measure = (size: number, units: readonly number[], requestedWorkload?: string) => {
  const measurements: Record<string, Record<string, Measurement>> = {};
  const sourceLengths: Record<string, number> = {};
  // A filtered checkpoint probe must not construct or time unrelated workloads.
  for (const workload of asyncWorkloads(
    size,
    (id) => requestedWorkload === undefined || id === requestedWorkload,
  )) {
    sourceLengths[workload.id] = workload.input.length;
    const expectedResult = expectedAsyncOutcome(workload);
    measurements[workload.id] = Object.fromEntries(
      units.map((budget) => [
        String(budget),
        fastest(() => operationAdvance(workload, budget, expectedResult)),
      ]),
    );
  }
  for (const [workload, budgets] of Object.entries(measurements)) {
    for (const [budget, measured] of Object.entries(budgets)) {
      if (measured.advances < 1)
        throw new Error(`${workload} at ${budget} units performed no measured advance`);
      const sourceLength = sourceLengths[workload];
      if (sourceLength === undefined) throw new Error(`${workload}: missing source length`);
      if (Number(budget) < sourceLength && measured.checkpoints < 1)
        throw new Error(`${workload} at ${budget} units reached no checkpoint`);
    }
  }
  return measurements;
};

function argumentAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const bestConcurrencySample = async (
  workload: AsyncWorkload,
  expected: () => string,
  concurrency: number,
  run: () => Promise<unknown>,
): Promise<ConcurrencySummary> => {
  const warmup = await measureConcurrencySample(workload, expected, concurrency, run);
  let best: ConcurrencyMetrics | undefined;
  for (let sample = 0; sample < SAMPLES; sample++) {
    // Samples stay sequential so their scheduler and memory costs remain attributable.
    // oxlint-disable-next-line no-await-in-loop
    const measured = await measureConcurrencySample(workload, expected, concurrency, run);
    best =
      best === undefined
        ? measured
        : {
            concurrency,
            fastestMilliseconds: Math.min(best.fastestMilliseconds, measured.fastestMilliseconds),
            longestHostGapMilliseconds: Math.max(
              best.longestHostGapMilliseconds,
              measured.longestHostGapMilliseconds,
            ),
            lowestCpuMilliseconds: Math.min(
              best.lowestCpuMilliseconds,
              measured.lowestCpuMilliseconds,
            ),
            lowestPeakRssDeltaBytes: Math.min(
              best.lowestPeakRssDeltaBytes,
              measured.lowestPeakRssDeltaBytes,
            ),
            highestPeakRssDeltaBytes: Math.max(
              best.highestPeakRssDeltaBytes,
              measured.highestPeakRssDeltaBytes,
            ),
            lowestRetainedRssDeltaBytes: Math.min(
              best.lowestRetainedRssDeltaBytes,
              measured.lowestRetainedRssDeltaBytes,
            ),
          };
  }
  if (best === undefined) throw new Error("concurrency benchmark ran no samples");
  return {
    ...best,
    firstPeakRssDeltaBytes: warmup.highestPeakRssDeltaBytes,
    repeatedPeakRssDeltaBytes: best.highestPeakRssDeltaBytes,
    // Storage review needs the worst sampled peak; warmup may allocate more than warm calls.
    highestPeakRssDeltaBytes: Math.max(
      warmup.highestPeakRssDeltaBytes,
      best.highestPeakRssDeltaBytes,
    ),
    longestHostGapMilliseconds: Math.max(
      warmup.longestHostGapMilliseconds,
      best.longestHostGapMilliseconds,
    ),
  };
};

const routeConcurrencyLevels = (): readonly number[] => {
  const requested = argumentAfter("--concurrency");
  return requested === undefined
    ? [...new Set([4, availableParallelism()])]
    : [positiveInteger(requested, 1, "route concurrency")];
};

const routeConcurrency = async (): Promise<void> => {
  const host = captureHostContext();
  const size = positiveInteger(argumentAfter("--size"), SIZE, "route concurrency size");
  const requestedWorkload = argumentAfter("--workload");
  const requestedRoute = argumentAfter("--route");
  const workloads = asyncWorkloads(size, (id) =>
    requestedWorkload === undefined ? CONCURRENT_WORKLOADS.has(id) : id === requestedWorkload,
  );
  const routes = asyncRoutes.filter(
    (route) => requestedRoute === undefined || route.id === requestedRoute,
  );
  if (workloads.length === 0)
    throw new Error(`unknown concurrent workload: ${String(requestedWorkload)}`);
  if (routes.length === 0) throw new Error(`unknown concurrent route: ${String(requestedRoute)}`);
  const levels = routeConcurrencyLevels();
  const results: RouteConcurrencyMeasurement[] = [];
  for (const workload of workloads) {
    const expected = outcomeOracle(workload, false, argumentAfter("--expected-record"));
    for (const concurrency of levels) {
      for (const route of routes) {
        // Routes stay sequential so CPU and memory remain attributable to one public strategy.
        // oxlint-disable-next-line no-await-in-loop
        const best = await bestConcurrencySample(workload, expected, concurrency, () =>
          route.run(workload),
        );
        results.push({
          ...routeIdentity(workload, route),
          ...best,
          cancellationPhase: "none",
          status: "passed",
        });
      }
    }
  }
  const expectedCount = workloads.length * routes.length * levels.length;
  if (results.length !== expectedCount)
    throw new Error("route concurrency benchmark omitted an expected cell");
  console.log(
    JSON.stringify({
      census: { expected: expectedCount, passed: results.length },
      host,
      results,
      runtime: runtime(),
      size,
    }),
  );
};

const profile = (): void => {
  const host = captureHostContext();
  const id = argumentAfter("--profile") ?? "exact-digits";
  const size = positiveInteger(argumentAfter("--size"), 1024 * 1024, "profile size");
  const units = positiveInteger(argumentAfter("--units"), TOTAL_BUDGET, "profile units");
  const iterations = positiveInteger(argumentAfter("--iterations"), 20, "profile iterations");
  const workload = asyncWorkloads(size, (candidate) => candidate === id)[0];
  if (workload === undefined) throw new Error(`unknown profile workload: ${id}`);
  const expectedResult = expectedAsyncOutcome(workload);
  let advances = 0;
  for (let iteration = 0; iteration < iterations; iteration++)
    advances += operationAdvance(workload, units, expectedResult).advances;
  console.log(JSON.stringify({ advances, host, id, iterations, runtime: runtime(), size, units }));
};

const observe = async (): Promise<void> => {
  const host = captureHostContext();
  const quanta = process.argv.includes("--quanta");
  const scaling = process.argv.includes("--scaling");
  const requestedWorkload = argumentAfter("--workload");
  const requestedSize = positiveInteger(argumentAfter("--size"), SIZE, "route size");
  const checkpointBudgets = quanta ? measure(requestedSize, BUDGETS, requestedWorkload) : {};
  const totalSizes = scaling
    ? Object.fromEntries(
        TOTAL_SIZES.map((size) => [String(size), measure(size, [TOTAL_BUDGET], requestedWorkload)]),
      )
    : {};
  // `--size` is forwarded to every observer; ignoring it here measured 64 KB whatever was asked.
  const requestedRoute = argumentAfter("--route");
  console.error(`${runtime()}: constructing ${requestedWorkload ?? "all"} workloads`);
  const selectedWorkloads = asyncWorkloads(
    requestedSize,
    (id) => requestedWorkload === undefined || id === requestedWorkload,
  );
  const selectedRoutes = asyncRoutes.filter(
    (route) => requestedRoute === undefined || route.id === requestedRoute,
  );
  if (selectedWorkloads.length === 0)
    throw new Error(`unknown async workload: ${String(requestedWorkload)}`);
  if (selectedRoutes.length === 0)
    throw new Error(`unknown async route: ${String(requestedRoute)}`);
  const routes: RouteResult[] = [];
  if (!quanta && !scaling) {
    for (const workload of selectedWorkloads) {
      const expected = outcomeOracle(
        workload,
        cancelAfterFirst,
        argumentAfter("--expected-record"),
      );
      for (const route of selectedRoutes) {
        // Route observations stay isolated so their event-loop and worker state remain attributable.
        // oxlint-disable-next-line no-await-in-loop
        try {
          // oxlint-disable-next-line no-await-in-loop
          routes.push(await measureRoute(workload, route, expected));
        } catch (error) {
          routes.push({
            ...routeIdentity(workload, route),
            reason: error instanceof Error ? error.message : String(error),
            status: "failed",
          });
        }
      }
    }
  }
  const census = {
    attempted: routes.length,
    expected: asyncWorkloadIds().length * asyncRoutes.length,
    failed: routes.filter((route) => route.status === "failed").length,
    passed: routes.filter((route) => route.status === "passed").length,
    selected: quanta || scaling ? 0 : selectedWorkloads.length * selectedRoutes.length,
    unavailable: routes.filter((route) => route.status === "unavailable").length,
  };
  console.log(
    JSON.stringify({ census, checkpointBudgets, host, routes, runtime: runtime(), totalSizes }),
  );
};

const launch = (): void => {
  // Keep package imports external: workers and startup must use shipped files.
  const root = ROOT;
  let packed: ReturnType<typeof packConsumer> | undefined;
  try {
    packed = packConsumer(root, "pjr-async-");
    const scratch = realpathSync(packed.consumer.dir);
    // ASCII source keeps Unicode workload literals identical across observer loaders. Package
    // imports stay external, so changing this instrument does not change the measured artifact.
    const observer = spawnSync(
      join(root, "node_modules/.bin/esbuild"),
      [
        import.meta.path,
        "--bundle",
        "--platform=node",
        "--target=es2022",
        "--charset=ascii",
        "--format=esm",
        "--external:partial-json-repair",
        "--external:partial-json-repair/async",
        `--outfile=${join(scratch, "async.js")}`,
      ],
      { stdio: ["ignore", 2, 2] },
    );
    if (observer.status !== 0) throw new Error("async benchmark observer build failed");
    const runner = join(scratch, "async.js");
    const worker = join(packed.consumer.installed, "dist/async-worker.js");
    if (!existsSync(runner) || !existsSync(worker))
      throw new Error("async benchmark did not emit its runner and production worker");
    const routeConcurrencyMode = process.argv.includes("--route-concurrency");
    const requestedRuntime = argumentAfter("--runtime");
    const selectedRuntimes: AsyncRuntime[] = [
      ...supportedBunRuntimes("bun", requestedRuntime),
      ...supportedNodeRuntimes("node", requestedRuntime),
    ];
    if (
      requestedRuntime === undefined ||
      `deno ${supportedDenoVersion}`.includes(requestedRuntime)
    ) {
      const deno = supportedDenoRuntime();
      selectedRuntimes.push({
        argv: [...deno.argv, "run", `--allow-read=${realpathSync(scratch)}`, "--allow-sys"],
        label: deno.label,
      });
    }
    if (!nativeOnlyProbe && platformMembers(requestedRuntime).length > 0) {
      // A separate build process keeps browser controllers out of native observer bundles.
      const platform = spawnSync(
        process.execPath,
        [
          join(root, "bench/async-platform.ts"),
          "--build",
          root,
          packed.consumer.dir,
          packed.consumer.installed,
          ...(requestedRuntime === undefined ? [] : [requestedRuntime]),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      if (platform.status !== 0) throw new Error("async platform build failed");
      selectedRuntimes.push(...(JSON.parse(platform.stdout) as AsyncRuntime[]));
    }
    if (selectedRuntimes.length === 0)
      throw new Error(
        `no supported runtime matches: ${String(requestedRuntime)}; --runtime matches case-sensitive family/release labels, platforms, or ${PLATFORM_HOSTS.join(", ")}`,
      );
    const modes = ["--quanta", "--scaling"].filter((flag) => process.argv.includes(flag));
    if (process.argv.includes("--gap-cpu")) modes.push("--gap-cpu");
    if (cancelAfterFirst) modes.push("--cancel-after-first");
    if (routeConcurrencyMode) modes.push("--route-concurrency");
    const requestedWorkload = argumentAfter("--workload");
    const requestedRoute = argumentAfter("--route");
    const concurrentWorkloadsOnly = requestedWorkload === "concurrent" || routeConcurrencyMode;
    // Explicit filters can expand a mode's default set; the launcher must not expand it itself.
    const workloads = asyncWorkloadIds().filter((id) =>
      requestedWorkload === undefined || requestedWorkload === "concurrent"
        ? !concurrentWorkloadsOnly || CONCURRENT_WORKLOADS.has(id)
        : id === requestedWorkload,
    );
    const routes = asyncRoutes.filter(
      (route) => requestedRoute === undefined || route.id === requestedRoute,
    );
    if (workloads.length === 0)
      throw new Error(`unknown async workload: ${String(requestedWorkload)}`);
    if (routes.length === 0) throw new Error(`unknown async route: ${String(requestedRoute)}`);
    // Each first call needs a cold worker pool; one route or workload must not warm another.
    // Checkpoint modes measure scanner code, so retain their single observer per fork.
    const checkpoints =
      !routeConcurrencyMode &&
      ["--quanta", "--scaling"].some((flag) => process.argv.includes(flag));
    const cells = checkpoints
      ? [{ workload: requestedWorkload, route: requestedRoute }]
      : workloads.flatMap((workload) => routes.map((route) => ({ workload, route: route.id })));
    const trials = Array.from({ length: SAMPLES }, (_, fork) =>
      // Preserve cold observers while varying which route sees each position in machine drift.
      (fork % 2 === 0 ? cells : cells.toReversed()).map(({ workload, route }) => ({
        workload,
        route,
        fork,
      })),
    ).flat();
    let failedCells = 0;
    const inputs = new Map<string, string>();
    const checkInputs = (
      rows: readonly Pick<RouteIdentity, "workload" | "input" | "size" | "inputDigest">[],
    ): void => {
      for (const row of rows) {
        const identity = `${row.input}/${row.size}/${row.inputDigest}`;
        const previous = inputs.get(row.workload);
        if (previous !== undefined && previous !== identity)
          throw new Error(`${row.workload}: input differs across hosts; reject these timings`);
        inputs.set(row.workload, identity);
      }
    };
    for (const candidate of selectedRuntimes) {
      const oracles = new Map<string, string>();
      // Fresh observers keep JIT and heap state independent; JSON preserves each fork for spread.
      for (const { fork, workload, route } of trials) {
        console.error(
          `${candidate.label}: ${workload ?? "checkpoints"}/${route ?? "scanner"}: fork ${String(fork + 1)}/${String(SAMPLES)}`,
        );
        const executable = candidate.argv[0];
        if (executable === undefined) throw new Error(`${candidate.label} has no executable`);
        const filters = ["--size", "--concurrency", "--sampling-budget"].flatMap((flag) => {
          const value = argumentAfter(flag);
          return value === undefined ? [] : [flag, value];
        });
        // Share defaults with host children rather than copying numeric policy into each adapter.
        if (!filters.includes("--size")) filters.push("--size", String(SIZE));
        if (!checkpoints && !routeConcurrencyMode && !filters.includes("--sampling-budget"))
          filters.push("--sampling-budget", String(samplingBudgetMilliseconds));
        if (workload !== undefined) filters.push("--workload", workload);
        if (route !== undefined) filters.push("--route", route);
        const expected: string[] = [];
        if (!checkpoints && workload !== undefined) {
          let oracle = oracles.get(workload);
          if (oracle === undefined) {
            oracle = isolatedOracle(
              candidate.argv,
              candidate.observerEntry ?? runner,
              filters,
              cancelAfterFirst,
            );
            oracles.set(workload, oracle);
          }
          expected.push("--expected-record", oracle);
        }
        const result = spawnSync(
          executable,
          [
            ...candidate.argv.slice(1),
            candidate.observerEntry ?? runner,
            "--observe",
            ...modes,
            ...filters,
            ...expected,
          ],
          {
            encoding: "utf8",
            // Progress must survive timeout; only the final JSON belongs on the captured channel.
            stdio: ["ignore", "pipe", "inherit"],
            timeout: 30_000,
          },
        );
        if (result.status !== 0) {
          const error = result.stderr?.trim() ?? "";
          // A signal alone proves no deadline: an operator can stop an unrepresentative run.
          const stopped =
            result.signal === null
              ? `exit ${String(result.status)}`
              : `stopped by ${result.signal}${result.error !== undefined && Reflect.get(result.error, "code") === "ETIMEDOUT" ? " after the 30 s bound; narrow with --workload" : ""}`;
          throw new Error(`${candidate.label}: ${error === "" ? stopped : error}`);
        }
        if (routeConcurrencyMode) {
          const observation = JSON.parse(result.stdout) as {
            readonly census: { readonly expected: number; readonly passed: number };
            readonly results: readonly RouteConcurrencyMeasurement[];
            readonly runtime: string;
          };
          if (
            observation.results.length === 0 ||
            observation.results.length !== observation.census.expected ||
            observation.results.some((row) => row.workload !== workload || row.route !== route)
          )
            throw new Error("concurrency observer did not measure its selected route and workload");
          checkInputs(observation.results);
          for (const row of observation.results)
            if (row.longestHostGapMilliseconds > GAP_OPTIMIZATION_MS)
              console.warn(
                `  TIMING WARNING ${row.cell} concurrency=${String(row.concurrency)}: host gap ${row.longestHostGapMilliseconds.toFixed(1)} ms; later optimization`,
              );
          if (process.argv.includes("--json")) process.stdout.write(`${result.stdout.trim()}\n`);
          else
            console.log(
              [
                observation.runtime,
                `concurrent=${String(observation.census.passed)}/${String(observation.census.expected)}`,
                `host-gap-max=${maximum(
                  observation.results.map((row) => row.longestHostGapMilliseconds),
                ).toFixed(3)}ms (${gapVerdict(
                  maximum(observation.results.map((row) => row.longestHostGapMilliseconds)),
                )})`,
                `retained-rss-max=${String(
                  maximum(observation.results.map((row) => row.lowestRetainedRssDeltaBytes)),
                )}B`,
              ].join("\t"),
            );
          continue;
        }
        const observation = JSON.parse(result.stdout) as Observation;
        if (
          !checkpoints &&
          (observation.census.selected !== 1 ||
            observation.routes.length !== 1 ||
            observation.routes.some(
              (row) =>
                row.workload !== workload ||
                row.route !== route ||
                row.concurrency !== sampleConcurrency,
            ))
        )
          throw new Error("observer did not measure its selected route, workload and concurrency");
        checkInputs(observation.routes);
        failedCells += observation.census.failed;
        // Native matrix members require workers; unsupported cannot silently qualify them.
        if (candidate.observerEntry === undefined) failedCells += observation.census.unavailable;
        if (process.argv.includes("--json")) process.stdout.write(`${result.stdout.trim()}\n`);
        else console.log(summarize(observation));
        // A count alone sends the reader to `--json` and a hand search; the cell and the start of its
        // reason (which embeds whole recovered values, so it is cut) say where to look.
        for (const row of observation.routes)
          if (row.status === "failed" || row.status === "unavailable")
            console.error(`  ${row.status.toUpperCase()} ${row.cell}: ${row.reason.slice(0, 300)}`);
          else if (row.status === "passed" && observedRouteGap(row) > GAP_OPTIMIZATION_MS)
            console.warn(
              `  TIMING WARNING ${row.cell}: host gap ${observedRouteGap(row).toFixed(1)} ms; later optimization`,
            );
      }
    }
    if (failedCells > 0) {
      throw new Error(`${String(failedCells)} async route cells failed or were unavailable`);
    }
  } finally {
    if (packed !== undefined) rmSync(packed.work, { recursive: true, force: true });
    // Release generated output only after every observer exits.
    cleanupBuild();
  }
};

if (process.argv.includes("--observe") && process.argv.includes("--oracle-only")) {
  const id = argumentAfter("--workload");
  const workload = asyncWorkloads(
    positiveInteger(argumentAfter("--size"), SIZE, "oracle size"),
    (candidate) => candidate === id,
  )[0];
  if (workload === undefined) throw new Error("oracle requires one known workload");
  console.log(oracleRecord(workload, cancelAfterFirst, expectedAsyncOutcome));
} else if (process.argv.includes("--observe") && process.argv.includes("--route-concurrency"))
  await routeConcurrency();
else if (process.argv.includes("--profile")) {
  try {
    profile();
  } finally {
    cleanupBuild();
  }
} else if (process.argv.includes("--observe")) await observe();
else launch();
