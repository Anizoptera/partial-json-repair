// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { assertInputRetention } from "../test/pending-token-memory-probe";
import { INPUT_MEMORY_COHORTS } from "./consumer-memory";
import { LANE_DEADLINE_MS, PLATFORM_OBSERVATION_MS } from "./run-script";

const owners = [
  { name: "terminal caller reference", initializer: "__useTerminalInputMemory" },
  { name: "stopped view", initializer: "__useStoppedViewMemory" },
  { name: "pending token", initializer: "__usePendingTokenMemory" },
] as const;
const cohorts = Object.entries(INPUT_MEMORY_COHORTS).map(([name, { width, retain }]) => ({
  name,
  width,
  retain,
}));

async function run(command: string[], input?: string): Promise<string> {
  // Drain both pipes while waiting; compiler diagnostics must not deadlock the observation.
  const child = Bun.spawn(command, {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  let stopped = false;
  const deadline = setTimeout(() => {
    stopped = true;
    child.kill("SIGKILL");
  }, LANE_DEADLINE_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (stopped || code !== 0)
      throw new Error(
        `WebKit string ownership ${stopped ? "stopped at its deadline" : "failed"}: ${stderr}`,
      );
    return stdout;
  } finally {
    clearTimeout(deadline);
  }
}

type Reading = { name: string; suspended: number; ended: number };
type Output = { groups: { owner: string; rows: Reading[] }[] };

export async function webkitStringMemory(work: string): Promise<(url: string) => Promise<void>> {
  // Compile once into the platform owner's disposable package directory, then reuse the binary.
  const binary = path.join(work, "webkit-memory");
  await run([
    "xcrun",
    "swiftc",
    "-O",
    path.join(import.meta.dir, "webkit-memory.swift"),
    "-o",
    binary,
  ]);
  return async (url) => {
    const raw = await run(
      [binary],
      JSON.stringify({
        url,
        operationMs: PLATFORM_OBSERVATION_MS,
        owners,
        cohorts,
        traceInputs: process.env.PJR_TRACE_INPUTS === "1",
      }),
    );
    // The native helper is a private transport, not a second source of bounds or cohort policy.
    const output = JSON.parse(raw) as Output;
    if (process.env.PJR_TRACE_INPUTS !== undefined)
      console.log(`WebKit ownership readings ${url}: ${raw}`);
    if (!Array.isArray(output.groups) || output.groups.length !== owners.length)
      throw new Error("WebKit string ownership omitted a probe owner");
    for (const [index, owner] of owners.entries()) {
      const group = output.groups[index];
      if (
        group?.owner !== owner.name ||
        !Array.isArray(group.rows) ||
        group.rows.length !== cohorts.length
      )
        throw new Error(`WebKit string ownership omitted ${owner.name} cohorts`);
      for (const [at, cohort] of cohorts.entries()) {
        const reading = group.rows[at];
        if (
          reading?.name !== cohort.name ||
          !Number.isSafeInteger(reading.suspended) ||
          !Number.isSafeInteger(reading.ended) ||
          reading.suspended <= 0 ||
          reading.ended <= 0
        )
          throw new Error(`WebKit ${owner.name} returned an invalid ${cohort.name} heap reading`);
      }
      const [, small, control, large] = group.rows;
      if (small === undefined || control === undefined || large === undefined)
        throw new Error(`WebKit ${owner.name} omitted its comparison`);
      assertInputRetention(small, control, large, `WebKit ${owner.name} snapshot`);
    }
  };
}
