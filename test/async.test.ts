// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/** The async entry preserves core outcomes while yielding and honoring cancellation. */

import { setImmediate } from "node:timers";
import { Stopper } from "../src/stopper";
import { JoinedStopperConstructor } from "../src/joined-stop-signal";
import { firstOutcome } from "../src/async-operation";
import { repairOperation } from "../src/repair-operation";
import { spanOperation } from "../src/span-operation";
import { wholeOperation } from "../src/whole-operation";
import { manySteps } from "../src/whole-reader";
import { resolveOptions } from "../src/options";
import { describe, expect, it } from "vitest";
import {
  preIterationStops,
  verifyPreIterationCancellation,
} from "./pre-iteration-cancellation-probe";

import {
  auto,
  cooperative,
  findJsonSpanAsync,
  initAsyncParser,
  parseAsync,
  parseManyAsync,
  repairAsync,
  worker,
} from "../src/async";
import {
  createStreamParser,
  diagnostics,
  findJsonSpan,
  locations,
  parse,
  parseMany,
  repair,
  select,
  ANY,
  STRICT,
} from "../src/index";
import type { AsyncExecution } from "../src/async";
import type { StopSignal } from "../src/stop-signal";
import type { Match } from "../src/types";
import { configurationCause, rejectedCause } from "./configuration-error";

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
};

it.each(["signal", "execution"] as const)(
  "ignores inherited %s getters in async options",
  async (field) => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
    const expected = parse('{"a":1}');
    let reads = 0;
    try {
      // eslint-disable-next-line no-extend-native -- A host getter must not become caller configuration.
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        get() {
          reads++;
          throw new Error("Inherited options must not be read");
        },
      });
      const options = { execution: auto, maxDepth: 2 };
      expect(await parseAsync('{"a":1}', options)).toEqual(expected);
      const parser = initAsyncParser(options);
      try {
        expect(await parseAsync('{"a":1}', parser)).toEqual(expected);
      } finally {
        parser.close();
      }
      expect(reads).toBe(0);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, field);
      // eslint-disable-next-line no-extend-native -- Restore the host's original descriptor.
      else Object.defineProperty(Object.prototype, field, previous);
    }
  },
);

it("honors non-enumerable async settings and reads own accessors once", async () => {
  const task = new AbortController();
  task.abort("stop before input");
  const options = Object.defineProperty({ execution: auto }, "signal", { value: task.signal });
  expect(await parseAsync('{"a":1}', options)).toMatchObject({
    ok: false,
    failure: { kind: "aborted", reason: "stop before input" },
  });
  const invalid = Object.defineProperty({}, "execution", { value: "inline" });
  expect(await rejectedCause(parseAsync("{}", invalid as never))).toEqual({
    kind: "invalid-options",
    field: "execution",
    reason: "execution",
  });
  let reads = 0;
  const once = {
    get execution() {
      reads++;
      return auto;
    },
  } as never;
  expect(await parseAsync('{"a":1}', once)).toEqual(parse('{"a":1}'));
  expect(reads).toBe(1);
});

// A default strategy would be referenced by every verb and ship its engine in every app, so the
// strategy is required, and a caller who omits or mistypes it is told which import fixes it.
it("refuses a missing or unrecognised execution strategy with a message naming the imports", async () => {
  const refusals = [
    undefined,
    {},
    { execution: "worker" },
    { execution: JSON.parse(JSON.stringify(auto)) as unknown },
    { execution: { feature: "execution", kind: "auto" } },
  ];
  const cause = { kind: "invalid-options", field: "execution", reason: "execution" };
  const named = 'import { auto } from "partial-json-repair/async"';
  const rejections = await Promise.all(
    refusals.map((options) =>
      parseAsync("{}", options as never).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ),
  );
  for (const [index, options] of refusals.entries()) {
    const thrown = rejections[index];
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).cause).toEqual(cause);
    expect((thrown as TypeError).message).toContain(named);
    expect(() => initAsyncParser(options as never)).toThrow(named);
    expect(() => parseManyAsync("{}", options as never)).toThrow(named);
  }
});

it("keeps continuing roots nonterminal under an inherited terminal flag", async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "terminal");
  try {
    // eslint-disable-next-line no-extend-native -- Exercise a host prototype extension, then restore it.
    Object.defineProperty(Object.prototype, "terminal", { value: true, configurable: true });
    const steps = [...wholeOperation(manySteps, '{"a":1} {"b":2}', resolveOptions())];
    const items = steps.filter((step) => step.kind === "item");
    expect(items.map((step) => step.terminal)).toEqual([false, false]);
    expect(items.map((step) => step.value)).toEqual([...parseMany('{"a":1} {"b":2}')]);
    const expected = [...parseMany('{"a":1} {"b":2}')];
    const outcomes = await Promise.all(
      [{ execution: auto }, { execution: cooperative }].map((options) =>
        collect(parseManyAsync('{"a":1} {"b":2}', options)),
      ),
    );
    expect(outcomes).toEqual([expected, expected]);
    const stopped = [
      ...wholeOperation(manySteps, '{"a":{"b":1}}', resolveOptions({ maxDepth: 1 })),
    ];
    expect(stopped.filter((step) => step.kind === "item").map((step) => step.terminal)).toEqual([
      true,
    ]);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(Object.prototype, "terminal");
    // eslint-disable-next-line no-extend-native -- Preserve the descriptor owned by the host.
    else Object.defineProperty(Object.prototype, "terminal", previous);
  }
});

it.each(["parse", "repair", "findJsonSpan"] as const)(
  "retains the completed %s outcome when cleanup fails",
  async (operation) => {
    const input = "{'safe':2}";
    const options = { diagnostics };
    const original =
      operation === "parse"
        ? parse(input, options)
        : operation === "repair"
          ? repair(input, options)
          : findJsonSpan(input, options);
    expect(original.ok).toBe(true);
    const cause = new Error("cleanup failed");
    const cleanup = (): never => {
      throw cause;
    };
    async function* sequence() {
      try {
        yield original;
      } finally {
        cleanup();
      }
    }
    const outcome = await firstOutcome(
      operation === "repair"
        ? repairOperation
        : operation === "findJsonSpan"
          ? spanOperation
          : operation,
      sequence(),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "cleanup-failed", cause, completed: original },
      diagnostics: original.diagnostics,
    });
    const returned = outcome as {
      failure: { completed: typeof original; cause: unknown };
      diagnostics: typeof original.diagnostics;
    };
    expect(returned.failure.completed).toBe(original);
    expect(returned.failure.cause).toBe(cause);
    expect(returned.diagnostics).toBe(original.diagnostics);
  },
);

it.each([new Error("earlier cleanup failed"), undefined])(
  "preserves an earlier cleanup cause when iterator cleanup also fails (%s)",
  async (earlier) => {
    const original = parse('{"safe":1,"other":\'2\'}', { ...STRICT, diagnostics });
    if (original.ok || original.failure.kind !== "policy-refused")
      throw new Error("fixture needs a real policy refusal");
    expect(original.failure.recovered).toMatchObject({ value: { safe: 1 } });
    const before = {
      ...original,
      failure: {
        ...original.failure,
        cleanupFailure: { kind: "cleanup-failed" as const, cause: earlier },
      },
    };
    const later = new Error("later cleanup failed");
    const cleanup = (): never => {
      throw later;
    };
    async function* sequence() {
      try {
        yield before;
      } finally {
        cleanup();
      }
    }
    const result = (await firstOutcome("parse", sequence())) as typeof before;
    expect(result).toMatchObject({ ok: false, failure: { kind: original.failure.kind } });
    expect(result.diagnostics).toBe(original.diagnostics);
    expect(result.failure.recovered).toBe(original.failure.recovered);
    const cause = result.failure.cleanupFailure.cause as AggregateError;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(cause.errors[0]).toBe(earlier);
    expect(cause.errors[1]).toBe(later);
    expect(cause.cause).toBe(later);
  },
);

it("preserves a whole-input refusal when iterator cleanup also fails", async () => {
  const original = parse("{'safe':2}", { ...STRICT, diagnostics });
  expect(original.ok).toBe(false);
  const cause = new Error("cleanup failed");
  const cleanup = (): never => {
    throw cause;
  };
  async function* sequence() {
    try {
      yield original;
    } finally {
      cleanup();
    }
  }
  const outcome = await firstOutcome("parse", sequence());
  expect(outcome).toEqual({
    ...original,
    ...(!original.ok && {
      failure: { ...original.failure, cleanupFailure: { kind: "cleanup-failed", cause } },
    }),
  });
  const returned = outcome as typeof original;
  expect(returned.diagnostics).toBe(original.diagnostics);
  if (
    !original.ok &&
    !returned.ok &&
    "recovered" in original.failure &&
    "recovered" in returned.failure
  )
    expect(returned.failure.recovered).toBe(original.failure.recovered);
});

/** The failure kind every route gives `input`: the sync verbs, a stream feed, both async routes. */
const refusalKinds = async (input: unknown): Promise<unknown[]> => {
  const bad = input as never;
  const sync = [parse(bad), repair(bad), findJsonSpan(bad), ...parseMany(bad)];
  const fed = [...createStreamParser().feed(bad)];
  const routes = await Promise.all(
    [cooperative, worker].map((execution) => parseAsync(bad, { execution })),
  );
  return [...sync, ...fed, ...routes].map((r) =>
    "ok" in r && !r.ok ? r.failure.kind : "not refused",
  );
};

// A signal that turns aborted on its next read after `after` reads lands the stop at a chosen
// checkpoint without timers. `after` is calibrated by counting reads on a run that never aborts.
const abortsAfter = (after: number, reason: string): StopSignal => {
  let reads = 0;
  return {
    get aborted() {
      return ++reads > after;
    },
    reason,
  };
};
const readsOf = async (run: (signal: StopSignal) => Promise<unknown>): Promise<number> => {
  let reads = 0;
  await run({
    get aborted() {
      reads++;
      return false;
    },
  });
  return reads;
};

const withFixedCostClock = async (run: () => Promise<void>): Promise<void> => {
  // Signal-read calibration identifies scanner checkpoints only when timed host yields cannot add
  // different reads in the reference and subject. Real-timer tests own callback responsiveness.
  const clock = Object.getOwnPropertyDescriptor(performance, "now");
  try {
    performance.now = () => 0;
    await run();
  } finally {
    if (clock === undefined) Reflect.deleteProperty(performance, "now");
    else Object.defineProperty(performance, "now", clock);
  }
};

const sliceReads = (input: string, execution: AsyncExecution): Promise<number> =>
  readsOf((signal) => parseAsync(input, { execution, signal }));

/** What an always-aborted signal saw of one call: its reads, its subscriptions, and the outcome. */
const alreadyAborted = async (input: string, execution: AsyncExecution) => {
  let reads = 0;
  let subscriptions = 0;
  const signal = {
    get aborted() {
      reads++;
      return true;
    },
    reason: "stop",
    addEventListener: () => {
      subscriptions++;
    },
  };
  const result = await parseAsync(input, { execution, signal });
  return { reads, subscriptions, result };
};

describe("whole-input async entry", () => {
  it.each(["parse", "parseMany", "repair", "findJsonSpan"] as const)(
    "preserves built recovery when scheduling %s fails",
    async (operation) => {
      const length = 8 * 1024 * 1024;
      const input = '{"ready":1,"tail":"' + "x".repeat(length) + '"}';
      const cause = new Error("host task failed");
      const original = globalThis.setImmediate;
      let turns = 0;
      try {
        globalThis.setImmediate = Object.assign((callback: () => void) => {
          // One successful turn ensures scanning has begun even if a prior call spent the budget.
          if (++turns === 2) throw cause;
          return original(callback);
        }, original);
        const options = { execution: cooperative, diagnostics, builtinParsers: false } as const;
        const result =
          operation === "parse"
            ? await parseAsync(input, options)
            : operation === "repair"
              ? await repairAsync(input, options)
              : operation === "findJsonSpan"
                ? await findJsonSpanAsync(input, options)
                : (await collect(parseManyAsync(input, options))).at(-1);
        expect(result).toMatchObject({
          ok: false,
          failure: {
            kind: "scheduling-failed",
            cause,
            recovered: { complete: false, cut: { kind: "string" } },
          },
        });
        if (result === undefined || result.ok) throw new Error("missing scheduling failure");
        const partial = "recovered" in result.failure && result.failure.recovered?.value;
        expect(partial).toMatchObject({ ready: 1 });
        if (typeof partial !== "object" || partial === null)
          throw new Error("missing built object");
        const tail: unknown = Reflect.get(partial, "tail");
        if (typeof tail !== "string") throw new Error("missing decoded string prefix");
        expect(tail.length).toBeGreaterThan(0);
        expect(tail.length).toBeLessThan(length);
        expect(tail).toBe("x".repeat(tail.length));
        expect(result.diagnostics).toBeDefined();
        expect(turns).toBe(2);
      } finally {
        globalThis.setImmediate = original;
      }
    },
  );

  it.each([1, 8])(
    "releases a failed host yield for %i callers so later calls can retry",
    async (count) => {
      // Exhaust the delivery budget even on a host where scanning takes less than one time slice.
      const input = '{"a":1}'.repeat(600);
      const options = { execution: cooperative } as const;
      const cause = new Error("host scheduling failed");
      const original = globalThis.setImmediate;
      try {
        globalThis.setImmediate = Object.assign(() => {
          throw cause;
        }, original);
        const calls = Array.from({ length: count }, () => collect(parseManyAsync(input, options)));
        for (const stopped of await Promise.all(calls)) {
          expect(stopped.at(-1)).toMatchObject({
            ok: false,
            failure: { kind: "scheduling-failed", cause },
          });
          expect(stopped.slice(0, -1)).toEqual(
            Array.from(parseMany(input)).slice(0, stopped.length - 1),
          );
        }
        globalThis.setImmediate = original;
        // Restoring the real host must not leave an unrelated caller awaiting the rejected promise.
        expect(await collect(parseManyAsync(input, options))).toEqual(Array.from(parseMany(input)));
      } finally {
        globalThis.setImmediate = original;
      }
    },
  );

  it("keeps an observed abort ahead of a failing delivery-budget yield", () =>
    withFixedCostClock(async () => {
      const controller = new AbortController();
      const original = globalThis.setImmediate;
      const sequence = parseManyAsync('{"a":1}'.repeat(600), {
        execution: cooperative,
        signal: controller.signal,
      });
      try {
        // Reach the delivery boundary independently of machine speed.
        for (let index = 0; index < 512; index++) {
          // eslint-disable-next-line no-await-in-loop -- Parallel pulls change the abort's delivery boundary.
          expect((await sequence.next()).done).toBe(false);
        }
        controller.abort("consumer stopped");
        globalThis.setImmediate = Object.assign(() => {
          throw new Error("unneeded host yield");
        }, original);
        expect((await sequence.next()).value).toMatchObject({
          ok: false,
          failure: { kind: "aborted", reason: "consumer stopped" },
        });
        expect((await sequence.next()).done).toBe(true);
      } finally {
        globalThis.setImmediate = original;
        await sequence.return(undefined);
      }
    }));

  it("lets host cancellation interrupt buffered final matches", async () => {
    const controller = new AbortController();
    const expected = Array.from({ length: 4096 }, (_, index) => index);
    const input = '{"items":[' + expected.join(",") + "]}";
    const values: unknown[] = [];
    let delivered = 0;
    let unread = 0;
    let terminal: string | undefined;
    let abortTask = Promise.resolve();
    for await (const item of parseManyAsync(input, {
      execution: cooperative,
      select: select([["items", ANY]]),
      signal: controller.signal,
    })) {
      if (item.ok) {
        values.push(item.value.value);
        if (++delivered === 1)
          abortTask = new Promise((resolve) => {
            // Queue on the executor's host-task lane; a zero-delay timer may not yet be due.
            setImmediate(() => {
              controller.abort("stop deliveries");
              resolve();
            });
          });
      } else {
        terminal = item.failure.kind;
        if (item.failure.kind !== "aborted")
          throw new Error("Unexpected failure before cancellation", { cause: item.failure });
        const recovery = item.failure.recovered?.value;
        if (Array.isArray(recovery)) {
          unread = recovery.length;
          for (const match of recovery as Match[]) values.push(match.value);
          expect(item.failure.recovered?.complete).toBe(true);
        }
      }
    }
    await abortTask;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(4096);
    expect(terminal).toBe("aborted");
    expect(delivered + unread).toBe(4096);
    expect(values).toEqual(expected);
  });
  it.each(["subscribe", "poll"])(
    "releases partially constructed signal after %s fails",
    (fault) => {
      const failure = new Error("signal setup failed");
      const listeners = new Set<() => void>();
      expect(
        () =>
          new Stopper({
            get aborted() {
              if (fault === "poll" && listeners.size > 0) throw failure;
              return false;
            },
            addEventListener(_type, listener) {
              listeners.add(listener);
              if (fault === "subscribe") throw failure;
            },
            removeEventListener(_type, listener) {
              listeners.delete(listener);
            },
          }),
      ).toThrow(failure);
      expect(listeners.size).toBe(0);
    },
  );
  it("releases detached signal ownership when outer listener removal throws", () => {
    const failure = new Error("listener removal failed");
    let reads = 0;
    let notified = 0;
    const stopper = new Stopper({
      get aborted() {
        reads++;
        return false;
      },
      removeEventListener() {
        throw failure;
      },
    });
    stopper.addEventListener("abort", () => {
      notified++;
    });
    expect(() => {
      stopper.detach();
    }).toThrow(failure);
    const before = reads;
    expect(stopper.aborted).toBe(false);
    expect(reads).toBe(before);
    expect(() => {
      stopper.detach();
    }).not.toThrow();
    stopper.stop("later");
    expect(notified).toBe(0);
  });
  it.each(["task", "local", "both"])(
    "releases both joined signals after %s removal fails",
    (fault) => {
      const taskError = new Error("task removal failed");
      const localError = new Error("local removal failed");
      let reads = 0;
      const removed: string[] = [];
      const joined = new JoinedStopperConstructor(
        {
          get aborted() {
            reads++;
            return false;
          },
          removeEventListener() {
            removed.push("task");
            if (fault !== "local") throw taskError;
          },
        },
        {
          get aborted() {
            reads++;
            return false;
          },
          removeEventListener() {
            removed.push("local");
            if (fault !== "task") throw localError;
          },
        },
      );
      let caught: unknown;
      try {
        joined.detach();
      } catch (error) {
        caught = error;
      }
      expect(removed).toEqual(["task", "local"]);
      if (fault === "both")
        expect((caught as AggregateError).errors).toEqual([taskError, localError]);
      else expect(caught).toBe(fault === "task" ? taskError : localError);
      const before = reads;
      expect(joined.aborted).toBe(false);
      expect(reads).toBe(before);
      expect(() => {
        joined.detach();
      }).not.toThrow();
    },
  );
  it.each(["aborted", "limit", "exhausted"] as const)(
    "reports configured listener cleanup before terminal %s delivery",
    async (exit) => {
      const task = new AbortController();
      const local = new AbortController();
      const taskError = new Error("task removal failed");
      const localError = new Error("local removal failed");
      const removed: string[] = [];
      for (const [controller, label, cause] of [
        [task, "task", taskError],
        [local, "local", localError],
      ] as const) {
        const remove = controller.signal.removeEventListener.bind(controller.signal);
        Object.defineProperty(controller.signal, "removeEventListener", {
          value(...args: Parameters<AbortSignal["removeEventListener"]>) {
            remove(...args);
            removed.push(label);
            throw cause;
          },
        });
      }
      const parser = initAsyncParser({
        execution: auto,
        signal: task.signal,
        ...(exit === "limit" ? { maxDepth: 1 } : {}),
      });
      const values = parseManyAsync('{"a":1} {"b":{"c":2}}', parser, { signal: local.signal });
      try {
        expect(await values.next()).toMatchObject({
          done: false,
          value: { ok: true, value: { a: 1 } },
        });
        if (exit === "aborted") local.abort("stop");
        if (exit === "exhausted")
          expect((await values.next()).value).toMatchObject({ ok: true, value: { b: { c: 2 } } });
        const failed = await values.next();
        const cleanup = { errors: [taskError, localError] };
        expect(failed).toMatchObject({
          done: false,
          value: {
            ok: false,
            failure:
              exit === "exhausted"
                ? { kind: "cleanup-failed", cause: cleanup }
                : {
                    kind: exit === "aborted" ? "aborted" : "limit-reached",
                    cleanupFailure: { kind: "cleanup-failed", cause: cleanup },
                  },
          },
        });
        if (exit === "limit")
          expect(failed.value).toMatchObject({
            failure: { recovered: { value: { b: {} }, complete: true } },
          });
        if (exit === "aborted") expect(failed.value).toMatchObject({ failure: { reason: "stop" } });
        if (failed.done === true || failed.value.ok)
          throw new Error("fixture needs a failed cleanup outcome");
        const failure = failed.value.failure;
        const cause =
          failure.kind === "cleanup-failed"
            ? failure.cause
            : "cleanupFailure" in failure
              ? failure.cleanupFailure?.cause
              : undefined;
        expect(cause).toBeInstanceOf(AggregateError);
        expect((cause as AggregateError).errors[0]).toBe(taskError);
        expect((cause as AggregateError).errors[1]).toBe(localError);
        expect(removed).toEqual(["task", "local"]);
        expect(await values.next()).toEqual({ done: true, value: undefined });
      } finally {
        parser.close();
        await values.return(undefined);
      }
    },
  );

  it.each([
    { label: "thrown Error", exit: "throw", consumer: new Error("consumer failed") },
    { label: "thrown undefined", exit: "throw", consumer: undefined },
    { label: "return", exit: "return", consumer: undefined },
  ] as const)(
    "preserves $label when configured iterator cleanup fails",
    async ({ exit, consumer }) => {
      const cleanup = new Error("call listener removal failed");
      const taskListeners = new Set<() => void>();
      const callListeners = new Set<() => void>();
      const signal = (listeners: Set<() => void>, fails = false) => ({
        aborted: false,
        addEventListener(_type: string, listener: () => void) {
          listeners.add(listener);
        },
        removeEventListener(_type: string, listener: () => void) {
          listeners.delete(listener);
          if (fails) throw cleanup;
        },
      });
      const parser = initAsyncParser({ execution: auto, signal: signal(taskListeners) });
      try {
        const values = parseManyAsync('{"a":1} {"b":2}', parser, {
          signal: signal(callListeners, true),
        });
        expect(await values.next()).toMatchObject({ done: false, value: { ok: true } });
        expect(taskListeners.size).toBe(1);
        expect(callListeners.size).toBe(1);
        const closing = exit === "throw" ? values.throw(consumer) : values.return(undefined);
        const caught = await closing.then(
          () => {
            throw new Error("iterator cleanup failure was swallowed");
          },
          (cause: unknown) => cause,
        );
        if (exit === "throw") {
          expect(caught).toBeInstanceOf(AggregateError);
          expect((caught as AggregateError).errors).toEqual([consumer, cleanup]);
          expect((caught as AggregateError).cause).toBe(cleanup);
        } else expect(caught).toBe(cleanup);
        expect(taskListeners.size).toBe(0);
        expect(callListeners.size).toBe(0);
        expect(await values.next()).toEqual({ done: true, value: undefined });
      } finally {
        parser.close();
      }
    },
  );
  it("releases task subscription when joining the call signal fails", () => {
    const failure = new Error("call subscription failed");
    const listeners = new Set<() => void>();
    const task = {
      aborted: false,
      addEventListener(_type: string, listener: () => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        listeners.delete(listener);
      },
    };
    expect(
      () =>
        new JoinedStopperConstructor(task, {
          aborted: false,
          addEventListener() {
            throw failure;
          },
        }),
    ).toThrow(failure);
    expect(listeners.size).toBe(0);
  });
  it.each(["addEventListener", "removeEventListener"])(
    "rejects a non-callable signal %s before reading input",
    async (method) => {
      const input = new Uint8Array([123, 125]);
      structuredClone(input.buffer, { transfer: [input.buffer] });
      const signal = { aborted: true, [method]: 42 } as never;
      const failure = { kind: "invalid-options", field: "signal", reason: "signal" };
      expect(configurationCause(() => initAsyncParser({ execution: auto, signal }))).toEqual(
        failure,
      );
      expect(await rejectedCause(parseAsync(input, { execution: auto, signal }))).toEqual(failure);
      const parser = initAsyncParser({ execution: auto });
      expect(await rejectedCause(parseAsync(input, parser, { signal }))).toEqual(failure);
      expect(
        await parseAsync(input, { execution: auto, signal: { aborted: true, reason: "polling" } }),
      ).toEqual({
        ok: false,
        failure: { kind: "aborted", reason: "polling" },
      });
    },
  );
  it("captures configured policies and call overrides before scheduling", async () => {
    const recover = { "single-quote": false };
    const parser = initAsyncParser({ execution: auto, recover });
    recover["single-quote"] = true;
    expect((await parseAsync("{'a':1}", parser, { maxDepth: 5 })).ok).toBe(false);
    const options = { allowUnquotedKeys: false, maxErrors: 1 };
    const call = parseAsync("{a:1}", parser, options);
    options.allowUnquotedKeys = true;
    expect((await call).ok).toBe(false);
    const customDangerousKeys = ["secret"];
    const requiredKeys = ["id"];
    const keys = initAsyncParser({
      execution: auto,
      customDangerousKeys,
      requiredKeys,
      onDangerousKey: "drop",
    });
    customDangerousKeys[0] = "id";
    requiredKeys[0] = "missing";
    expect(await parseAsync('{"id":1,"secret":2}', keys)).toMatchObject({
      ok: true,
      value: { id: 1 },
    });
  });

  it("keeps task cancellation distinct from local cancellation and parser close", async () => {
    const task = new AbortController();
    const local = new AbortController();
    const parser = initAsyncParser({ execution: auto, signal: task.signal });
    local.abort("local");
    expect(await parseAsync("{}", parser, { signal: local.signal })).toMatchObject({
      ok: false,
      failure: { kind: "aborted", reason: "local" },
    });
    expect((await parseAsync("{}", parser)).ok).toBe(true);
    task.abort("task");
    expect(await parseAsync("{}", parser, { signal: local.signal })).toMatchObject({
      ok: false,
      failure: { kind: "aborted", reason: "task" },
    });
    expect(await parseAsync("{}", parser)).toMatchObject({
      ok: false,
      failure: { kind: "aborted", reason: "task" },
    });
    const reusable = initAsyncParser({ execution: auto });
    const running = parseAsync("{}", reusable);
    const close = reusable.close;
    close();
    expect((await running).ok).toBe(true);
    expect(await parseAsync("{}", reusable)).toMatchObject({
      ok: false,
      failure: { kind: "parser-closed" },
    });
    const batch = new AbortController();
    const active = initAsyncParser({ signal: batch.signal, execution: cooperative });
    const pending = parseAsync("[" + "1,".repeat(100000) + "1]", active);
    active.close();
    batch.abort("active task");
    expect(await pending).toMatchObject({
      ok: false,
      failure: { kind: "aborted", reason: "active task" },
    });
  });

  it("captures already-aborted reasons before a lazy iterator starts", async () => {
    await Promise.all(
      (["local", "task", "both"] as const).map(async (first) => {
        const task = new AbortController();
        const local = new AbortController();
        const parser = initAsyncParser({ execution: auto, signal: task.signal });
        if (first !== "local") task.abort("task");
        if (first !== "task") local.abort("local");
        const values = parseManyAsync("{}", parser, { signal: local.signal });
        try {
          task.abort("task");
          local.abort("local");
          expect((await values.next()).value).toMatchObject({
            ok: false,
            failure: { kind: "aborted", reason: first === "local" ? "local" : "task" },
          });
          expect((await values.next()).done).toBe(true);
        } finally {
          await values.return();
          parser.close();
        }
      }),
    );
  });

  it.each(preIterationStops)(
    "keeps a pre-iteration %s cancellation ahead of listener setup failure",
    (first) => verifyPreIterationCancellation(initAsyncParser, parseManyAsync, first, auto),
  );

  it("observes cancellation before delivering the next whole-input value", async () => {
    const controller = new AbortController();
    const values = parseManyAsync('{"a":1} {"b":2}', {
      execution: auto,
      signal: controller.signal,
      builtinParsers: false,
    });
    expect((await values.next()).value).toMatchObject({ ok: true, value: { a: 1 } });
    controller.abort("between pulls");
    expect((await values.next()).value).toMatchObject({
      ok: false,
      failure: { kind: "aborted", reason: "between pulls" },
    });
    expect((await values.next()).done).toBe(true);
  });

  it.each([auto, cooperative])(
    "isolates concurrent local stops and retains the first observed task reason (%o)",
    async (execution) => {
      const task = new AbortController();
      const local = new AbortController();
      const parser = initAsyncParser({ execution, signal: task.signal, builtinParsers: false });
      const first = parseManyAsync('{"a":1} {"b":2}', parser, { signal: local.signal });
      const sibling = parseManyAsync('{"a":1} {"b":2} {"c":3}', parser);
      try {
        const started = await Promise.all([first.next(), sibling.next()]);
        for (const item of started) expect(item.value).toMatchObject({ ok: true, value: { a: 1 } });
        local.abort("local first");
        // A local stop must leave an already-running sibling able to deliver its next value.
        expect((await sibling.next()).value).toMatchObject({ ok: true, value: { b: 2 } });
        task.abort("task second");
        expect((await first.next()).value).toMatchObject({
          failure: { kind: "aborted", reason: "local first" },
        });
        expect((await sibling.next()).value).toMatchObject({
          failure: { kind: "aborted", reason: "task second" },
        });
      } finally {
        await Promise.all([first.return(), sibling.return()]);
        parser.close();
      }
      expect((await parseAsync("{}", { execution: auto })).ok).toBe(true);
    },
  );

  it("ignores inherited selection on omitted-option calls", async () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "selection");
    // eslint-disable-next-line no-extend-native -- Exercise actual host pollution, restored in finally.
    Object.defineProperty(Object.prototype, "selection", {
      configurable: true,
      get() {
        throw new Error("inherited selection read");
      },
    });
    try {
      expect(parse('{"a":1}')).toMatchObject({ ok: true, value: { a: 1 } });
      expect(await parseAsync('{"a":1}', { execution: auto })).toMatchObject({
        ok: true,
        value: { a: 1 },
      });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, "selection");
      else {
        // eslint-disable-next-line no-extend-native -- Restore the host's original descriptor.
        Object.defineProperty(Object.prototype, "selection", previous);
      }
    }
  });

  it("uses the public defaults when options are omitted", async () => {
    const input = "noise {answer:42,} after";
    const expected = parse(input);
    expect(expected).toMatchObject({ ok: true, value: { answer: 42 } });
    expect(await parseAsync(input, { execution: auto })).toEqual(expected);
    expect(await repairAsync(input, { execution: auto })).toEqual(repair(input));
    expect(await findJsonSpanAsync(input, { execution: auto })).toEqual(findJsonSpan(input));
    expect(await collect(parseManyAsync(input, { execution: auto }))).toEqual([
      ...parseMany(input),
    ]);

    const parser = initAsyncParser({ execution: auto });
    try {
      expect(await parseAsync(input, parser)).toEqual(expected);
    } finally {
      parser.close();
    }
  });

  it("refuses malformed options with the configuration error and malformed input with a result", async () => {
    const notObject = { kind: "invalid-options", field: "options", reason: "object" };
    expect(await rejectedCause(parseAsync("{}", null as never))).toEqual(notObject);
    expect(configurationCause(() => parse("{}", null as never))).toEqual(notObject);
    expect(await rejectedCause(repairAsync("{}", null as never))).toEqual(notObject);
    expect(await rejectedCause(findJsonSpanAsync("{}", null as never))).toEqual(notObject);
    // Thrown at the call, before any iterator exists, like the synchronous `parseMany`.
    expect(configurationCause(() => parseManyAsync("{}", null as never))).toEqual(notObject);
    expect(configurationCause(() => initAsyncParser(null as never))).toEqual(notObject);
    // The key is spelt right and the value is not, so the reason names the values, never a typo.
    expect(await rejectedCause(parseAsync("{}", { execution: "inline" as never }))).toEqual({
      kind: "invalid-options",
      field: "execution",
      reason: "execution",
    });
    const configured = initAsyncParser({ execution: auto });
    const badDepth = { kind: "invalid-options", field: "maxDepth", reason: "positive-integer" };
    expect(await rejectedCause(parseAsync("{}", configured, { maxDepth: 0 }))).toEqual(badDepth);
    expect(configurationCause(() => parseManyAsync("{}", configured, { maxDepth: 0 }))).toEqual(
      badDepth,
    );
    // A bound parser checks the override's shape too, so `null` gets a typed cause and `[]` is refused.
    const shapes = [null, [], "ab"].map((shape) => parseAsync("{}", configured, shape as never));
    expect(await Promise.all(shapes.map((call) => rejectedCause(call)))).toEqual([
      notObject,
      notObject,
      notObject,
    ]);
    // The controller passed for its signal has no `aborted`: it would have been ignored, uncancellable.
    const controller = { execution: auto, signal: new AbortController() as never };
    const badSignal = { kind: "invalid-options", field: "signal", reason: "signal" };
    expect(await rejectedCause(parseAsync("{}", controller))).toEqual(badSignal);
    expect(await rejectedCause(parseAsync("{}", configured, controller))).toEqual(badSignal);
    // A released parser still refuses a bad override instead of hiding it behind `parser-closed`.
    configured.close();
    expect(await rejectedCause(parseAsync("{}", configured, { maxDepth: 0 }))).toEqual(badDepth);

    const invalidInput = await parseAsync(null as never, { execution: auto });
    expect(invalidInput).toEqual(parse(null as never));
  });

  it("answers input no verb accepts with invalid-input on every route", async () => {
    // A function or symbol once failed to clone for the worker and read as `execution-unavailable`;
    // a proxied `Uint8Array` passed `instanceof` and then threw from its typed-array getters.
    const inputs = [() => 1, Symbol("x"), new Proxy(new TextEncoder().encode("{}"), {})];
    const answers = await Promise.all(inputs.map((input) => refusalKinds(input)));
    expect(answers).toEqual(inputs.map(() => Array.from({ length: 7 }, () => "invalid-input")));
  });

  it("matches every synchronous whole-input projection", async () => {
    const input = "noise {foo:'bar', list:[1,2,], tail:true} after";
    const options = { diagnostics, locations };
    const sameThread = { ...options, execution: auto };
    expect(await parseAsync(input, sameThread)).toEqual(parse(input, options));
    expect(await repairAsync(input, sameThread)).toEqual(repair(input, options));
    expect(await findJsonSpanAsync(input, sameThread)).toEqual(findJsonSpan(input, options));
  });

  it("matches parseMany item order and reports", async () => {
    const input = "{a:1} [2,3,] false";
    const options = { diagnostics: diagnostics({ scope: "all" }) };
    expect(await collect(parseManyAsync(input, { ...options, execution: auto }))).toEqual([
      ...parseMany(input, options),
    ]);
  });

  it("decodes byte input incrementally with original byte positions", async () => {
    const input = new TextEncoder().encode(` ${"é".repeat(5000)} {"x":"✓"}`);
    expect(await parseAsync(input, { execution: auto, locations })).toEqual(
      parse(input, { locations }),
    );
  });

  it("preserves queued pulls, terminal return values and iterator disposal", async () => {
    const input = '{"a":1} {"b":2}';
    await Promise.all(
      [
        () => parseManyAsync(input, { execution: auto }),
        () => parseManyAsync(input, initAsyncParser({ execution: auto })),
      ].map(async (create) => {
        const values = create();
        const [first, second, done] = await Promise.all([
          values.next(),
          values.next(),
          values.next(),
        ]);
        expect(first.value).toMatchObject({ ok: true, value: { a: 1 } });
        expect(second.value).toMatchObject({ ok: true, value: { b: 2 } });
        expect(done).toEqual({ done: true, value: undefined });
        expect(await values.return(Promise.resolve())).toEqual({ done: true, value: undefined });
        const cause = Symbol("caller failure");
        // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Iterator rejection values are not restricted to Errors.
        await expect(values.return(Promise.reject(cause))).rejects.toBe(cause);
        await expect(values.throw(cause)).rejects.toBe(cause);
        const abandoned = create();
        await abandoned[Symbol.asyncDispose]();
        expect(await abandoned.next()).toEqual({ done: true, value: undefined });
      }),
    );
  });

  // A sliced scan has read only part of the text when it records an error, yet the error's context
  // must quote the same characters as the one-shot parse. Moving the error across a slice boundary
  // puts its 20-character tail beyond what was read for some of these offsets.
  it("quotes the same error context when the error sits near a slice boundary", async () => {
    const options = {
      diagnostics: diagnostics({ scope: "all" }),
      recover: { "comment-removed": false },
    } as const;
    const inputs = Array.from(
      { length: 40 },
      (_, i) => `{"a":"${"x".repeat(2540 + i)}" // a trailing comment\n}`,
    );
    const results = await Promise.all(
      inputs.map((input) => parseAsync(input, { ...options, execution: auto })),
    );
    expect(results).toEqual(inputs.map((input) => parse(input, options)));
  });

  // The scan reads `aborted` at each checkpoint, so the read count shows whether a call ran in
  // slices without timing anything. Malformed input keeps the built-in parsers out of the way.
  it("keeps small input inline only for auto; forced cooperative is always sliced", async () => {
    const tiny = "{a:0}";
    // Long enough for several slices, short enough that `auto` may keep it inline.
    const small = `{${"a:0 ".repeat(350)}}`;
    const large = `{${"a:0 ".repeat(25_000)}}`;
    const [unsliced, smallAuto, largeAuto, smallCooperative] = await Promise.all([
      sliceReads(tiny, auto),
      sliceReads(small, auto),
      sliceReads(large, auto),
      sliceReads(small, cooperative),
    ]);
    expect(smallAuto).toBe(unsliced);
    expect(largeAuto).toBeGreaterThan(unsliced);
    expect(smallCooperative).toBeGreaterThan(unsliced);
  });

  // An abort read from the signal before the call starts must stop it before it decodes, scans or
  // starts a worker. Neither shows in the outcome, so the signal counts its own reads (equal for
  // tiny and large input: no checkpoint ran) and its subscriptions (made only by a worker run).
  it("does no work for an already-aborted call", async () => {
    const executions = [auto, cooperative, worker];
    const seen = await Promise.all(
      executions.map(async (execution) => ({
        execution: execution.kind,
        tiny: await alreadyAborted('{"a":1}', execution),
        large: await alreadyAborted(`{${"a:0 ".repeat(25_000)}}`, execution),
      })),
    );
    for (const { execution, tiny, large } of seen) {
      for (const call of [tiny, large]) {
        expect(call.result, execution).toStrictEqual({
          ok: false,
          failure: { kind: "aborted", reason: "stop" },
        });
        expect(call.subscriptions, execution).toBe(0);
      }
      expect(large.reads, execution).toBe(tiny.reads);
    }
  });

  it("stops a scan at a host-task checkpoint", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort("later");
    }, 0);
    try {
      const result = await parseAsync(`[${"0,".repeat(100_000)}0]`, {
        execution: auto,
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toMatchObject({ kind: "aborted", reason: "later" });
    } finally {
      clearTimeout(timer);
    }
  });

  it("keeps decoded byte recovery when parseMany reaches a cancellation checkpoint", () =>
    withFixedCostClock(async () => {
      const options = { execution: cooperative } as const;
      // Three bytes decode without a checkpoint, so this counts the reads made before any work.
      const before = await readsOf((signal) =>
        collect(parseManyAsync(new TextEncoder().encode("[0]"), { ...options, signal })),
      );
      const input = new TextEncoder().encode(`[${"0,".repeat(2000)}0]`);
      const results = await collect(
        parseManyAsync(input, { ...options, signal: abortsAfter(before, "decode-stop") }),
      );
      // The decoded prefix was already scanned; cancellation must not erase its usable values.
      expect(results).toHaveLength(1);
      const result = results[0];
      if (result === undefined || result.ok || result.failure.kind !== "aborted")
        throw new Error("byte cancellation must remain a typed aborted outcome");
      expect(result.failure).toMatchObject({
        reason: "decode-stop",
        recovered: { complete: false },
      });
      const prefix = result.failure.recovered?.value;
      expect(Array.isArray(prefix) && prefix.length > 0 && prefix[0] === 0).toBe(true);
    }));

  it("keeps decoded byte recovery when default parsing reaches a cancellation checkpoint", () =>
    withFixedCostClock(async () => {
      const options = { execution: cooperative } as const;
      const before = await readsOf((signal) =>
        parseAsync(new TextEncoder().encode("[0]"), { ...options, signal }),
      );
      // A large input cannot use the indivisible built-in parser; decoding must not hide scan progress.
      const input = new TextEncoder().encode(`[${"0,".repeat(100_000)}0]`);
      const result = await parseAsync(input, {
        ...options,
        signal: abortsAfter(before, "decode-stop"),
      });
      if (result.ok || result.failure.kind !== "aborted")
        throw new Error("byte cancellation must remain a typed aborted outcome");
      expect(result.failure).toMatchObject({
        reason: "decode-stop",
        recovered: { complete: false },
      });
      const prefix = result.failure.recovered?.value;
      expect(Array.isArray(prefix) && prefix.length > 0 && prefix[0] === 0).toBe(true);
    }));

  it("observes cancellation while projecting a dense repair", () =>
    withFixedCostClock(async () => {
      const input = `{${"a:0 ".repeat(2000)}}`;
      const options = { diagnostics, execution: cooperative } as const;
      // `parseAsync` reads the signal exactly as often as the scan inside `repairAsync` does.
      const scanReads = await readsOf((signal) => parseAsync(input, { ...options, signal }));
      const result = await repairAsync(input, {
        ...options,
        signal: abortsAfter(scanReads, "projection-stop"),
      });
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: "aborted", reason: "projection-stop" },
      });
      // Only a finished scan recovers the whole object as complete; a stop mid-scan recovers the same
      // `{ a: 0 }` (every member is `a`) but cut, so this exact record is what places the stop.
      expect((result as { failure: { recovered: unknown } }).failure.recovered).toEqual({
        value: { a: 0 },
        complete: true,
      });
    }));

  it("observes cancellation while listing later values, keeping the returned value", () =>
    withFixedCostClock(async () => {
      const input = `{"a":1}\n${'{"b":2}\n'.repeat(2000)}`;
      // Both counts on the scanner: without a report valid JSON would take the built-in route.
      const options = { execution: cooperative, builtinParsers: false } as const;
      // Without a report the call never scans past its value, so every read beyond that count is
      // inside the later-value scan.
      const valueReads = await readsOf((signal) => parseAsync(input, { ...options, signal }));
      const reported = { ...options, diagnostics };
      const allReads = await readsOf((signal) => parseAsync(input, { ...reported, signal }));
      expect(allReads).toBeGreaterThan(valueReads + 1);
      const result = await parseAsync(input, {
        ...reported,
        signal: abortsAfter(valueReads + 1, "later-stop"),
      });
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: "aborted", reason: "later-stop", recovered: { value: { a: 1 } } },
      });
      expect(result.diagnostics?.laterValues).toEqual([]);
      // Whitespace after the value holds nothing to list, so the report costs no second scan.
      const single = `{${'"a":0,'.repeat(2000)}"z":0}\n  \n`;
      expect(await readsOf((signal) => parseAsync(single, { ...reported, signal }))).toBe(
        await readsOf((signal) => parseAsync(single, { ...options, signal })),
      );
    }));

  it.each([false, true])(
    "observes cancellation while projecting selected spans (diagnostics=%s)",
    (reported) =>
      withFixedCostClock(async () => {
        const input = `{"items":[${"0,".repeat(2000)}0]}`;
        const options = {
          select: select([["items", ANY]]),
          diagnostics: reported && diagnostics,
        } as const;
        // Parse and span lookup share scanning; only span lookup has work after the last scan check.
        const scanReads = await readsOf((signal) =>
          parseAsync(input, { ...options, execution: cooperative, signal }),
        );
        const original = parse(input, options);
        expect(original.ok).toBe(true);
        if (!original.ok) throw new Error("selected span fixture must recover");
        const result = await findJsonSpanAsync(input, {
          ...options,
          execution: cooperative,
          signal: abortsAfter(scanReads, "span-stop"),
        });
        // Fail on the verdict before printing a large recovered match set in assertion diagnostics.
        expect(result.ok).toBe(false);
        expect(result).toEqual({
          ok: false,
          failure: {
            kind: "aborted",
            reason: "span-stop",
            recovered: { value: original.value, complete: true },
          },
          ...(reported ? { diagnostics: original.diagnostics } : {}),
        });
      }),
  );

  it("validates configured options once and applies call overrides", async () => {
    const initialized = initAsyncParser({ execution: auto, objectOnly: true });
    expect(await parseAsync("[1] {a:2}", initialized)).toEqual(
      parse("[1] {a:2}", { objectOnly: true }),
    );
    expect(await parseAsync("[1]", initialized, { objectOnly: false })).toEqual(parse("[1]"));
  });

  it("releases a configured parser once and refuses later calls", async () => {
    const initialized = initAsyncParser({ execution: auto, diagnostics });

    const first = initialized.close();
    expect(first).toEqual({ ok: true, value: undefined });
    expect(initialized.close()).toBe(first);
    initialized[Symbol.dispose]();

    expect(await parseAsync("{}", initialized)).toMatchObject({
      ok: false,
      failure: { kind: "parser-closed" },
    });
    expect(await collect(parseManyAsync("{}", initialized))).toEqual([
      expect.objectContaining({ ok: false, failure: { kind: "parser-closed" } }),
    ]);
  });
});
