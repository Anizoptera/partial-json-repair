// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runScript } from "../scripts/run-script";

it("joins cancelled child cleanup before settling and capturing its final output", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "pjr-script-settlement-"));
  const ready = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const control = new AbortController();
  const server = createServer((request, response) => {
    if (request.url === "/ready") ready.resolve();
    if (request.url === "/done") done.resolve();
    if (request.url === "/stopping") {
      stopping.resolve();
      void release.promise.then(() => response.end("released"));
    } else response.end("ok");
  });
  let pending: ReturnType<typeof runScript> | undefined;
  let settled = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No local probe port");
    const url = `http://127.0.0.1:${address.port}/`;
    symlinkSync(path.resolve(".tool-versions"), path.join(work, ".tool-versions"));
    writeFileSync(
      path.join(work, "package.json"),
      JSON.stringify({ scripts: { fixture: "bun child.ts" } }),
    );
    // The server holds real cleanup. The child's timer only bounds a broken parent, never readiness.
    writeFileSync(
      path.join(work, "child.ts"),
      `
const url = ${JSON.stringify(url)};
const watchdog = setTimeout(() => process.exit(1), 2000);
process.on("SIGTERM", async () => {
  await fetch(url + "stopping");
  console.log("cleanup completed");
  await fetch(url + "done");
  clearTimeout(watchdog);
  process.exit(0);
});
await fetch(url + "ready");
`,
    );
    const hung = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new Error("Child lifecycle acknowledgement hung"));
      }, 3000);
    });
    const bounded = <Value>(promise: Promise<Value>): Promise<Value> =>
      Promise.race([promise, hung]);
    pending = runScript("fixture", control.signal, [], work).then((result) => {
      settled = true;
      return result;
    });
    try {
      await bounded(ready.promise);
      control.abort();
      await bounded(stopping.promise);
      expect(settled).toBe(false);
      release.resolve();
      const result = await bounded(pending);
      expect(result.kind).toBe("stopped");
      expect(result.output).toContain("cleanup completed");
    } finally {
      release.resolve();
      control.abort();
      await Promise.all([bounded(done.promise), bounded(pending)]);
    }
  } finally {
    clearTimeout(deadline);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(work, { recursive: true });
  }
});
