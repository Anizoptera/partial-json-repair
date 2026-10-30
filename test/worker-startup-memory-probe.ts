// SPDX-License-Identifier: Apache-2.0

// Compare cancelled startup callers with retained promise reactions while a real sibling waits.
export const startupWaiterMemoryProbe = (module: string): string => `
  import { Worker } from "node:worker_threads";
  // The Node-compatible counter can stay fixed on Bun while promise reactions remain live.
  import { heapSize } from "bun:jsc";
  import { parseAsync, worker } from ${JSON.stringify(module)};
  const entered = Promise.withResolvers();
  const once = Worker.prototype.once;
  let acknowledge;
  let started;
  Worker.prototype.once = function(name, listener) {
    started = this;
    return once.call(this, name, name === "message" ? message => {
      acknowledge = () => listener(message);
      entered.resolve();
    } : listener);
  };
  const heap = async () => {
    const used = await new Promise(resolve => setImmediate(() => {
      Bun.gc(true);
      resolve(heapSize());
    }));
    // Reject a broken counter before NaN can make every ownership comparison pass.
    if (!Number.isFinite(used) || used < 0) throw Error("Invalid startup waiter heap counter");
    return used;
  };
  async function churn(count) {
    for (let i = 0; i < count; i++) {
      const signal = { aborted: false, reason: "cancelled",
        addEventListener(_name, cancel) { this.aborted = true; cancel(); },
        removeEventListener() {},
      };
      const result = await parseAsync('{"a":1}', { execution: worker, signal });
      if (result.ok || result.failure.kind !== "aborted") throw Error("Startup cancellation missing");
    }
  }
  try {
    const sibling = parseAsync('{"safe":1}', { execution: worker });
    sibling.then(() => { if (!acknowledge) entered.reject(Error("Startup settled before observation")); });
    await entered.promise;
    await churn(100);
    const before = await heap();
    await churn(10000);
    const cancelled = await heap();
    const control = Promise.withResolvers();
    for (let i = 0; i < 10000; i++) control.promise.then(() => {});
    const retainedControl = await heap();
    control.resolve();
    await control.promise;
    const controlReleased = await heap();
    Worker.prototype.once = once;
    acknowledge();
    const result = await sibling;
    if (!result.ok || result.value.safe !== 1) throw Error("Sibling result lost");
    const startupReleased = await heap();
    const retained = retainedControl - cancelled;
    if (retained <= 0 || retainedControl - controlReleased < retained / 2)
      throw Error("Heap instrument did not detect and release retained promise reactions");
    if (cancelled - before >= retained / 2)
      throw Error("Cancelled startup callers retain promise reactions: " + JSON.stringify({before, cancelled, retainedControl, controlReleased, startupReleased}));
    console.log("cancelled startup waiters released; retained reaction control detected");
  } finally { Worker.prototype.once = once; await started?.terminate(); }
`;
