// SPDX-License-Identifier: Apache-2.0

import {
  preIterationStops,
  verifyPreIterationCancellation,
} from "./pre-iteration-cancellation-probe";

// Remove the capability, not the worker: cancellation must still cross the real control port.
export const workerMessageCancellationProbe = (module: string, core: string): string => `
import { strict as assert } from 'node:assert';
import { MessagePort } from 'node:worker_threads';
import { parse, repair, findJsonSpan } from ${JSON.stringify(core)};
import { initAsyncParser, parseAsync, parseManyAsync, repairAsync, findJsonSpanAsync, worker } from ${JSON.stringify(module)};
const storage = globalThis.SharedArrayBuffer;
globalThis.SharedArrayBuffer = undefined;
try {
  const result = await parseAsync('{"safe":1}', { execution: worker });
  assert.equal(result.ok, true, 'A worker host without shared memory must remain usable');
  assert.deepEqual(result.value, { safe: 1 });
  for (const [direct, scheduled] of [[parse, parseAsync], [repair, repairAsync], [findJsonSpan, findJsonSpanAsync]]) {
    for (const input of ['prefix {"safe":1} suffix', '{"a":{"b":{"c":1}}}']) {
      const options = { maxDepth: 1 };
      assert.deepEqual(await scheduled(input, { ...options, execution: worker }), direct(input, options));
    }
  }
  const task = new AbortController();
  ${verifyPreIterationCancellation.toString()}
  for (const firstStop of ${JSON.stringify(preIterationStops)})
    await verifyPreIterationCancellation(initAsyncParser, parseManyAsync, firstStop, worker);
  const local = new AbortController();
  const parser = initAsyncParser({ execution: worker, signal: task.signal });
  const first = parseManyAsync('{"a":1}\\n{"a":2}\\n{"a":3}', parser, { signal: local.signal });
  const sibling = parseManyAsync('{"b":1}\\n{"b":2}\\n{"b":3}', parser);
  try {
    assert.deepEqual((await first.next()).value.value, { a: 1 });
    assert.deepEqual((await sibling.next()).value.value, { b: 1 });
    const localReason = { stopped: 'local' };
    local.abort(localReason);
    const stopped = (await first.next()).value;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.failure.kind, 'aborted');
    assert.equal(stopped.failure.reason, localReason);
    assert.deepEqual((await sibling.next()).value.value, { b: 2 });
    const taskReason = { stopped: 'task' };
    task.abort(taskReason);
    const taskStopped = (await sibling.next()).value;
    assert.equal(taskStopped.ok, false);
    assert.equal(taskStopped.failure.kind, 'aborted');
    assert.equal(taskStopped.failure.reason, taskReason);
    assert.equal(stopped.failure.reason, localReason, 'Task cancellation replaced the local reason');
  } finally {
    await Promise.all([first.return(), sibling.return()]);
    parser.close();
  }
  const add = MessagePort.prototype.addEventListener;
  let faults = 0;
  MessagePort.prototype.addEventListener = function(name, listener, ...options) {
    const registered = add.call(this, name, listener, ...options);
    if (name === 'messageerror') {
      faults++;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('messageerror')));
    }
    return registered;
  };
  try {
    for (const operation of [parseAsync, repairAsync, findJsonSpanAsync]) {
      const result = await operation('{"a":"' + 'x'.repeat(65536) + '"}', {
        execution: worker, signal: new AbortController().signal,
      });
      assert.equal(result.ok, false);
      assert.equal(result.failure.kind, 'execution-unavailable');
    }
    assert.equal(faults, 3, 'Receiver faults did not reach every projection');
  } finally { MessagePort.prototype.addEventListener = add; }
  console.log('Message cancellation: worker reuse, cancellation, recovery and receiver-fault cleanup passed');
} finally { globalThis.SharedArrayBuffer = storage; }
`;
