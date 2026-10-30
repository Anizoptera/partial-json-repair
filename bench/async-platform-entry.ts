// SPDX-License-Identifier: Apache-2.0

import { asyncRoutes } from "./async-routes";
import type { AsyncRoute } from "./async-routes";
import { asyncWorkloads, expectedAsyncOutcome } from "./async-cases";
import { sampleRoute } from "./async-sample";
import { canonical } from "../scripts/corpus/canonical";
import type { PlatformRequest } from "./async-platform-protocol";

const sha256 = async (value: string | Uint8Array): Promise<string> => {
  // WebCrypto needs non-shared storage; byte factories may also exercise shared input.
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

// Test the same sampler on idle and blocking tasks before trusting a host's clock.
const clockControl = async (base: AsyncRoute, rounds: number) => {
  let captured = 0;
  let hash = 1;
  const route: AsyncRoute = {
    ...base,
    run: () => {
      let value = 1;
      for (let index = 0; index < rounds; index++)
        // eslint-disable-next-line unicorn/prefer-math-trunc -- LCG state wraps at 32 bits; truncation does not.
        value = (Math.imul(value, 1664525) + 1013904223) | 0;
      return Promise.resolve(value);
    },
  };
  const result = await sampleRoute(
    { id: "host-clock", input: "", operation: "parse" },
    route,
    {
      capture(value) {
        if (typeof value !== "number" || !Number.isInteger(value))
          throw new Error("clock control lost its work result");
        hash = value;
        captured++;
      },
      finish(expected) {
        if (captured !== expected) throw new Error("clock control lost a sample");
      },
    },
    { budgetMilliseconds: 1, cancelAfterFirst: false },
  );
  if (result.status !== "passed") throw new Error("clock control could not run");
  return {
    rounds,
    hash,
    gap: Math.max(result.firstHostGapMilliseconds, result.longestHostGapMilliseconds),
  };
};

export const run = async (request: PlatformRequest): Promise<string> => {
  const workerSupported = typeof Worker === "function";
  const route = asyncRoutes.find((candidate) => candidate.id === request.route);
  if (route === undefined) throw new Error("unsupported platform route: " + request.route);
  let clocks:
    | {
        idle: Awaited<ReturnType<typeof clockControl>>;
        blocked: Awaited<ReturnType<typeof clockControl>>;
      }
    | undefined;
  if (!request.oracleOnly) {
    const idle = await clockControl(route, 0);
    const blocked = await clockControl(route, 33554432);
    if (!(blocked.gap > idle.gap && blocked.gap > 0))
      throw new Error(
        "host clock cannot distinguish blocked and idle tasks: " +
          JSON.stringify({ idle, blocked }),
      );
    clocks = { idle, blocked };
  }
  const workload = asyncWorkloads(request.size, (id) => id === request.workload)[0];
  if (workload === undefined) throw new Error("unknown platform workload: " + request.workload);
  const buildIdentity = async () => {
    const options = canonical(workload.options ?? {});
    return {
      runtime: request.runtime,
      target: request.host === "workerd" ? "edge" : "browser",
      input: typeof workload.input === "string" ? "text" : "bytes",
      inputDigest: await sha256(workload.input),
      operation: workload.operation,
      options,
      optionsDigest: await sha256(options),
      size: workload.input.length,
      workload: workload.id,
      cancelAfterFirst: request.cancelAfterFirst,
    } as const;
  };
  // Identity stays lazy until sampling ends; reuse its hashes and selector encoding afterwards.
  let identityPromise: ReturnType<typeof buildIdentity> | undefined;
  const identity = () => (identityPromise ??= buildIdentity());
  const oracleIdentity = async () => {
    // Only the digest crosses process arguments: a literal selector may exceed their limit.
    const { options: _options, ...record } = await identity();
    return record;
  };
  if (request.oracleOnly) {
    let expected: unknown;
    expectedAsyncOutcome(workload, request.cancelAfterFirst, (value) => {
      expected = value;
      return "";
    });
    return JSON.stringify({
      ...(await oracleIdentity()),
      digest: await sha256(canonical(expected)),
    });
  }
  const results: unknown[] = [];
  let sample: Awaited<ReturnType<typeof sampleRoute>>;
  try {
    sample = await sampleRoute(
      workload,
      route,
      {
        capture(value) {
          results.push(value);
        },
        async finish(expectedCalls) {
          try {
            if (results.length !== expectedCalls)
              throw new Error("platform observer lost captured outcomes");
            if (request.expectedRecord === undefined)
              throw new Error("platform observer requires its isolated oracle");
            const expected: unknown = JSON.parse(request.expectedRecord);
            if (typeof expected !== "object" || expected === null)
              throw new Error("platform oracle is not a record");
            // Hash only after sampling: touching input earlier would warm the first measured read.
            const metadata = await oracleIdentity();
            if (
              Object.entries(metadata).some(([key, value]) => Reflect.get(expected, key) !== value)
            )
              throw new Error(
                "platform oracle does not match this host, input, options or cancellation",
              );
            const digest: unknown = Reflect.get(expected, "digest");
            if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))
              throw new Error("platform oracle has no SHA-256 digest");
            for (const result of results) {
              // Verification stays sequential to avoid allocating every canonical output at once.
              // oxlint-disable-next-line no-await-in-loop
              if ((await sha256(canonical(result))) !== digest)
                throw new Error("platform outcome differs from its isolated oracle");
            }
          } finally {
            results.length = 0;
          }
        },
      },
      {
        budgetMilliseconds: request.budgetMilliseconds,
        cancelAfterFirst: request.cancelAfterFirst,
        concurrency: request.concurrency,
      },
    );
  } finally {
    results.length = 0;
  }
  // Only absent host capability permits refusal; worker startup failures must fail qualification.
  const verdict =
    sample.status === "unavailable" &&
    !(sample.unsupported && !workerSupported && route.execution?.kind === "worker")
      ? { status: "failed" as const, reason: sample.reason }
      : sample;
  const observed = await identity();
  const row = {
    ...observed,
    boundary: route.boundary,
    cancellationPhase: request.cancelAfterFirst ? "after-first-delivery" : "none",
    cell: [request.runtime, observed.target, route.id, workload.id].join("/"),
    concurrency: request.concurrency,
    execution: route.execution?.kind ?? "auto",
    implementation: route.implementation,
    placement: route.placement,
    route: route.id,
    ...verdict,
  };
  return JSON.stringify({
    runtime: request.runtime,
    host: {
      engine: typeof navigator === "undefined" ? request.host : navigator.userAgent,
      workerSupported,
      clocks,
    },
    census: {
      attempted: 1,
      expected: 1,
      selected: 1,
      passed: row.status === "passed" ? 1 : 0,
      failed: row.status === "failed" ? 1 : 0,
      unavailable: row.status === "unavailable" ? 1 : 0,
    },
    routes: [row],
    checkpointBudgets: {},
    totalSizes: {},
  });
};
