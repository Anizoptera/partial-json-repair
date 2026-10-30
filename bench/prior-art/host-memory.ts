#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

import { dlopen } from "bun:ffi";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Miniflare } from "miniflare";
import { openBrowser } from "../../scripts/browser";
import { LANE_DEADLINE_MS } from "../../scripts/run-script";
import { captureHostContext } from "../async-host";
import { MEMORY_CALLS, MEMORY_SAMPLE_INTERVAL } from "./memory-method";

const host = process.argv[2];
if (host !== "chromium" && host !== "workerd")
  throw new Error(
    "Build first, then run host-memory.ts chromium|workerd; ONLY may select one library",
  );
if (process.platform !== "darwin") throw new Error("This OS RSS sampler requires macOS");

type Request =
  | { operation: "control" }
  | { operation: "select"; argument: string }
  | { operation: "advance" | "validate"; argument: number };
type Driver = {
  invoke(request: Request): Promise<unknown>;
  pids: number[];
  version: string;
  close(): void | Promise<void>;
};
const work = await mkdtemp(join(tmpdir(), "pjr-host-memory-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let sampler:
  | ReturnType<typeof dlopen<{ resident_bytes: { args: ["i32"]; returns: "u64" } }>>
  | undefined;
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
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(`${argv[0]} exited ${status}: ${stderr}`);
      return stdout;
    } finally {
      clearTimeout(deadline);
    }
  };
  const dylib = join(work, "resident-memory.dylib");
  await run([
    "xcrun",
    "clang",
    "-dynamiclib",
    "-O2",
    join(import.meta.dir, "resident-memory.c"),
    "-lproc",
    "-o",
    dylib,
  ]);
  sampler = dlopen(dylib, { resident_bytes: { args: ["i32"], returns: "u64" } });
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
  const context = captureHostContext();
  const artifactDigest = new Bun.CryptoHasher("sha256").update(code).digest("hex");
  if (host === "chromium")
    server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/entry.js"
          ? new Response(code, { headers: { "content-type": "text/javascript" } })
          : new Response("<!doctype html><title>memory</title>", {
              headers: { "content-type": "text/html" },
            }),
    });
  let workerdVersion: string | undefined;
  const open = async (): Promise<Driver> => {
    if (host === "chromium") {
      if (server === undefined) throw new Error("Chromium memory server is unavailable");
      const view = await openBrowser("chrome");
      try {
        await view.navigate(server.url.href);
        await view.evaluate(
          'import("/entry.js").then((module) => { globalThis.subject = module; return true; })',
        );
        const pids = await view.rendererPids?.();
        if (pids === undefined || pids.length === 0)
          throw new Error("Owned Chromium returned no renderer PIDs");
        return {
          pids,
          version: view.engineVersion ?? "unknown",
          invoke: (request) =>
            view.evaluate(
              `subject[${JSON.stringify(request.operation)}](${"argument" in request ? JSON.stringify(request.argument) : ""})`,
            ),
          close: () => view.close(),
        };
      } catch (error) {
        await view.close();
        throw error;
      }
    }
    const mf = new Miniflare({
      modules: [
        {
          type: "ESModule",
          path: "worker.mjs",
          contents:
            'import * as subject from "./entry.mjs"; export default { async fetch(request) { const call = await request.json(); return Response.json(subject[call.operation](call.argument)); } };',
        },
        { type: "ESModule", path: "entry.mjs", contents: code },
      ],
      compatibilityDate: "2026-07-01",
    });
    try {
      await mf.ready;
      // Only the directly owned workerd child is eligible; another project's runtime is not ours.
      const children = (await run(["/bin/ps", "-Ao", "pid=,ppid=,comm="]))
        .trim()
        .split("\n")
        .flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
          return match !== null &&
            Number(match[2]) === process.pid &&
            basename(match[3] ?? "") === "workerd"
            ? [{ pid: Number(match[1]), executable: match[3] ?? "" }]
            : [];
        });
      const [child] = children;
      if (children.length !== 1 || child === undefined)
        throw new Error("Owned workerd process is ambiguous or absent");
      workerdVersion ??= (await run([child.executable, "--version"])).trim();
      return {
        pids: [child.pid],
        version: workerdVersion,
        async invoke(request) {
          const response = await mf.dispatchFetch("http://localhost/memory", {
            method: "POST",
            body: JSON.stringify(request),
          });
          if (!response.ok) throw new Error(`workerd memory operation failed: ${response.status}`);
          return response.json();
        },
        close: () => mf.dispose(),
      };
    } catch (error) {
      await mf.dispose();
      throw error;
    }
  };
  const { PORTABLE_LIBS } = await import("./libs");
  const libraries = PORTABLE_LIBS.filter(
    (library) => process.env.ONLY === undefined || library.name === process.env.ONLY,
  );
  if (libraries.length === 0) throw new Error(`Unknown memory subject: ${process.env.ONLY}`);
  const sample = async (library: string | undefined) => {
    const driver = await open();
    try {
      const rss = (): number =>
        driver.pids.reduce((sum, pid) => {
          const bytes = Number(sampler?.symbols.resident_bytes(pid));
          if (!Number.isSafeInteger(bytes) || bytes <= 0)
            throw new Error(`No RSS for owned process ${pid}`);
          return sum + bytes;
        }, 0);
      let peakBytes = 0;
      let baselineBytes: number | undefined;
      if (library === undefined) {
        baselineBytes = rss();
        if ((await driver.invoke({ operation: "control" })) !== true)
          throw new Error("Held control failed");
        peakBytes = rss();
        if (peakBytes <= baselineBytes) throw new Error("RSS missed the held control");
      } else {
        await driver.invoke({ operation: "select", argument: library });
        for (let completed = 0; completed < MEMORY_CALLS;) {
          const count =
            completed === 0 ? 1 : Math.min(MEMORY_SAMPLE_INTERVAL, MEMORY_CALLS - completed);
          // eslint-disable-next-line no-await-in-loop -- Native sampling uses the same sequential parse batches.
          await driver.invoke({ operation: "advance", argument: count });
          completed += count;
          peakBytes = Math.max(peakBytes, rss());
        }
        if ((await driver.invoke({ operation: "validate", argument: MEMORY_CALLS })) !== true)
          throw new Error(`Wrong final value or count: ${library}`);
      }
      return { peakBytes, baselineBytes, pids: driver.pids, version: driver.version };
    } finally {
      await driver.close();
    }
  };
  const rows = [];
  for (const library of [undefined, ...libraries.map((entry) => entry.name)]) {
    const samples = [];
    for (let repeat = 0; repeat < (library === undefined ? 1 : 5); repeat++) {
      // eslint-disable-next-line no-await-in-loop -- Separate owned hosts keep memory observations independent.
      samples.push(await sample(library));
    }
    rows.push({ library: library ?? "held-control", samples });
    console.error(`${host} RSS: ${library ?? "held-control"} complete`);
  }
  console.log(
    JSON.stringify({
      host,
      context,
      artifactDigest,
      calls: MEMORY_CALLS,
      interval: MEMORY_SAMPLE_INTERVAL,
      rows,
    }),
  );
} finally {
  try {
    await server?.stop(true);
  } finally {
    try {
      sampler?.close();
    } finally {
      await rm(work, { recursive: true });
    }
  }
}
