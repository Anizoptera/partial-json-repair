// SPDX-License-Identifier: Apache-2.0

/**
 * Driving a stream parser from a source of chunks: the read loop, the source's own cleanup, and
 * the stop that wakes both.
 *
 * Separate from `parser.ts` because it knows nothing about parsing — it holds a `StreamBuild` and
 * asks it what a chunk produced, whether the stream is over, and how to word a failure. That is
 * also what lets the parser own the transport rather than a second entry point re-deriving these
 * rules: ordinary and configured `parseStream` calls use the same `drive` below, and a
 * module that both imported would be a cycle.
 */

import type { Exact, StreamParserOptions } from "./options";
import type { StreamBuild, StreamItem, Viewed } from "./parser";
import type { OptionOf } from "./types";
import type {
  CleanupFailure,
  CloseFailure,
  Result,
  SchedulingFailure,
  SignalFailure,
  StreamFailure,
} from "./types";
import type { StopSignal } from "./stop-signal";
import { readStop, signalFailures } from "./stop-signal";
import { Stopper } from "./stopper";
import { checkHelperOptions, resolveSignal } from "./configuration-error";

/** How the caller's input is described in `invalid-input`; `typeof` alone calls `null` an object. */
export const describeInput = (input: unknown): string => {
  if (input === null) return "null";
  try {
    return Array.isArray(input) ? "array" : typeof input;
  } catch {
    // A revoked proxy cannot reveal its array brand; its ordinary typeof still describes it.
    return typeof input;
  }
};

type ByteSlots = {
  [Symbol.toStringTag]: string | undefined;
  length: number;
  buffer: ArrayBufferLike;
  byteOffset: number;
};

const byteAccess = /* @__PURE__ */ (() => {
  // Native slots cross realms and ignore caller properties; slice methods also invoke species.
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const slot = <Key extends keyof ByteSlots>(key: Key) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    return (input: unknown): ByteSlots[Key] => descriptor?.get?.call(input) as ByteSlots[Key];
  };
  return {
    Type: Uint8Array,
    // eslint-disable-next-line typescript/unbound-method -- Native borrowing requires the checked input as receiver.
    copyWithin: Uint8Array.prototype.copyWithin,
    brand: slot(Symbol.toStringTag),
    length: slot("length"),
    buffer: slot("buffer"),
    offset: slot("byteOffset"),
  };
})();

/** Accept actual Uint8Array storage across realms, never proxy wrappers or other view types. */
export const isBytes = (input: unknown): input is Uint8Array => {
  if (byteAccess.brand(input) !== "Uint8Array") return false;
  if (byteAccess.length(input) !== 0) return true;
  try {
    // Detached and out-of-bounds views also report zero length. A zero-width intrinsic move
    // validates storage without caller hooks or writes, even if a shared view grows meanwhile.
    byteAccess.copyWithin.call(input, 0, 0, 0);
    return true;
  } catch {
    return false;
  }
};

export const byteLength = (input: Uint8Array): number => byteAccess.length(input);

/** Borrow only the visible bytes, without caller slicing methods or constructor species. */
export const byteSlice = (input: Uint8Array, from = 0, end?: number): Uint8Array => {
  const length = byteLength(input);
  const start = Math.min(from, length);
  return new byteAccess.Type(
    byteAccess.buffer(input),
    byteAccess.offset(input) + start,
    Math.max(0, Math.min(end ?? length, length) - start),
  );
};

/**
 * Anything that produces chunks.
 *
 * A Node `Readable`, an async generator, a plain array and a `for`-loop over strings all satisfy
 * `AsyncIterable` or `Iterable` already, so none of them needs an adapter — which is why this
 * package ships no `./stream` subpath and no `Transform`. A web `ReadableStream` is the ONE source
 * that does not: Safari still gives it no `Symbol.asyncIterator` (checked 2026-08; Chrome and
 * Firefox have it), so `for await (const c of response.body)` throws there and works elsewhere.
 * Reading it here is what makes one entry point cover every runtime.
 *
 * Duck-typed on `getReader` rather than named as `ReadableStream`, deliberately: naming the type
 * would pull a DOM lib into an entry that must type-check and build for every runtime, and the
 * reader protocol is the whole of what is used.
 */
export type ChunkSource =
  | AsyncIterable<string | Uint8Array>
  | Iterable<string | Uint8Array>
  | {
      getReader(): {
        read(): Promise<{ done: boolean; value?: string | Uint8Array | undefined }>;
        cancel?(reason?: unknown): Promise<void>;
        releaseLock(): void;
        readonly closed?: Promise<unknown>;
      };
    };

/**
 * What driving a source hands back: the items, and `close()`.
 *
 * Leaving the loop early — `break`, `throw`, `return()` — REQUESTS the source's cleanup and does not
 * wait for it, so a producer that never answers cannot hang the consumer. `close()` is for the
 * caller who needs the acknowledgement: it stops delivery, shares one cleanup attempt across every
 * call, and answers with its outcome — observable there even after the iteration itself has ended.
 * `close({ signal })` bounds that wait; abandoning the wait says nothing about the source.
 */
export type ParsedStream<O extends StreamParserOptions = StreamParserOptions> =
  AsyncIterableIterator<StreamItem<O>> & {
    close<Options extends TransportOptions | undefined>(
      options: Exact<Options, TransportOptions>,
    ): Promise<Result<undefined, CloseFailure>>;
    // eslint-disable-next-line typescript/no-unnecessary-type-parameters -- Explicit generic forwarding needs this non-inferred overload; optional inference hides union typos.
    close<Options extends TransportOptions = never>(
      options?: Exact<NoInfer<Options>, TransportOptions>,
    ): Promise<Result<undefined, CloseFailure>>;
  } & Viewed<OptionOf<O, "view">, O>;

/** What the transport itself takes, as opposed to what shapes the parser behind it. */
export type TransportOptions = { signal?: StopSignal };

const sourceKind = (source: unknown): string => {
  if (source === null) return "null";
  if (typeof source !== "object" && typeof source !== "function") return typeof source;
  if ("getReader" in source) return "readable-stream";
  if (Symbol.asyncIterator in source) return "async-iterable";
  if (Symbol.iterator in source) return "iterable";
  return "object";
};

/** A string is its own single chunk; anything else must expose one of the three protocols. */
const isChunkSource = (source: unknown): source is ChunkSource =>
  typeof source === "string" ||
  ((typeof source === "object" || typeof source === "function") &&
    source !== null &&
    ("getReader" in source || Symbol.asyncIterator in source || Symbol.iterator in source));

const STOPPED = /* @__PURE__ */ Symbol("stopped");
const DONE: IteratorResult<string | Uint8Array, undefined> = { done: true, value: undefined };
type InvalidSource = Extract<StreamFailure, { kind: "invalid-source" }>;
/** A small deterministic quantum keeps scanner work below one host turn without runtime clocks. */
const WORK_SLICE = 512;

const schedulingFailure = (cause: unknown): SchedulingFailure => ({
  kind: "scheduling-failed",
  cause,
});

/** Yield to a host task so cancellation and unrelated work can run between scanner slices. */
export const yieldToHost = (): Promise<SchedulingFailure | undefined> => {
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
    .setImmediate;
  if (immediate !== undefined)
    return new Promise((resolve) => {
      try {
        immediate(() => {
          resolve(undefined);
        });
      } catch (cause) {
        resolve(schedulingFailure(cause));
      }
    });
  // Prefer an explicit task wait: edge MessageChannel delivery can starve queued timers.
  const scheduler = (globalThis as { scheduler?: { wait?: (delay: number) => Promise<void> } })
    .scheduler;
  if (typeof scheduler?.wait === "function") {
    try {
      return scheduler.wait(0).then(() => undefined, schedulingFailure);
    } catch (cause) {
      return Promise.resolve(schedulingFailure(cause));
    }
  }
  return new Promise((resolve) => {
    let channel: MessageChannel;
    try {
      channel = new MessageChannel();
    } catch (cause) {
      resolve(schedulingFailure(cause));
      return;
    }
    let failure: SchedulingFailure | undefined;
    // The delivery callback runs outside the Promise executor; cleanup errors must settle its wait.
    const finish = () => {
      let cleanupFailure: CleanupFailure | undefined;
      try {
        channel.port1.close();
      } catch (cause) {
        cleanupFailure = { kind: "cleanup-failed", cause };
      }
      try {
        channel.port2.close();
      } catch (cause) {
        cleanupFailure = cleanupFailures(
          cleanupFailure,
          { kind: "cleanup-failed", cause },
          "Host task cleanup failed",
        );
      }
      if (cleanupFailure !== undefined)
        failure =
          failure === undefined
            ? schedulingFailure(cleanupFailure.cause)
            : { ...failure, cleanupFailure };
      resolve(failure);
    };
    try {
      channel.port1.addEventListener("message", finish, { once: true });
      channel.port1.start();
      channel.port2.postMessage(undefined);
    } catch (cause) {
      failure = schedulingFailure(cause);
      finish();
    }
  });
};

/**
 * The three source shapes behind one `next()` that a stop can wake, and one `finish()` that runs
 * the source's own cleanup exactly once and reports whether it succeeded.
 *
 * Cancelling a web stream, not merely releasing the reader, is what stops an HTTP body from
 * streaming on with nobody reading it — measured identically on node 24.20.0 and bun 1.4.0, where
 * `for await (… of parseStream(body)) break` never reached the source's `cancel()` while only the
 * lock was released. Cancelling an already-closed stream is a spec-defined no-op, so exhaustion and
 * early exit need no telling apart.
 */
class Chunks {
  private iterator: Iterator<string | Uint8Array> | AsyncIterator<string | Uint8Array> | undefined;
  private reader: ReturnType<Extract<ChunkSource, { getReader: unknown }>["getReader"]> | undefined;
  /** Settles the read in flight with `STOPPED`; one abort listener serves every read. */
  private wake: ((stopped: typeof STOPPED) => void) | undefined;
  /**
   * A stop arrived while an iterator's `next()` was unsettled. Its `return()` then queues behind
   * that read (async generators run one request at a time), so awaiting it can hang forever. A web
   * stream's `cancel()` settles a pending read by spec and is never stuck this way.
   */
  cleanupQueued = false;
  /**
   * A web stream errored (a read or `closed` rejected while held): `cancel()` would only reject with
   * the same error, which then read as a second, cleanup failure. Iterators keep their `return()`.
   */
  private streamErrored = false;
  private cleanup: Promise<void> | undefined;

  constructor(
    source: ChunkSource,
    private readonly stopper: Stopper,
  ) {
    if (typeof source === "string") this.iterator = [source][Symbol.iterator]();
    else if ("getReader" in source) {
      const reader = source.getReader();
      this.reader = reader;
      // A body can error with no read pending (a client disconnects while the consumer is slow);
      // `closed` rejects then too. Only while held: releasing the lock also rejects it.
      reader.closed?.catch(() => {
        if (this.reader === reader) this.streamErrored = true;
      });
    } else if (Symbol.asyncIterator in source) this.iterator = source[Symbol.asyncIterator]();
    else this.iterator = source[Symbol.iterator]();
    stopper.addEventListener("abort", () => {
      this.wake?.(STOPPED);
    });
  }

  async next(): Promise<IteratorResult<string | Uint8Array, undefined> | InvalidSource> {
    if (this.stopper.aborted) return DONE;
    // A source is sequential by definition: whether a next read exists at all is only known once
    // this one resolves, so there is no set of promises to collect.
    const read =
      this.reader === undefined
        ? (this.iterator as AsyncIterator<string | Uint8Array>).next()
        : this.reader.read();
    // Not `Promise.race` against a stop promise: that adds a reaction to a promise which never
    // settles on a normal run, one per read, so a long stream grew without bound.
    let step: unknown;
    try {
      step = await new Promise<unknown>((resolve, reject) => {
        this.wake = resolve;
        // `next()` runs a generator's body synchronously, so the stop may already have arrived
        // while `read` was being requested, before there was a wake to call.
        if (this.stopper.aborted) resolve(STOPPED);
        Promise.resolve(read).then(resolve, reject);
      });
    } catch (cause) {
      this.streamErrored = this.reader !== undefined;
      throw cause;
    } finally {
      this.wake = undefined;
    }
    if (step === STOPPED) {
      this.cleanupQueued = this.reader === undefined;
      return DONE;
    }
    // Iterator results are objects; a missing chunk is a producer defect, never a retry request.
    if ((typeof step !== "object" && typeof step !== "function") || step === null)
      return { kind: "invalid-source", sourceKind: `iterator-result:${describeInput(step)}` };
    const done = Boolean(Reflect.get(step, "done"));
    if (done) return DONE;
    const chunk: unknown = Reflect.get(step, "value");
    return typeof chunk === "string" || isBytes(chunk)
      ? { done: false, value: chunk }
      : { kind: "invalid-source", sourceKind: `chunk:${describeInput(chunk)}` };
  }

  /** The source's own cleanup, started once and shared by every caller that awaits it. */
  finish(): Promise<void> {
    this.cleanup ??= this.release();
    return this.cleanup;
  }

  /** Reuse the read's wake slot so close or abort can interrupt upstream cleanup too. */
  waitForCleanup(cleanup: Promise<void>): Promise<CleanupFailure | undefined> {
    if (this.stopper.aborted) {
      cleanup.catch(() => undefined);
      return Promise.resolve(undefined);
    }
    return new Promise<CleanupFailure | undefined>((resolve) => {
      const complete = () => {
        this.wake = undefined;
        resolve(undefined);
      };
      this.wake = complete;
      // Keep the acknowledgement promise for close(); stopped iteration cannot await it forever.
      cleanup.then(complete, (cause) => {
        this.wake = undefined;
        resolve({ kind: "cleanup-failed", cause });
      });
    });
  }

  private async release(): Promise<void> {
    // Retain the cleanup result for close(), not the producer behind a finished stream.
    const iterator = this.iterator;
    const reader = this.reader;
    this.iterator = undefined;
    this.reader = undefined;
    if (reader === undefined) {
      await iterator?.return?.();
      return;
    }
    if (this.streamErrored) {
      reader.releaseLock();
      return;
    }
    // Cancel settles any pending read at once, so the lock can go before the source's own cancel
    // has answered: a consumer who left early gets their body back without waiting on it.
    let cancelling: Promise<void> | undefined;
    let cancellationFailure: { cause: unknown } | undefined;
    try {
      cancelling = reader.cancel?.(this.stopper.reason);
    } catch (cause) {
      cancellationFailure = { cause };
    }
    let releaseFailure: { cause: unknown } | undefined;
    try {
      reader.releaseLock();
    } catch (cause) {
      releaseFailure = { cause };
    }
    // Release promptly, but observe cancellation even when releasing the lock failed.
    try {
      await cancelling;
    } catch (cause) {
      cancellationFailure = { cause };
    }
    if (cancellationFailure && releaseFailure)
      throw new AggregateError(
        [cancellationFailure.cause, releaseFailure.cause],
        "Reader cleanup failed",
      );
    // eslint-disable-next-line typescript/only-throw-error -- Preserve arbitrary producer causes for the outer typed cleanup failure.
    if (cancellationFailure) throw cancellationFailure.cause;
    // eslint-disable-next-line typescript/only-throw-error -- Preserve arbitrary reader causes for the outer typed cleanup failure.
    if (releaseFailure) throw releaseFailure.cause;
  }
}

type CloseResult = Result<undefined, CloseFailure>;
type CloseWaiter = (result: CloseResult) => void;
// A retained generator can retain its original arguments; clear the source through shared state.
type TransportState = {
  chunks: Chunks | undefined;
  source: ChunkSource | undefined;
  startupFailure: SignalFailure | undefined;
  removalFailure: CleanupFailure | undefined;
};

// Iteration and close share the same removal result; a refused removal is never retried.
const detach = (stopper: Stopper, state: TransportState): CleanupFailure | undefined => {
  try {
    stopper.detach();
  } catch (cause) {
    state.removalFailure = { kind: "cleanup-failed", cause };
  }
  return state.removalFailure;
};

const cleanupFailures = (
  first: CleanupFailure | undefined,
  second: CleanupFailure | undefined,
  message = "Stream cleanup failed",
): CleanupFailure | undefined =>
  first === undefined
    ? second
    : second === undefined
      ? first
      : {
          kind: "cleanup-failed",
          cause: new AggregateError([first.cause, second.cause], message),
        };

/** Abandoned waits leave the shared waiter set even when source cleanup never settles. */
const boundedClose = (waiters: Set<CloseWaiter>, signal: StopSignal): Promise<CloseResult> => {
  const stopped = readStop(signal);
  if (stopped !== undefined) return Promise.resolve({ ok: false, failure: stopped });
  return new Promise<CloseResult>((resolve) => {
    let settled = false;
    const complete: CloseWaiter = (result) => {
      // Refused removal can leave a callback registered; it must not repeat fallible cleanup.
      if (settled) return;
      settled = true;
      waiters.delete(complete);
      try {
        signal.removeEventListener?.("abort", abort);
        resolve(result);
      } catch (cause) {
        // One wait's listener cleanup must neither strand it nor interrupt sibling notification.
        const cleanupFailure: CleanupFailure = { kind: "cleanup-failed", cause };
        resolve({
          ok: false,
          failure: result.ok ? cleanupFailure : { ...result.failure, cleanupFailure },
        });
      }
    };
    const abort = (): void => {
      if (settled) return;
      // A broken provider ends only this wait; it cannot settle the shared producer cleanup.
      complete({ ok: false, failure: readStop(signal) ?? { kind: "aborted", reason: undefined } });
    };
    waiters.add(complete);
    try {
      signal.addEventListener?.("abort", abort, { once: true });
      const afterSubscription = readStop(signal);
      if (afterSubscription !== undefined) complete({ ok: false, failure: afterSubscription });
    } catch (cause) {
      // A throwing subscription may already own a listener; complete still attempts its removal.
      complete({ ok: false, failure: { kind: "signal-failed", cause } });
    }
  });
};

/**
 * Runs `driver` to exhaustion over `source`, as a stream that can also be closed.
 *
 * The transport is the ONE place that feeds chunks, closes what the input left open, cancels the
 * source when the consumer leaves early and stops on an abort. Leaving the loop early REQUESTS the
 * source's cleanup without waiting, so a producer that never answers cannot hang the consumer;
 * `close()` is for the caller who needs the acknowledgement, sharing one cleanup attempt across
 * every call.
 */
export const drive = <O extends StreamParserOptions>(
  driver: StreamBuild<O>,
  source: ChunkSource,
  signal?: StopSignal,
): ParsedStream<O> => {
  let stopper: Stopper;
  let startupFailure: SignalFailure | undefined;
  try {
    stopper = new Stopper(signal);
  } catch (cause) {
    // Stopper releases partial registration; the failed stream still owns its normal close/view API.
    stopper = new Stopper(undefined);
    startupFailure = { kind: "signal-failed", cause };
  }
  const state: TransportState = {
    chunks: undefined,
    source,
    startupFailure,
    removalFailure: undefined,
  };
  const items = run<O>(driver, stopper, state);
  const nativeReturn = items.return.bind(items);
  const leave = (value?: void) => {
    stopper.closing = true;
    stopper.stop(undefined);
    // Native return can queue behind a pending pull; owned state must not wait on the producer.
    // An unstarted generator also skips its body and finally entirely.
    const removalFailure = detach(stopper, state);
    state.source = undefined;
    state.startupFailure = undefined;
    // Without an acquired source, no cleanup request needs the reason.
    if (state.chunks === undefined) {
      stopper.reason = undefined;
      signalFailures.delete(stopper);
    }
    driver.parser.close();
    // A refused listener removal cannot prevent the generator from releasing its producer.
    if (removalFailure !== undefined) {
      const { cause } = removalFailure;
      return nativeReturn(value).then(
        () => {
          throw cause;
        },
        (cleanup: unknown) => {
          throw new AggregateError([cause, cleanup], "Stream cleanup failed");
        },
      );
    }
    return nativeReturn(value);
  };
  const throwing = async (cause: unknown) => {
    try {
      await leave();
    } catch (cleanup) {
      // Iterator rejection must preserve the consumer's cause even when independent release fails.
      throw new AggregateError([cause, cleanup], "Consumer throw and stream cleanup failed", {
        cause: cleanup,
      });
    }
    // The iterator protocol rejects consumer throws; they are not producer failures.
    throw cause;
  };
  let attempt: Promise<Result<undefined, CloseFailure>> | undefined;
  let settled: CloseResult | undefined;
  let waiters: Set<CloseWaiter> | undefined;
  const close = (wait?: { signal?: StopSignal }): Promise<Result<undefined, CloseFailure>> => {
    // Validate before stopping: a misspelling must not silently cancel useful work.
    const bound =
      wait === undefined ? undefined : resolveSignal(checkHelperOptions(wait, ["signal"]).signal);
    attempt ??= (async (): Promise<CloseResult> => {
      let result: Result<undefined, CleanupFailure> = { ok: true, value: undefined };
      try {
        await leave();
      } catch (cause) {
        result = { ok: false, failure: { kind: "cleanup-failed", cause } };
      }
      // Listener removal and producer cleanup are independent; acknowledge each exactly once.
      try {
        await state.chunks?.finish();
      } catch (cause) {
        result = {
          ok: false,
          failure: {
            kind: "cleanup-failed",
            cause: result.ok
              ? cause
              : new AggregateError([result.failure.cause, cause], "Stream cleanup failed"),
          },
        };
      }
      settled = result;
      if (waiters !== undefined) {
        for (const give of waiters) give(result);
        waiters = undefined;
      }
      return result;
    })();
    if (bound === undefined) return attempt;
    if (settled !== undefined) return Promise.resolve(settled);
    // One cleanup observer serves every wait; Promise.race would retain each abandoned reaction.
    return boundedClose((waiters ??= new Set()), bound);
  };
  // The view rides on the stream itself: a caller rendering partial JSON while it arrives needs
  // both, and making them hold the parser separately is what forced them to re-drive the transport.
  // `snapshot` is a closure on the build, so binding is not involved; absent when no view was asked
  // for, which is exactly what `Viewed` promises on the type.
  const { snapshot } = driver.parser as { snapshot?: () => unknown };
  // Asserted because `Viewed` is a conditional over the `view` OPTION while the member's presence is
  // decided here at run time, and no narrowing relates the two. The builder settles both from that
  // one option, so the branch and the conditional cannot disagree; a test asks for a snapshot
  // through the transport under each view rather than trusting this line.
  return Object.assign(
    items,
    { close, return: leave, throw: throwing },
    snapshot === undefined ? {} : { snapshot },
  ) as ParsedStream<O>;
};

/** The loop itself; `drive` only wraps it with `close()`. */
async function* run<O extends StreamParserOptions>(
  driver: StreamBuild<O>,
  stopper: Stopper,
  state: TransportState,
): AsyncGenerator<StreamItem<O>, void, undefined> {
  const { parser: stream, summary, summarise, closed, failed } = driver;
  try {
    const aborted = stopper.aborted;
    if (aborted && stopper.closing) return;
    let chunks:
      | Chunks
      | SignalFailure
      | Extract<StreamFailure, { kind: "aborted" | "invalid-source" | "source-failed" }>;
    try {
      chunks =
        state.startupFailure ??
        (aborted
          ? (signalFailures.get(stopper) ?? { kind: "aborted", reason: stopper.reason })
          : isChunkSource(state.source)
            ? new Chunks(state.source, stopper)
            : { kind: "invalid-source", sourceKind: sourceKind(state.source) });
    } catch (cause) {
      // Only source acquisition belongs here; catching across a yield would mislabel consumer throws.
      chunks = { kind: "source-failed", cause };
    }
    // Failed acquisition owns no reader; release the source before suspending at its failure.
    state.source = undefined;
    state.startupFailure = undefined;
    if ("kind" in chunks) {
      const cleanupFailure = detach(stopper, state);
      yield failed({ ...chunks, ...(cleanupFailure === undefined ? {} : { cleanupFailure }) });
      if (summary) yield summarise(false);
      return;
    }
    state.chunks = chunks;
    let processingFailure:
      | Extract<StreamFailure, { kind: "invalid-source" | "source-failed" | "scheduling-failed" }>
      | undefined;
    /** A terminal item was delivered by a drain; there is no tail to close. */
    let ended = false;
    // Normal terminal paths report source cleanup before their summary. A failed host yield or
    // consumer return cannot wait for a live producer; close() keeps that acknowledgement.
    // Iterator cleanup may also queue behind a pending read (Chunks.cleanupQueued).
    let finished = false;
    let cleanupFailure: CleanupFailure | undefined;
    // Ready reads and deliveries may only yield microtasks. Count actual work across chunks;
    // consumer suspension is not parser work and must not spend this budget.
    let work = 0;
    try {
      for (;;) {
        // Checked before `next()`: a `for await` loop requests the next chunk before entering its
        // body, so a body-only check prevents parsing but cannot keep the source from being read.
        if (stopper.aborted) break;
        // Iterators are sequential and the parser's backpressure forbids requesting the next chunk early.
        // oxlint-disable-next-line no-await-in-loop
        const step = await chunks.next();
        if ("kind" in step) {
          processingFailure = step;
          break;
        }
        if (step.done === true) break;
        // The source may abort while fulfilling `next()`. That chunk is in hand but still untouched.
        if (stopper.aborted) break;
        const chunk = step.value;
        let offset = 0;
        const chunkLength = typeof chunk === "string" ? chunk.length : byteLength(chunk);
        const logicalLength = Math.max(1, chunkLength);
        do {
          // A borrowed view must stay intact across pulls; resizing can otherwise reverse progress.
          if ((typeof chunk === "string" ? chunk.length : byteLength(chunk)) !== chunkLength) {
            processingFailure = { kind: "invalid-source", sourceKind: "chunk:resized" };
            break;
          }
          const end = Math.min(chunkLength, offset + WORK_SLICE);
          // feedSlice decodes bytes synchronously; retaining a copied slice buys no ownership.
          const slice =
            typeof chunk === "string" ? chunk.slice(offset, end) : byteSlice(chunk, offset, end);
          work += Math.max(1, end - offset);
          for (const item of driver.feedSlice(slice, offset, end === chunkLength)) {
            // Checked before each buffered result: an abort while the consumer held the previous
            // one must stop the rest of this chunk's results, not only the next chunk.
            if (stopper.aborted) break;
            // Deliver the completed item before yielding to the host: stopping at that yield must
            // not discard a result already removed from the parser's recovery state.
            yield item;
            if (++work >= WORK_SLICE) {
              // oxlint-disable-next-line no-await-in-loop
              processingFailure = await yieldToHost();
              if (processingFailure !== undefined) break;
              work = 0;
              if (stopper.aborted) break;
            }
          }
          if (stopper.aborted || processingFailure !== undefined) break;
          if (closed()) {
            ended = true;
            break;
          }
          // Delivery may already have yielded and reset the budget; remaining input is not work.
          if (work >= WORK_SLICE) {
            // oxlint-disable-next-line no-await-in-loop
            processingFailure = await yieldToHost();
            if (processingFailure !== undefined) break;
            work = 0;
            if (stopper.aborted) break;
          }
          offset = (typeof chunk === "string" ? chunk.length : byteLength(chunk)) === 0 ? 1 : end;
        } while (offset < logicalLength);
        if (ended || stopper.aborted || processingFailure !== undefined) break;
      }
      finished = processingFailure?.kind !== "scheduling-failed";
    } catch (cause) {
      processingFailure = { kind: "source-failed", cause };
      finished = true;
    } finally {
      const cleanup = chunks.finish();
      if (finished && !chunks.cleanupQueued) {
        cleanupFailure = await chunks.waitForCleanup(cleanup);
      } else {
        // Cancellation cannot wait for an arbitrary producer; close() still observes its cleanup.
        // A rejection nobody awaits must not surface as unhandled.
        cleanup.catch(() => undefined);
      }
    }
    if (stopper.closing) return;
    if (processingFailure !== undefined || ended || closed() || stopper.aborted)
      cleanupFailure = cleanupFailures(cleanupFailure, detach(stopper, state));
    if (processingFailure !== undefined) {
      // Finish only the received open prefix; already delivered roots are never repeated.
      // Host-port and source cleanup failures must both survive the stopped operation.
      cleanupFailure = cleanupFailures(processingFailure.cleanupFailure, cleanupFailure);
      const { recovered, diagnostics } = driver.recoverOpen();
      yield failed(
        {
          ...processingFailure,
          ...(recovered === undefined ? {} : { recovered }),
          ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
        },
        diagnostics,
      );
      if (summary) yield summarise(false);
      return;
    }
    // A parser's terminal cause wins cancellation observed after that cause was delivered.
    if (ended || (closed() && !driver.abandoned())) {
      if (cleanupFailure !== undefined) yield failed(cleanupFailure);
      if (summary) yield summarise(false);
      return;
    }
    // Cancellation preserves built recovery without running EOF repair or finalizing pending tokens.
    if (stopper.aborted) {
      const { recovered, diagnostics } = driver.recovery();
      stream.close();
      yield failed(
        {
          ...(signalFailures.get(stopper) ?? { kind: "aborted", reason: stopper.reason }),
          ...(recovered === undefined ? {} : { recovered }),
          ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
        },
        diagnostics,
      );
      if (summary) yield summarise(false);
      return;
    }
    // The summary is the last word, so a cleanup failure after normal exhaustion goes before it.
    let held: StreamItem<O> | undefined;
    for (const item of stream.end()) {
      if (stopper.aborted || processingFailure !== undefined) {
        // EOF may have built several matches; retain the unread suffix, not delivered matches.
        const { recovered, diagnostics } = driver.recovery(item);
        cleanupFailure = cleanupFailures(cleanupFailure, detach(stopper, state));
        cleanupFailure = cleanupFailures(processingFailure?.cleanupFailure, cleanupFailure);
        yield failed(
          {
            ...(processingFailure ??
              signalFailures.get(stopper) ?? { kind: "aborted", reason: stopper.reason }),
            ...(recovered === undefined ? {} : { recovered }),
            ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
          },
          diagnostics,
        );
        if (summary) yield summarise(false);
        return;
      }
      if ("kind" in item) held = item;
      else {
        yield item;
        // EOF can release many held matches; consumer microtasks do not service host cancellation.
        if (++work >= WORK_SLICE) {
          // oxlint-disable-next-line no-await-in-loop
          processingFailure = await yieldToHost();
          work = 0;
        }
      }
    }
    cleanupFailure = cleanupFailures(cleanupFailure, detach(stopper, state));
    if (processingFailure !== undefined) {
      // A yield after the final delivery can fail with no unread value left to attach.
      cleanupFailure = cleanupFailures(processingFailure.cleanupFailure, cleanupFailure);
      yield failed({
        ...processingFailure,
        ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
      });
      if (summary) yield summarise(false);
      return;
    }
    if (cleanupFailure !== undefined) yield failed(cleanupFailure);
    if (held !== undefined) yield cleanupFailure === undefined ? held : summarise(false);
  } finally {
    state.source = undefined;
    detach(stopper, state);
    // Detachment records host failures instead of interrupting local release.
    stopper.reason = undefined;
    signalFailures.delete(stopper);
    stream.close();
  }
}
