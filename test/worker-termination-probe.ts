// SPDX-License-Identifier: Apache-2.0
import { nodeWorkerHostSetup } from "./worker-startup-probe";

// Fault before native termination: an error reported after stopping cannot expose lost ownership.
export const workerTerminationProbe = (
  module: string,
  phase: "startup" | "startup-unref" | "idle",
  rejection: boolean,
): string => `
${nodeWorkerHostSetup}
import { Worker } from 'node:worker_threads';
import { strict as assert } from 'node:assert';
import { parseAsync, worker } from ${JSON.stringify(module)};

const once = Worker.prototype.once;
const terminate = Worker.prototype.terminate;
const unref = Worker.prototype.unref;
const storage = globalThis.SharedArrayBuffer;
const phase = ${JSON.stringify(phase)};
const threads = new Map();
const live = new Set();
const setup = new Error('startup listener failed');
const cleanup = new Error('termination failed before stopping the thread');
let fault = true;
Worker.prototype.once = function(name, listener) {
  if (name === 'message') {
    if (!threads.has(this)) {
      const ready = Promise.withResolvers();
      threads.set(this, ready.promise);
      live.add(this);
      once.call(this, 'exit', () => live.delete(this));
      once.call(this, 'message', ready.resolve);
    }
    if (fault && phase !== 'idle') throw setup;
  }
  return once.call(this, name, listener);
};
Worker.prototype.terminate = function() { ${rejection ? "return Promise.reject(cleanup);" : "throw cleanup;"} };
if (phase === 'startup-unref') Worker.prototype.unref = function() { throw setup; };
if (phase === 'idle') {
  Worker.prototype.unref = undefined;
  globalThis.SharedArrayBuffer = class { constructor() { throw setup; } };
}
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await parseAsync('{"safe":1}', { execution: worker });
    assert.equal(result.ok, false);
    assert.equal(result.failure.kind, 'execution-unavailable');
    if (phase === 'startup-unref') {
      assert.deepEqual(result.failure.cleanupFailure?.cause.errors, [cleanup, setup]);
    } else assert.equal(result.failure.cleanupFailure?.cause, cleanup);
    // The operation released its reference; this observer alone keeps startup visible until ack.
    for (const thread of threads.keys()) thread.ref();
    const ready = await Promise.all(threads.values());
    for (const thread of threads.keys()) unref.call(thread);
    assert(ready.every(message => message === 'started'), 'Real worker never acknowledged startup');
  }
  console.log('Failed calls left '+threads.size+' started threads');
  assert.equal(threads.size, 1, 'Retry allocated another thread before owned termination succeeded');
  fault = false;
  if (phase === 'startup-unref') Worker.prototype.unref = unref;
  globalThis.SharedArrayBuffer = storage;
  const releasing = Promise.withResolvers();
  const release = Promise.withResolvers();
  let releases = 0;
  Worker.prototype.terminate = function() {
    releases++;
    releasing.resolve();
    return release.promise.then(() => terminate.call(this));
  };
  const stop = new AbortController();
  const reason = { stopped: 'owned-release' };
  const cancelled = parseAsync('{"safe":3}', { execution: worker, signal: stop.signal });
  const healthy = parseAsync('{"safe":2}', { execution: worker });
  await releasing.promise;
  stop.abort(reason);
  release.resolve();
  const stopped = await cancelled;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.failure.kind, 'aborted');
  assert.equal(stopped.failure.reason, reason);
  const recovered = await healthy;
  Worker.prototype.terminate = terminate;
  assert.equal(releases, phase === 'idle' ? 2 : 1, 'Concurrent callers did not share owned release');
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.value, { safe: 2 });
  assert.equal(threads.size, 2, 'Successful cleanup did not permit one replacement');
  console.log('Worker termination ownership: bounded retries and recovery passed');
} finally {
  Worker.prototype.once = once;
  Worker.prototype.terminate = terminate;
  Worker.prototype.unref = unref;
  globalThis.SharedArrayBuffer = storage;
  // Bun 1.3 can leave a second termination pending after exit; clean only threads still owned.
  await Promise.all([...live].map(thread => terminate.call(thread)));
}
`;
