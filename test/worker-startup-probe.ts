// SPDX-License-Identifier: Apache-2.0

// Faults patched on Node's Worker must exercise that backend, including Deno's compatibility path.
export const nodeWorkerHostSetup =
  'if (Object.hasOwn(globalThis, "Deno")) globalThis.Worker = undefined;';

// Hold the real acknowledgement to distinguish pending startup from request processing.
export const pendingStartupProbe = (sibling: boolean, module: string): string => `
  ${nodeWorkerHostSetup}
  import { Worker } from "node:worker_threads";
  import { parseAsync, worker } from ${JSON.stringify(module)};
  const stop = new AbortController();
  const reason = { stopped: "pending-startup" };
  const once = Worker.prototype.once;
  let acknowledge;
  Worker.prototype.once = function(name, listener) {
    return once.call(this, name, name === "message" ? (message) => {
      acknowledge = () => listener(message);
      stop.abort(reason);
    } : listener);
  };
  try {
    const cancelled = parseAsync('{"a":1}', { execution: worker, signal: stop.signal });
    const sibling = ${sibling} ? parseAsync('{"b":2}', { execution: worker }) : undefined;
    const result = await cancelled;
    if (result.ok || result.failure.kind !== "aborted" || result.failure.reason !== reason)
      throw Error("pending startup did not return cancellation");
    Worker.prototype.once = once;
    acknowledge();
    if (sibling !== undefined) {
      const result = await sibling;
      if (!result.ok || result.value.b !== 2) throw Error("startup cancellation stopped its sibling");
    }
    const next = await parseAsync('{"safe":3}', { execution: worker });
    if (!next.ok || next.value.safe !== 3) throw Error("cancelled startup remained cached");
    console.log("pending startup cancellation and reuse passed");
  } finally { Worker.prototype.once = once; }
`;

// A caller whose setup fails must settle before a live sibling's held acknowledgement.
export const startupListenerFailureProbe = (module: string): string => `
  ${nodeWorkerHostSetup}
  import { Worker } from "node:worker_threads";
  import { parseAsync, worker } from ${JSON.stringify(module)};
  const observed = Promise.withResolvers();
  const once = Worker.prototype.once;
  let acknowledge;
  Worker.prototype.once = function(name, listener) {
    return once.call(this, name, name === "message" ? (message) => {
      acknowledge ??= () => listener(message);
      observed.resolve();
    } : listener);
  };
  try {
    const sibling = parseAsync('{"a":1}', { execution: worker });
    await observed.promise;
    const cause = new Error("startup-listener-denied");
    const signal = {
      aborted: false,
      addEventListener() { throw cause; },
      removeEventListener() {},
    };
    const failed = await parseAsync('{"b":2}', { execution: worker, signal });
    if (failed.ok || failed.failure.kind !== "signal-failed" || failed.failure.cause !== cause)
      throw Error("startup listener failure did not settle independently");
    const joinedStartup = Promise.withResolvers();
    const joining = parseAsync('{"b":2}', { execution: worker, signal: {
      aborted: false,
      addEventListener() { joinedStartup.resolve(); },
      removeEventListener() {},
    } });
    await joinedStartup.promise;
    acknowledge();
    const result = await sibling;
    if (!result.ok || result.value.a !== 1) throw Error("startup listener failure stopped its sibling");
    const joined = await joining;
    if (!joined.ok || joined.value.b !== 2) throw Error("startup listener failure erased its shared attempt");
    Worker.prototype.once = once;
    const next = await parseAsync('{"safe":3}', { execution: worker });
    if (!next.ok || next.value.safe !== 3) throw Error("startup listener failure broke reuse");
    console.log("startup listener failure preserves sibling and reuse");
  } finally { Worker.prototype.once = once; }
`;

export const startupReleaseProbe = (terminationFails: boolean): string =>
  [
    nodeWorkerHostSetup,
    'import { Worker } from "node:worker_threads";',
    'import { parseAsync, worker } from "partial-json-repair/async";',
    "const nativeUnref = Worker.prototype.unref, nativeTerminate = Worker.prototype.terminate;",
    "let created; let terminated = 0; let failed;",
    `const terminationFails = ${String(terminationFails)}; const cleanupCause = new Error("terminate-denied");`,
    'Worker.prototype.unref = function () { created = this; throw new Error("startup-unref-denied"); };',
    "Worker.prototype.terminate = function () { terminated++; const stopped = nativeTerminate.call(this); return terminationFails ? Promise.resolve(stopped).then(() => { throw cleanupCause; }) : stopped; };",
    'try { failed = await parseAsync("{safe:1}", { execution: worker }); }',
    "finally { Worker.prototype.unref = nativeUnref; Worker.prototype.terminate = nativeTerminate; if (created && terminated === 0) await nativeTerminate.call(created); }",
    'if (!created || terminated !== 1 || failed.ok || failed.failure.kind !== "execution-unavailable" || failed.failure.reason !== "failed") throw new Error("worker startup left an owned thread alive: " + terminated);',
    'if (terminationFails ? failed.failure.cleanupFailure?.kind !== "cleanup-failed" || failed.failure.cleanupFailure.cause !== cleanupCause : failed.failure.cleanupFailure !== undefined) throw new Error("worker startup lost its cleanup cause");',
    'const next = await parseAsync("{safe:2}", { execution: worker });',
    'if (!next.ok || next.value.safe !== 2) throw new Error("worker startup cleanup broke retry");',
  ].join("\n");
