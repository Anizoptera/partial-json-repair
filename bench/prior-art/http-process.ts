// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { InstalledRuntime } from "./runtimes";
import type { HttpEnding, HttpMode } from "./http-model";

export async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  // A deadline rejects a hang; only the listener or process acknowledgement establishes completion.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not settle`));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function observeHttpService<Result>(
  url: string,
  run: () => Promise<Result>,
  record: (metrics: { probes: number; maxHealthMs: number }) => void,
): Promise<Result> {
  let probing = true;
  let count = 0;
  let maximum = 0;
  const probes = (async () => {
    // One probe loop observes the whole batch; retaining every latency adds no evidence.
    /* eslint-disable no-await-in-loop -- Keep only one competing health request in flight. */
    // eslint-disable-next-line no-unmodified-loop-condition -- The operation owner stops probing in finally.
    while (probing) {
      const start = performance.now();
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
      if ((await response.text()) !== "ok") throw new Error("Competing health request failed");
      maximum = Math.max(maximum, performance.now() - start);
      count++;
    }
    /* eslint-enable no-await-in-loop */
  })();
  // Keep a rejection observed until the owner awaits it during cleanup.
  void probes.catch(() => undefined);
  try {
    return await run();
  } finally {
    probing = false;
    await probes;
    record({ probes: count, maxHealthMs: maximum });
  }
}

export async function requestHttpJob(
  url: string,
  job: { id: string; case: string; mode: HttpMode; ending: HttpEnding },
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(job);
  const stop = new AbortController();
  const response = await fetch(`${url}/job?${query.toString()}`, {
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new Error(`HTTP job failed: ${await response.text()}`);
  if (job.ending === "cancel") {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing cancellation response body");
    try {
      const first = await reader.read();
      if (first.done || !new TextDecoder().decode(first.value).includes("progress"))
        throw new Error("Cancellation did not reach a real model delta");
      // Abort the actual request before releasing its reader; otherwise its source may keep running.
      stop.abort();
      try {
        await reader.cancel();
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
      }
    } finally {
      reader.releaseLock();
    }
  } else await response.text();
  const settled = await fetch(`${url}/settled?id=${encodeURIComponent(job.id)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!settled.ok) throw new Error(`Job settlement failed: ${await settled.text()}`);
  const metrics = (await settled.json()) as Record<string, unknown>;
  if (typeof metrics.maxGapMs !== "number" || !Number.isFinite(metrics.maxGapMs))
    throw new Error("Missing finite server-loop measurement");
  return metrics;
}

export async function startHttp(runtime: InstalledRuntime, args: string[], cwd: string) {
  const child = spawn(runtime.argv[0] ?? "", [...runtime.argv.slice(1), ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  let errors = "";
  child.stderr.on("data", (part: Buffer) => {
    errors += part.toString();
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await bounded(
      Promise.race([
        new Promise<string>((resolve) => {
          lines.once("line", resolve);
        }),
        exit.then((code) => {
          throw new Error(`HTTP child exited ${String(code)}: ${errors}`);
        }),
      ]),
      "HTTP listener readiness",
    );
    const { ready: url } = JSON.parse(ready) as { ready: string };
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`Invalid HTTP readiness: ${ready}`);
    return {
      url,
      close: async () => {
        child.stdin.end();
        try {
          const code = await bounded(exit, "HTTP listener shutdown");
          if (code !== 0) throw new Error(`HTTP child failed ${String(code)}: ${errors}`);
        } finally {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
            await exit;
          }
          lines.close();
        }
      },
    };
  } catch (error) {
    child.kill();
    await exit;
    lines.close();
    throw error;
  }
}
