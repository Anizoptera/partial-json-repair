// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { parseStream } from "../src/stream";
import { configurationCause } from "./configuration-error";

describe("close()", () => {
  it("abandons one cleanup wait without cancelling another", async () => {
    const cleanup = Promise.withResolvers<IteratorResult<string>>();
    const items = parseStream({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: '{"a":1}' }),
        return: () => cleanup.promise,
      }),
    });
    try {
      await items.next();
      const first = new AbortController();
      const second = new AbortController();
      const abandoned = items.close({ signal: first.signal });
      const remaining = items.close({ signal: second.signal });
      first.abort("only this wait");
      expect(await abandoned).toEqual({
        ok: false,
        failure: { kind: "aborted", reason: "only this wait" },
      });
      cleanup.resolve({ done: true, value: undefined });
      const result = await remaining;
      expect(result).toEqual({ ok: true, value: undefined });
      expect(await items.close({ signal: first.signal })).toBe(result);
      expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
    } finally {
      cleanup.resolve({ done: true, value: undefined });
      await items.close();
    }
  });
  it("interrupts iteration waiting for web-source cleanup and releases owned subscriptions", async () => {
    const task = new AbortController();
    const { promise: entered, resolve: startCleanup } = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("```");
      },
      cancel() {
        startCleanup();
        return cleanup.promise;
      },
    });
    const stream = parseStream(source, { maxBuffer: 1, summary: true, signal: task.signal });
    try {
      expect(await stream.next()).toMatchObject({ value: { failure: { kind: "limit-reached" } } });
      const next = stream.next();
      await entered;
      expect(source.locked).toBe(false);
      const wait = new AbortController();
      wait.abort("wait stopped");
      expect(await stream.close({ signal: wait.signal })).toEqual({
        ok: false,
        failure: { kind: "aborted", reason: "wait stopped" },
      });
      expect(getEventListeners(task.signal, "abort")).toHaveLength(0);
      expect(await next).toEqual({ done: true, value: undefined });
    } finally {
      cleanup.resolve();
      await stream.close();
    }
  });
  it.each(
    [false, true].flatMap((started) =>
      (["return", "throw"] as const).map((method) => ({ started, method })),
    ),
  )("releases iterator $method subscriptions (started=$started)", async ({ started, method }) => {
    const task = new AbortController();
    const items = parseStream(['{"a":1} {"b":2}'], { signal: task.signal });
    if (started) expect(await items.next()).toMatchObject({ value: { ok: true } });
    const cause = new Error("consumer stopped");
    if (method === "return") await items.return?.();
    else await expect(items.throw?.(cause)).rejects.toBe(cause);
    expect(getEventListeners(task.signal, "abort")).toHaveLength(0);
    expect(await items.next()).toEqual({ done: true, value: undefined });
    await items.close();
  });

  it.each([false, true])(
    "preserves consumer throw when cleanup fails, started %s",
    async (started) => {
      const cause = new Error("consumer stopped");
      const cleanup = new Error("signal removal refused");
      const items = parseStream(['{"a":1} {"b":2}'], {
        signal: {
          aborted: false,
          removeEventListener() {
            throw cleanup;
          },
        },
      });
      if (started) await items.next();
      await expect(items.throw?.(cause)).rejects.toMatchObject({
        errors: [cause, cleanup],
        cause: cleanup,
      });
      expect(await items.next()).toEqual({ done: true, value: undefined });
      expect(await items.close()).toEqual({
        ok: false,
        failure: { kind: "cleanup-failed", cause: cleanup },
      });
    },
  );

  it("releases task and wait subscriptions even before the first pull", async () => {
    const task = new AbortController();
    const bound = new AbortController();
    const items = parseStream([], { signal: task.signal });
    expect(getEventListeners(task.signal, "abort")).toHaveLength(1);
    const result = await items.close({ signal: bound.signal });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(getEventListeners(task.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(bound.signal, "abort")).toHaveLength(0);
    expect(await items.close()).toBe(result);
  });

  it("refuses malformed close settings without stopping delivery", async () => {
    const items = parseStream(['{"a":1} ']);
    for (const settings of [null, { singal: new AbortController().signal }, { signal: 1 }])
      expect(configurationCause(() => items.close(settings as never))).toMatchObject({
        kind: "invalid-options",
      });
    expect(await items.next()).toMatchObject({ value: { ok: true, value: { a: 1 } } });
    await items.close();
  });

  it("stops delivery and answers with the cleanup outcome, once, for every caller", async () => {
    let returned = 0;
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: '{"a":1} ' }) as IteratorResult<string>,
        async return(): Promise<IteratorResult<string>> {
          returned++;
          return { done: true, value: undefined };
        },
      }),
    };
    const items = parseStream(source);
    expect(await items.next()).toMatchObject({ value: { ok: true, value: { a: 1 } } });
    const [first, second] = await Promise.all([items.close(), items.close()]);
    expect(first).toEqual({ ok: true, value: undefined });
    expect(second).toEqual(first);
    expect(returned).toBe(1);
    // Closed means closed: no `aborted` item, no tail, nothing more at all.
    expect(await items.next()).toEqual({ done: true, value: undefined });
  });

  it("wakes a read stalled on the source, without leaving an aborted item behind", async () => {
    const source = new ReadableStream<string>({
      pull: () => new Promise<void>(() => {}),
    });
    const items = parseStream(source);
    const pending = items.next();
    expect(await items.close()).toEqual({ ok: true, value: undefined });
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(source.locked).toBe(false);
  });

  it.each([new Error("cancel refused"), undefined])(
    "releases the reader lock when cancellation throws synchronously (%s)",
    async (cause) => {
      let cancelled = 0;
      let released = 0;
      const items = parseStream({
        getReader: () => ({
          read: async () => ({ done: false, value: '{"a":1} ' }),
          cancel: () => {
            cancelled++;
            // eslint-disable-next-line typescript/only-throw-error -- External producers can throw any value, including undefined.
            throw cause;
          },
          releaseLock: () => {
            released++;
          },
        }),
      });
      expect(await items.next()).toMatchObject({ value: { ok: true, value: { a: 1 } } });
      const result = await items.close();
      expect(result).toEqual({ ok: false, failure: { kind: "cleanup-failed", cause } });
      expect(await items.close()).toBe(result);
      expect(cancelled).toBe(1);
      expect(released).toBe(1);
    },
  );

  it("retains both reader cleanup failures without an unhandled cancellation rejection", async () => {
    const cancelCause = new Error("cancel failed");
    const releaseCause = new Error("release failed");
    const items = parseStream({
      getReader: () => ({
        read: async () => ({ done: false, value: '{"a":1} ' }),
        cancel: () => Promise.reject(cancelCause),
        releaseLock: () => {
          throw releaseCause;
        },
      }),
    });
    await items.next();
    const result = await items.close();
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== "cleanup-failed")
      throw new Error("Missing cleanup failure");
    expect(result.failure.cause).toBeInstanceOf(AggregateError);
    const cause = result.failure.cause as AggregateError;
    expect(cause.errors).toEqual([cancelCause, releaseCause]);
    expect(await items.close()).toBe(result);
  });

  it("keeps a cleanup failure observable after the iteration itself has ended", async () => {
    const cause = new Error("late");
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: '{"a":1} ' }) as IteratorResult<string>,
        async return(): Promise<IteratorResult<string>> {
          throw cause;
        },
      }),
    };
    const items = parseStream(source);
    // Leaving early only REQUESTS the cleanup; the answer is not waited for here.
    for await (const _ of items) break;
    expect(await items.close()).toEqual({ ok: false, failure: { kind: "cleanup-failed", cause } });
  });

  it("settles an abandoned wait once when listener removal refuses to act", async () => {
    const cleanup = Promise.withResolvers<IteratorResult<string>>();
    const items = parseStream({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: '{"a":1} ' }),
        return: () => cleanup.promise,
      }),
    });
    try {
      await items.next();
      const cause = new Error("listener removal refused");
      const listeners = new Set<() => void>();
      let removals = 0;
      const signal = {
        aborted: false,
        reason: "stop waiting",
        addEventListener(_type: "abort", listener: () => void) {
          listeners.add(listener);
        },
        removeEventListener() {
          removals++;
          throw cause;
        },
      };
      const first = items.close({ signal });
      const sibling = items.close();
      signal.aborted = true;
      for (const listener of listeners) listener();
      expect(await first).toEqual({
        ok: false,
        failure: {
          kind: "aborted",
          reason: signal.reason,
          cleanupFailure: { kind: "cleanup-failed", cause },
        },
      });
      // A host may retain and invoke the callback after refusing removal; it owns no second release.
      for (const listener of listeners) listener();
      expect(removals).toBe(1);
      cleanup.resolve({ done: true, value: undefined });
      expect(await sibling).toEqual({ ok: true, value: undefined });
    } finally {
      cleanup.resolve({ done: true, value: undefined });
      await items.close();
    }
  });

  it.each([false, true])(
    "settles sibling cleanup waits when listener removal fails, source failure %s",
    async (sourceFails) => {
      const cleanup = Promise.withResolvers<IteratorResult<string>>();
      const items = parseStream({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: '{"a":1} ' }),
          return: () => cleanup.promise,
        }),
      });
      try {
        await items.next();
        const cause = new Error("listener cleanup failed");
        const sourceCause = new Error("source cleanup failed");
        const signal = {
          aborted: false,
          addEventListener() {},
          removeEventListener() {
            throw cause;
          },
        };
        const first = items.close({ signal });
        const sibling = items.close({ signal: new AbortController().signal });
        const shared = items.close();
        if (sourceFails) cleanup.reject(sourceCause);
        else cleanup.resolve({ done: true, value: undefined });
        const expected = sourceFails
          ? { ok: false, failure: { kind: "cleanup-failed", cause: sourceCause } }
          : { ok: true, value: undefined };
        expect(await first).toEqual({
          ok: false,
          failure: sourceFails
            ? {
                kind: "cleanup-failed",
                cause: sourceCause,
                cleanupFailure: { kind: "cleanup-failed", cause },
              }
            : { kind: "cleanup-failed", cause },
        });
        expect(await sibling).toEqual(expected);
        expect(await shared).toEqual(expected);
      } finally {
        cleanup.resolve({ done: true, value: undefined });
        await items.close();
      }
    },
  );

  it.each([false, true])(
    "returns subscription failure after partial registration %s",
    async (registered) => {
      const cleanup = Promise.withResolvers<IteratorResult<string>>();
      const items = parseStream({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: '{"a":1} ' }),
          return: () => cleanup.promise,
        }),
      });
      try {
        await items.next();
        const cause = new Error("subscription failed");
        const listeners = new Set<() => void>();
        const signal = {
          aborted: false,
          addEventListener(_type: "abort", listener: () => void) {
            if (registered) listeners.add(listener);
            throw cause;
          },
          removeEventListener(_type: "abort", listener: () => void) {
            listeners.delete(listener);
          },
        };
        expect(await items.close({ signal })).toEqual({
          ok: false,
          failure: { kind: "signal-failed", cause },
        });
        expect(listeners.size).toBe(0);
        cleanup.resolve({ done: true, value: undefined });
        expect(await items.close()).toEqual({ ok: true, value: undefined });
      } finally {
        cleanup.resolve({ done: true, value: undefined });
        await items.close();
      }
    },
  );

  it("bounds the wait with a signal, and says so rather than claiming the source released", async () => {
    const cleanup = Promise.withResolvers<IteratorResult<string>>();
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: '{"a":1} ' }) as IteratorResult<string>,
        return: () => cleanup.promise,
      }),
    };
    const items = parseStream(source);
    try {
      await items.next();
      const bound = new AbortController();
      const closing = items.close({ signal: bound.signal });
      bound.abort("gave up");
      expect(await closing).toEqual({ ok: false, failure: { kind: "aborted", reason: "gave up" } });
    } finally {
      cleanup.resolve({ done: true, value: undefined });
      await items.close();
    }
  });

  it("can be called on a stream nobody ever pulled", async () => {
    let opened = false;
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        opened = true;
        return { next: async () => ({ done: true, value: undefined }) as IteratorResult<string> };
      },
    };
    expect(await parseStream(source).close()).toEqual({ ok: true, value: undefined });
    expect(opened).toBe(false);
  });

  it.each([false, true])(
    "releases the producer when the caller signal refuses listener removal, producer failure %s",
    async (refused) => {
      const cause = new Error("signal removal refused");
      const producerCause = new Error("producer release refused");
      let releases = 0;
      const items = parseStream(
        {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: false, value: '{"a":1} ' }),
            return: async () => {
              releases++;
              if (refused) throw producerCause;
              return { done: true, value: undefined };
            },
          }),
        },
        {
          signal: {
            aborted: false,
            removeEventListener() {
              throw cause;
            },
          },
        },
      );
      expect((await items.next()).done).toBe(false);
      if (!refused) await expect(items.return?.()).rejects.toBe(cause);
      const result = await items.close();
      if (refused) {
        expect(result).toMatchObject({
          ok: false,
          failure: { kind: "cleanup-failed", cause: { errors: [cause, producerCause] } },
        });
      } else {
        expect(result).toEqual({ ok: false, failure: { kind: "cleanup-failed", cause } });
      }
      expect(releases).toBe(1);
      expect((await items.next()).done).toBe(true);
      expect(await items.close()).toBe(result);
      expect(releases).toBe(1);
    },
  );
});
