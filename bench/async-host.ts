// SPDX-License-Identifier: Apache-2.0

import { availableParallelism, loadavg } from "node:os";

export const runtime = (): string => {
  const deno = (globalThis as { Deno?: { version: { deno: string } } }).Deno;
  if (deno !== undefined) return `deno ${deno.version.deno}`;
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return bun === undefined ? `node ${process.versions.node}` : `bun ${bun.version}`;
};

// Keep the 1/5/15-minute load averages with the observation; a separate log can be lost.
export const captureHostContext = () => ({
  availableParallelism: availableParallelism(),
  loadAverages: loadavg(),
  observedAt: new Date().toISOString(),
});
