// SPDX-License-Identifier: Apache-2.0
import { nodeWorkerHostSetup } from "./worker-startup-probe";

// A settled failure must release process liveness even when native termination is refused.
export const workerExitMarker = "Owned failure settled; real thread acknowledged startup";
export const workerExitProbe = (module: string): string => `
${nodeWorkerHostSetup}
import { Worker } from 'node:worker_threads';
import { strict as assert } from 'node:assert';
import { parseAsync, worker } from ${JSON.stringify(module)};
const once = Worker.prototype.once;
const ready = Promise.withResolvers();
const cause = new Error('termination denied before native stop');
Worker.prototype.once = function(name, listener) {
  if (name === 'message') {
    once.call(this, name, ready.resolve);
    throw new Error('startup listener denied');
  }
  return once.call(this, name, listener);
};
Worker.prototype.terminate = function() { return ready.promise.then(() => { throw cause; }); };
const result = await parseAsync('{"safe":1}', { execution: worker });
assert.equal(result.ok, false);
assert.equal(result.failure.kind, 'execution-unavailable');
assert.equal(result.failure.cleanupFailure.cause, cause);
assert.equal(await ready.promise, 'started');
// Neither force process exit nor terminate here: either would hide a referenced idle worker.
console.log(${JSON.stringify(workerExitMarker)});
`;
