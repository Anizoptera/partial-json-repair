// SPDX-License-Identifier: Apache-2.0

/** Run each request through one resumable operation and its shared stop state. */

import type { ParserOptions } from "./options";
import type { StopSignal } from "./stop-signal";
import { executeCooperatively } from "./cooperative-executor";
import { validateOptions } from "./options";
import { fromWire, select, skip } from "./selection-feature";
import { locations } from "./positions";
import { diagnostics } from "./report";
import { describeWorkerValue, planWorkerPieces } from "./worker-output";
import type {
  WorkerParserOptions,
  WorkerPiece,
  WorkerPort,
  WorkerRequest,
  WorkerResponse,
  WorkerStartup,
} from "./worker-message";
import { wholeOperation } from "./whole-operation";
import type { WholeSingleRequest } from "./whole-operation";
import { repairOperation } from "./repair-operation";
import { spanOperation } from "./span-operation";
import { manySteps } from "./whole-reader";
import { recovered } from "./parser-outcome";
import type { Diagnostics, Recovery } from "./types";

type ExecutionRequest = Omit<WorkerRequest, "options"> & {
  readonly options: Exclude<ReturnType<typeof validateOptions>, { readonly kind: string }>;
  readonly signal: StopSignal;
};

const send = (port: WorkerPort<unknown, WorkerResponse>, message: WorkerResponse): void => {
  // MessagePort has no target origin; this rule is for Window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  port.postMessage(message);
};

const stopSignal = (request: WorkerRequest): StopSignal => {
  if (request.stop === undefined) {
    let aborted = false;
    request.port.addEventListener("message", ({ data }) => {
      if (data === "abort" || data === "discard") aborted = true;
    });
    request.port.addEventListener("close", () => {
      aborted = true;
    });
    request.port.start?.();
    return {
      get aborted(): boolean {
        return aborted;
      },
    };
  }
  const cell = new Int32Array(request.stop);
  return {
    get aborted(): boolean {
      return Atomics.load(cell, 0) !== 0;
    },
  };
};

const outcomePieces = (value: unknown, operation: WorkerRequest["operation"]) => {
  // Projected text and spans are not source recovery. Failed projections can carry real recovery,
  // and parse results already are it; only those owners get a delivery recovery boundary.
  let owner: object | undefined;
  if (typeof value === "object" && value !== null) {
    if (Reflect.get(value, "ok") === true) {
      if (operation === "parse" || operation === "parseMany") owner = value;
    } else {
      const failure: unknown = Reflect.get(value, "failure");
      if (typeof failure === "object" && failure !== null) {
        const recovery: unknown = Reflect.get(failure, "recovered");
        if (typeof recovery === "object" && recovery !== null) owner = recovery;
      }
    }
  }
  return planWorkerPieces(value, undefined, owner);
};

const runMany = (request: ExecutionRequest): void => {
  const iterator =
    request.stop === undefined
      ? undefined
      : wholeOperation(manySteps, request.input, request.options, request.signal);
  const scheduled =
    iterator === undefined
      ? executeCooperatively(
          manySteps,
          request.input,
          request.options,
          "cooperative",
          request.signal,
        )
      : undefined;
  let discarded = false;
  let finished = false;
  let terminal = false;
  /** The pieces of the item being sent, while one too large to send whole is. */
  let pending: Iterator<WorkerPiece> | undefined;
  const finish = (message: WorkerResponse): void => {
    if (finished) return;
    finished = true;
    send(request.port, message);
    request.port.close();
  };
  const deliver = (message: Extract<WorkerResponse, { readonly kind: "item" }>): void => {
    if (terminal) {
      // A stopped operation needs no next pull; release it before its failure crosses the port.
      iterator?.return(undefined);
      finish({ ...message, kind: "done" });
    } else send(request.port, message);
  };
  const deliverValue = (value: unknown): void => {
    pending = outcomePieces(value, "parseMany");
    if (pending === undefined) deliver({ kind: "item", result: describeWorkerValue(value) });
    else pull();
  };
  const pull = (): void => {
    if (discarded) return;
    try {
      if (pending !== undefined) {
        const piece = pending.next();
        if (piece.done !== true) {
          send(request.port, { kind: "piece", piece: piece.value });
          return;
        }
        pending = undefined;
        deliver({ kind: "item" });
        return;
      }
      if (scheduled !== undefined) {
        void scheduled.next().then(
          (item) => {
            if (discarded) return undefined;
            try {
              if (item.done === true) {
                if (item.value === undefined) finish({ kind: "done" });
                else {
                  terminal = true;
                  deliverValue(item.value);
                }
              } else deliverValue(item.value);
            } catch {
              finish({ kind: "failed" });
            }
            return undefined;
          },
          () => {
            finish({ kind: "failed" });
          },
        );
        return;
      }
      if (iterator === undefined) return;
      while (true) {
        const item = iterator.next();
        if (item.done === true) {
          finish({ kind: "done" });
          return;
        }
        if (item.value.kind === "item") {
          terminal = item.value.terminal;
          deliverValue(item.value.value);
          return;
        }
      }
    } catch {
      finish({ kind: "failed" });
    }
  };
  const discard = (): void => {
    discarded = true;
    if (scheduled !== undefined) {
      void scheduled.return(undefined).then(
        () => {
          finish({ kind: "done" });
          return undefined;
        },
        () => {
          finish({ kind: "failed" });
        },
      );
      return;
    }
    try {
      iterator?.return(undefined);
      finish({ kind: "done" });
    } catch {
      finish({ kind: "failed" });
    }
  };
  request.port.addEventListener("message", ({ data }) => {
    if (data === "discard") discard();
    else if (data === "pull") pull();
  });
  request.port.start?.();
};

const runOne = (request: ExecutionRequest, operation: WholeSingleRequest): void => {
  let finished = false;
  let waiting = request.retainRecovery === true;
  let recovery: Recovery | undefined;
  const finish = (message: WorkerResponse): void => {
    if (finished) return;
    if (waiting && message.kind === "done") {
      send(request.port, { ...message, kind: "ready" });
      return;
    }
    finished = true;
    recovery = undefined;
    send(request.port, message);
    request.port.close();
  };
  if (request.stop === undefined) {
    // A receiver can fail while this scan is yielding; a discarded projection must not wait
    // for acceptance from the caller that has already left.
    request.port.addEventListener("message", ({ data }) => {
      if (data === "discard") waiting = false;
    });
    const reading = executeCooperatively(
      operation,
      request.input,
      request.options,
      "cooperative",
      request.signal,
      waiting
        ? (data, cut) => {
            recovery = recovered(data, cut);
          }
        : undefined,
    );
    // A message-driven stop becomes visible only when the worker services its task queue.
    const drain = async (): Promise<unknown> => {
      try {
        let step = await reading.next();
        while (step.done !== true) {
          // oxlint-disable-next-line eslint/no-await-in-loop
          step = await reading.next();
        }
        return step.value;
      } finally {
        await reading.return(undefined);
      }
    };
    void drain().then(transmitValue, () => {
      finish({ kind: "failed" });
    });
    return;
  }
  let output: unknown;
  try {
    const reading = wholeOperation(
      operation,
      request.input,
      request.options,
      request.signal,
      undefined,
      waiting
        ? (data, cut) => {
            recovery = recovered(data, cut);
          }
        : undefined,
    );
    let step = reading.next();
    while (step.done !== true) step = reading.next();
    output = step.value;
  } catch {
    finish({ kind: "failed" });
    return;
  }
  transmitValue(output);

  function transmitValue(initial: unknown): void {
    let value = initial;
    let pieces: Iterator<WorkerPiece> | undefined;
    // One piece per `pull`: sent all at once, they would queue and be received in one task again.
    const next = (): void => {
      try {
        const piece = pieces?.next();
        if (piece === undefined) return;
        if (piece.done === true) finish({ kind: "done", pieces: true });
        else send(request.port, { kind: "piece", piece: piece.value });
      } catch {
        finish({ kind: "failed" });
      }
    };
    const transmit = (): void => {
      try {
        pieces = outcomePieces(value, request.operation);
        if (pieces === undefined) finish({ kind: "done", result: describeWorkerValue(value) });
        else next();
      } catch {
        finish({ kind: "failed" });
      }
    };
    try {
      pieces = outcomePieces(value, request.operation);
      if (pieces === undefined) {
        finish({ kind: "done", result: describeWorkerValue(value) });
        // Ordinary small results need no acknowledgement listener or retained recovery.
        if (!waiting) return;
      }
    } catch {
      finish({ kind: "failed" });
      return;
    }
    request.port.addEventListener("message", ({ data }) => {
      if (data === "abort") return;
      if (data === "discard") {
        waiting = false;
        finish({ kind: "done" });
      } else if (data === "recover" && waiting) {
        // Reuse the saved tree only when cancellation wins; successful projection sends no duplicate data.
        waiting = false;
        if (recovery === undefined) {
          finish({ kind: "failed" });
          return;
        }
        const report =
          typeof value === "object" && value !== null
            ? (Reflect.get(value, "diagnostics") as Diagnostics | undefined)
            : undefined;
        value = {
          ok: false,
          failure: { kind: "aborted", recovered: recovery },
          ...(report === undefined ? {} : { diagnostics: report }),
        };
        transmit();
      } else next();
    });
    request.port.start?.();
    if (pieces !== undefined) next();
  }
};

/** Rebuilds each feature from the settings `encodeWorkerOptions` sent. */
const decodeWorkerOptions = (options: WorkerParserOptions): ParserOptions => {
  const {
    diagnostics: report,
    locations: spans,
    select: picked,
    skip: skipped,
    ...plain
  } = options;
  return {
    ...plain,
    ...(report === undefined ? {} : { diagnostics: diagnostics(report) }),
    ...(spans === undefined ? {} : { locations }),
    ...(picked === undefined
      ? {}
      : { select: select(fromWire(picked.paths), { occurrences: picked.occurrences }) }),
    ...(skipped === undefined ? {} : { skip: skip(fromWire(skipped)) }),
  };
};

const receive = (request: WorkerRequest): void => {
  let options: ReturnType<typeof validateOptions>;
  try {
    options = validateOptions(decodeWorkerOptions(request.options));
  } catch {
    options = { kind: "invalid-options", field: "options", reason: "object" };
  }
  if ("kind" in options) {
    send(request.port, { kind: "failed" });
    request.port.close();
    return;
  }
  const decoded = { ...request, options, signal: stopSignal(request) };
  if (decoded.operation === "parseMany") runMany(decoded);
  else
    runOne(
      decoded,
      decoded.operation === "repair"
        ? repairOperation
        : decoded.operation === "findJsonSpan"
          ? spanOperation
          : decoded.operation,
    );
};

const web = globalThis as typeof globalThis & {
  readonly name?: string;
  postMessage?: (message: "started") => void;
  addEventListener?: (
    name: "message",
    receive: (event: MessageEvent<WorkerRequest | WorkerStartup>) => void,
  ) => void;
};
// Our Deno constructor names its Web Worker with this entry URL. Select its known bridge before
// touching Node globals: importing Node to discover an absent parent port adds work and a race.
const denoWeb = Object.hasOwn(globalThis, "Deno") && web.name === import.meta.url;
const node = !denoWeb && typeof process === "object" && process.versions?.node !== undefined;
let lifetimePort: WorkerStartup["port"] | undefined;
const acknowledgeStartup = (request: WorkerStartup): void => {
  // Retain the endpoint for the worker's lifetime: its closure is the parent's exit signal.
  // Closing after acknowledgement can overtake a pending acknowledgement in another caller.
  lifetimePort?.close();
  lifetimePort = request.port;
  // MessagePort has no Window target origin.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  request.port.postMessage("started");
};
const listenOnWebWorker = (): void => {
  if (typeof web.addEventListener !== "function" || typeof web.postMessage !== "function")
    throw new Error("async worker needs a message listener");
  web.addEventListener("message", ({ data }) => {
    if (data.operation === "start") acknowledgeStartup(data);
    else receive(data);
  });
  // Startup means the entry accepts requests, not merely that its thread was constructed.
  // WorkerGlobalScope has no Window target origin.
  // eslint-disable-next-line unicorn/require-post-message-target-origin
  web.postMessage("started");
};
/**
 * How each consumer bundler sees the Node branch decides whether a browser app builds at all:
 * - no top-level `await`: Vite bundles a worker as a classic script by default, where it is a build
 *   error;
 * - `webpackIgnore`: webpack and Rspack otherwise fail the browser build on `node:worker_threads`;
 * - `@vite-ignore`: Vite otherwise warns, in every build of an app using `/async`, that it stubbed
 *   the module out;
 * - inside `try`: esbuild fails a browser build on an unresolvable `import()` anywhere else.
 * A Node MessagePort queues messages until its first listener, so attaching late loses none.
 */
const listenOnParentPort = async (): Promise<void> => {
  let threads: typeof import("node:worker_threads");
  try {
    threads = await import(/* webpackIgnore: true */ /* @vite-ignore */ "node:worker_threads");
  } catch (error) {
    throw new Error("async worker cannot load node:worker_threads", { cause: error });
  }
  // Deno exposes Node globals in web workers too; a real parent port chooses the Node bridge.
  if (threads.parentPort === null) {
    listenOnWebWorker();
    return;
  }
  threads.parentPort.on("message", receive);
  // MessagePort has no target origin; this rule is for Window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  threads.parentPort.postMessage("started");
};
// The parent observes listener readiness through its acknowledgement; this entry needs no exports.
if (node) void listenOnParentPort();
else listenOnWebWorker();
