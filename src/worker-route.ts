// SPDX-License-Identifier: Apache-2.0

/**
 * Loads the worker client on first use and runs one accepted input through it. Reached only from the
 * imported `worker` strategy (`worker-strategy.ts`), so an app that never names it ships none of this.
 *
 * The client loads through two spellings because each bundler family reads a different one, and each
 * must stay invisible to the others: worker-aware bundlers (webpack, Vite) expand the lazy
 * `import.meta.glob` into a chunk without leaving an unused URL asset, while esbuild, Bun and native
 * hosts never analyse it and take the URL import, which no bundler follows (the README recipe adds the
 * client as a named entry). A literal `import("./worker-executor.js")` is not an option: esbuild emits
 * every literal dynamic import target as a chunk even when the code holding it is tree-shaken, so a
 * cooperative-only app grew by the client. Without `sideEffects` metadata, webpack and Rspack count
 * the glob as a side effect and keep this module; the published package carries the field.
 */

import type * as WorkerExecutor from "./worker-executor";
import type { OperationRelease, PlannedWorker } from "./async-operation";
import { finishOutcome } from "./async-operation";
import { unavailable } from "./worker-unavailable";
import { ExactNumber } from "./exact-number";
import { bareFailure, shaped } from "./parser-outcome";
import { readStop } from "./stop-signal";
import { describeInput, isBytes } from "./transport";
import type { Input } from "./types";
import type { WholeRequest } from "./whole-operation";

const loadExecutor = async (): Promise<typeof WorkerExecutor | undefined> => {
  // Bun also exposes env, but its values are strings; Vite replaces DEV with a boolean.
  if (
    typeof (import.meta as ImportMeta & { readonly webpack?: number }).webpack === "number" ||
    typeof (import.meta as ImportMeta & { readonly env?: { readonly DEV?: string | boolean } }).env
      ?.DEV === "boolean"
  ) {
    const clients = (
      import.meta as ImportMeta & {
        glob(pattern: string): Record<string, () => Promise<typeof WorkerExecutor>>;
      }
    ).glob("./worker-executor.js");
    return clients["./worker-executor.js"]?.();
  }
  const client = new URL(/* @vite-ignore */ "./worker-executor.js", import.meta.url);
  return (await import(
    /* webpackIgnore: true */ /* @vite-ignore */ client.href
  )) as typeof WorkerExecutor;
};

/**
 * The `worker` strategy's whole route as ONE generator. A wrapper delegating through `yield*` holds
 * the last delivered outcome in its own suspended frame, out of reach of the delivery slot below, so a
 * caller pausing after a large report kept it alive (`deliveredMetadataMemoryProbe`).
 */
export async function* runInWorker(
  operation: WholeRequest,
  input: Input,
  planned: PlannedWorker,
  release?: OperationRelease,
): AsyncGenerator<unknown, void, undefined> {
  // A caller can hold a terminal failure without another pull; release its private owner before
  // yielding so the suspended generator cannot keep input and caller signals alive.
  try {
    const stopped = readStop(planned.signal);
    if (stopped !== undefined) {
      yield finishOutcome(shaped(bareFailure(stopped, planned.reported)), release);
      return;
    }
    // Input no verb accepts is refused here, as every route refuses it; posted to a worker, a
    // function or symbol fails to clone and reads as an absent worker. Answered without the
    // same-thread executor, so a worker-only app does not ship it.
    if (typeof input !== "string" && !isBytes(input)) {
      yield finishOutcome(
        shaped(
          bareFailure({ kind: "invalid-input", received: describeInput(input) }, planned.reported),
        ),
        release,
      );
      return;
    }
    // Missing host capabilities take precedence over missing deployment assets, so this check runs
    // before anything is loaded.
    if (
      !(typeof process === "object" && process.versions?.node !== undefined) &&
      (typeof Worker !== "function" || typeof MessageChannel !== "function")
    ) {
      yield finishOutcome(
        shaped(bareFailure(unavailable("unsupported"), planned.reported)),
        release,
      );
      return;
    }
    const verb =
      typeof operation === "function"
        ? "parseMany"
        : typeof operation === "string"
          ? operation
          : operation.kind;
    let executor: typeof WorkerExecutor | undefined;
    try {
      executor = await loadExecutor();
    } catch {
      // A rejected load and a glob that matched nothing are the same missing deployment asset.
    }
    if (executor === undefined) {
      yield finishOutcome(shaped(bareFailure(unavailable("failed"), planned.reported)), release);
      return;
    }
    const { executeInWorker, rethrowWorkerCleanup, WorkerCleanupError } = executor;
    const sequence = executeInWorker(
      verb,
      input,
      planned.workerOptions,
      ExactNumber,
      import.meta.url,
      // Consumer bundlers recognize only this literal constructor shape and emit its worker.
      () => new Worker(new URL("./async-worker.js", import.meta.url), { type: "module" }),
      planned.signal,
    );
    let primary: { readonly cause: unknown } | undefined;
    let open = true;
    // Empty the delivery slot before suspension; generator locals can retain a handed-out report.
    const delivery: unknown[] = [];
    try {
      while (true) {
        // Worker results and backpressure acknowledgements are strictly ordered.
        let item: Awaited<ReturnType<typeof sequence.next>>;
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop
          item = await sequence.next();
        } catch (cause) {
          if (!(cause instanceof WorkerCleanupError)) throw cause;
          open = false;
          if (verb !== "parseMany") throw cause.cause;
          // Completed stream values already reached the caller; never repeat them as recovery.
          yield finishOutcome(
            shaped(bareFailure({ kind: "cleanup-failed", cause: cause.cause }, planned.reported)),
            release,
          );
          return;
        }
        if (item.done === true) {
          open = false;
          if (item.value !== undefined) {
            // The worker is closed; drop the public owner before exposing its terminal result.
            if (typeof item.value !== "string" && "ok" in item.value) {
              yield finishOutcome(shaped(item.value), release);
              return;
            }
            const failure =
              typeof item.value === "string"
                ? unavailable(item.value)
                : item.value.kind === "aborted" || item.value.kind === "signal-failed"
                  ? item.value
                  : { ...unavailable("failed"), cleanupFailure: item.value };
            yield finishOutcome(shaped(bareFailure(failure, planned.reported)), release);
          }
          return;
        }
        delivery[0] = item.value;
        item.value = undefined;
        yield delivery.pop();
      }
    } catch (cause) {
      // Even thrown undefined is a primary cause; disposal must not replace it.
      primary = { cause };
      throw cause;
    } finally {
      try {
        if (open) await sequence.return(undefined);
      } catch (cause) {
        // Iterator disposal follows the same cause ordering as source disposal.
        rethrowWorkerCleanup(cause, primary);
      }
    }
  } finally {
    release?.();
  }
}
