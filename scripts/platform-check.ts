// SPDX-License-Identifier: Apache-2.0

/**
 * Browser and edge proof (HLD: browsers and edge): the packed package, bundled by each consumer bundler, gives the
 * same outputs in WebKit, Chromium and workerd as the unbundled package gives in Node.
 *
 * One page script, composed from the size-check fixture rows (parse, stream with snapshots, /async
 * cooperative with an abort, /async worker), runs:
 * - in native `Bun.WebView` WebKit and Playwright Chromium. A browser that cannot start fails the
 *   run as `unproved`: this check is the browser-support proof, so a missing host is never a pass;
 * - twice per browser: cross-origin isolated (atomic cancellation) and plain (message cancellation),
 *   so both control transports exercise the same recovered outcomes;
 * - in workerd through miniflare: `execution: worker` must answer the typed unavailable failure
 *   without reading input, and `auto` must fall back to the same thread.
 * Any other output differing from Node fails; every host is listed as proved or unproved.
 * The printed README preview also runs here; browsers use native animation frames across
 * completion and source, render and handler failures, checking repeated calls and owned cleanup.
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rolldown } from "rolldown";
import { openBrowser } from "./browser";
import type { BrowserView } from "./browser";
import { BUNDLERS, PKG, packConsumer, workerRecipe } from "./consumer-bundlers";
import { FIXTURES, PLATFORM_PARTS as PARTS } from "./consumer-fixtures";
import { firstDifference } from "../test/consumer-outcomes";
import { checkTerminalMemory } from "./consumer-memory";
import type { MemoryProbe } from "./consumer-memory";
import { webkitStringMemory } from "./webkit-memory";
import { PLATFORM_OBSERVATION_MS } from "./run-script";
import { probeArguments } from "./probe-arguments";
import { terminalInputBrowserProgram } from "../test/worker-iterator-memory-probe";
import { webStreamProbe } from "../test/native-stream-probe";
import { resourceRecoveryProgram, stoppedViewMemoryProgram } from "../test/resource-recovery-probe";
import { pendingTokenMemoryProgram } from "../test/pending-token-memory-probe";
import {
  preIterationStops,
  verifyPreIterationCancellation,
} from "../test/pre-iteration-cancellation-probe";
import type { Miniflare as MiniflareRuntime } from "miniflare";

const ROOT = process.env.PJR_ROOT ?? path.resolve(import.meta.dir, "..");
const HOSTS = ["webkit", "chromium", "workerd"] as const;
// Refuse unknown arguments and missing values before any build or host starts.
const { flag, option } = probeArguments(process.argv.slice(2), {
  usage: `bun scripts/platform-check.ts [--bundler <name>] [--host ${HOSTS.join("|")}] [--keep]`,
  flags: ["--keep"],
  options: ["--bundler", "--host"],
});
const keep = flag("--keep");
const selectedHost = option("--host");
if (selectedHost !== undefined && !HOSTS.some((host) => host === selectedHost))
  throw new Error(`--host requires one of: ${HOSTS.join(", ")}`);
const requestedHosts = HOSTS.filter((host) => selectedHost === undefined || host === selectedHost);
const browserRequested = requestedHosts.some((host) => host !== "workerd");
const selectedBundler = option("--bundler");
if (!browserRequested && selectedBundler !== undefined)
  throw new Error("--bundler selects browser builds; omit it with --host workerd");
const bundlers =
  selectedBundler === undefined
    ? BUNDLERS
    : BUNDLERS.filter((bundler) => bundler.name === selectedBundler);
if (bundlers.length === 0)
  throw new Error(
    `--bundler requires one of: ${BUNDLERS.map((bundler) => bundler.name).join(", ")}`,
  );
// A narrow retry keeps the same packed oracle and host checks, but proves only these bundles.
console.log(
  selectedBundler === undefined && selectedHost === undefined
    ? "scope: complete platform matrix"
    : `scope: filtered probe, not release verification; hosts: ${requestedHosts.join(", ")}`,
);
const started = performance.now();
const failures: string[] = [];
const hosts: { host: string; status: string }[] = [];

const packed = packConsumer(ROOT, "pjr-platform-");
let completed = false;
// Early reference/build failures must release the packed copy too, not just the normal exit path.
process.once("exit", () => {
  // An unresolved host promise can outlive every event-loop handle and exit without a verdict.
  // Only the final census proves that the matrix reached its judge.
  if (!completed) {
    console.error(
      "Platform matrix ended before its final host census; no support verdict is proved.",
    );
    process.exitCode = 1;
  }
  if (!keep) rmSync(packed.work, { recursive: true, force: true });
});
const fixturesDir = path.join(packed.consumer.dir, "fixtures");
for (const id of Object.values(PARTS)) {
  const row = FIXTURES.find((f) => f.id === id);
  if (row === undefined) throw new Error(`fixture row ${id} is missing`);
  writeFileSync(path.join(fixturesDir, `${id}.mjs`), row.source);
}
// Plain JavaScript beside the fixtures: Rspack has no TypeScript loader configured, and a consumer
// page should hold only what a browser runs.
const describeModule = path.join(fixturesDir, "describe.mjs");
writeFileSync(
  describeModule,
  new Bun.Transpiler({ loader: "ts" }).transformSync(
    await Bun.file(path.join(import.meta.dir, "../test/consumer-outcomes.ts")).text(),
  ),
);
const entry = path.join(fixturesDir, "platform.mjs");
// Run the printed recipe against packed imports; a copied implementation can hide doc drift.
const readme = await Bun.file(path.join(ROOT, "README.md")).text();
const previewStart = readme.indexOf("export async function showReply(");
const previewEnd = readme.indexOf("\n```", previewStart);
if (previewStart < 0 || previewEnd <= previewStart)
  throw new Error("README preview recipe is missing");
const previewRecipe = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readme.slice(previewStart, previewEnd).replace("export async", "async"),
);
writeFileSync(
  entry,
  `import { describe, firstDifference } from ${JSON.stringify(describeModule)};
import { parse as recover, parseMany, initParser, parseStream, createStreamParser, createMetrics, decodedFragments, select, diagnostics, ownedView, sharedView, STRICT, isExactNumber, stringify } from "${PKG}";
import { auto, findJsonSpanAsync, initAsyncParser, parseAsync, parseManyAsync, repairAsync, worker, cooperative } from "${PKG}/async";
await (${webStreamProbe.toString()})(parseStream, stringify);
${Object.entries(PARTS)
  // Caller jobs can share names with public capabilities; keep their generated bindings separate.
  .map(([name, id]) => `import { run as fixture_${name} } from "./${id}.mjs";`)
  .join("\n")}
${terminalInputBrowserProgram(undefined, process.env.PJR_TRACE_INPUTS === "1")}
const syncMany = () => {
  const out = [];
  for (let pass = 0; pass < 2; pass++) for (const configured of [false, true]) {
    const parser = configured ? initParser() : undefined;
    const many = input => parser ? parseMany(input, parser) : parseMany(input);
    try {
      const values = [...many('{"a":1} {"b":2}')];
      if (values.length !== 2 || !values[0].ok || values[0].value.a !== 1 || !values[1].ok || values[1].value.b !== 2)
        throw new Error("synchronous iteration changed completed roots");
      for (const started of [false, true]) {
        const call = many('{"a":1} {"b":2}');
        if (started && !call.next().value?.ok) throw new Error("synchronous first pull failed");
        const returned = call.return(17);
        if (!returned.done || returned.value !== 17 || !call.next().done || call[Symbol.iterator]() !== call)
          throw new Error("synchronous return changed iterator behavior");
        const cause = { caller: true }; let caught = false;
        try { call.throw(cause); } catch (error) { if (error !== cause) throw error; caught = true; }
        if (!caught) throw new Error("synchronous throw lost its caller cause");
        if (typeof [].values().map === "function" && [...call.map(value => value)].length !== 0)
          throw new Error("synchronous iterator helper replayed a value");
      }
      const denied = many(new Uint8Array([255,254]));
      const failure = denied.next();
      if (failure.done || failure.value.ok || failure.value.failure.kind !== "unsupported-encoding" || !denied.next().done)
        throw new Error("synchronous terminal refusal changed");
      out.push({ pass, configured, values, failure: failure.value });
    } finally { parser?.close(); }
  }
  return out;
};
const invalidInput = async () => {
  const out = [];
  const requireInvalid = result => {
    if (result.ok || result.failure.kind !== "invalid-input" || result.failure.received !== "object")
      throw new Error("revoked input lost its typed refusal");
  };
  for (const target of [{}, [], new Uint8Array()]) {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    requireInvalid(recover(proxy));
    const stream = createStreamParser();
    try {
      const items = [...stream.feed(proxy)];
      if (items.length !== 1) throw new Error("revoked feed did not deliver one refusal");
      requireInvalid(items[0]);
    } finally { stream.close(); }
    for (const options of [{ execution: auto }, { execution: cooperative }, { execution: worker }])
      requireInvalid(await parseAsync(proxy, options));
    out.push("invalid-input");
  }
  let frame;
  try {
    const bytes = new Uint8Array([123,34,97,34,58,49,125]);
    const capacity = 4 * 1024 * 1024;
    let input = new Uint8Array(new ArrayBuffer(capacity), 4096, bytes.length);
    input.set(bytes);
    if (typeof document === "object") {
      // A real iframe proves foreign prototypes through the installed browser bundle.
      frame = document.createElement("iframe");
      document.body.append(frame);
      input = new frame.contentWindow.Uint8Array(new frame.contentWindow.ArrayBuffer(capacity), 4096, bytes.length);
      input.set(bytes);
      if (input instanceof Uint8Array) throw new Error("byte probe did not cross a realm");
    }
    const storage = input.buffer;
    const sizeOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get;
    // Foreign storage and caller properties must not select different bytes by execution route.
    Object.defineProperty(input, "subarray", {value: () => new Uint8Array([123,34,97,34,58,50,125])});
    for (const key of ["length", "buffer", "byteOffset", "byteLength", "constructor"])
      Object.defineProperty(input, key, {get() {throw new Error("caller " + key);}});
    const requireBytes = result => {
      if (!result.ok || result.value.a !== 1) throw new Error("genuine byte input was refused");
    };
    requireBytes(recover(input));
    const stream = createStreamParser();
    try {
      const items = [...stream.feed(input), ...stream.end()];
      if (items.length !== 1) throw new Error("byte feed did not deliver one value");
      requireBytes(items[0]);
    } finally { stream.close(); }
    for (const options of [{ execution: auto }, { execution: cooperative }])
      requireBytes(await parseAsync(input, options));
    // A real request must exclude the foreign view's padding and leave caller storage attached.
    const prototype = typeof document === "object" && typeof Worker === "function" ? Worker.prototype : undefined;
    const post = prototype?.postMessage;
    let postedWindow;
    if (post) prototype.postMessage = function(message, transfers) {
      if (ArrayBuffer.isView(message?.input))
        postedWindow = { visible: message.input.byteLength, backing: message.input.buffer.byteLength };
      return post.call(this, message, transfers);
    };
    try {
      const control = await parseAsync('{"a":1}', { execution: worker });
      const result = await parseAsync(input, { execution: worker });
      if (control.ok) {
        requireBytes(result);
        if (post && (postedWindow?.visible !== bytes.length || postedWindow.backing !== bytes.length))
          throw new Error("worker byte request carried unrelated storage");
      } else if (result.ok || control.failure.kind !== "execution-unavailable" ||
                 result.failure.kind !== control.failure.kind || result.failure.reason !== control.failure.reason)
        throw new Error("byte worker disagreed with the same host's text control");
      if (sizeOf.call(input) !== bytes.length || storage.byteLength !== capacity ||
          bytes.some((byte, index) => input[index] !== byte))
        throw new Error("worker detached or changed foreign caller bytes");
    } finally { if (post) prototype.postMessage = post; }
    out.push("byte-input");
  } finally { frame?.remove(); }
  return out;
};
const preview = async () => {
  // Browsers use their real animation scheduler; Node and edge use a host-task control.
  if (typeof window !== "undefined" && typeof requestAnimationFrame !== "function")
    throw new Error("browser preview has no animation scheduler");
  const request = typeof requestAnimationFrame === "function"
    ? draw => globalThis.requestAnimationFrame(draw) : draw => setTimeout(draw, 0);
  const cancel = typeof cancelAnimationFrame === "function"
    ? frame => globalThis.cancelAnimationFrame(frame) : frame => clearTimeout(frame);
  const out = [];
  for (const pass of [0, 1]) for (const mode of ["complete", "source", "late-source", "limit", "handler", "render", "frame"]) {
  const cause = new Error("preview-render-failed");
  const sourceCause = new Error("preview-source-failed");
  const handlerCause = new Error("preview-handler-failed");
  let reads = 0, releases = 0, draws = 0, requested = 0, cancelled = 0, handled = 0;
  let releaseRead;
  let lastRendered;
  const source = { [Symbol.asyncIterator]: () => ({
    next() {
      if (++reads === 1) return Promise.resolve({ done: false,
        // late-source and render need the root completed by this first read: one ending on its
        // chunk's closing brace is held for a possible list comma until the next read, so a late
        // failure would return it as recovery and a render fault would follow a second read.
        value: ["late-source", "render"].includes(mode) ? '{"title":"Hel"}\\n'
          : ["complete", "limit"].includes(mode) ? '{"title":"Hel"}' : '{"title":"Hel' });
      if (mode === "limit" && reads === 2)
        return Promise.resolve({ done: false, value: '{"deep":[[0]]}' });
      if (mode === "frame") return new Promise(resolve => { releaseRead = () => resolve({ done: true }); });
      if (["source", "late-source", "handler"].includes(mode)) return Promise.reject(sourceCause);
      return Promise.resolve({ done: true });
    },
    return() { releases++; releaseRead?.(); return Promise.resolve({ done: true }); },
  }) };
  const show = ((parseStream, render, handleFailure, requestAnimationFrame, cancelAnimationFrame) => {
    ${previewRecipe}
    return showReply;
  })((source, options) => parseStream(source, mode === "limit" ? { ...options, maxDepth: 2 } : options), value => {
    draws++;
    lastRendered = value;
    if ((mode === "limit" && draws === 2 ? !Array.isArray(value?.deep) : value?.title !== "Hel") ||
        (mode === "frame" && reads !== 2))
      throw new Error("preview did not render the received value");
    if (mode === "frame" || mode === "render") throw cause;
  }, failure => {
    handled++;
    if (mode === "limit" ? failure.kind !== "limit-reached" || failure.resource !== "depth" ||
        failure.recovered?.value !== lastRendered || draws !== 2
        : failure.kind !== "source-failed" || failure.cause !== sourceCause || draws !== 1 ||
          (mode === "late-source" ? failure.recovered !== undefined : failure.recovered?.value?.title !== "Hel"))
      throw new Error("preview lost its failed prefix or source cause");
    if (mode === "handler") throw handlerCause;
  },
  draw => { requested++; return request(draw); }, frame => { cancelled++; cancel(frame); });
  let failure, value;
  try { value = await show({ textStream: source }); } catch (error) { failure = error; }
  finally { releaseRead?.(); }
  const expectedFailure = mode === "handler" ? handlerCause
    : mode === "frame" || mode === "render" ? cause : undefined;
  if (failure !== expectedFailure || reads !== (mode === "render" ? 1 : mode === "limit" ? 3 : 2) ||
      releases !== 1 || draws !== (mode === "limit" ? 2 : 1) || requested !== 1 || cancelled !== 1 ||
      handled !== (["source", "late-source", "limit", "handler"].includes(mode) ? 1 : 0) ||
      (mode === "complete" ? value?.title !== "Hel" : value !== undefined))
    throw new Error("preview lost output, cause or source/frame cleanup: " + mode);
  out.push({ pass, mode, reads, releases, draws, requested, cancelled, handled });
  }
  return out;
};
// Bytes that are not UTF-8: read, they give a decoding outcome; unread, only the execution answer.
const workerProbe = async () => {
  const bytes = await parseAsync(new Uint8Array([0xff, 0x7b, 0x7d]), { execution: worker });
  if (!bytes.ok && bytes.failure.kind === "execution-unavailable") return [bytes];
  // A browser process shim must not silently skip the host-fault assertions below.
  if (typeof window !== "undefined" && typeof process !== "undefined")
    throw new Error("browser worker fault coverage skipped by a process shim");
  // Observe native controls without replacing the worker or its discard acknowledgement.
  const channel = new MessageChannel();
  const portPrototype = Object.getPrototypeOf(channel.port1);
  channel.port1.close(); channel.port2.close();
  const post = portPrototype.postMessage;
  const removalCause = new Error("caller signal removal failed");
  let discards = 0;
  portPrototype.postMessage = function(message, ...rest) {
    if (message === "discard") discards++;
    return post.call(this, message, ...rest);
  };
  try { for (const exit of ["return", "throw", "throw-undefined"]) {
    const before = discards;
    const consumer = exit === "throw-undefined" ? undefined : new Error("consumer stopped");
    let exiting = false;
    const signal = { aborted: false, addEventListener() {}, removeEventListener() { if (exiting) throw removalCause; } };
    const stream = parseManyAsync('{"a":1} {"a":2}', { execution: worker, signal });
    const first = await stream.next();
    if (first.done || !first.value.ok || first.value.value.a !== 1) throw new Error("worker cleanup probe lost first root");
    exiting = true;
    let failure;
    try {
      if (exit === "return") await stream.return();
      else await stream.throw(consumer);
    } catch (cause) { failure = cause; }
    if (exit === "return") {
      if (failure !== removalCause) throw new Error("worker cleanup cause lost");
    } else if (!(failure instanceof AggregateError) || failure.errors[0] !== consumer ||
        failure.errors[1] !== removalCause || failure.cause !== removalCause)
      throw new Error("worker consumer or cleanup cause lost");
    if (discards !== before + 1) throw new Error("caller listener removal suppressed worker discard");
  } } finally { portPrototype.postMessage = post; }
  const afterRemoval = await parseAsync('{"safe":3}', { execution: worker });
  if (!afterRemoval.ok || afterRemoval.value.safe !== 3) throw new Error("signal cleanup failure broke worker reuse");
  // Allocation failure must release idle workers without terminating a sibling-owned worker.
  if (typeof process === "undefined") {
    // Restore the same host constructor before retrying; missing capabilities are a different case.
    const NativeWorker = globalThis.Worker;
    // Hold the real entry acknowledgement: cancellation must settle before we release it.
    const listenerDescriptor = Object.getOwnPropertyDescriptor(NativeWorker.prototype, "addEventListener");
    const listen = NativeWorker.prototype.addEventListener;
    try { for (const live of [false, true]) {
      const stop = new AbortController(); const reason = { source: "pending-startup" };
      let acknowledge;
      NativeWorker.prototype.addEventListener = function(type, listener, options) {
        return listen.call(this, type, type === "message" && options?.once ? (event) => {
          acknowledge = () => listener(event);
          stop.abort(reason);
        } : listener, options);
      };
      const cancelled = parseAsync('{"a":1}', { execution: worker, signal: stop.signal });
      const sibling = live ? parseAsync('{"b":2}', { execution: worker }) : undefined;
      const stopped = await cancelled;
      NativeWorker.prototype.addEventListener = listen;
      acknowledge?.();
      if (acknowledge === undefined || stopped.ok || stopped.failure.kind !== "aborted" || stopped.failure.reason !== reason)
        throw new Error("pending browser startup did not settle cancellation");
      if (sibling !== undefined) {
        const result = await sibling;
        if (!result.ok || result.value.b !== 2) throw new Error("startup cancellation stopped browser sibling");
      }
      const next = await parseAsync('{"safe":3}', { execution: worker });
      if (!next.ok || next.value.safe !== 3) throw new Error("cancelled browser startup poisoned retry");
    }
      // A setup failure settles independently; observe the next caller joining before releasing ready.
      const observed = Promise.withResolvers();
      let acknowledge;
      NativeWorker.prototype.addEventListener = function(type, listener, options) {
        return listen.call(this, type, type === "message" && options?.once ? (event) => {
          acknowledge ??= () => listener(event);
          observed.resolve();
        } : listener, options);
      };
      const sibling = parseAsync('{"a":1}', { execution: worker });
      await observed.promise;
      const failed = await parseAsync('{"b":2}', { execution: worker, signal: {
        aborted: false,
        addEventListener() { throw new Error("startup-listener-denied"); },
        removeEventListener() {},
      } });
      const joinedStartup = Promise.withResolvers();
      const joining = parseAsync('{"b":2}', { execution: worker, signal: {
        aborted: false,
        addEventListener() { joinedStartup.resolve(); },
        removeEventListener() {},
      } });
      await joinedStartup.promise;
      acknowledge();
      const first = await sibling;
      const joined = await joining;
      // Release the held startup before judging failures, so a failed assertion cannot strand later cases.
      if (failed.ok || failed.failure.kind !== "signal-failed")
        throw new Error("browser startup listener failure did not settle independently");
      if (!first.ok || first.value.a !== 1 || !joined.ok || joined.value.b !== 2)
        throw new Error("browser startup listener failure stopped sibling or erased its attempt");
      NativeWorker.prototype.addEventListener = listen;
      const next = await parseAsync('{"safe":3}', { execution: worker });
      if (!next.ok || next.value.safe !== 3) throw new Error("browser startup listener failure broke reuse");
    } finally {
      if (listenerDescriptor === undefined) delete NativeWorker.prototype.addEventListener;
      else Object.defineProperty(NativeWorker.prototype, "addEventListener", listenerDescriptor);
    }
    let startupDenied = false;
    let startupFailure;
    globalThis.Worker = class extends NativeWorker {
      constructor() { startupDenied = true; throw new Error("startup-denied"); }
    };
    try {
      startupFailure = await parseAsync('{"safe":1}', { execution: worker });
    } finally {
      globalThis.Worker = NativeWorker;
    }
    const retried = await parseAsync('{"safe":2}', { execution: worker });
    if (!startupDenied || startupFailure.ok || startupFailure.failure.kind !== "execution-unavailable" ||
        startupFailure.failure.reason !== "failed" || !retried.ok || retried.value.safe !== 2)
      throw new Error("worker startup failure poisoned its next caller");
    const nativeListen = NativeWorker.prototype.addEventListener;
    const nativeEnd = NativeWorker.prototype.terminate;
    for (const terminationFails of [false, true]) {
      let owned; let terminations = 0; let failed;
      const cleanupCause = new Error("terminate-denied");
      NativeWorker.prototype.addEventListener = function () { owned = this; throw new Error("startup-listener-denied"); };
      NativeWorker.prototype.terminate = function () { terminations++; const stopped = nativeEnd.call(this); if (terminationFails) throw cleanupCause; return stopped; };
      try {
        failed = await parseAsync('{"safe":1}', { execution: worker });
      } finally {
        NativeWorker.prototype.addEventListener = nativeListen;
        NativeWorker.prototype.terminate = nativeEnd;
        if (owned && terminations === 0) nativeEnd.call(owned);
      }
      if (!owned || terminations !== 1 || failed.ok || failed.failure.kind !== "execution-unavailable" ||
          failed.failure.reason !== "failed" || (terminationFails ? failed.failure.cleanupFailure?.cause !== cleanupCause : failed.failure.cleanupFailure !== undefined))
        throw new Error("worker partial startup lost its thread or cleanup cause");
      const next = await parseAsync('{"safe":2}', { execution: worker });
      if (!next.ok || next.value.safe !== 2) throw new Error("worker partial startup cleanup broke retry");
    }
    const NativeChannel = globalThis.MessageChannel;
    const nativeTerminate = Worker.prototype.terminate;
    let denied = false;
    let terminated = 0;
    for (const live of [false, true]) {
    const sibling = live ? parseManyAsync('{"safe":10} {"safe":11}', { execution: worker, builtinParsers: false }) : undefined;
    if (sibling !== undefined && (await sibling.next()).value?.value?.safe !== 10)
      throw new Error("channel sibling control failed");
    denied = false; terminated = 0;
    globalThis.MessageChannel = class extends NativeChannel {
      constructor() { denied = true; throw new Error("channel-denied"); }
    };
    Worker.prototype.terminate = function () { terminated++; return nativeTerminate.call(this); };
    try {
      const failed = await parseAsync('{"safe":1}', { execution: worker });
      if (!denied || failed.ok || failed.failure.kind !== "execution-unavailable" ||
          failed.failure.reason !== "failed" || terminated !== (live ? 0 : 1))
        throw new Error("channel allocation failure changed worker ownership");
    } finally {
      globalThis.MessageChannel = NativeChannel;
      Worker.prototype.terminate = nativeTerminate;
    }
    if (sibling !== undefined && ((await sibling.next()).value?.value?.safe !== 11 || !(await sibling.next()).done))
      throw new Error("channel allocation failure damaged its sibling");
    const next = await parseAsync('{"safe":2}', { execution: worker });
    if (!next.ok || next.value.safe !== 2) throw new Error("channel failure broke the next worker call");
    }
    for (const fault of ["message", "messageerror", "close", "start", "stop-buffer", "post", "receive"]) for (const live of [false, true]) for (const terminationFails of (live ? [false] : [false, true])) {
      // A suspended sibling keeps the shared worker owned; another failed request must not terminate it.
      const sibling = live ? parseManyAsync('{"safe":10} {"safe":11}', { execution: worker, builtinParsers: false }) : undefined;
      if (sibling !== undefined && (await sibling.next()).value?.value?.safe !== 10)
        throw new Error("browser request sibling control failed: " + fault);
      const owner = fault === "stop-buffer" ? globalThis : fault === "post" ? Worker.prototype : MessagePort.prototype;
      const method = fault === "stop-buffer" ? "SharedArrayBuffer" : fault === "post" ? "postMessage" : fault === "start" ? "start" : "addEventListener";
      const original = owner[method];
      const cleanupCause = new Error("allocation-cleanup-denied");
      denied = false; terminated = 0;
      owner[method] = function (...args) {
        if (fault === "receive" && args[0] === "messageerror" && !denied) {
          // Register first: this fault must reach receive cleanup, not listener setup.
          const registered = original.apply(this, args);
          denied = true;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("messageerror")));
          return registered;
        }
        if (fault === "stop-buffer" || fault === "start" || fault === "post" || args[0] === fault) {
          denied = true; throw new Error("port-setup-denied");
        }
        return original.apply(this, args);
      };
      // Release the real thread before injecting failure; the request keeps its typed primary cause.
      Worker.prototype.terminate = function () {
        terminated++; const stopped = nativeTerminate.call(this);
        if (terminationFails) throw cleanupCause;
        return stopped;
      };
      try {
        const failed = await parseAsync('{"safe":1}', { execution: worker });
        if (!denied || failed.ok || failed.failure.kind !== "execution-unavailable" ||
            failed.failure.reason !== "failed" || terminated !== (live ? 0 : 1))
          throw new Error("port request failure changed worker ownership: " + fault);
        if (terminationFails ? failed.failure.cleanupFailure?.kind !== "cleanup-failed" || failed.failure.cleanupFailure.cause !== cleanupCause : failed.failure.cleanupFailure !== undefined)
          throw new Error("port request failure lost its cleanup cause: " + fault);
      } finally {
        owner[method] = original; Worker.prototype.terminate = nativeTerminate;
      }
      if (sibling !== undefined && ((await sibling.next()).value?.value?.safe !== 11 || !(await sibling.next()).done))
        throw new Error("browser request failure damaged its sibling: " + fault);
      const resumed = await parseAsync('{"safe":2}', { execution: worker });
      if (!resumed.ok || resumed.value.safe !== 2) throw new Error("port request failure broke next call: " + fault);
    }
  }
  if (typeof process === "undefined") {
    const NativeBuffer = globalThis.SharedArrayBuffer;
    const nativeControl = MessagePort.prototype.postMessage;
    let abortSent = false;
    let stopCell;
    // Observe the real stop transport before listener-removal failure; neither transport may be skipped.
    if (typeof NativeBuffer === "function") globalThis.SharedArrayBuffer = class extends NativeBuffer {
      constructor(size) { super(size); if (size === 4) stopCell = new Int32Array(this); }
    };
    else MessagePort.prototype.postMessage = function (...args) {
      if (args[0] === "abort") abortSent = true;
      return nativeControl.apply(this, args);
    };
    const removalFailure = new Error("remove-failed");
    let exitingCleanup = false;
    const cleanupSignal = { aborted: false, addEventListener() {}, removeEventListener() { if (exitingCleanup) throw removalFailure; } };
    try {
    const stoppedCleanup = parseManyAsync('{"safe":30} {"safe":31}', { execution: worker, signal: cleanupSignal });
      if ((await stoppedCleanup.next()).value?.value?.safe !== 30 || (typeof NativeBuffer === "function" ? stopCell === undefined || Atomics.load(stopCell, 0) !== 0 : abortSent))
        throw new Error("listener cleanup stop-cell control failed");
    exitingCleanup = true;
    let removalRejected = false;
    try { await stoppedCleanup.return(); } catch (error) { removalRejected = error === removalFailure; }
    if (!removalRejected || (typeof NativeBuffer === "function" ? Atomics.load(stopCell, 0) !== 1 : !abortSent)) throw new Error("listener cleanup failure skipped worker stop");
    } finally {
      globalThis.SharedArrayBuffer = NativeBuffer;
      MessagePort.prototype.postMessage = nativeControl;
    }
    for (const live of [false, true]) {
      const sibling = live ? parseManyAsync('{"safe":40} {"safe":41}', { execution: worker, builtinParsers: false }) : undefined;
      if (sibling !== undefined && (await sibling.next()).value?.value?.safe !== 40)
        throw new Error("cleanup sibling control failed");
      const pendingCleanup = parseManyAsync('{"safe":20} {"safe":21}', { execution: worker, builtinParsers: false });
      if ((await pendingCleanup.next()).value?.value?.safe !== 20) throw new Error("cleanup control failed");
      const nativeClose = MessagePort.prototype.close;
      const nativeTerminate = Worker.prototype.terminate;
      let closes = 0; let terminations = 0; let rejected = false;
      // Throw after the native close so the probe isolates continuation of cleanup, not host refusal.
      MessagePort.prototype.close = function () {
        nativeClose.call(this);
        if (++closes === 1) throw new Error("close-failed");
      };
      Worker.prototype.terminate = function () { terminations++; return nativeTerminate.call(this); };
      try { await pendingCleanup.return(); } catch { rejected = true; } finally {
        MessagePort.prototype.close = nativeClose; Worker.prototype.terminate = nativeTerminate;
      }
      if (!rejected || closes !== 2 || terminations !== (live ? 0 : 1)) throw new Error("cleanup error skipped a release or terminated its sibling");
      if (sibling !== undefined && ((await sibling.next()).value?.value?.safe !== 41 || !(await sibling.next()).done))
        throw new Error("cleanup error damaged its live sibling");
      const afterCleanup = await parseAsync('{"safe":22}', { execution: worker });
      if (!afterCleanup.ok || afterCleanup.value.safe !== 22) throw new Error("cleanup error broke next call");
    }
    // A browser stream reports release failure as a terminal item without repeating delivered data.
    for (const live of [false, true]) for (const refuses of [false, true]) for (const configured of [false, true]) for (const strict of [false, true]) for (const finish of ["next", "return", "dispose"]) {
      const options = { ...(strict ? STRICT : {}), execution: worker, diagnostics };
      const parser = configured ? initAsyncParser(options) : undefined;
      const call = () => parser ? parseManyAsync("{'safe':2}", parser) : parseManyAsync("{'safe':2}", options);
      const control = call(); const expected = await control.next(); await control.return();
      if (expected.done) throw new Error("browser stream cleanup control lost its first outcome");
      const sibling = live ? parseManyAsync('{"safe":40} {"safe":41}', { execution: worker }) : undefined;
      if (sibling !== undefined && (await sibling.next()).value?.value?.safe !== 40)
        throw new Error("browser stream cleanup sibling control failed");
      const nativeClose = MessagePort.prototype.close; const cause = new Error("stream cleanup"); let closes = 0; let refused;
      MessagePort.prototype.close = function () {
        const first = ++closes === 1;
        if (first && refuses) { refused = this; throw cause; }
        nativeClose.call(this);
        if (first) throw cause;
      };
      try {
        const sequence = call(); const first = await sequence.next();
        if (firstDifference(describe(first), describe(expected)) !== undefined)
          throw new Error("browser stream cleanup changed first delivery");
        if (finish === "next") {
          const terminal = await sequence.next();
          if (terminal.done || terminal.value.ok || terminal.value.failure.kind !== "cleanup-failed" ||
              terminal.value.failure.cause !== cause || "recovered" in terminal.value.failure || "completed" in terminal.value.failure)
            throw new Error("browser stream cleanup lost its cause or repeated delivery");
        } else {
          let caught;
          try { if (finish === "return") await sequence.return(); else await sequence[Symbol.asyncDispose](); }
          catch (failure) { caught = failure; }
          if (caught !== cause) throw new Error("browser stream disposal lost its cleanup cause");
        }
        if (closes !== 2 || !(await sequence.next()).done)
          throw new Error("browser stream cleanup skipped release or kept iteration live");
        const next = await parseAsync('{"safe":3}', { execution: worker });
        if (!next.ok || next.value.safe !== 3) throw new Error("browser stream cleanup damaged the next call");
        if (sibling !== undefined && ((await sibling.next()).value?.value?.safe !== 41 || !(await sibling.next()).done))
          throw new Error("browser stream cleanup damaged its sibling");
      } finally {
        MessagePort.prototype.close = nativeClose;
        // A host-refused port is still live; the probe must release its own injected resource.
        if (refused !== undefined) nativeClose.call(refused);
        await sibling?.return();
        parser?.close();
      }
    }
    // Fail after real source rows arrive; missing metadata must not look like a clean report.
    // Require multiple packets below; more rows only repeat the same native boundary.
    const deliveryCount = 2048;
    const deliveryRows = Array.from({ length: deliveryCount }, (_, id) => '{"id":' + id + '}').join(',');
    const deliverySibling = parseManyAsync('{"safe":40} {"safe":41}', { execution: worker });
    if ((await deliverySibling.next()).value?.value?.safe !== 40) throw new Error("delivery sibling did not start");
    try {
      for (const boundary of ["early", "final"]) for (const shape of ["clean", "cut", "refused", "metadata"]) {
        const source = shape === "metadata" ? '{"rows":[{"id":0}],"' + 'x'.repeat(200000)
          : '{"rows":[' + deliveryRows + (shape === "cut" ? '' : shape === "refused" ? ',]}' : ']}');
        const rowCount = shape === "metadata" ? 1 : deliveryCount;
        const options = { builtinParsers: false, diagnostics, ...(shape === "refused" ? STRICT : {}) };
        const expected = recover(source, options); const expectedRecovery = expected.ok ? expected : expected.failure.recovered;
        if (expectedRecovery?.value.rows.length !== rowCount) throw new Error("delivery oracle missed source rows");
        const receive = MessagePort.prototype.addEventListener; const post = MessagePort.prototype.postMessage;
        const close = MessagePort.prototype.close; const cleanupCause = new Error("delivery release failed");
        const failCleanup = shape === "refused" && boundary === "final";
        let received = 0; let receivingPort; let failed = false; let closes = 0; let sequence;
        MessagePort.prototype.addEventListener = function(name, listener, ...rest) {
          if (name !== "message") return receive.call(this, name, listener, ...rest);
          return receive.call(this, name, event => {
            const message = event.data; const payload = message.kind === "piece" ? message.piece.envelope?.value : undefined;
            const rows = message.piece?.kind === "items" ? payload : payload?.value?.rows;
            if (Array.isArray(rows) && rows.length > 0 && Object.hasOwn(rows[0], "id")) { received += rows.length; receivingPort = this; }
            listener(event);
          }, ...rest);
        };
        MessagePort.prototype.postMessage = function(message, ...rest) {
          if (this === receivingPort && message === "pull" && received > 0 && (boundary === "early" || received === rowCount)) {
            failed = true; this.dispatchEvent(new MessageEvent("messageerror")); return;
          }
          return post.call(this, message, ...rest);
        };
        MessagePort.prototype.close = function() { close.call(this); if (++closes === 1 && failCleanup) throw cleanupCause; };
        try {
          sequence = shape === "cut" ? parseManyAsync(source, { ...options, execution: worker }) : undefined;
          const result = sequence ? (await sequence.next()).value : await parseAsync(source, { ...options, execution: worker });
          if (!failed || result.ok || result.failure.kind !== "execution-unavailable" || result.failure.reason !== "failed") throw new Error("delivery fault missed real browser data");
          if (boundary === "early" && shape !== "metadata" && received >= rowCount) throw new Error("early browser fault did not interrupt a partial value");
          const partial = result.failure.recovered;
          if (!partial || partial.value.rows.length !== received || partial.value.rows[0].id !== 0 || partial.value.rows[received - 1].id !== received - 1) throw new Error("delivery lost or invented browser rows");
          const cutDifference = firstDifference(describe(partial.cut), describe(expectedRecovery.cut));
          const reportDifference = firstDifference(describe(result.diagnostics), describe(expected.diagnostics));
          if (partial.complete !== expectedRecovery.complete || cutDifference !== undefined || reportDifference !== undefined) throw new Error("delivery changed browser source metadata: " + shape + "/" + boundary + " " + (cutDifference ?? reportDifference ?? "completion"));
          if (shape === "refused" && (result.failure.cause?.kind !== "policy-refused" || result.failure.cause.issue !== result.diagnostics.errors[0])) throw new Error("delivery lost browser refusal identity");
          if (closes !== 2 || (failCleanup ? result.failure.cleanupFailure?.cause !== cleanupCause : result.failure.cleanupFailure !== undefined)) throw new Error("delivery skipped independent browser releases");
          if (sequence && !(await sequence.next()).done) throw new Error("failed delivery repeated browser rows");
        } finally {
          MessagePort.prototype.addEventListener = receive; MessagePort.prototype.postMessage = post; MessagePort.prototype.close = close;
          await sequence?.return();
        }
      }
      // The worker cannot clone a caller's reason; failure of its recovery must preserve it too.
      for (const project of [repairAsync, findJsonSpanAsync]) for (const report of [false, true]) {
        const source = '{"rows":[' + deliveryRows + ']}'; const settings = { diagnostics: report ? diagnostics : false };
        const expected = recover(source, settings); const stop = new AbortController();
        const reason = { source: "cancelled-recovery-delivery", unclonable: () => {} };
        const receive = MessagePort.prototype.addEventListener; const post = MessagePort.prototype.postMessage;
        let ready = false; let received = 0; let port;
        MessagePort.prototype.addEventListener = function(name, listener, ...rest) {
          if (name !== "message") return receive.call(this, name, listener, ...rest);
          return receive.call(this, name, event => {
            const message = event.data;
            if (message.kind === "ready") { ready = true; stop.abort(reason); }
            const rows = message.kind === "piece" && message.piece.kind === "items" ? message.piece.envelope.value : undefined;
            if (ready && Array.isArray(rows) && rows[0]?.id === 0) { received += rows.length; port = this; }
            listener(event);
          }, ...rest);
        };
        MessagePort.prototype.postMessage = function(message, ...rest) {
          if (this === port && message === "pull") { this.dispatchEvent(new MessageEvent("messageerror")); return; }
          return post.call(this, message, ...rest);
        };
        try {
          const result = await project(source, { ...settings, execution: worker, signal: stop.signal });
          if (!ready || received === 0 || received >= deliveryCount || result.ok || result.failure.kind !== "execution-unavailable" || result.failure.recovered?.value?.rows?.length !== received || result.failure.cause?.kind !== "aborted" || result.failure.cause.reason !== reason || firstDifference(describe(result.diagnostics), describe(expected.diagnostics)) !== undefined)
            throw new Error("cancelled browser recovery delivery lost its prefix, report or original reason");
        } finally { MessagePort.prototype.addEventListener = receive; MessagePort.prototype.postMessage = post; }
      }
      if ((await deliverySibling.next()).value?.value?.safe !== 41 || !(await deliverySibling.next()).done) throw new Error("failed delivery stopped browser sibling");
      const next = await parseAsync('{"safe":3}', { execution: worker });
      if (!next.ok || next.value.safe !== 3) throw new Error("failed delivery blocked next browser call");
    } finally { await deliverySibling.return(); }
    // A refused native release must not require probe cleanup before other calls can finish.
    for (const live of [false, true]) for (const strict of [false, true]) for (const configured of [false, true]) for (const verb of ["parseAsync", "repairAsync", "findJsonSpanAsync"]) for (const report of [false, true]) {
      const options = { ...(strict ? STRICT : {}), execution: worker, diagnostics: report ? diagnostics : false };
      const parser = configured ? initAsyncParser(options) : undefined;
      const call = input => ({ parseAsync, repairAsync, findJsonSpanAsync })[verb](input, parser ?? options);
      const input = "{'safe':2}"; const expected = await call(input);
      if (strict ? expected.ok || expected.failure.kind !== "policy-refused" : !expected.ok) throw new Error("browser close refusal control failed");
      const sibling = live ? parseManyAsync('{"safe":40} {"safe":41}', { execution: worker }) : undefined;
      if (sibling !== undefined && (await sibling.next()).value?.value?.safe !== 40) throw new Error("browser close refusal sibling did not start");
      const nativeClose = MessagePort.prototype.close; const cause = new Error("host refused close"); let refused; let closes = 0;
      MessagePort.prototype.close = function () { if (++closes === 1) { refused = this; throw cause; } nativeClose.call(this); };
      try {
        const outcome = await call(input);
        if (closes !== 2 || outcome.ok) throw new Error("browser close refusal skipped release or became success");
        if (strict) { const { cleanupFailure, ...failure } = outcome.failure; if (cleanupFailure?.kind !== "cleanup-failed" || cleanupFailure.cause !== cause || firstDifference(describe({ ...outcome, failure }), describe(expected)) !== undefined) throw new Error("browser close refusal lost primary recovery or cause"); }
        else if (outcome.failure.kind !== "cleanup-failed" || outcome.failure.cause !== cause || firstDifference(describe(outcome.failure.completed), describe(expected)) !== undefined || "recovered" in outcome.failure) throw new Error("browser close refusal lost completed output or cause");
        const next = await parseAsync('{"safe":3}', { execution: worker }); if (!next.ok || next.value.safe !== 3) throw new Error("browser refused port blocked next caller");
        if (sibling !== undefined && ((await sibling.next()).value?.value?.safe !== 41 || !(await sibling.next()).done)) throw new Error("browser refused port damaged sibling");
      } finally { MessagePort.prototype.close = nativeClose; if (refused !== undefined) nativeClose.call(refused); await sibling?.return(); parser?.close(); }
    }
    // Cleanup after delivery must preserve each verb's completed output, not claim success.
    for (const faults of [1, 2]) for (const configured of [false, true]) for (const verb of ["parseAsync", "repairAsync", "findJsonSpanAsync"]) for (const report of [false, true]) {
      const options = { execution: worker, diagnostics: report ? diagnostics : false };
      const parser = configured ? initAsyncParser(options) : undefined;
      const call = input => ({ parseAsync, repairAsync, findJsonSpanAsync })[verb](input, parser ?? options);
      const input = "{'safe':2}"; const expected = await call(input);
      if (!expected.ok) throw new Error("cleanup success control failed");
      const nativeClose = MessagePort.prototype.close; const causes = [new Error("first cleanup"), new Error("second cleanup")]; let closes = 0; let outcome;
      MessagePort.prototype.close = function () { nativeClose.call(this); if (++closes <= faults) throw causes[closes - 1]; };
      try { outcome = await call(input); } finally { MessagePort.prototype.close = nativeClose; parser?.close(); }
      if (closes !== 2 || outcome.ok || outcome.failure.kind !== "cleanup-failed" || firstDifference(describe(outcome.failure.completed), describe(expected)) !== undefined)
        throw new Error("cleanup lost completed output");
      const error = outcome.failure.cause;
      if (faults === 1 ? error !== causes[0] : !(error instanceof AggregateError) || error.errors.length !== 2 || error.errors.some((cause, index) => cause !== causes[index])) throw new Error("cleanup lost a host cause");
      if (report && outcome.diagnostics !== outcome.failure.completed.diagnostics) throw new Error("cleanup copied the completed report");
      if ("value" in outcome || "recovered" in outcome.failure) throw new Error("cleanup disguised completed output as success or source recovery");
      const next = await parseAsync('{"safe":3}', { execution: worker });
      if (!next.ok || next.value.safe !== 3) throw new Error("cleanup damaged the next caller");
    }
    // Whole-input calls must return a primary refusal even when releasing their channel fails.
    for (const faults of [1, 2]) for (const configured of [false, true]) for (const verb of ["parseAsync", "repairAsync", "findJsonSpanAsync"]) for (const report of [false, true]) {
      const options = { ...STRICT, execution: worker, diagnostics: report ? diagnostics : false };
      const parser = configured ? initAsyncParser(options) : undefined;
      const call = input => ({ parseAsync, repairAsync, findJsonSpanAsync })[verb](input, parser ?? options);
      const input = "{'safe':2}"; const expected = await call(input);
      if (expected.ok || expected.failure.kind !== "policy-refused") throw new Error("cleanup refusal control failed");
      const nativeClose = MessagePort.prototype.close; const causes = [new Error("first cleanup"), new Error("second cleanup")]; let closes = 0; let outcome;
      MessagePort.prototype.close = function () { nativeClose.call(this); if (++closes <= faults) throw causes[closes - 1]; };
      try { outcome = await call(input); } finally { MessagePort.prototype.close = nativeClose; parser?.close(); }
      if (closes !== 2 || outcome.ok || outcome.failure.kind !== "policy-refused" || outcome.failure.cleanupFailure?.kind !== "cleanup-failed")
        throw new Error("cleanup replaced the primary failure");
      const error = outcome.failure.cleanupFailure.cause;
      if (faults === 1 ? error !== causes[0] : !(error instanceof AggregateError) || error.errors.length !== 2 || error.errors.some((cause, index) => cause !== causes[index])) throw new Error("cleanup lost a host cause");
      const { cleanupFailure, ...failure } = outcome.failure;
      if (firstDifference(describe({ ...outcome, failure }), describe(expected)) !== undefined)
        throw new Error("cleanup changed recovery or diagnostics");
      if (report && outcome.failure.issue !== outcome.diagnostics.errors[0]) throw new Error("cleanup lost diagnostic identity");
      const next = await parseAsync('{"safe":3}', { execution: worker });
      if (!next.ok || next.value.safe !== 3) throw new Error("cleanup damaged the next caller");
    }
  }
  // Deep equality cannot detect copied exact-number leaves in overlapping selections.
  for (const padding of ["", "x".repeat(200000)]) {
    const source = '{"a":9007199254740993,"b":9007199254740993,"padding":"' + padding + '"}';
    const aliases = await parseAsync(source, { execution: worker, select: select([[], ["a"], ["b"]]) });
    if (!aliases.ok || aliases.value.length !== 3 ||
        !isExactNumber(aliases.value[1].value) || !isExactNumber(aliases.value[2].value) ||
        !Object.is(aliases.value[0].value.a, aliases.value[1].value) ||
        !Object.is(aliases.value[0].value.b, aliases.value[2].value) ||
        Object.is(aliases.value[1].value, aliases.value[2].value))
      throw new Error("worker selection must preserve exact-number aliases without merging equal tokens");
  }
  // Repeated overlapping selections share one exact token across changed packet boundaries.
  const selectedToken = "9".repeat(131072);
  const selectedSource = '{"a":'.repeat(64) + selectedToken + "}".repeat(64);
  const selectedPaths = Array.from({ length: 65 }, (_, depth) => Array(depth).fill("a"));
  for (let pass = 0; pass < 2; pass++) {
    const result = await parseAsync(selectedSource, { execution: worker, select: select(selectedPaths) });
    if (!result.ok || result.value.length !== selectedPaths.length)
      throw new Error("overlapping worker selection lost matches");
    let first;
    for (const match of result.value) {
      let leaf = match.value;
      while (!isExactNumber(leaf)) {
        if (typeof leaf !== "object" || leaf === null || !Object.hasOwn(leaf, "a"))
          throw new Error("overlapping worker selection changed its nested value");
        leaf = leaf.a;
      }
      if (leaf.text !== selectedToken) throw new Error("overlapping worker selection changed exact digits");
      if (first === undefined) first = leaf;
      else if (leaf !== first) throw new Error("overlapping worker selection copied its shared exact leaf");
    }
  }
  // Input depth must not become a host-specific structured-clone limit.
  const depth = 6000;
  const deep = await parseAsync("[".repeat(depth) + "1" + "]".repeat(depth), { execution: worker, maxDepth: depth + 1, builtinParsers: false });
  if (!deep.ok) throw new Error("deep worker recovery failed");
  let leaf = deep.value;
  for (let i = 0; i < depth; i++) {
    if (!Array.isArray(leaf) || leaf.length !== 1) throw new Error("deep worker value changed");
    leaf = leaf[0];
  }
  if (leaf !== 1) throw new Error("deep worker leaf changed");
  // Refusal metadata shares its issue with the report, even when recovery crosses in pieces.
  const refusalInput = "[" + "[".repeat(600) + "1" + "]".repeat(600) + "," + ('{"' + "k".repeat(5000) + '":').repeat(32) + "[1,]" + "}".repeat(32) + "," + '{"a":1},'.repeat(5000) + "]";
  const expectedRefusal = recover(refusalInput, { ...STRICT, diagnostics, maxDepth: 1024 });
  const refusal = await parseAsync(refusalInput, { ...STRICT, diagnostics, maxDepth: 1024, execution: worker });
  if (refusal.ok || refusal.failure.kind !== "policy-refused" || refusal.failure.issue !== refusal.diagnostics.errors[0] || firstDifference(describe(expectedRefusal), describe(refusal)) !== undefined) throw new Error("worker refusal lost recovery or diagnostic identity");
  const reason = { source: "polling-caller" };
  const signal = { aborted: false, reason };
  const values = parseManyAsync('{"a":1} {"b":2}', { execution: worker, signal });
  try {
    const first = await values.next();
    if (first.done || !first.value.ok) throw new Error("worker must deliver the first root");
    signal.aborted = true;
    const stopped = await values.next();
    if (stopped.done || stopped.value.ok || stopped.value.failure.kind !== "aborted" || stopped.value.failure.reason !== reason) throw new Error("worker ignored polling cancellation");
    const transfers = [];
    for (const project of [repairAsync, findJsonSpanAsync]) {
      const reason = { source: "projected-transfer" };
      const signal = { aborted: false, reason };
      // Cancellation must reach a parsed projection; startup polls vary with worker reuse.
      const method = typeof portPrototype.on === "function" ? "on" : "addEventListener";
      const receive = portPrototype[method];
      let reached = false;
      portPrototype[method] = function(name, listener, ...rest) {
        if (name !== "message") return receive.call(this, name, listener, ...rest);
        return receive.call(this, name, (event, ...args) => {
          const message = method === "on" ? event : event.data;
          if (message.kind === "ready") { reached = true; signal.aborted = true; }
          return listener(event, ...args);
        }, ...rest);
      };
      const source = "{a:1";
      const expected = recover(source);
      let result;
      try { result = await project(source, { execution: worker, signal }); }
      finally { portPrototype[method] = receive; }
      const recovery = { value: expected.value, complete: expected.complete, cut: expected.cut };
      if (!reached) throw new Error("projected cancellation must observe the worker ready boundary");
      if (!expected.ok || result.ok || result.failure.kind !== "aborted" || result.failure.reason !== reason || firstDifference(describe(recovery), describe(result.failure.recovered)) !== undefined) throw new Error("projected transfer stop lost recovery");
      transfers.push(result);
    }
    return [bytes, first.value, stopped.value, ...transfers];
  } finally { await values.return(); }
};
const repairCases = async (execution) => {
  const results = [];
  for (const report of [false, true]) for (const input of ["undefined", "NaN", "Infinity", "-Infinity", '{"bad":NaN,"good":[1,']) {
    const options = { allowJavaScript: true, diagnostics: report ? diagnostics : false, ...(input.startsWith("{") ? { select: select([["bad"], ["good"]]) } : {}) };
    const expected = recover(input, options);
    const result = await repairAsync(input, { ...options, execution });
    if (!result.ok && result.failure.kind === "execution-unavailable") { results.push(result); continue; }
    // JSON has no spelling for these values, so repair writes each as null in place.
    const written = !result.ok ? undefined : Array.isArray(result.value) ? result.value.map((match) => match.value).join() : result.value;
    if (!expected.ok || !result.ok || written !== (input.startsWith("{") ? "null,[1]" : "null") || result.complete !== expected.complete) throw new Error("repair must write recovered non-JSON values as null");
    if (firstDifference(describe(expected.cut), describe(result.cut)) !== undefined || firstDifference(describe(expected.diagnostics), describe(result.diagnostics)) !== undefined) throw new Error("repair discarded recovery or diagnostics");
    results.push(result);
  }
  return results;
};
const repair = async () => [...await repairCases(auto), ...await repairCases(cooperative)];
const workerRepair = () => repairCases(worker);
// Close waits are portable even where worker execution is unavailable.
const closeWaits = async () => {
  const out = [];
  for (const mode of ["control", "remove", "before", "after", "both", "abort", "abort-remove", "abort-refuse"])
    for (const sourceFails of [false, true]) {
      const cleanup = Promise.withResolvers();
      const stream = parseStream({ [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: '{"a":1} ' }),
        return: () => cleanup.promise,
      }) });
      await stream.next();
      const registrationCause = new Error("registration failed");
      const removalCause = new Error("removal failed");
      const sourceCause = new Error("source cleanup failed");
      const reason = { stop: "abandon this wait" };
      const aborts = mode === "abort" || mode === "abort-remove" || mode === "abort-refuse";
      const listeners = new Set();
      let removals = 0;
      const signal = {
        aborted: false,
        reason,
        addEventListener(_type, listener) {
          if (mode === "before") throw registrationCause;
          listeners.add(listener);
          if (mode === "after" || mode === "both") throw registrationCause;
        },
        removeEventListener(_type, listener) {
          removals++;
          if (mode === "abort-refuse") throw removalCause;
          listeners.delete(listener);
          if (mode === "remove" || mode === "both" || mode === "abort-remove") throw removalCause;
        },
      };
      const first = stream.close({ signal });
      const sibling = stream.close({ signal: new AbortController().signal });
      const shared = stream.close();
      if (aborts) {
        signal.aborted = true;
        for (const listener of listeners) listener();
        // An abandoned wait must settle before an uncooperative source acknowledges cleanup.
        const abandoned = await first;
        if (abandoned.ok || abandoned.failure.kind !== "aborted" || abandoned.failure.reason !== reason)
          throw new Error("close wait lost cancellation: " + mode);
      }
      if (sourceFails) cleanup.reject(sourceCause);
      else cleanup.resolve({ done: true, value: undefined });
      const result = await first;
      const subscriptionFails = mode === "before" || mode === "after" || mode === "both";
      // Subscription fails before source cleanup answers; later removal must preserve that first cause.
      const primary = subscriptionFails ? registrationCause : sourceFails ? sourceCause : mode === "remove" ? removalCause : undefined;
      const failureKind = subscriptionFails ? "signal-failed" : "cleanup-failed";
      if (!aborts && (primary === undefined ? !result.ok : result.ok || result.failure.kind !== failureKind || result.failure.cause !== primary))
        throw new Error("close wait primary cause changed: " + mode);
      const secondary = mode === "both" || mode === "abort-remove" || mode === "abort-refuse" || (mode === "remove" && sourceFails) ? removalCause : undefined;
      if (!result.ok && result.failure.cleanupFailure?.cause !== secondary)
        throw new Error("close wait secondary cause changed: " + mode);
      if (listeners.size !== (mode === "abort-refuse" ? 1 : 0)) throw new Error("close wait listener ownership changed: " + mode);
      for (const listener of listeners) listener();
      if (removals !== 1) throw new Error("close wait repeated listener cleanup: " + mode);
      for (const independent of [await sibling, await shared])
        if (sourceFails ? independent.ok || independent.failure.kind !== "cleanup-failed" || independent.failure.cause !== sourceCause : !independent.ok)
          throw new Error("close wait corrupted independent acknowledgement: " + mode);
      out.push({ mode, sourceFails });
    }
  return out;
};
${verifyPreIterationCancellation.toString()}
const signalRemoval = async () => {
  for (const execution of [auto, cooperative, worker])
    for (const first of ${JSON.stringify(preIterationStops)})
      await verifyPreIterationCancellation(initAsyncParser, parseManyAsync, first, execution);
  const out = [];
  for (const mode of ["exhausted", "source", "aborted", "close", "return", "throw", "unstarted-throw"]) {
    const cause = new Error("signal removal refused");
    const primary = new Error("source failed");
    let reads = 0, releases = 0, removals = 0;
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "removeEventListener", { value(...args) {
      AbortSignal.prototype.removeEventListener.call(controller.signal, ...args);
      removals++;
      throw cause;
    } });
    const stream = parseStream({ [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (mode === "source") throw primary;
        if (mode === "aborted") controller.abort(primary);
        return ++reads === 1 ? { done: false, value: '{"a":1} ' } : { done: true };
      },
      return: async () => { releases++; return { done: true }; },
    }) }, { summary: true, signal: controller.signal });
    if (mode === "close" || mode === "return" || mode === "throw" || mode === "unstarted-throw") {
      if (mode !== "unstarted-throw" && (await stream.next()).done) throw new Error("lost first stream value");
      if (mode === "return") {
        let failure;
        try { await stream.return(); } catch (error) { failure = error; }
        if (failure !== cause) throw new Error("return lost removal cause");
      }
      if (mode === "throw" || mode === "unstarted-throw") {
        let failure;
        try { await stream.throw(primary); } catch (error) { failure = error; }
        if (!(failure instanceof AggregateError) || failure.errors.length !== 2 || failure.errors[0] !== primary || failure.errors[1] !== cause || failure.cause !== cause)
          throw new Error("consumer throw lost a cause: " + mode);
      }
    } else {
      const items = [];
      for await (const item of stream) items.push(item);
      const failure = items.find(item => item.ok === false)?.failure;
      if (!failure || (mode === "exhausted"
        ? failure.kind !== "cleanup-failed" || failure.cause !== cause
        : failure.kind !== (mode === "aborted" ? "aborted" : "source-failed") || failure.cleanupFailure?.cause !== cause || (mode === "aborted" ? failure.reason : failure.cause) !== primary))
        throw new Error("terminal removal failure changed: " + mode);
      if (items.at(-1)?.kind !== "summary" || items.at(-1).complete !== false)
        throw new Error("removal failure followed the final summary");
    }
    const closed = await stream.close();
    if (closed.ok || closed.failure.kind !== "cleanup-failed" || closed.failure.cause !== cause)
      throw new Error("close lost removal cause: " + mode);
    if (!(await stream.next()).done || await stream.close() !== closed || removals !== 1 || releases !== (mode === "unstarted-throw" ? 0 : 1))
      throw new Error("removal failure stranded ownership: " + mode);
    out.push({ mode, reads, releases, removals });
  }
  return out;
};
const metricsExit = async () => {
  for (const mode of ["return", "throw", "close"]) {
    const scope = createMetrics();
    const stream = parseStream(['{"a":1} {"b":2}'], scope);
    if ((await stream.next()).done) throw new Error("metrics lost its first item");
    const cause = new Error("consumer stopped");
    if (mode === "return") await stream.return();
    else if (mode === "close") await stream.close();
    else {
      let failure;
      try { await stream.throw(cause); } catch (error) { failure = error; }
      if (failure !== cause) throw new Error("metrics changed consumer rejection");
    }
    const metrics = scope.read();
    if (typeof metrics.parseDuration !== "number" || !Number.isFinite(metrics.parseDuration) || metrics.parseAttempts !== 1 || !(await stream.next()).done)
      throw new Error("metrics lost early-exit accounting: " + mode);
  }
  return true;
};
const sharedSpine = async () => {
  const out = [];
  for (const selected of [false, true]) {
    const stream = createStreamParser({ view: sharedView, ...(selected ? { select: select([["a"]]) } : {}) });
    try {
      Array.from(stream.feed('{"done":[1],"a":{"b":"par'));
      const first = stream.snapshot();
      if (!first.ok || !first.value) throw new Error("missing shared snapshot");
      const held = selected ? first.value.value[0]?.value : first.value.value.a;
      if (!held || held.b !== "par" || Object.isFrozen(held)) throw new Error("shared open copy is incorrect");
      if (!selected && !Object.isFrozen(first.value.value.done)) throw new Error("shared finished branch is mutable");
      Array.from(stream.feed('t"}} '));
      const last = stream.snapshot();
      if (!last.ok || !last.value) throw new Error("missing completed shared snapshot");
      const value = selected ? last.value.value[0]?.value : last.value.value.a;
      if (!value || value.b !== "part" || held.b !== "par") throw new Error("later input changed a held shared copy");
      held.b = "caller";
      if (value.b !== "part") throw new Error("shared open copy reached parser state");
      out.push({ selected, first, last });
    } finally { stream.close(); }
  }
  return out;
};
const detachedSelection = async () => {
  const out = [];
  for (const text of ['{"content":"hel', '{"content":{"text":"hel']) {
    const stream = createStreamParser({ select: select([["content"]]), view: ownedView });
    Array.from(stream.feed(text));
    stream.close();
    const first = stream.snapshot();
    const match = first.ok && first.value?.value[0];
    if (!match) throw new Error("missing detached selected prefix");
    const offset = match.span.start.offset;
    if (!first.value.cut) throw new Error("missing detached cut");
    Reflect.set(first.value.cut, "kind", "number");
    Reflect.set(match, "value", "caller replacement");
    Reflect.set(match.span, "start", { ...match.span.start, offset: -1 });
    const next = stream.snapshot();
    const later = next.ok && next.value?.value[0];
    if (!later || next.value.cut?.kind !== "string" || later.span.start.offset !== offset ||
        (text.includes('{"text"') ? later.value.text : later.value) !== "hel")
      throw new Error("caller write changed a detached owned snapshot");
    out.push(later);
  }
  return out;
};
${resourceRecoveryProgram()}
${stoppedViewMemoryProgram()}
${pendingTokenMemoryProgram()}
const strictRetry = async () => {
  const out = [];
  const parser = initAsyncParser({ ...STRICT, execution: cooperative, diagnostics });
  try { for (const pass of [0, 1]) {
    const refused = await parseAsync('{"safe":1,broken:2}', parser);
    if (refused.ok || refused.failure.kind !== "policy-refused" ||
        refused.failure.recovered?.value?.safe !== 1 || refused.diagnostics.errors.length === 0)
      throw new Error("strict refusal lost its usable prefix or report");
    // The caller supplies corrected source; retry must not relax the reusable strict policy.
    const retried = await parseAsync('{"safe":1,"broken":2}', parser);
    const refusedAgain = await parseAsync('{"safe":1,broken:2}', parser);
    if (!retried.ok || !retried.complete || retried.value.safe !== 1 || retried.value.broken !== 2 ||
        retried.diagnostics.errors.length !== 0 || refusedAgain.ok ||
        firstDifference(describe(refused), describe(refusedAgain)) !== undefined)
      throw new Error("retry changed strict policy or reused a previous outcome");
    out.push({ pass, refused, retried });
  } } finally { parser.close(); }
  return out;
};
const batchStop = async () => {
  const out = [];
  for (const mode of ["sibling", "task"]) {
    const task = new AbortController(), sibling = new AbortController();
    const parser = initAsyncParser({ execution: cooperative, signal: task.signal });
    const calls = [parseManyAsync('{"id":1} {"id":2}', parser, { signal: sibling.signal }),
      parseManyAsync('{"id":1} {"id":2}', parser)];
    try {
      const first = await Promise.all(calls.map(call => call.next()));
      if (first.some(item => item.done || !item.value.ok || item.value.value.id !== 1))
        throw new Error("batch lost its first delivered roots");
      (mode === "task" ? task : sibling).abort("batch stop");
      const next = await Promise.all(calls.map(call => call.next()));
      for (const [index, item] of next.entries()) {
        const stopped = mode === "task" || index === 0;
        if (item.done || (stopped ? item.value.ok || item.value.failure.kind !== "aborted" ||
            item.value.failure.reason !== "batch stop" : !item.value.ok || item.value.value.id !== 2))
          throw new Error("batch cancellation crossed sibling boundaries or changed its reason");
      }
      if ((await Promise.all(calls.map(call => call.next()))).some(item => !item.done))
        throw new Error("batch replayed delivered roots after completion");
      out.push({ mode, first, next });
    } finally {
      await Promise.all(calls.map(call => call.return()));
      parser.close();
    }
  }
  return out;
};
const cooperativeLargeAbort = async () => {
  const out = [];
  for (const pass of [0, 1]) for (const selecting of [false, true]) {
  const controller = new AbortController();
  const length = 8 * 1024 * 1024;
  const input = '{"a":1}{"b":"' + "x".repeat(length) + '"}';
  const call = parseManyAsync(input, { execution: cooperative, signal: controller.signal, maxScalar: length * 2,
    ...(selecting ? { select: select([["a"], ["b"]]) } : {}),
  });
  let timer;
  try {
    const first = await call.next();
    if (first.done || !first.value.ok || (selecting
        ? first.value.value.value !== 1 || first.value.value.path.length !== 1 || first.value.value.path[0] !== "a"
        : first.value.value.a !== 1))
      throw new Error("cooperative cancellation lost the completed first root");
    // Queue after delivery: a synchronous consumer abort cannot prove host-task liveness.
    timer = setTimeout(() => controller.abort("queued stop"), 0);
    const next = await call.next();
    if (next.done || next.value.ok || next.value.failure.kind !== "aborted" ||
        next.value.failure.reason !== "queued stop")
      throw new Error("large cooperative scalar completed before queued cancellation");
    if (!(await call.next()).done)
      throw new Error("cooperative cancellation replayed a value after failure");
    // The stopped prefix length depends on host scheduling; compare the terminal contract.
    out.push({ pass, selecting, failure: next.value.failure.kind, reason: next.value.failure.reason });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await call.return();
  }
  }
  return out;
};
const schedulingRecovery = async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "setImmediate");
  const length = 8 * 1024 * 1024;
  const input = '{"ready":1,"tail":"' + "x".repeat(length) + '"}';
  const out = [];
  try {
    for (const selected of [false, true]) for (const verb of ["parse", "many", "repair", "span"]) {
      const cause = new Error("host scheduling failed");
      let turns = 0, call;
      // A real first task lets scanning begin; the second request fails without replaying source.
      Object.defineProperty(globalThis, "setImmediate", { configurable: true, value: callback => {
        if (++turns === 2) throw cause;
        return setTimeout(callback, 0);
      } });
      const options = { execution: cooperative, builtinParsers: false,
        ...(selected ? { select: select([[], ["tail"]]), diagnostics } : {}) };
      try {
        let result;
        if (verb === "many") {
          call = parseManyAsync(input, options);
          const item = await call.next();
          if (item.done) throw new Error("scheduling failure disappeared");
          result = item.value;
          if (!(await call.next()).done) throw new Error("stopped iteration replayed source");
        } else result = await ({ parse: parseAsync, repair: repairAsync, span: findJsonSpanAsync })[verb](input, options);
        if (result.ok || result.failure.kind !== "scheduling-failed" || result.failure.cause !== cause || turns !== 2)
          throw new Error("scheduling failure changed cause, outcome or execution route");
        const recovery = result.failure.recovered;
        if (!recovery || recovery.complete !== false || recovery.cut?.kind !== "string")
          throw new Error("scheduling failure lost incomplete recovery");
        const value = selected ? recovery.value.find(match => match.path.length === 0)?.value : recovery.value;
        const prefix = value?.tail;
        if (value?.ready !== 1 || typeof prefix !== "string" || prefix.length === 0 ||
            prefix.length >= length || prefix !== "x".repeat(prefix.length))
          throw new Error("scheduling failure lost or invented string content");
        if (selected && recovery.value.find(match => match.path[0] === "tail")?.value !== prefix)
          throw new Error("selected parent and leaf disagree after stopping");
        if ((result.diagnostics !== undefined) !== selected)
          throw new Error("scheduling failure changed optional report collection");
        out.push({ selected, verb, failure: result.failure.kind, prefix: true });
      } finally { if (call) await call.return(); }
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "setImmediate", original);
    else delete globalThis.setImmediate;
  }
  return out;
};
const largeFragments = async () => {
  const out = [];
  for (const pass of [0, 1]) for (const mode of ["complete", "early", "cut", "source"]) {
    const piece = "abc".repeat(1024), pieces = 256;
    let reads = 0, releases = 0, starts = 0, ends = 0, length = 0;
    let firstDataReads, occurrence;
    let failures = 0;
    const sourceCause = new Error("large scalar source failed");
    const source = async function* () {
      try {
        reads++; yield '{"content":"';
        for (let index = 0; index < pieces; index++) { reads++; yield piece; }
        if (mode === "source") throw sourceCause;
        if (mode !== "cut") { reads++; yield '"}'; }
      } finally { releases++; }
    };
    const stream = parseStream(source(), { select: select([["content"]], { fragments: decodedFragments }) });
    try { for await (const outcome of stream) {
      if (!outcome.ok) {
        if (mode !== "source" || outcome.failure.kind !== "source-failed" || outcome.failure.cause !== sourceCause)
          throw new Error("large selected scalar lost its source failure");
        failures++;
        continue;
      }
      if (failures !== 0) throw new Error("large scalar delivered success after failure");
      const fragment = outcome.value;
      if (fragment.kind === "start") {
        starts++;
        occurrence = fragment.id;
        if (fragment.path.length !== 1 || fragment.path[0] !== "content" || fragment.scalar !== "string")
          throw new Error("large scalar lost its source identity");
      } else if (fragment.kind === "data") {
        if (fragment.id !== occurrence) throw new Error("large scalar data changed occurrence");
        firstDataReads ??= reads;
        length += fragment.text.length;
        for (let index = 0; index < fragment.text.length; index++)
          if (fragment.text[index] !== "abc"[(length - fragment.text.length + index) % 3])
            throw new Error("large scalar changed its decoded contents");
        if (mode === "early") break;
      } else if (fragment.kind === "end") {
        ends++;
        if (fragment.id !== occurrence || fragment.complete !== (mode !== "cut"))
          throw new Error("large scalar changed its occurrence or source completion");
      }
    } } finally { await stream.close(); }
    // Fragment mode must deliver useful content before EOF and release the actual producer.
    if (starts !== 1 || releases !== 1 || firstDataReads === undefined || firstDataReads >= pieces + 2 ||
        failures !== (mode === "source" ? 1 : 0) ||
        (mode === "early" ? ends !== 0 || length === 0 || reads >= pieces + 2
          : length !== piece.length * pieces || ends !== (mode === "source" ? 0 : 1) ||
            reads !== pieces + (mode === "complete" ? 2 : 1)))
      throw new Error("large scalar delivery or early-exit cleanup is incomplete");
    out.push({ pass, mode, starts, ends, failures, length, released: releases });
  }
  return out;
};
const largeSelectedValues = async () => {
  const out = [];
  for (const pass of [0, 1]) for (const mode of ["complete", "cut", "source"]) {
    const piece = "abc".repeat(1024), pieces = 256;
    let reads = 0, releases = 0, successes = 0, failures = 0;
    const cause = new Error("large selected value source failed");
    const check = match => {
      if (match.path.length !== 1 || match.path[0] !== "content" || typeof match.value !== "string" ||
          match.value.length !== piece.length * pieces)
        throw new Error("large selected value lost its path or content");
      for (let index = 0; index < match.value.length; index++)
        if (match.value[index] !== "abc"[index % 3]) throw new Error("large selected value changed content");
    };
    const source = async function* () {
      try {
        reads++; yield '{"content":"';
        for (let index = 0; index < pieces; index++) { reads++; yield piece; }
        if (mode === "source") throw cause;
        if (mode === "complete") { reads++; yield '"}'; }
      } finally { releases++; }
    };
    const stream = parseStream(source(), { select: select([["content"]]) });
    try { for await (const item of stream) {
      if (item.ok) {
        if (mode === "source" || failures !== 0 || item.complete !== (mode === "complete") ||
            (mode === "cut" && item.cut?.kind !== "string"))
          throw new Error("large selected value disguised incomplete source");
        check(item.value);
        successes++;
      } else {
        const recovery = item.failure.recovered;
        if (mode !== "source" || item.failure.kind !== "source-failed" || item.failure.cause !== cause ||
            recovery?.complete !== false || recovery.cut?.kind !== "string" || recovery.value.length !== 1)
          throw new Error("large selected source failure lost its recovery or cause");
        check(recovery.value[0]);
        failures++;
      }
    } } finally { await stream.close(); }
    // Final selection must retain the usable prefix on failure without delivering it as success.
    if (successes !== (mode === "source" ? 0 : 1) || failures !== (mode === "source" ? 1 : 0) ||
        releases !== 1 || reads !== pieces + (mode === "complete" ? 2 : 1))
      throw new Error("large selected value delivery or cleanup is incomplete");
    out.push({ pass, mode, successes, failures, released: releases });
  }
  return out;
};
const scalarValues = async () => {
  const out = [];
  for (const pass of [0, 1]) for (const token of ["9".repeat(131072), "1.25", "-0", "true", "false", "null"])
    for (const mode of ["complete", "cut", "source", "abort"]) {
      const number = token !== "true" && token !== "false" && token !== "null";
      let releases = 0, successes = 0, failures = 0;
      const cause = new Error("selected scalar value source failed");
      const controller = new AbortController();
      const check = match => {
        if (match.path.length !== 1 || match.path[0] !== "content")
          throw new Error("selected scalar value lost its source path");
        if (token.length > 100) {
          if (!isExactNumber(match.value) || match.value.text !== token)
            throw new Error("selected scalar value lost exact digits");
        } else if (!Object.is(match.value, JSON.parse(token)))
          throw new Error("selected scalar value changed its value");
      };
      const source = async function* () {
        try {
          yield '{"content":';
          for (let at = 0; at < token.length; at += 4096) yield token.slice(at, at + 4096);
          if (mode === "cut") return;
          yield ',';
          if (mode === "source") throw cause;
          if (mode === "abort") controller.abort(cause);
          yield '"tail":0}';
        } finally { releases++; }
      };
      const stream = parseStream(source(), { select: select([["content"]]), maxScalar: token.length * 2, signal: controller.signal });
      try { for await (const item of stream) {
        if (item.ok) {
          if (mode === "source" || mode === "abort" || failures || item.complete !== (mode !== "cut" || !number) ||
              (mode === "cut" && number && item.cut?.kind !== "number"))
            throw new Error("selected scalar value disguised incomplete source");
          check(item.value); successes++;
        } else {
          const recovery = item.failure.recovered;
          if ((mode === "source" ? item.failure.kind !== "source-failed" || item.failure.cause !== cause
                : mode !== "abort" || item.failure.kind !== "aborted" || item.failure.reason !== cause) ||
              recovery?.complete !== false || recovery.value.length !== 1)
            throw new Error("selected scalar value lost its source failure or recovery");
          check(recovery.value[0]); failures++;
        }
      } } finally { await stream.close(); }
      // A settled token inside an open root remains recovery until final membership is known.
      if (successes !== (mode === "source" || mode === "abort" ? 0 : 1) || failures !== (mode === "source" || mode === "abort" ? 1 : 0) || releases !== 1)
        throw new Error("selected scalar value delivery or cleanup is incomplete");
      out.push({ pass, token: token.length > 100 ? "exact integer" : token, mode, successes, failures, releases });
    }
  return out;
};
const scalarFragments = async () => {
  const out = [];
  for (const pass of [0, 1]) for (const token of ["9".repeat(131072), "true", "false", "null"])
    for (const mode of ["complete", "early", "cut", "source"]) {
      const scalar = token[0] === "9" ? "number" : "literal";
      let releases = 0, starts = 0, ends = 0, failures = 0, text = "", occurrence;
      const cause = new Error("selected scalar source failed");
      const source = async function* () {
        try {
          yield '{"content":'; yield token;
          if (mode === "cut") return;
          yield ',';
          if (mode === "source") throw cause;
          yield '"tail":0}';
        } finally { releases++; }
      };
      const stream = parseStream(source(), {
        select: select([["content"]], { fragments: decodedFragments }), maxScalar: token.length * 2,
      });
      try { for await (const item of stream) {
        if (!item.ok) {
          if (mode !== "source" || item.failure.kind !== "source-failed" || item.failure.cause !== cause)
            throw new Error("selected scalar lost its source failure");
          failures++; continue;
        }
        if (failures) throw new Error("selected scalar delivered success after failure");
        const fragment = item.value;
        if (fragment.kind === "start") {
          starts++; occurrence = fragment.id;
          if (fragment.scalar !== scalar || fragment.path.length !== 1 || fragment.path[0] !== "content")
            throw new Error("selected scalar lost its kind or path");
        } else if (fragment.kind === "data") {
          if (fragment.id !== occurrence) throw new Error("selected scalar changed its occurrence");
          text += fragment.text;
          if (mode === "early") break;
        } else if (fragment.kind === "end") {
          ends++;
          if (fragment.id !== occurrence || fragment.complete !== (mode !== "cut" || scalar === "literal"))
            throw new Error("selected scalar changed source completion");
        }
      } } finally { await stream.close(); }
      // A settled token can need several pieces; early exit keeps its prefix and releases the source.
      const textValid = mode === "early" ? text.length > 0 && token.startsWith(text) : text === token;
      if (starts !== 1 || !textValid || releases !== 1 || ends !== (mode === "early" ? 0 : 1) ||
          failures !== (mode === "source" ? 1 : 0))
        throw new Error("selected scalar fragment mismatch: " + scalar + "/" + mode + ", text=" + text.length + ", starts=" + starts + ", ends=" + ends + ", failures=" + failures + ", releases=" + releases);
      out.push({ pass, scalar, mode, starts, ends, failures, length: text.length, releases });
    }
  return out;
};
const CASES = { ${Object.keys(PARTS)
    .map((name) => `${JSON.stringify(name)}: fixture_${name}`)
    .join(
      ", ",
    )}, syncMany, invalidInput, sharedSpine, detachedSelection, stoppedViews, completedScalars, preview, workerProbe, repair, workerRepair, closeWaits, signalRemoval, metricsExit, strictRetry, batchStop, cooperativeLargeAbort, schedulingRecovery, largeFragments, largeSelectedValues, scalarValues, scalarFragments };
export async function runAll() {
  const out = {};
  for (const [name, run] of Object.entries(CASES)) {
    try { out[name] = describe(await run()); } catch (error) { out[name] = { $: "threw", message: String(error && error.stack || error) }; }
  }
  return JSON.stringify(out);
}
`,
);

type Results = Record<string, unknown>;

// Reference: Node running the unbundled package (Node strips the describe module's types natively).
const node = spawnSync(
  "node",
  [
    "--input-type=module",
    "-e",
    `import(${JSON.stringify(entry)}).then((m) => m.runAll()).then((s) => process.stdout.write(s))`,
  ],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (node.status !== 0) throw new Error(`node reference failed: ${node.stderr}`);
const nodeVersion = spawnSync("node", ["--version"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const reference = JSON.parse(node.stdout) as Results;
for (const [name, value] of Object.entries(reference))
  if ((value as { $?: string }).$ === "threw")
    failures.push(`node reference: case ${name} threw: ${(value as { message: string }).message}`);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A member of a described object, by key. */
const get = (e: [string, unknown][], key: string): unknown => e.find(([k]) => k === key)?.[1];

/** A described string back as text. */
const text = (v: unknown): string | undefined => {
  const units = (v as { units?: number[] } | undefined)?.units;
  return units === undefined ? undefined : String.fromCharCode(...units);
};

/** Is this described outcome the typed `execution-unavailable` failure with the given reason, explained in words? */
const isUnavailable = (described: unknown, reason: string): boolean => {
  const entries = (described as { entries?: [string, unknown][] }).entries ?? [];
  const failure = get(entries, "failure") as { entries?: [string, unknown][] } | undefined;
  return (
    get(entries, "ok") === false &&
    text(get(failure?.entries ?? [], "kind")) === "execution-unavailable" &&
    text(get(failure?.entries ?? [], "execution")) === "worker" &&
    text(get(failure?.entries ?? [], "reason")) === reason &&
    // The message must name the fix that belongs to this reason, not only exist.
    (text(get(failure?.entries ?? [], "message")) ?? "").includes(
      reason === "unsupported" ? "has no `Worker`" : "deploys the package's worker file",
    )
  );
};

/** Every outcome inside a worker case's described array (parseMany results are nested one level). */
const outcomesOf = (described: unknown): unknown[] =>
  ((described as { entries?: [string, unknown][] }).entries ?? []).flatMap(([, v]) =>
    (v as { $?: string }).$ === "array" ? outcomesOf(v) : [v],
  );

const judge = (host: string, got: Results, workerUnavailable: string | undefined): void => {
  for (const name of Object.keys(reference)) {
    const value = got[name];
    if ((value as { $?: string } | undefined)?.$ === "threw") {
      failures.push(
        `${host}: case ${name} threw: ${(value as { message: string }).message.slice(0, 300)}`,
      );
      continue;
    }
    if (
      workerUnavailable !== undefined &&
      (name === "worker" || name === "workerProbe" || name === "workerRepair")
    ) {
      const outcomes = outcomesOf(value);
      if (
        outcomes.length === 0 ||
        (name === "workerRepair" && outcomes.length !== outcomesOf(reference[name]).length)
      )
        failures.push(`${host}: case ${name}: worker outcomes are missing`);
      const bad = outcomes.filter((o) => !isUnavailable(o, workerUnavailable));
      if (bad.length > 0)
        failures.push(
          `${host}: case ${name}: ${bad.length} outcome(s) are not execution-unavailable/${workerUnavailable}`,
        );
      continue;
    }
    const where = firstDifference(reference[name], value);
    if (where !== undefined)
      failures.push(
        `${host}: case ${name} differs from node ${nodeVersion} at ${where.slice(0, 300)}`,
      );
  }
};

/**
 * Browser bundles, one directory each. A bundler that does not emit `new Worker(new URL(...))`
 * builds twice: plain, where a forced worker must answer the typed `failed`, and with the README
 * recipe (the receiver in the app build, the worker built alone), where it must run like Node.
 */
type Page = { bundler: string; dir: string; script: string; workerFails: boolean };
const recipe = browserRequested ? workerRecipe(packed.consumer) : undefined;
const variants = (browserRequested ? bundlers : []).flatMap((b) =>
  b.takesExtraEntries
    ? [
        { b, name: b.name, extra: undefined, workerFails: true },
        { b, name: `${b.name}+recipe`, extra: recipe, workerFails: false },
      ]
    : [{ b, name: b.name, extra: undefined, workerFails: false }],
);
const out = path.join(packed.work, "out");
const built = await Promise.all(
  variants.map(async ({ b, name, extra, workerFails }): Promise<Page | undefined> => {
    const dir = path.join(out, name);
    try {
      const script = path.basename((await b.build(entry, dir, "optimised", extra)).entryFile);
      writeFileSync(
        path.join(dir, "index.html"),
        `<!doctype html><meta charset="utf-8"><script>window.__done = import("./${script}").then(({ runAll }) => runAll()).catch((e) => JSON.stringify({ $page: String(e && e.stack || e) }));</script>`,
      );
      // Reuse the packed bundle's memory cohorts without rerunning unrelated behavior recipes.
      writeFileSync(
        path.join(dir, "memory.html"),
        `<!doctype html><script type="module">import "./${script}"; globalThis.__workerUnavailable=${JSON.stringify(workerFails ? "failed" : null)}; globalThis.__memoryReady = true;</script>`,
      );
      return { bundler: name, dir, script, workerFails };
    } catch (error) {
      failures.push(`${name}: page build failed: ${messageOf(error).slice(0, 400)}`);
      return undefined;
    }
  }),
);
const pages = built.filter((p) => p !== undefined);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const [, isolation, bundler, ...rest] = url.pathname.split("/");
    const page = pages.find((p) => p.bundler === bundler);
    if (page === undefined) return new Response("no such bundle", { status: 404 });
    const file = Bun.file(path.join(page.dir, ...rest));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const headers: Record<string, string> = {
      "content-type": (file.name ?? "").endsWith(".html")
        ? "text/html"
        : (file.name ?? "").endsWith(".js")
          ? "text/javascript"
          : "application/octet-stream",
    };
    if (isolation === "iso") {
      headers["cross-origin-opener-policy"] = "same-origin";
      headers["cross-origin-embedder-policy"] = "require-corp";
    }
    return new Response(file, { headers });
  },
});

const heapUsage = (reply: unknown): number => {
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("usedSize" in reply) ||
    !Object.hasOwn(reply, "usedSize") ||
    typeof reply.usedSize !== "number" ||
    !Number.isFinite(reply.usedSize) ||
    reply.usedSize < 0
  )
    throw new Error("terminal memory probe returned an invalid heap counter");
  return reply.usedSize;
};

const chromiumMemoryProbe = (view: BrowserView): MemoryProbe => {
  // Collect between acknowledged phases; returning measured objects would retain them in CDP.
  const phase = async (expression: string): Promise<void> => {
    const reply = await view.cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (
      typeof reply !== "object" ||
      reply === null ||
      !("result" in reply) ||
      !Object.hasOwn(reply, "result") ||
      Object.hasOwn(reply, "exceptionDetails") ||
      typeof reply.result !== "object" ||
      reply.result === null ||
      !("value" in reply.result) ||
      !Object.hasOwn(reply.result, "value") ||
      reply.result.value !== true
    )
      throw new Error(`terminal memory phase did not complete: ${JSON.stringify(reply)}`);
  };
  const heap = async (): Promise<number> => {
    await view.cdp("HeapProfiler.collectGarbage");
    await view.cdp("HeapProfiler.collectGarbage");
    return heapUsage(await view.cdp("Runtime.getHeapUsage"));
  };
  return {
    start: (width, retain) => phase(`globalThis.__start(${width},${retain})`),
    advance: () => phase("globalThis.__advance()"),
    validate: () => phase("globalThis.__validate()"),
    clear: () => phase("globalThis.__clear()"),
    heap,
  };
};

const workerdMemoryProbe = async (mf: MiniflareRuntime) => {
  const discovery = new URL("/json/list", await mf.getInspectorURL());
  discovery.protocol = "http:";
  const response = await fetch(discovery);
  if (!response.ok) throw new Error("workerd inspector discovery failed");
  const targets: unknown = await response.json();
  if (!Array.isArray(targets)) throw new Error("workerd inspector returned no target list");
  const urls: string[] = [];
  for (const target of targets as unknown[]) {
    if (
      typeof target === "object" &&
      target !== null &&
      "id" in target &&
      Object.hasOwn(target, "id") &&
      target.id === "core:user:pjr-platform" &&
      "webSocketDebuggerUrl" in target &&
      Object.hasOwn(target, "webSocketDebuggerUrl") &&
      typeof target.webSocketDebuggerUrl === "string"
    )
      urls.push(target.webSocketDebuggerUrl);
  }
  const [endpoint] = urls;
  if (urls.length !== 1 || endpoint === undefined)
    throw new Error("workerd inspector did not identify the user isolate");
  const socket = new WebSocket(endpoint);
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(cause: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let serial = 0;
  const rejectPending = (cause: Error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(cause);
    }
    pending.clear();
  };
  const close = () => {
    try {
      socket.close();
    } finally {
      rejectPending(new Error("workerd inspector disposed"));
    }
  };
  socket.addEventListener("close", () => {
    rejectPending(new Error("workerd inspector closed before replying"));
  });
  socket.addEventListener("error", () => {
    rejectPending(new Error("workerd inspector connection failed"));
  });
  socket.addEventListener("message", (event) => {
    let message: unknown;
    try {
      if (typeof event.data !== "string") throw new Error("Inspector sent a non-text response");
      message = JSON.parse(event.data);
    } catch (cause) {
      rejectPending(new Error("workerd inspector returned malformed protocol data", { cause }));
      return;
    }
    if (
      typeof message !== "object" ||
      message === null ||
      !("id" in message) ||
      !Object.hasOwn(message, "id") ||
      typeof message.id !== "number"
    )
      return;
    const item = pending.get(message.id);
    if (item === undefined) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (Object.hasOwn(message, "error"))
      item.reject(new Error(`workerd inspector rejected its command: ${JSON.stringify(message)}`));
    else
      item.resolve(
        "result" in message && Object.hasOwn(message, "result") ? message.result : undefined,
      );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("workerd inspector connection timed out"));
      }, 3_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("workerd inspector connection failed"));
        },
        { once: true },
      );
    });
    const command = (method: string): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`workerd inspector timed out: ${method}`));
        }, 3_000);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method }));
        } catch (cause) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("workerd inspector could not send its command", { cause }));
        }
      });
    const phase = async (step: string): Promise<void> => {
      const reply = await mf.dispatchFetch(`http://localhost/__memory/${step}`);
      if (!reply.ok || (await reply.text()) !== "true")
        throw new Error(`workerd memory phase failed: ${step}`);
    };
    await command("Runtime.enable");
    await command("HeapProfiler.enable");
    const collect = async () => {
      // A single wake request can finish before the inspector command reaches the idle isolate.
      // Stop activity only on acknowledgement, and join both tasks even when either fails.
      let replied = false;
      const collecting = command("HeapProfiler.collectGarbage").finally(() => {
        replied = true;
      });
      const activity = async () => {
        // The acknowledgement changes replied; parallel wake requests would add needless work.
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition, eslint/no-await-in-loop
        while (!replied) await phase("gc");
      };
      const outcomes = await Promise.allSettled([collecting, activity()]);
      const errors: unknown[] = [];
      for (const outcome of outcomes)
        if (outcome.status === "rejected") {
          const cause: unknown = outcome.reason;
          errors.push(cause);
        }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, errors.map(String).join("; "));
    };
    const probe: MemoryProbe = {
      start: (width, retain) => phase(`start?width=${width}&retain=${retain}`),
      advance: () => phase("advance"),
      validate: () => phase("validate"),
      clear: () => phase("clear"),
      heap: async () => {
        await collect();
        await collect();
        return heapUsage(await command("Runtime.getHeapUsage"));
      },
    };
    return {
      probe,
      close,
      selectTerminalInput: () => phase("terminal-input"),
      selectStoppedViews: () => phase("stopped-views"),
      selectPendingTokens: () => phase("pending-tokens"),
    };
  } catch (cause) {
    close();
    throw cause;
  }
};

const runBrowser = async (backend: "webkit" | "chrome"): Promise<void> => {
  const label = backend === "webkit" ? "webkit" : "chromium";
  let view: BrowserView | undefined;
  try {
    view = await openBrowser(backend);
    if (view.engineVersion !== undefined) console.log(`  chromium engine: ${view.engineVersion}`);
    await view.navigate("about:blank");
  } catch (error) {
    await view?.close();
    const why = `unproved: ${label} (${messageOf(error).slice(0, 160)})`;
    hosts.push({ host: label, status: why });
    failures.push(`${why}; install the browser or run where it exists`);
    return;
  }
  const before = failures.length;
  let webkitMemory: Awaited<ReturnType<typeof webkitStringMemory>> | undefined;
  if (backend === "webkit") {
    try {
      webkitMemory = await webkitStringMemory(packed.work);
    } catch (error) {
      failures.push(`WebKit string ownership unproved: ${messageOf(error)}`);
    }
  }
  const completionTimeout = new Error("page completion timed out: window.__done");
  /* oxlint-disable eslint/no-await-in-loop */
  browserPages: for (const page of pages)
    for (const isolation of ["iso", "plain"] as const) {
      const host = `${label} ${page.bundler} ${isolation}`;
      try {
        const entryResponse = await fetch(
          `${server.url.href}${isolation}/${page.bundler}/${page.script}`,
        );
        if (!entryResponse.ok || (await entryResponse.arrayBuffer()).byteLength === 0)
          throw new Error(
            "browser entry request failed or returned an empty bundle; fix its build output",
          );
        await view.navigate(`${server.url.href}${isolation}/${page.bundler}/index.html`);
        const pageCompletion = view.evaluate("window.__done");
        const raw = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(reject, PLATFORM_OBSERVATION_MS, completionTimeout);
          pageCompletion.then(resolve, reject).finally(() => {
            clearTimeout(timer);
          });
        });
        if (typeof raw !== "string") throw new Error("page completion returned no JSON text");
        const got = JSON.parse(raw) as Results & { $page?: string };
        if (got.$page !== undefined) {
          failures.push(`${host}: page threw: ${got.$page.slice(0, 300)}`);
          continue;
        }
        const sab = (await view.evaluate("typeof SharedArrayBuffer")) as string;
        // Missing shared memory selects message cancellation; deployment failures still refuse.
        const workerUnavailable = page.workerFails ? "failed" : undefined;
        judge(host, got, workerUnavailable);
        if (isolation === "iso" && sab !== "function")
          failures.push(
            `${host}: COOP/COEP did not enable SharedArrayBuffer; the worker path went unproved`,
          );
        if (webkitMemory !== undefined) {
          await webkitMemory(`${server.url.href}${isolation}/${page.bundler}/memory.html`);
          console.log(
            `  terminal caller-reference, stopped-view and pending-token string ownership: ${host} proved`,
          );
        }
        if (backend === "chrome") {
          // Match the behavior owner's declared loading route, including bare bundlers' failures.
          await view.evaluate(
            `globalThis.__workerUnavailable=${JSON.stringify(workerUnavailable ?? null)}`,
          );
          if ((await view.evaluate("globalThis.__useTerminalInputMemory()")) !== true)
            throw new Error("terminal-input memory probe did not initialize");
          await checkTerminalMemory(chromiumMemoryProbe(view));
          const cases = await view.evaluate("globalThis.__caseCount");
          if (typeof cases !== "number" || cases !== (workerUnavailable === undefined ? 48 : 32))
            throw new Error("terminal ownership matrix omitted a declared execution route");
          console.log(`  terminal ownership: ${host} proved (${cases} cases)`);
          if ((await view.evaluate("globalThis.__useStoppedViewMemory()")) !== true)
            throw new Error("stopped-view memory probe did not initialize");
          await checkTerminalMemory(chromiumMemoryProbe(view), "stopped view");
          console.log(`  stopped-view ownership: ${host} proved`);
          if ((await view.evaluate("globalThis.__usePendingTokenMemory()")) !== true)
            throw new Error("pending-token memory probe did not initialize");
          await checkTerminalMemory(chromiumMemoryProbe(view), "pending token");
          console.log(`  pending-token ownership: ${host} proved`);
        }
      } catch (error) {
        failures.push(`${host}: ${messageOf(error)}`);
        // Closing below releases a stuck evaluation; that view cannot serve another page.
        if (error === completionTimeout) break browserPages;
      }
    }
  /* oxlint-enable eslint/no-await-in-loop */
  await view.close();
  hosts.push({ host: label, status: failures.length === before ? "proved" : "FAILED" });
};

if (requestedHosts.includes("webkit")) await runBrowser("webkit");
if (requestedHosts.includes("chromium")) await runBrowser("chrome");
await server.stop(true);

// workerd via miniflare: one module, no code splitting, no nodejs_compat (a plain edge consumer).
if (requestedHosts.includes("workerd"))
  try {
    const workerEntry = path.join(fixturesDir, "workerd.mjs");
    writeFileSync(
      workerEntry,
      `import { runAll } from "./platform.mjs";
// Keep a measured cohort reachable across requests while inspector collection runs.
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/__memory/")) {
    let result = true;
    switch (url.pathname) {
      case "/__memory/start": result = await globalThis.__start(Number(url.searchParams.get("width")), url.searchParams.get("retain") === "true"); break;
      case "/__memory/advance": result = await globalThis.__advance(); break;
      case "/__memory/validate": result = globalThis.__validate(); break;
      case "/__memory/clear": result = await globalThis.__clear(); break;
      case "/__memory/stopped-views": result = globalThis.__useStoppedViewMemory(); break;
      case "/__memory/pending-tokens": result = globalThis.__usePendingTokenMemory(); break;
      case "/__memory/terminal-input": result = globalThis.__useTerminalInputMemory(); break;
      case "/__memory/gc": break;
      default: throw new Error("Unknown memory probe phase");
    }
    return new Response(String(result));
  }
  return new Response(await runAll());
} };\n`,
    );
    const bundle = await rolldown({
      input: workerEntry,
      platform: "browser",
      logLevel: "silent",
      external: [/^node:/u],
    });
    const { output } = await bundle.generate({ format: "esm", minify: true, codeSplitting: false });
    await bundle.close();
    const script = output.find((o) => o.type === "chunk" && o.isEntry);
    if (script === undefined || script.type !== "chunk") throw new Error("no workerd script");
    const { Miniflare } = await import("miniflare");
    // Modules listed explicitly: miniflare's automatic collection refuses the package's
    // `import("node:worker_threads")` at construction, though workerd never takes that branch.
    const mf = new Miniflare({
      name: "pjr-platform",
      modules: [{ type: "ESModule", path: "worker.mjs", contents: script.code }],
      compatibilityDate: "2026-07-01",
      inspectorPort: 0,
    });
    try {
      const response = await mf.dispatchFetch("http://localhost/");
      const got = JSON.parse(await response.text()) as Results;
      const before = failures.length;
      judge("workerd", got, "unsupported");
      const memory = await workerdMemoryProbe(mf);
      try {
        await memory.selectTerminalInput();
        await checkTerminalMemory(memory.probe);
        console.log("  terminal ownership: workerd proved");
        await memory.selectStoppedViews();
        await checkTerminalMemory(memory.probe, "stopped view");
        console.log("  stopped-view ownership: workerd proved");
        await memory.selectPendingTokens();
        await checkTerminalMemory(memory.probe, "pending token");
        console.log("  pending-token ownership: workerd proved");
      } finally {
        memory.close();
      }
      hosts.push({ host: "workerd", status: failures.length === before ? "proved" : "FAILED" });
    } finally {
      await mf.dispose();
    }
  } catch (error) {
    failures.push(`workerd: ${messageOf(error)}`);
    hosts.push({ host: "workerd", status: "FAILED" });
  }

console.log(
  `reference: node ${nodeVersion}, unbundled package; bundles: ${pages.map((p) => p.bundler).join(", ") || "none"}`,
);
for (const h of hosts) console.log(`  ${h.host.padEnd(10)} ${h.status}`);
console.log(`wall ${((performance.now() - started) / 1000).toFixed(1)} s`);
if (keep) {
  console.log(`kept ${packed.work}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exitCode = 1;
}
completed = true;
