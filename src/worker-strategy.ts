// SPDX-License-Identifier: Apache-2.0

/**
 * The `worker` execution strategy: pass it as `{ execution: worker }` to run async recovery in a
 * background worker.
 *
 * An imported value, never a string, because only this value may reach the worker code (HLD D5: an
 * app ships only the strategies it names). As a string, `execution: "worker"` made the worker client
 * and its `new Worker(new URL(...))` literal reachable from every async call, and that literal makes
 * Vite, webpack and Rspack emit a worker asset holding a second copy of the engine: about 154 KB of
 * minified JavaScript in apps whose calls could never start a worker. Validation recognises the value
 * by its shape (`async-operation.ts` `strategyOf`), so validating never imports this module.
 * `worker-route.ts` runs the whole route.
 */

import { encodeWorkerOptions } from "./worker-message";
import { runInWorker } from "./worker-route";

/** What a caller sees. The members the planner reads stay off the public type, as for every feature. */
export type WorkerExecution = { readonly feature: "execution"; readonly kind: "worker" };

/** Read by the planner once it has recognised the value: options encode at plan time, once per parser. */
export type WorkerStrategy = WorkerExecution & {
  readonly encode: typeof encodeWorkerOptions;
  readonly start: typeof runInWorker;
};

export const worker: WorkerExecution = /* @__PURE__ */ Object.freeze<WorkerStrategy>({
  feature: "execution",
  kind: "worker",
  encode: encodeWorkerOptions,
  start: runInWorker,
});
