// SPDX-License-Identifier: Apache-2.0

/** Record cold engine loading, retained memory and artifact size for each supported JS runtime. */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse } from "../../dist/index.js";
import { stable } from "../estimator.ts";
import type { Runner } from "./baseline.ts";
import { acceptCandidate, retainCandidate } from "./baseline-candidate.ts";
import { availableEngineRoutes, buildEngineArtifacts, engineCommand } from "./baseline-engines.ts";
import { loadEngine } from "./engine-load";
import { engineHostOf, engineModeOf } from "./engine-routes";
import type { EngineMode } from "./engine-routes";
import { MEMORY_CALLS, MEMORY_SAMPLE_INTERVAL } from "./memory-method.ts";
import { supportedBunRuntimes, supportedDenoRuntime, supportedNodeRuntimes } from "./runtimes";

interface Observation {
  readonly runtime: string;
  readonly startupMs: number;
  readonly peakBytes: number;
}

type Footprint = {
  readonly machine: Record<string, number | string>;
  readonly routes: Record<string, Partial<Record<EngineMode, Record<string, string | number>>>>;
};

const FILE = resolve("bench/prior-art/route-footprint.json");
const CANDIDATE = resolve("bench/prior-art/.route-footprint-candidate.json");

const runtimeLabel = (): string => {
  const hosts = globalThis as {
    Bun?: { version: string };
    Deno?: { version: { deno: string } };
  };
  if (hosts.Deno !== undefined) return `deno ${hosts.Deno.version.deno}`;
  if (hosts.Bun !== undefined) return `bun ${hosts.Bun.version}`;
  return `node ${process.versions.node}`;
};

const collect = async (): Promise<void> => {
  const child = process.argv.indexOf("--child");
  const mode = engineModeOf(process.argv[child + 1]);
  const artifact = process.argv[child + 2];
  if (mode === undefined || artifact === undefined)
    throw new Error("route footprint child requires a registered engine mode and artifact");
  const documents = JSON.parse(readFileSync(0, "utf8")) as Record<string, string>;
  const clean = documents.clean;
  const damaged = documents.malformed;
  if (clean === undefined || damaged === undefined) throw new Error("route cases are incomplete");
  const expected = [parse(clean), parse(damaged)];
  if (expected.some((outcome) => !outcome.ok)) throw new Error("route oracle rejected a case");

  const started = performance.now();
  const loaded = await loadEngine(mode, artifact);
  const startupMs = performance.now() - started;
  if (!loaded.ok) throw new Error(loaded.failure.reason);
  let peakBytes = process.memoryUsage().rss;
  for (let index = 0; index < MEMORY_CALLS; index++) {
    const text = index % 2 === 0 ? clean : damaged;
    const outcome = loaded.value.parse(text);
    const wanted = expected[index % 2];
    if (
      !outcome.ok ||
      wanted === undefined ||
      !wanted.ok ||
      !isDeepStrictEqual(outcome.value, wanted.value)
    )
      throw new Error(outcome.ok ? "route answer differs from TypeScript" : outcome.failure.kind);
    if (index % MEMORY_SAMPLE_INTERVAL === 0)
      peakBytes = Math.max(peakBytes, process.memoryUsage().rss);
  }
  peakBytes = Math.max(peakBytes, process.memoryUsage().rss);
  console.log(JSON.stringify({ runtime: `${runtimeLabel()} ${mode}`, startupMs, peakBytes }));
};

const cases = (): string => {
  const compared = spawnSync(process.execPath, [resolve("bench/prior-art/compare.ts")], {
    encoding: "utf8",
    env: { ...process.env, EMIT: "cases" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (compared.status !== 0) throw new Error(`could not read route cases: ${compared.stderr}`);
  return compared.stdout;
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--accept")) {
    const accepted = acceptCandidate(CANDIDATE, FILE) as Footprint;
    console.log(`written: ${Object.keys(accepted.routes).join(", ")}`);
    return;
  }
  const machine = {
    arch: process.arch,
    logicalCpus: cpus().length,
    loadAverages: loadavg()
      .map((value) => value.toFixed(2))
      .join(" "),
    platform: process.platform,
  };
  const artifacts = buildEngineArtifacts();
  const runner = resolve("rust/target/release/route-footprint.js");
  const built = await Bun.build({
    entrypoints: ["bench/prior-art/route-footprint.ts"],
    target: "node",
    format: "esm",
    outdir: resolve("rust/target/release"),
    naming: "route-footprint.js",
  });
  if (!built.success) throw new Error("route footprint runner bundle failed");

  const input = cases();
  const installed = [...supportedBunRuntimes(), ...supportedNodeRuntimes(), supportedDenoRuntime()];
  const runtimes: Runner[] = installed.map((runtime) => ({
    argv:
      engineHostOf(runtime.label) === "deno"
        ? [
            ...runtime.argv,
            "run",
            "--node-modules-dir=manual",
            "--allow-read",
            "--allow-env",
            "--allow-sys",
            "--no-config",
            runner,
          ]
        : [...runtime.argv, runner],
    expect: runtime.label,
    reference: "JSON.parse",
  }));
  const report: Record<string, Partial<Record<EngineMode, Record<string, string | number>>>> = {};
  for (const runtime of runtimes) {
    const byMode: Partial<Record<EngineMode, Record<string, string | number>>> = {};
    for (const route of availableEngineRoutes(runtime)) {
      const artifact = route.mode === "wasm" ? artifacts.wasm : artifacts.native;
      const observations: Observation[] = [];
      const [command = "", ...args] = engineCommand(runtime, route, runner, artifacts, "--child");
      for (let fork = 0; fork < 5; fork++) {
        const run = spawnSync(command, args, {
          encoding: "utf8",
          input,
        });
        if (run.status !== 0) throw new Error(`${runtime.expect} ${route.mode}: ${run.stderr}`);
        const observed = JSON.parse(run.stdout) as Observation;
        const expected = `${runtime.expect} ${route.mode}`;
        if (observed.runtime !== expected)
          throw new Error(`asked for ${expected}, ran ${observed.runtime}`);
        observations.push(observed);
      }
      const peaks = observations.map(({ peakBytes }) => peakBytes).toSorted((a, b) => a - b);
      byMode[route.mode] = {
        artifactBytes: statSync(artifact).size,
        peakMiB: Math.round((peaks[2] ?? 0) / 1024 / 1024),
        startupMs: stable(Math.min(...observations.map(({ startupMs }) => startupMs))),
      };
    }
    report[runtime.expect] = byMode;
  }
  const output: Footprint = { machine, routes: report };
  retainCandidate(CANDIDATE, output);
  console.log(JSON.stringify(output, null, 2));
  console.log("candidate retained; inspect it, then pass --accept");
};

if (process.argv.includes("--child")) await collect();
else await main();
