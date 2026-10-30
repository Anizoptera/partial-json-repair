// SPDX-License-Identifier: Apache-2.0

// Exercise Deno's real Web Worker and Node ports; no replacement engine can prove their lifetimes.
const DENO_STARTUP_FAULTS = ["exit", "error"] as const;
const denoStartupFailureProbe = (
  module: string,
  fault: (typeof DENO_STARTUP_FAULTS)[number],
): string => `
import { parseAsync, worker } from ${JSON.stringify(module)};
const NativeWorker = globalThis.Worker;
const post = NativeWorker.prototype.postMessage;
if (${JSON.stringify(fault)} === "exit") NativeWorker.prototype.postMessage = function(message, transfers) {
  // Exit before transfer is a different host failure from exit after receiving the port.
  this.terminate();
  return post.call(this, message, transfers);
};
const source = ${JSON.stringify(fault === "exit" ? "close();" : 'throw Error("startup failed");')};
globalThis.Worker = new Proxy(NativeWorker, { construct(Target, args, newTarget) {
  return Reflect.construct(Target, [new URL("data:application/javascript," + encodeURIComponent(source)), ...args.slice(1)], newTarget);
} });
let failed;
try { failed = await parseAsync('{"safe":1}', { execution: worker }); }
finally { globalThis.Worker = NativeWorker; NativeWorker.prototype.postMessage = post; }
if (failed.ok || failed.failure.kind !== "execution-unavailable" || failed.failure.reason !== "failed")
  throw Error("Worker startup exit or error did not settle as a typed failure");
const next = await parseAsync('{"safe":2}', { execution: worker });
if (!next.ok || next.value.safe !== 2) throw Error("Worker startup failure poisoned retry");
console.log("Deno worker startup failure settles and retries");
`;

const denoStartupTimerProbe = (module: string): string => `
import { parseAsync, worker } from ${JSON.stringify(module)};
const schedule = globalThis.setTimeout, clear = globalThis.clearTimeout;
const pending = new Set();
let rejected = false;
// Observe real timers; reject release before the native operation so lost ownership stays visible.
globalThis.setTimeout = (callback, delay, ...args) => {
  const handle = schedule((...values) => { pending.delete(handle); callback(...values); }, delay, ...args);
  pending.add(handle);
  return handle;
};
globalThis.clearTimeout = handle => {
  if (pending.has(handle) && !rejected) { rejected = true; throw Error("startup timer release failed"); }
  clear(handle);
  pending.delete(handle);
};
try {
  const result = await parseAsync('{"safe":1}', { execution: worker });
  if (!rejected || result.ok || result.failure.kind !== "execution-unavailable")
    throw Error("Startup timer release fault did not reach its typed failure");
  if (pending.size !== 0) throw Error("Failed startup lost its live timer handle");
} finally {
  globalThis.setTimeout = schedule;
  globalThis.clearTimeout = clear;
  for (const handle of pending) clear(handle);
}
const retry = await parseAsync('{"safe":2}', { execution: worker });
if (!retry.ok || retry.value.safe !== 2) throw Error("Startup timer failure poisoned retry");
console.log("Deno startup timer release preserves ownership and retry");
`;

const denoStartupCancellationProbe = (module: string, sibling: boolean): string => `
import { MessagePort } from "node:worker_threads";
import { parseAsync, worker } from ${JSON.stringify(module)};
const add = MessagePort.prototype.addEventListener;
const stop = new AbortController(), reason = { stopped: "pending startup" };
let acknowledge;
MessagePort.prototype.addEventListener = function(name, listener, ...options) {
  return add.call(this, name, name === "message" ? event => {
    if (event.data === "started" && acknowledge === undefined) {
      acknowledge = () => listener(event);
      stop.abort(reason);
    } else listener(event);
  } : listener, ...options);
};
try {
  const cancelled = parseAsync('{"a":1}', { execution: worker, signal: stop.signal });
  const sibling = ${sibling} ? parseAsync('{"b":2}', { execution: worker }) : undefined;
  const result = await cancelled;
  if (result.ok || result.failure.kind !== "aborted" || result.failure.reason !== reason || !acknowledge)
    throw Error("Startup cancellation did not settle before the held acknowledgement");
  MessagePort.prototype.addEventListener = add;
  acknowledge();
  if (sibling !== undefined) {
    const result = await sibling;
    if (!result.ok || result.value.b !== 2) throw Error("Startup cancellation stopped its sibling");
  }
  const next = await parseAsync('{"safe":3}', { execution: worker });
  if (!next.ok || next.value.safe !== 3) throw Error("Startup cancellation poisoned reuse");
  console.log("Deno startup cancellation preserves sibling and reuse");
} finally { MessagePort.prototype.addEventListener = add; }
`;

const denoStartupCleanupProbe = (module: string): string => `
import { MessagePort } from "node:worker_threads";
import { parseAsync, worker } from ${JSON.stringify(module)};
const add = MessagePort.prototype.addEventListener, close = MessagePort.prototype.close;
const post = Worker.prototype.postMessage;
const causes = [Error("startup receive close failed"), Error("startup send close failed")];
const ports = [], failedPorts = new Set();
Worker.prototype.postMessage = function(message, transfers) {
  if (message.operation === "start") ports[1] = message.port;
  return post.call(this, message, transfers);
};
MessagePort.prototype.addEventListener = function(name, listener, ...options) {
  return add.call(this, name, name === "message" ? event => {
    if (event.data === "started") {
      ports[0] = this;
      this.unref = () => { throw Error("startup reference release failed"); };
    }
    listener(event);
  } : listener, ...options);
};
MessagePort.prototype.close = function() {
  const index = ports.indexOf(this);
  if (index !== -1 && !failedPorts.has(this)) {
    failedPorts.add(this);
    throw causes[index];
  }
  return close.call(this);
};
let failed;
try { failed = await parseAsync('{"safe":1}', { execution: worker }); }
finally {
  Worker.prototype.postMessage = post;
  MessagePort.prototype.addEventListener = add;
  MessagePort.prototype.close = close;
  for (const port of ports) if (port !== undefined) close.call(port);
}
if (ports.length !== 2 || failedPorts.size !== 2 || failed.ok || failed.failure.kind !== "execution-unavailable" ||
    failed.failure.cleanupFailure?.cause.errors?.[0] !== causes[0] ||
    failed.failure.cleanupFailure?.cause.errors?.[1] !== causes[1])
  throw Error("Startup channel cleanup did not attempt both closes and preserve both causes");
const next = await parseAsync('{"safe":2}', { execution: worker });
if (!next.ok || next.value.safe !== 2) throw Error("Startup channel cleanup poisoned retry");
console.log("Deno startup channel cleanup preserves both causes and retry");
`;

const denoReferenceFailureProbe = (module: string): string => `
import { parseAsync, worker } from ${JSON.stringify(module)};
const NativeWorker = Worker, terminate = Worker.prototype.terminate;
const symbol = Object.getOwnPropertySymbols(Worker.prototype).find(key => key.description === undefined);
const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, symbol);
if (typeof descriptor?.value !== "function") throw Error("Deno reference hook fixture is unavailable");
const setup = Error("reference release failed"), cleanup = Error("termination failed");
const threads = new Set();
let fault = true;
const reference = function(referenced) {
  if (fault && !referenced) throw setup;
  return descriptor.value.call(this, referenced);
};
Object.defineProperty(reference, "name", {value: descriptor.value.name});
Object.defineProperty(Worker.prototype, symbol, {...descriptor, value: reference});
Worker.prototype.terminate = function() { if (fault) throw cleanup; return terminate.call(this); };
globalThis.Worker = new Proxy(NativeWorker, { construct(Target, args, newTarget) {
  const worker = Reflect.construct(Target, args, newTarget); threads.add(worker); return worker;
} });
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await parseAsync('{"safe":1}', {execution: worker});
    if (result.ok || result.failure.kind !== "execution-unavailable" ||
        result.failure.cleanupFailure?.cause.errors?.[0] !== cleanup ||
        result.failure.cleanupFailure?.cause.errors?.[1] !== setup)
      throw Error("Reference and termination failures lost their independent cleanup causes");
  }
  if (threads.size !== 1) throw Error("Failed termination allocated another live worker");
  fault = false;
  Worker.prototype.terminate = terminate;
  Object.defineProperty(Worker.prototype, symbol, descriptor);
  const next = await parseAsync('{"safe":2}', {execution: worker});
  if (!next.ok || next.value.safe !== 2 || threads.size !== 2)
    throw Error("Successful termination did not permit one healthy replacement");
  console.log("Deno reference failures preserve bounded ownership and retry");
} finally {
  fault = false;
  globalThis.Worker = NativeWorker;
  NativeWorker.prototype.terminate = terminate;
  Object.defineProperty(NativeWorker.prototype, symbol, descriptor);
  for (const worker of threads) terminate.call(worker);
}
`;

const denoWorkerLifetimeProbe = (module: string): string => `
import { Worker as ThreadWorker } from "node:worker_threads";
import { parseAsync, parseManyAsync, worker } from ${JSON.stringify(module)};
const NativeWorker = Worker, on = ThreadWorker.prototype.on, threads = new Set();
ThreadWorker.prototype.on = function(...args) { threads.add(this); return on.apply(this, args); };
globalThis.Worker = new Proxy(NativeWorker, { construct(Target, args, newTarget) {
  const worker = Reflect.construct(Target, args, newTarget); threads.add(worker); return worker;
} });
try {
  for (let pass = 0; pass < 3; pass++) {
    const values = await Promise.all([1, 2].map(safe => parseAsync('{"safe":' + safe + '}', {execution: worker})));
    if (values.some((value, index) => !value.ok || value.value.safe !== index + 1))
      throw Error("Concurrent worker calls changed their results");
  }
  const call = parseManyAsync('{"a":1}{"a":2}', {execution: worker});
  const first = await call.next();
  if (first.done || !first.value.ok || first.value.value.a !== 1 || threads.size !== 1)
    throw Error("Worker reuse or the suspended iterator lost its first root");
  // No return or forced exit: a suspended consumer must not keep this process alive.
  console.log("Deno worker reuses one thread and releases suspended-consumer liveness");
} finally { globalThis.Worker = NativeWorker; ThreadWorker.prototype.on = on; }
`;

const denoIdleExitProbe = (module: string): string => `
import { parseAsync, worker } from ${JSON.stringify(module)};
const NativeWorker = Worker, threads = [];
globalThis.Worker = new Proxy(NativeWorker, { construct(Target, args, newTarget) {
  const worker = Reflect.construct(Target, args, newTarget); threads.push(worker); return worker;
} });
try {
  const first = await parseAsync('{"safe":1}', {execution: worker});
  if (!first.ok || first.value.safe !== 1 || threads.length !== 1) throw Error("Idle-exit fixture never started");
  threads[0].terminate();
  const interrupted = await parseAsync('{"safe":2}', {execution: worker});
  if (interrupted.ok ? interrupted.value.safe !== 2 :
      interrupted.failure.kind !== "execution-unavailable" || interrupted.failure.reason !== "failed")
    throw Error("Unexpected worker exit changed recovery or lost its typed failure");
  const next = await parseAsync('{"safe":3}', {execution: worker});
  if (!next.ok || next.value.safe !== 3 || threads.length !== 2) throw Error("Unexpected idle exit poisoned reuse");
  console.log("Deno idle worker exit settles and replaces one dead thread");
} finally { globalThis.Worker = NativeWorker; for (const worker of threads) worker.terminate(); }
`;

const denoAmbiguousReferenceProbe = (module: string): string => `
import { parseAsync, worker } from ${JSON.stringify(module)};
const symbol = Symbol();
let called = false;
const reference = function(referenced) { called = true; throw Error("Unqualified private hook called"); };
Object.defineProperty(reference, "name", {value: ""});
Object.defineProperty(Worker.prototype, symbol, {configurable: true, value: reference});
try {
  const result = await parseAsync('{"safe":1}', {execution: worker});
  if (called || !result.ok || result.value.safe !== 1)
    throw Error("Ambiguous worker capability did not retain the working Node backend");
  console.log("Deno ambiguous reference capability falls back without guessing");
} finally { delete Worker.prototype[symbol]; }
`;

export const denoWorkerProbes = (module: string): readonly string[] => [
  ...DENO_STARTUP_FAULTS.map((fault) => denoStartupFailureProbe(module, fault)),
  ...[false, true].map((sibling) => denoStartupCancellationProbe(module, sibling)),
  denoStartupCleanupProbe(module),
  denoReferenceFailureProbe(module),
  denoWorkerLifetimeProbe(module),
  denoIdleExitProbe(module),
  denoAmbiguousReferenceProbe(module),
  denoStartupTimerProbe(module),
];
