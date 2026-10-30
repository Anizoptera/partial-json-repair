#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_DEADLINE_MS, PLATFORM_OBSERVATION_MS } from "../../scripts/run-script";
import { MEMORY_CALLS, MEMORY_SAMPLE_INTERVAL } from "./memory-method";

// Build first. Each fresh helper owns one renderer; inspector heap counters omit backing storage.
const work = await mkdtemp(join(tmpdir(), "pjr-webkit-memory-"));
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const run = async (argv: string[], input?: string): Promise<string> => {
    const child = Bun.spawn(argv, {
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => {
      child.kill();
    }, LANE_DEADLINE_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr}`);
      return stdout;
    } finally {
      clearTimeout(deadline);
    }
  };
  const binary = join(work, "memory");
  await run(["xcrun", "swiftc", "-O", join(import.meta.dir, "webkit-memory.swift"), "-o", binary]);
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "webkit-memory-entry.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  const [bundle] = build.outputs;
  if (!build.success || bundle === undefined)
    throw new Error(`Memory bundle failed: ${build.logs.map((log) => log.message).join("; ")}`);
  const code = await bundle.text();
  server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/entry.js"
        ? new Response(code, { headers: { "content-type": "text/javascript" } })
        : new Response("<!doctype html><title>memory</title>", {
            headers: { "content-type": "text/html" },
          }),
  });
  // Import the same registry only after bundling, rather than maintain a second library list.
  const { PORTABLE_LIBS } = await import("./libs");
  const subjects = [undefined, ...PORTABLE_LIBS.map((library) => library.name)];
  const rows: unknown[] = [];
  for (const library of subjects) {
    const readings: unknown[] = [];
    for (let repeat = 0; repeat < (library === undefined ? 1 : 5); repeat++) {
      // eslint-disable-next-line no-await-in-loop -- Concurrent renderers contaminate each other's memory samples.
      const raw = await run(
        [binary],
        JSON.stringify({
          url: server.url.href,
          library,
          calls: MEMORY_CALLS,
          interval: MEMORY_SAMPLE_INTERVAL,
          operationMs: PLATFORM_OBSERVATION_MS,
        }),
      );
      const reading: unknown = JSON.parse(raw);
      readings.push(reading);
    }
    rows.push({ library: library ?? "held-control", readings });
    console.error(`WebKit RSS: ${library ?? "held-control"} complete`);
  }
  console.log(
    JSON.stringify({
      method:
        "fresh owned WebKit renderer sampled RSS; shared adapters and corpus; final value validated after final sample",
      calls: MEMORY_CALLS,
      sampleInterval: MEMORY_SAMPLE_INTERVAL,
      rows,
    }),
  );
} finally {
  try {
    await server?.stop(true);
  } finally {
    await rm(work, { recursive: true });
  }
}
