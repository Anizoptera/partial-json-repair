// SPDX-License-Identifier: Apache-2.0

import { nodeWorkerHostSetup } from "./worker-startup-probe";

// Separate processes keep startup cold and native host faults isolated from sibling probes.
export const workerHostStartProbes = (): readonly string[] =>
  [
    // Deliver a native port event while the real worker owns the request; cleanup is a separate fault.
    `
    import { MessagePort } from "node:worker_threads";
    import { parseAsync, worker } from "partial-json-repair/async";
    const options = { execution: worker };
    if (!(await parseAsync('{"safe":1}', options)).ok) throw Error("warmup failed");
    const controller = new AbortController();
    const cleanup = new Error("signal release failed");
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (...args) => { remove(...args); throw cleanup; };
    const add = MessagePort.prototype.addEventListener;
    let injected = false;
    MessagePort.prototype.addEventListener = function(...args) {
      const result = add.apply(this, args);
      if (args[0] === "messageerror" && !injected) {
        injected = true;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("messageerror")));
      }
      return result;
    };
    try {
      const result = await parseAsync('{"safe":2}', { ...options, signal: controller.signal });
      if (!injected || result.ok || result.failure.kind !== "execution-unavailable" ||
          result.failure.reason !== "failed" || result.failure.cleanupFailure?.cause !== cleanup)
        throw Error("receive failure lost its typed outcome or cleanup cause");
    } finally { MessagePort.prototype.addEventListener = add; }
    const next = await parseAsync('{"safe":3}', options);
    if (!next.ok || next.value.safe !== 3) throw Error("receive failure broke reuse");
    console.log("receive failure preserves cleanup and reuse");
  `,
    // Use a real thread with browser-style idle ownership; neither setup fault may post caller input.
    ...[false, true].map(
      (releaseFails) => `
    import { Worker } from "node:worker_threads";
    import { parseAsync, worker } from "partial-json-repair/async";
    const buffer = globalThis.SharedArrayBuffer;
    const unref = Worker.prototype.unref;
    const terminate = Worker.prototype.terminate;
    const post = Worker.prototype.postMessage;
    const cleanup = new Error("idle worker termination failed");
    let posted = 0;
    Worker.prototype.unref = undefined;
    Worker.prototype.postMessage = function(...args) { posted++; return post.apply(this, args); };
    Worker.prototype.terminate = async function() {
      await terminate.call(this);
      if (${releaseFails}) throw cleanup;
    };
    globalThis.SharedArrayBuffer = class { constructor() { throw Error("stop allocation failed"); } };
    try {
      const result = await parseAsync('{"safe":1}', { execution: worker });
      if (posted !== 0 || result.ok || result.failure.kind !== "execution-unavailable" ||
          result.failure.reason !== "failed") throw Error("setup failure lost its typed result");
      if (result.failure.cleanupFailure?.cause !== (${releaseFails} ? cleanup : undefined))
        throw Error("setup failure lost its cleanup cause");
    } finally {
      globalThis.SharedArrayBuffer = buffer;
      Worker.prototype.unref = unref;
      Worker.prototype.terminate = terminate;
      Worker.prototype.postMessage = post;
    }
    const next = await parseAsync('{"safe":2}', { execution: worker });
    if (!next.ok || next.value.safe !== 2) throw Error("setup cleanup broke worker retry");
    console.log("allocation failure preserves cleanup and retry");
  `,
    ),
    // Abort at the real startup acknowledgement, before the request can cross the worker boundary.
    ...[false, true].map(
      (releaseFails) => `
    import { Worker } from "node:worker_threads";
    import { parseAsync, worker } from "partial-json-repair/async";
    import { diagnostics } from "partial-json-repair";
    const stop = new AbortController();
    const reason = { stopped: "startup" };
    const cleanup = new Error("startup signal release failed");
    if (${releaseFails}) stop.signal.removeEventListener = () => { throw cleanup; };
    const once = Worker.prototype.once;
    const post = Worker.prototype.postMessage;
    let posted = 0;
    Worker.prototype.once = function(name, listener) {
      return once.call(this, name, name === "message" ? (message) => {
        stop.abort(reason);
        listener(message);
      } : listener);
    };
    Worker.prototype.postMessage = function(...args) { posted++; return post.apply(this, args); };
    try {
      const result = await parseAsync('{"safe":1}', { execution: worker, signal: stop.signal, diagnostics });
      if (posted !== 0) throw Error("cancelled startup posted caller input");
      if (result.ok || result.failure.kind !== "aborted" || result.failure.reason !== reason ||
          result.failure.recovered !== undefined || result.diagnostics === undefined)
        throw Error("startup cancellation lost its typed outcome or report");
      if (${releaseFails} && result.failure.cleanupFailure?.cause !== cleanup)
        throw Error("startup cancellation lost its cleanup cause");
    } finally { Worker.prototype.once = once; Worker.prototype.postMessage = post; }
    const next = await parseAsync('{"safe":2}', { execution: worker });
    if (!next.ok || next.value.safe !== 2) throw Error("startup cancellation broke worker reuse");
    console.log("startup cancellation leaves input unread and worker usable");
  `,
    ),
    // Observe the real worker's startup message; constructor completion is not entry readiness.
    `
    import { Worker } from "node:worker_threads";
    import { parseAsync, worker } from "partial-json-repair/async";
    const originalOnce = Worker.prototype.once;
    const originalPost = Worker.prototype.postMessage;
    let started = false;
    Worker.prototype.once = function(name, listener) {
      return originalOnce.call(this, name, name === "message" ? (message) => {
        if (message === "started") started = true;
        listener(message);
      } : listener);
    };
    Worker.prototype.postMessage = function(...args) {
      if (!started) throw Error("caller input posted before worker startup acknowledgement");
      return originalPost.apply(this, args);
    };
    try {
      const result = await parseAsync('{"safe":3}', { execution: worker });
      if (!started || !result.ok || result.value.safe !== 3) throw Error("worker readiness missing");
      console.log("worker startup acknowledged before input");
    } finally {
      Worker.prototype.once = originalOnce;
      Worker.prototype.postMessage = originalPost;
    }
  `,
    // Terminate a real thread before subscribing to startup; exit must settle the pending load.
    `
    import { Worker } from "node:worker_threads";
    import { parseAsync, worker } from "partial-json-repair/async";
    const original = Worker.prototype.once;
    let interrupted = false;
    Worker.prototype.once = function(name, listener) {
      if (name === "message" && !interrupted) {
        interrupted = true;
        void this.terminate();
        return this;
      }
      return original.call(this, name, listener);
    };
    try {
      const result = await parseAsync('{"safe":1}', { execution: worker });
      if (!interrupted || result.ok || result.failure.kind !== "execution-unavailable" ||
          result.failure.reason !== "failed") throw Error("startup exit did not settle as failure");
    } finally { Worker.prototype.once = original; }
    const next = await parseAsync('{"safe":2}', { execution: worker });
    if (!next.ok || next.value.safe !== 2) throw Error("failed startup remained cached");
    console.log("worker startup exit settles and retries");
  `,
  ].map((program) => `${nodeWorkerHostSetup}\n${program}`);
