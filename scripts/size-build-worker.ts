// SPDX-License-Identifier: Apache-2.0

/**
 * Builds one consumer bundle per message, on its own thread.
 *
 * webpack compiles in JavaScript on one thread, so the size check's ~40 webpack builds queued behind
 * each other in a single thread: 34 s of a 44 s run, while every other bundler finished in under 2 s.
 * A pool of these threads lets the builds use the machine's cores. Results are plain data (`Built`),
 * so they cross the thread boundary by structured clone.
 */

import type { Built, Mode, WorkerRecipe } from "./consumer-bundlers";
import { BUNDLERS } from "./consumer-bundlers";

export type BuildJob = {
  bundler: string;
  entry: string;
  dir: string;
  mode: Mode;
  extra: WorkerRecipe | undefined;
};
export type BuildReply = { ok: true; built: Built } | { ok: false; error: string };

declare const self: Worker;

const build = async (job: BuildJob): Promise<BuildReply> => {
  const bundler = BUNDLERS.find((b) => b.name === job.bundler);
  if (bundler === undefined) return { ok: false, error: `unknown bundler ${job.bundler}` };
  try {
    return { ok: true, built: await bundler.build(job.entry, job.dir, job.mode, job.extra) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const reply = (message: BuildReply): void => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage has no target origin
  self.postMessage(message);
};

self.addEventListener("message", (event: MessageEvent<BuildJob>) => {
  void build(event.data).then(reply);
});
