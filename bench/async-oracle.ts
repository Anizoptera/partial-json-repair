// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { canonical, writeCanonical } from "../scripts/corpus/canonical";
import type { AsyncWorkload } from "./async-cases";
import { runtime } from "./async-host";

// Oracle and measurement identities must describe the same input, options and host.
export const workloadIdentity = (workload: AsyncWorkload) => ({
  runtime: runtime(),
  target: `${process.platform}-${process.arch}`,
  input: typeof workload.input === "string" ? ("text" as const) : ("bytes" as const),
  inputDigest: createHash("sha256").update(workload.input).digest("hex"),
  operation: workload.operation,
  options: canonical(workload.options ?? {}),
  size: workload.input.length,
  workload: workload.id,
});

export const canonicalDigest = (value: unknown): string => {
  const hash = createHash("sha256");
  let pending = "";
  writeCanonical(value, (part) => {
    pending += part;
    // Flush complete tokens: separate UTF-8 updates must not split a surrogate pair.
    if (pending.length >= 8192) {
      hash.update(pending);
      pending = "";
    }
  });
  if (pending.length > 0) hash.update(pending);
  return hash.digest("hex");
};

export const createSampleVerifier = (workload: string, route: string, expected: () => string) => {
  // Verification allocations can pause later samples. Keep every result until sampling ends.
  const results: unknown[] = [];
  return {
    capture(this: void, value: unknown): void {
      results.push(value);
    },
    finish(expectedCalls: number): void {
      try {
        if (results.length !== expectedCalls)
          throw new Error(
            `${workload}: ${route} captured ${String(results.length)} outcomes; expected ${String(expectedCalls)}`,
          );
        const reference = expected();
        for (const result of results) {
          const actual = canonicalDigest(result);
          if (actual !== reference)
            throw new Error(`${workload}: ${route} returned ${actual}; expected ${reference}`);
        }
      } finally {
        results.length = 0;
      }
    },
  };
};

// The launcher builds before loading public-call fixtures; keep that runtime import out of this module.
type ExpectedOutcome = typeof import("./async-cases").expectedAsyncOutcome;

const oracleIdentity = (workload: AsyncWorkload) => {
  // Literal selector paths can exceed process argument limits; metadata needs only their identity.
  const { options, ...identity } = workloadIdentity(workload);
  return { ...identity, optionsDigest: createHash("sha256").update(options).digest("hex") };
};

export const oracleRecord = (
  workload: AsyncWorkload,
  cancelAfterFirst: boolean,
  expected: ExpectedOutcome,
): string =>
  JSON.stringify({
    ...oracleIdentity(workload),
    cancelAfterFirst,
    digest: expected(workload, cancelAfterFirst, canonicalDigest),
  });

const verifiedDigest = (
  workload: AsyncWorkload,
  cancelAfterFirst: boolean,
  encoded?: string,
): string => {
  if (encoded === undefined)
    throw new Error(
      "route observer requires --expected-record; run bench/async.ts without --observe to prepare its isolated oracle",
    );
  const record: unknown = JSON.parse(encoded);
  if (typeof record !== "object" || record === null)
    throw new Error("async oracle must be a record");
  const digest: unknown = Reflect.get(record, "digest");
  if (
    Object.entries(oracleIdentity(workload)).some(
      ([key, value]) => Reflect.get(record, key) !== value,
    ) ||
    Reflect.get(record, "cancelAfterFirst") !== cancelAfterFirst ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(digest)
  )
    throw new Error(
      "async oracle does not match the measured host, workload, input, options or cancellation; regenerate it through bench/async.ts",
    );
  return digest;
};

export const outcomeOracle = (
  workload: AsyncWorkload,
  cancelAfterFirst: boolean,
  encoded?: string,
): (() => string) => {
  // Input hashing reads the whole source. Defer it until validation so the cold call owns that cost.
  let digest: string | undefined;
  return () => (digest ??= verifiedDigest(workload, cancelAfterFirst, encoded));
};

export const isolatedOracle = (
  argv: readonly string[],
  runner: string,
  filters: readonly string[],
  cancelAfterFirst: boolean,
): string => {
  const executable = argv[0];
  if (executable === undefined) throw new Error("async oracle has no runtime executable");
  // A synchronous reference repair can leave gigabytes of garbage for the next measured call.
  // Use the same packed program in another process; only its small digest crosses into observers.
  const result = spawnSync(
    executable,
    [
      ...argv.slice(1),
      runner,
      "--observe",
      "--oracle-only",
      ...filters,
      ...(cancelAfterFirst ? ["--cancel-after-first"] : []),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30_000 },
  );
  if (result.status !== 0 || result.stdout.trim() === "")
    throw new Error(`async oracle failed: ${result.signal ?? `exit ${String(result.status)}`}`);
  return result.stdout.trim();
};
