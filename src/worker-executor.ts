// SPDX-License-Identifier: Apache-2.0

/** Reuse one host worker while each call owns its message channel and cancellation. */

// Keep reception self-contained: a lazy URL asset cannot resolve un-emitted sibling imports.

import type { StopSignal } from "./stop-signal";
import { readStop } from "./stop-signal";
import { restoreWorkerStop, restoreWorkerValue } from "./worker-receive";
import type { ExactNumber } from "./exact-number";
import type { Outcome } from "./parser-outcome";
import type { ExecutionUnavailableFailure } from "./async-operation";
import { unavailable } from "./worker-unavailable";
import type {
  AbortedFailure,
  CleanupFailure,
  Input,
  ParseFailure,
  RepairFailure,
  Recovery,
  SignalFailure,
} from "./types";
import type {
  Slot,
  Address,
  Alias,
  WorkerPiece,
  WorkerControl,
  WorkerOperation,
  WorkerParserOptions,
  WorkerResponse,
  WorkerLike,
  WorkerChannel,
} from "./worker-message";
export type { WorkerLike } from "./worker-message";
import type {
  Host,
  OwnedWorker,
  Startup,
  StartupResult,
  Termination,
  WorkerFailure,
} from "./worker-host";
export type { WorkerFailure } from "./worker-host";

const setWorkerReference = (thread: OwnedWorker, referenced: boolean): void => {
  if (thread.reference !== undefined) thread.reference(referenced);
  else if (referenced) thread.worker.ref?.();
  else thread.worker.unref?.();
};

const denoWorkerReference = (): ((worker: WorkerLike, referenced: boolean) => void) | undefined => {
  if (!Object.hasOwn(globalThis, "Deno") || typeof Worker !== "function") return undefined;
  let reference: ((worker: WorkerLike, referenced: boolean) => void) | undefined;
  // Qualified Deno releases expose one anonymous unary symbol method for reference counting.
  // This private hook avoids Node bootstrap while preserving idle reuse and exit. New supported
  // releases must requalify its lifetime; missing or ambiguous shapes retain the public Node path.
  for (const symbol of Object.getOwnPropertySymbols(Worker.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, symbol);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
    const method: unknown = descriptor.value;
    if (typeof method !== "function" || method.name !== "" || method.length !== 1) continue;
    if (reference !== undefined) return undefined;
    reference = (worker, referenced) => {
      Reflect.apply(method, worker, [referenced]);
    };
  }
  return reference;
};

let pool: Host | Startup | Termination | undefined;

// Only host-release failures cross this internal boundary; runtime defects remain exceptions.
export class WorkerCleanupError extends Error {}

// Explicit disposal preserves both consumer rejection and cleanup without exposing our marker.
export const rethrowWorkerCleanup = (
  cause: unknown,
  primary?: { readonly cause: unknown },
): never => {
  const cleanup = cause instanceof WorkerCleanupError ? cause.cause : cause;
  if (primary !== undefined)
    throw new AggregateError([primary.cause, cleanup], "Consumer throw and worker cleanup failed", {
      cause: cleanup,
    });
  throw cleanup;
};

const cleanupFailure = (failures: readonly unknown[]): CleanupFailure => ({
  kind: "cleanup-failed",
  cause:
    failures.length === 1 ? failures[0] : new AggregateError(failures, "Worker cleanup failed"),
});
const closeChannel = (
  channel: { readonly port1: { close(): void }; readonly port2: { close(): void } },
  failures?: unknown[],
): unknown[] | undefined => {
  // Both ends are independent resources; one failed close must not suppress the other.
  try {
    channel.port1.close();
  } catch (cause) {
    (failures ??= []).push(cause);
  }
  try {
    channel.port2.close();
  } catch (cause) {
    (failures ??= []).push(cause);
  }
  return failures;
};
const cleanupFailed = (failure: CleanupFailure): never => {
  throw new WorkerCleanupError("Worker cleanup failed", { cause: failure.cause });
};

const terminateOwned = (thread: OwnedWorker): Promise<CleanupFailure | undefined> => {
  if (thread.state === "ended") return Promise.resolve(undefined);
  // Publish before calling the host: concurrent retries share release, while a rejected
  // termination retains a live thread until successful retry or an observed exit.
  const release: Termination = {
    kind: "terminating",
    thread,
    pending: true,
    result: Promise.resolve().then(async () => {
      let failure: CleanupFailure | undefined;
      try {
        await thread.worker.terminate();
      } catch (cause) {
        failure = { kind: "cleanup-failed", cause };
      }
      if (failure === undefined) thread.state = "ended";
      const portFailures = thread.release?.();
      if (portFailures !== undefined)
        failure = cleanupFailure(
          failure === undefined ? portFailures : [failure.cause, ...portFailures],
        );
      if (failure !== undefined && thread.state !== "ended") {
        // Failed startup can leave the server reference active even after every caller settles.
        try {
          setWorkerReference(thread, false);
        } catch (cause) {
          failure = cleanupFailure([failure.cause, cause]);
        }
      }
      release.pending = false;
      if (thread.state === "ended" && pool === release) pool = undefined;
      return failure;
    }),
  };
  pool = release;
  return release.result;
};

const releaseIdle = (current: Host): Promise<CleanupFailure | undefined> | undefined => {
  // Server workers remain reusable; failed hosts and browser workers must actually terminate.
  if (current.active !== 0 || pool !== current) return undefined;
  if (
    current.thread.state === "failed" ||
    (current.thread.reference === undefined && current.thread.worker.unref === undefined)
  )
    return terminateOwned(current.thread);
  return undefined;
};

const define = (target: object, key: PropertyKey, value: unknown): void => {
  // Never assignment: an own `__proto__` member would call the setter instead of being written.
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const frozenMemberDescriptor = (): Readonly<PropertyDescriptor> => {
  // An inherited `value` can replace data during native descriptor conversion; use a null prototype.
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.configurable = false;
  descriptor.writable = false;
  return Object.freeze(descriptor);
};
const FROZEN_MEMBER = /* @__PURE__ */ frozenMemberDescriptor();

/**
 * Rebuilds a result from its pieces on the main thread, one piece per call, so each call costs
 * about one piece's receipt.
 */
export const assembleWorkerPieces = (numberType: typeof ExactNumber) => {
  // Slot zero owns the root; cloned parents let every later piece reach its slot directly.
  const root: { value: unknown } = { value: undefined };
  const slots: Slot[] = [[root, "value"]];
  // Keep references rather than root paths; pop releases them as each freeze batch lands.
  const frozen: object[] = [];
  let frozenPrefixes: WeakMap<object, number> | undefined;
  let freezeCredit = 0;
  let freezeAt = 0;
  let recovery: Recovery | undefined;
  let recoveryAt: number | undefined;
  const read = (at: number): unknown => {
    const [parent, key] = slots[at] as Slot;
    return Reflect.get(parent, key);
  };
  const place = (at: number, value: unknown): void => {
    const [parent, key] = slots[at] as Slot;
    define(parent, key, value);
  };
  const register = (
    target: object,
    batch: unknown,
    addresses: readonly Address[] | undefined,
    aliases: readonly Alias[] | undefined,
  ): void => {
    // The batch root is copied into the destination; nested parents themselves are retained there.
    for (const [at, parent, key] of addresses ?? [])
      slots[at] = [parent === batch ? target : parent, key];
    for (const [at, parent, key] of aliases ?? [])
      define(parent === batch ? target : parent, key, read(at));
  };
  return {
    add(piece: WorkerPiece): void {
      switch (piece.kind) {
        case "place":
          root.value = restoreWorkerValue(piece.envelope, numberType);
          return;
        case "items": {
          const target = read(piece.at) as unknown[];
          if (frozenPrefixes?.get(target) === 0 && target.length > 0) {
            const first = target[0];
            // The first scalar is settled before this array's next packet. Lock it while
            // the prefix is packet-sized: the first readonly index can convert the whole array.
            if (typeof first !== "object" || first === null) {
              Object.defineProperty(target, 0, FROZEN_MEMBER);
              frozenPrefixes.set(target, 1);
            } else frozenPrefixes.delete(target);
          }
          // Pre-sizing length reduces some receipt pauses but slows later caller reads on Bun.
          for (const item of restoreWorkerValue(piece.envelope, numberType, frozen) as unknown[])
            target.push(item);
          if (piece.freeze === true) {
            frozen.push(target);
            (frozenPrefixes ??= new WeakMap()).set(target, 0);
          }
          register(target, piece.envelope.value, piece.addresses, piece.aliases);
          return;
        }
        case "members": {
          const target = read(piece.at) as object;
          const members = restoreWorkerValue(piece.envelope, numberType, frozen) as object;
          for (const key of Object.keys(members)) define(target, key, Reflect.get(members, key));
          if (piece.freeze === true) frozen.push(target);
          register(target, piece.envelope.value, piece.addresses, piece.aliases);
          if (piece.at === recoveryAt) {
            // Before this value packet, the wrapper has metadata but no received source value.
            recovery = read(piece.at) as Recovery;
            recoveryAt = undefined;
          }
          return;
        }
        case "text":
          place(piece.at, (read(piece.at) as string) + piece.text);
          return;
        case "recovery":
          // Completion describes the source, never how much of its value has crossed the channel.
          recoveryAt = piece.at;
          return;
        case "freeze":
          freezeCredit += piece.count;
          while (frozen.length > 0 && freezeCredit > 0) {
            const target = frozen[frozen.length - 1] as object;
            if (Array.isArray(target) && (freezeAt > 0 || target.length > piece.count)) {
              // Paths can be wider than a whole piece. Freeze their dense slots incrementally;
              // closing length and extensibility completes the same immutable array without a walk.
              if (freezeAt < target.length) {
                if (
                  Object.hasOwn(target, freezeAt) &&
                  (freezeAt !== 0 || frozenPrefixes?.get(target) !== 1)
                )
                  Object.defineProperty(target, freezeAt, FROZEN_MEMBER);
                freezeAt++;
              } else {
                Object.defineProperty(target, "length", FROZEN_MEMBER);
                Object.preventExtensions(target);
                frozen.pop();
                freezeAt = 0;
              }
              freezeCredit--;
            } else {
              // Small native freezes can overshoot by one container; carry that charge forward.
              freezeCredit -=
                1 + (Array.isArray(target) ? target.length : Object.keys(target).length);
              Object.freeze(target);
              frozen.pop();
            }
          }
      }
    },
    value: (): unknown => root.value,
    recovery: (): Recovery | undefined => recovery,
  };
};

const startWorker = (base: string, browserWorker: () => WorkerLike): Startup => {
  const started = Promise.withResolvers<boolean>();
  const pending: Startup = {
    kind: "starting",
    waiters: new Set(),
    state: "starting",
    cancel: () => {
      pending.state = "stopped";
      started.resolve(false);
    },
    // Defer construction until the attempt has an owner and its callers can subscribe to stop.
    result: Promise.resolve().then(async () => {
      let created: OwnedWorker | undefined;
      let startupChannel: WorkerChannel<"started", unknown> | undefined;
      let startupCleanup: unknown[] | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const clearDeadline = (): void => {
        const timer = deadline;
        // A failed host clear must leave its handle available to startup cleanup.
        if (timer !== undefined) clearTimeout(timer);
        deadline = undefined;
      };
      const wasStopped = (): boolean => pending.state === "stopped";
      if (wasStopped()) return "failed";
      try {
        const node =
          typeof process === "object" && process.versions?.node !== undefined ? process : undefined;
        let worker: WorkerLike;
        let channel: () => WorkerChannel;
        let directMessages = false;
        const webReference = denoWorkerReference();
        if (node === undefined) {
          if (typeof Worker !== "function" || typeof MessageChannel !== "function")
            return "unsupported";
          // The caller's processed constructor keeps the worker URL valid when this asset relocates.
          worker = browserWorker();
          channel = () => new MessageChannel();
        } else {
          // The comments and the enclosing `try` keep each consumer bundler's browser build clean of
          // this Node-only import; `async-worker.ts` says which bundler needs which.
          const threads = await import(
            /* webpackIgnore: true */ /* @vite-ignore */ "node:worker_threads"
          );
          if (wasStopped()) return "failed";
          // Probe the transport before allocation; a throwing host getter must own no thread.
          // Deno's instance-level `on` adapters still construct web events and defer start.
          directMessages = typeof threads.MessagePort.prototype.on === "function";
          if (webReference === undefined) {
            /**
             * Deliberately NOT the literal pattern: Rspack treats a `new URL("<literal>",
             * import.meta.url)` outside a recognised `new Worker` as an asset, so it copied the raw
             * worker file, whose sibling imports it never emits, into browser builds of `/async`. Reading
             * the caller's module URL keeps this Node-only branch out of that detection. Bun
             * also takes this branch and resolves `.js` to the sibling `.ts` when running from
             * source; Node does not, so a source run under Node answers `failed`.
             */
            worker = new threads.Worker(new URL("./async-worker.js", base), {
              type: "module",
              // Node rejects parent input modes and GC exposure in workers, under either spelling.
              // Inspect only the longest flag-name prefix: execArgv also holds the whole eval program.
              // Other flags keep their original values; only this comparison is normalized.
              execArgv: node.execArgv.filter((arg) => {
                const flag = arg.slice(0, "--input-type".length).replaceAll("_", "-");
                return !flag.startsWith("--input-type") && !flag.startsWith("--expose-gc");
              }),
            } as ConstructorParameters<typeof threads.Worker>[1]) as WorkerLike;
          } else {
            startupChannel = new threads.MessageChannel();
            // Readiness comes from the installed listener's acknowledgement, not an entry export:
            // webpack cannot render unused worker exports in module-library consumers.
            const entry = new URL("./async-worker.js", base).href;
            worker = new Worker(entry, { type: "module", name: entry });
            created = { worker, state: "running" };
            let referenced = true;
            // Deno counts references; the host interface promises idempotent ref/unref operations.
            created.reference = (next: boolean): void => {
              if (next === referenced) return;
              webReference(worker, next);
              referenced = next;
            };
          }
          channel = () => new threads.MessageChannel();
        }
        created ??= { worker, state: "running" };
        const startup = startupChannel;
        startupChannel = undefined;
        let closing = false;
        if (startup !== undefined)
          created.release = () => {
            closing = true;
            return closeChannel(startup);
          };
        const failures = new Set<() => void>();
        const current: Host = {
          kind: "ready",
          active: 0,
          waiting: 0,
          channel,
          directMessages,
          failures,
          thread: created,
        };
        const fail = (): void => {
          if (current.thread.state === "running") current.thread.state = "failed";
          started.resolve(false);
          for (const reject of failures) reject();
          // An error may leave the native thread alive; its final owner releases it.
          void releaseIdle(current);
        };
        const ended = (): void => {
          current.thread.state = "ended";
          fail();
          // Exit proves release independently of an API error; older callbacks cannot clear a retry.
          if (pool === current || (pool?.kind === "terminating" && pool.thread === current.thread))
            pool = undefined;
        };
        worker.addEventListener?.("error", (event) => {
          // Deno otherwise turns a worker error into an unhandled parent failure.
          event?.preventDefault?.();
          fail();
        });
        worker.addEventListener?.("close", ended);
        // Server worker implementations expose lifecycle completion through EventEmitter `exit`.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        worker.on?.("error", fail);
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        worker.on?.("exit", ended);
        // A constructed thread may still be evaluating its entry. Publish it only after the
        // request listener acknowledges startup; errors before that must settle this attempt.
        if (startup !== undefined) {
          // Deno exposes no exit event. Keep this channel through idle reuse: posting to a dead
          // Web Worker silently succeeds, while closure of its retained endpoint reports exit.
          startup.port1.addEventListener("message", ({ data }) => {
            started.resolve(data === "started");
          });
          startup.port1.addEventListener("messageerror", fail);
          startup.port1.addEventListener("close", () => {
            if (!closing) ended();
          });
          startup.port1.start?.();
          // Deno can discard a transfer sent after exit without closing it. Bound that hang;
          // expiry means failure, never readiness; slow startup may fail and require a retry.
          deadline = setTimeout(() => {
            started.resolve(false);
          }, 1000);
          worker.postMessage({ operation: "start", port: startup.port2 }, [startup.port2]);
        } else if (worker.once === undefined) {
          worker.addEventListener?.(
            "message",
            ({ data }) => {
              started.resolve(data === "started");
            },
            { once: true },
          );
        } else {
          worker.once("message", (message) => {
            started.resolve(message === "started");
          });
        }
        const ready = await started.promise;
        clearDeadline();
        if (ready && current.thread.state === "running" && !wasStopped()) {
          startup?.port1.unref?.();
          setWorkerReference(created, false);
          pending.state = "ready";
          pool = current;
          return current;
        }
      } catch {
        // Host setup exceptions and ordinary startup stops share the owned cleanup below.
      }
      try {
        clearDeadline();
      } catch (cause) {
        (startupCleanup ??= []).push(cause);
      }
      if (startupChannel !== undefined) {
        startupCleanup = closeChannel(startupChannel, startupCleanup);
        startupChannel = undefined;
      }
      // Until publication, this attempt alone owns the thread; no sibling can use it.
      if (created !== undefined) {
        const failure = await terminateOwned(created);
        if (failure !== undefined) (startupCleanup ??= []).push(failure.cause);
      }
      return startupCleanup === undefined ? "failed" : cleanupFailure(startupCleanup);
    }),
  };
  // One reaction owns startup completion; removed callers must not accumulate promise reactions
  // while a sibling keeps an unacknowledged attempt alive.
  void pending.result.then((result) => {
    if (typeof result === "string" || result.kind === "cleanup-failed") {
      pending.state = "stopped";
      if (pool === pending) pool = undefined;
    }
    for (const reply of pending.waiters) reply(result);
    pending.waiters.clear();
    return result;
  });
  return pending;
};

type WorkerStop = (AbortedFailure | SignalFailure) & { cleanupFailure?: CleanupFailure };

const load = async (
  base: string,
  browserWorker: () => WorkerLike,
  signal?: StopSignal,
): Promise<Host | WorkerFailure | CleanupFailure | WorkerStop> => {
  // Claim before the async handoff: another caller's failed setup must not end our ready host.
  const current = pool;
  if (current?.kind === "terminating") {
    const failure = await (current.pending ? current.result : terminateOwned(current.thread));
    const stopped = readStop(signal);
    if (stopped !== undefined)
      return {
        ...stopped,
        ...(failure === undefined ? {} : { cleanupFailure: failure }),
      };
    if (failure !== undefined) return failure;
    return load(base, browserWorker, signal);
  }
  if (current?.kind === "ready") {
    if (current.thread.state !== "running") return "failed";
    current.active++;
    return current;
  }
  const attempt = current ?? (pool = startWorker(base, browserWorker));
  const waiter = Promise.withResolvers<StartupResult | undefined>();
  attempt.waiters.add(waiter.resolve);
  let aborted: WorkerStop | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    attempt.waiters.delete(waiter.resolve);
    // Stop only an unpublished attempt with no remaining callers; siblings own their wait.
    if (attempt.waiters.size === 0 && attempt.state === "starting") {
      attempt.cancel();
    }
  };
  const cancel = (): void => {
    if (attempt.state !== "starting" || aborted !== undefined) return;
    aborted = readStop(signal) ?? { kind: "aborted", reason: undefined };
    release();
    waiter.resolve(undefined);
  };
  let result: Host | WorkerFailure | CleanupFailure | WorkerStop;
  try {
    signal?.addEventListener?.("abort", cancel, { once: true });
    aborted ??= readStop(signal);
    if (aborted !== undefined) {
      release();
      waiter.resolve(undefined);
    }
    const ready = await waiter.promise;
    if (aborted === undefined) {
      result = ready ?? "failed";
    } else {
      result = aborted;
      // The last caller also observes owned termination; cancellation cannot hide its failure.
      if (attempt.state === "stopped") {
        const cleanup = await attempt.result;
        if (typeof cleanup !== "string" && cleanup.kind === "cleanup-failed")
          aborted.cleanupFailure = cleanup;
      }
    }
  } catch (cause) {
    release();
    result = { kind: "signal-failed", cause };
    // A setup failure owns termination only when it released the last startup waiter.
    // Waiting on a sibling's acknowledgement would turn an independent failure into a hang.
    if (attempt.state === "stopped") {
      const cleanup = await attempt.result;
      if (typeof cleanup !== "string" && cleanup.kind === "cleanup-failed")
        result.cleanupFailure = cleanup;
    }
  }
  release();
  const owned = typeof result !== "string" && result.kind === "ready" ? result : undefined;
  if (owned !== undefined) owned.active++;
  try {
    signal?.removeEventListener?.("abort", cancel);
  } catch (cause) {
    const failure: CleanupFailure = { kind: "cleanup-failed", cause };
    if (
      typeof result !== "string" &&
      (result.kind === "aborted" || result.kind === "signal-failed")
    )
      result.cleanupFailure =
        result.cleanupFailure === undefined
          ? failure
          : cleanupFailure([result.cleanupFailure.cause, cause]);
    else result = failure;
  }
  if (owned !== undefined && result !== owned) {
    owned.active--;
    const failure = await releaseIdle(owned);
    if (failure !== undefined && typeof result !== "string" && result.kind === "cleanup-failed")
      result = cleanupFailure([result.cause, failure.cause]);
  }
  // A stale waiter must not clear a newer retry's cache.
  if (typeof result !== "string" && result.kind === "ready") return result;
  if (
    (typeof result === "string" || result.kind === "cleanup-failed") &&
    pool === attempt &&
    attempt.state !== "starting"
  )
    pool = undefined;
  return result;
};

type TerminalOutcome = Extract<
  Outcome<
    never,
    (ParseFailure | AbortedFailure | SignalFailure) & { readonly cleanupFailure?: CleanupFailure }
  >,
  { readonly ok: false }
>;

export const executeInWorker = async function* (
  operation: WorkerOperation,
  input: Input,
  options: WorkerParserOptions,
  numberType: typeof ExactNumber,
  base: string,
  browserWorker: () => WorkerLike,
  signal?: StopSignal,
): AsyncGenerator<
  unknown,
  | WorkerFailure
  | CleanupFailure
  | WorkerStop
  | TerminalOutcome
  | Outcome<never, ExecutionUnavailableFailure & { cleanupFailure?: CleanupFailure }>
  | undefined,
  undefined
> {
  const current = await load(base, browserWorker, signal);
  if (typeof current === "string") return current;
  if (current.kind !== "ready") return current;
  let channel: WorkerChannel;
  let stop: Int32Array<SharedArrayBuffer> | undefined;
  try {
    // Allocate the stop cell before owning a channel; allocation failure needs no port cleanup.
    stop =
      typeof SharedArrayBuffer === "function"
        ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
        : undefined;
    channel = current.channel();
  } catch {
    current.active--;
    const failure = await releaseIdle(current);
    // No request was posted; retain the setup refusal and its independent cleanup failure.
    if (failure !== undefined) return failure;
    return "failed";
  }
  const { port1, port2 } = channel;
  const responses: WorkerResponse[] = [];
  let pending = Promise.withResolvers<void>();
  let done = false;
  let startupAbort: WorkerStop | undefined;
  let requestFailed = false;
  let readRef: (() => boolean) | undefined;
  let requestCleanup: CleanupFailure | undefined;
  let terminalOutcome: TerminalOutcome | undefined;
  let assembly: ReturnType<typeof assembleWorkerPieces> | undefined;
  // Reuse one slot, cleared before yielding so a paused caller does not retain the previous result.
  const delivery: unknown[] = [];
  const receive = (data: WorkerResponse): void => {
    responses.push(data);
    if (data.kind === "done" || data.kind === "failed") done = true;
    pending.resolve();
  };
  const receiveFailure = (): void => {
    // Receiving can fail after the sender cloned successfully. Fail this call, then discard
    // its pending worker state in finally; the shared worker and sibling calls remain usable.
    responses.push({ kind: "failed" });
    pending.resolve();
  };
  const reject = (): void => {
    if (done) return;
    responses.push({ kind: "failed" });
    done = true;
    pending.resolve();
  };
  const send = (control: WorkerControl): void => {
    // Structural signals may have no event relay; each pull is also a cancellation boundary.
    if (control === "pull" && isStopped()) cancel();
    try {
      port1.postMessage(control);
      // Bun 1.3.14 can close a port without a close event. A held native ref disappearing
      // during send is independently observable; do not wait for an impossible response.
      if (holding && readRef?.() === false) closed();
    } catch {
      requestFailed = true;
      cancel();
      reject();
    }
  };
  const nextResponse = async (): Promise<WorkerResponse | undefined> => {
    if (responses.length === 0 && !done) {
      await pending.promise;
      pending = Promise.withResolvers<void>();
    }
    // One pull permits one response; only a terminal failure or discard can queue behind it.
    return responses.shift();
  };
  let cancellationSent = false;
  const cancel = (): void => {
    if (cancellationSent) return;
    cancellationSent = true;
    if (stop === undefined) {
      // A broken control port fails this call, rather than throwing from the caller's abort callback.
      try {
        port1.postMessage("abort");
      } catch {
        reject();
      }
    } else Atomics.store(stop, 0, 1);
  };
  // Keep the first observation: a host getter may throw once, then appear healthy again.
  let observedStop: WorkerStop | undefined;
  const isStopped = (): boolean => {
    observedStop ??= readStop(signal);
    return observedStop !== undefined;
  };
  const closed = (): void => {
    // A closed port cannot acknowledge discard; stop this call without killing its siblings.
    if (!done) {
      cancel();
      reject();
    }
  };
  // The worker and this call's port keep a server process alive only while the call waits for the
  // worker. Suspended at a `yield`, it waits for its consumer instead, who may drop the iterator
  // without `return()`; holding them then kept Node and Bun running forever.
  let holding = false;
  // Release faults must not hide a response already decoded for delivery.
  let failures: unknown[] | undefined;
  const hold = (on: boolean): void => {
    if (on === holding) return;
    holding = on;
    if (on) {
      if (current.waiting++ === 0) setWorkerReference(current.thread, true);
      port1.ref?.();
    } else {
      try {
        port1.unref?.();
      } catch (cause) {
        (failures ??= []).push(cause);
      }
      try {
        if (--current.waiting === 0) setWorkerReference(current.thread, false);
      } catch (cause) {
        (failures ??= []).push(cause);
      }
    }
  };
  current.failures.add(reject);
  if (current.thread.state !== "running") reject();
  try {
    running: {
      // Host startup can fail before any request; still release this call through the same finally.
      try {
        // Node's MessageEvent path loads Undici on first receipt; raw listeners need no web event.
        if (!current.directMessages || port1.on === undefined)
          port1.addEventListener("message", ({ data }) => {
            receive(data);
          });
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        else port1.on("message", receive);
        port1.addEventListener("messageerror", receiveFailure);
        port1.addEventListener("close", closed);
        port1.start?.();
        // Liveness and cancellation setup also precede posting; failure cannot await discard.
        hold(true);
        // Use reference state only after the host proves this live port reports its held ref.
        const hasRef = typeof port1.hasRef === "function" ? port1.hasRef.bind(port1) : undefined;
        if (hasRef?.() === true) readRef = hasRef;
        try {
          signal?.addEventListener?.("abort", cancel, { once: true });
        } catch (cause) {
          done = true;
          startupAbort = { kind: "signal-failed", cause };
          return startupAbort;
        }
      } catch {
        requestFailed = true;
        reject();
        break running;
      }
      // Loading the shared worker is asynchronous; cancellation there must not consume caller input.
      // Own the ports first so the usual finally also releases an idle browser worker.
      if (isStopped()) {
        done = true;
        startupAbort = observedStop;
        return startupAbort;
      }
      if (!done) {
        try {
          const retainRecovery =
            signal !== undefined && (operation === "repair" || operation === "findJsonSpan");
          // Cloning a byte view carries its entire backing store. Copy only its visible bytes,
          // then transfer that private buffer to avoid a second copy or detaching caller storage.
          const requestInput = typeof input === "string" ? input : new Uint8Array(input);
          current.thread.worker.postMessage(
            {
              input: requestInput,
              operation,
              options,
              port: port2,
              ...(stop === undefined ? {} : { stop: stop.buffer }),
              ...(retainRecovery ? { retainRecovery: true as const } : {}),
            },
            typeof requestInput === "string" ? [port2] : [port2, requestInput.buffer],
          );
        } catch {
          requestFailed = true;
          reject();
          break running;
        }
      }
      if (operation === "parseMany") send("pull");
      // The value the pieces received so far are building, while a large one arrives.
      while (true) {
        // One caller pull permits one worker result, and one received piece the next piece.
        // oxlint-disable-next-line eslint/no-await-in-loop
        let message = await nextResponse();
        if (message === undefined || message.kind === "failed") {
          // Receive refusal remains primary when releasing the signal or channel also fails.
          requestFailed = true;
          break running;
        }
        if (message.kind === "piece") {
          // Cancellation stops scanning at checkpoints, but computed recovery still needs bounded receipt
          // before the failed outcome settles; cutting transfer here would discard that recovery.
          (assembly ??= assembleWorkerPieces(numberType)).add(message.piece);
          try {
            send("pull");
          } catch {
            requestFailed = true;
            break running;
          }
          continue;
        }
        let whole =
          message.result === undefined
            ? assembly?.value()
            : restoreWorkerValue(message.result, numberType);
        const carried = message.result !== undefined || assembly !== undefined;
        assembly = undefined;
        if (message.kind === "ready") {
          // Cancellation wins before delivery. The worker still owns the original recovery, which
          // crosses only on request; no duplicate tree travels with a successful text/span result.
          if (
            isStopped() &&
            typeof whole === "object" &&
            whole !== null &&
            Reflect.get(whole, "ok") === true
          ) {
            cancel();
            send("recover");
            continue;
          }
          whole = restoreWorkerStop(whole, observedStop);
          hold(false);
          yield whole;
          return undefined;
        }
        if (carried) {
          isStopped();
          let restored = restoreWorkerStop(whole, observedStop);
          if (operation === "parseMany" && restored !== whole) {
            // A stop during transfer is terminal; release the request before exposing recovery.
            terminalOutcome = restored as TerminalOutcome;
            break running;
          }
          whole = restored;
          restored = undefined;
        }
        if (message.kind === "done") {
          hold(false);
          if (operation === "parseMany" && carried) {
            // Only stopped failures finish this verb; root refusals still use ordinary items.
            terminalOutcome = whole as TerminalOutcome;
            break running;
          }
          if (carried) yield whole;
          return undefined;
        }
        hold(false);
        delivery[0] = whole;
        whole = undefined;
        message = undefined;
        yield delivery.pop();
        if (failures !== undefined) return undefined;
        hold(true);
        send("pull");
      }
    }
  } finally {
    current.failures.delete(reject);
    // Caller listener removal may fail; it must not prevent discard acknowledgement.
    if (!done) cancel();
    try {
      signal?.removeEventListener?.("abort", cancel);
    } catch (cause) {
      (failures ??= []).push(cause);
    }
    // A failed keepalive must not suppress the independent worker-state release.
    try {
      if (!done) {
        // Held again for the discard acknowledgement, or the process may exit before it arrives.
        hold(true);
      }
    } catch (cause) {
      (failures ??= []).push(cause);
    }
    try {
      if (!done) {
        send("discard");
        // The message listener advances `done` when the worker acknowledges discard.
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition
        while (!done) {
          // A result already in flight may arrive before the terminal acknowledgement.
          // oxlint-disable-next-line eslint/no-await-in-loop
          await nextResponse();
        }
      }
    } catch (cause) {
      (failures ??= []).push(cause);
    }
    // Every release still runs; preserve a lone cause's identity and aggregate independent faults.
    try {
      hold(false);
    } catch (cause) {
      (failures ??= []).push(cause);
    }
    failures = closeChannel(channel, failures);
    current.active--;
    const terminating = releaseIdle(current);
    if (terminating !== undefined) {
      const failure = await terminating;
      if (failure !== undefined) (failures ??= []).push(failure.cause);
    }
    if (failures !== undefined) {
      const failure = cleanupFailure(failures);
      // A refused request retains its typed failure when independent cleanup also fails.
      if (terminalOutcome !== undefined)
        terminalOutcome = {
          ...terminalOutcome,
          failure: { ...terminalOutcome.failure, cleanupFailure: failure },
        };
      else if (requestFailed) requestCleanup = failure;
      // Cancellation before posting remains primary even when independent releases fail.
      else if (startupAbort === undefined) cleanupFailed(failure);
      else startupAbort.cleanupFailure = failure;
    }
  }
  if (terminalOutcome !== undefined) return terminalOutcome;
  const partial = assembly?.recovery();
  if (partial !== undefined) {
    // Release before delivery. Translating here keeps receiver-only failures out of every caller.
    const received = assembly?.value() as Outcome<unknown, RepairFailure | AbortedFailure>;
    const recovered: Recovery = partial.complete
      ? { value: partial.value, complete: true }
      : { value: partial.value, complete: false, cut: partial.cut };
    const outcome: Outcome<
      never,
      ExecutionUnavailableFailure & { cleanupFailure?: CleanupFailure }
    > = {
      ok: false,
      failure: {
        ...unavailable("failed"),
        recovered,
        ...(received.ok
          ? {}
          : {
              // Stop reasons stay local: functions and symbols cannot cross structured clone.
              cause:
                received.failure.kind === "aborted"
                  ? { ...received.failure, ...(observedStop ?? readStop(signal)) }
                  : received.failure,
            }),
        ...(requestCleanup === undefined ? {} : { cleanupFailure: requestCleanup }),
      },
      ...(received.diagnostics === undefined ? {} : { diagnostics: received.diagnostics }),
    };
    // Cleanup already finished; terminal delivery must not suspend another receive frame.
    return outcome;
  }
  return requestCleanup ?? "failed";
};
