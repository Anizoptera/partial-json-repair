// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { diagnostics, initParser, parseStream } from "../src/index";
import { auto, initAsyncParser, parseManyAsync, cooperative } from "../src/async";
import { parseAsync as configuredParseAsync } from "../src/async";
import { ownedView } from "../src/index";

it("does not treat arbitrary symbol properties on a caller signal as internal failures", async () => {
  const reason = { stopped: "caller" };
  const signal = new Proxy(
    { aborted: true, reason },
    {
      get(target, key, receiver): unknown {
        return typeof key === "symbol" ? "unrelated host data" : Reflect.get(target, key, receiver);
      },
    },
  );
  const expected = [{ ok: false, failure: { kind: "aborted", reason } }];
  expect(await Array.fromAsync(parseManyAsync('{"a":1}', { execution: auto, signal }))).toEqual(
    expected,
  );
  const stream = parseStream(['{"a":1}'], { signal });
  try {
    expect(await Array.fromAsync(stream)).toEqual(expected);
  } finally {
    await stream.close();
  }
});

it.each(["aborted", "addEventListener", "removeEventListener"])(
  "contains an initial signal %s getter failure before consuming input",
  async (field) => {
    const cause = new Error("signal inspection failed");
    const controller = new AbortController();
    Object.defineProperty(controller.signal, field, {
      get() {
        throw cause;
      },
    });
    let reads = 0;
    function* source() {
      reads++;
      yield '{"a":1}';
    }
    const expected = { ok: false, failure: { kind: "signal-failed", cause } };
    const stream = parseStream(source(), { signal: controller.signal });
    const parser = initAsyncParser({ execution: auto, signal: controller.signal });
    const plain = initAsyncParser({ execution: auto });
    try {
      expect(await Array.fromAsync(stream)).toEqual([expected]);
      expect(reads).toBe(0);
      expect(
        await Array.fromAsync(
          parseManyAsync('{"a":1}', { execution: auto, signal: controller.signal }),
        ),
      ).toEqual([expected]);
      expect(await configuredParseAsync('{"a":1}', parser)).toEqual(expected);
      expect(await configuredParseAsync('{"a":1}', plain, { signal: controller.signal })).toEqual(
        expected,
      );
      const closing = parseStream([]);
      try {
        expect(await closing.close({ signal: controller.signal })).toEqual(expected);
      } finally {
        await closing.close();
      }
    } finally {
      await stream.close();
      parser.close();
      plain.close();
    }
  },
);

it("settles a failed close-wait signal without cancelling sibling cleanup waits", async () => {
  const cleanup = Promise.withResolvers<void>();
  const subscribed = Promise.withResolvers<() => void>();
  const cause = new Error("close signal read failed");
  let removed = false;
  async function* source() {
    try {
      // Settled by its line break, so the first `next()` returns it with the source still suspended.
      yield '{"a":1}\n';
    } finally {
      await cleanup.promise;
    }
  }
  const stream = parseStream(source());
  await stream.next();
  const signal = {
    aborted: false,
    get reason() {
      throw cause;
    },
    addEventListener(_type: "abort", listener: () => void) {
      subscribed.resolve(listener);
    },
    removeEventListener() {
      removed = true;
    },
  };
  try {
    const closing = stream.close({ signal });
    const sibling = stream.close();
    signal.aborted = true;
    const notify = await subscribed.promise;
    expect(notify).not.toThrow();
    expect(await closing).toEqual({ ok: false, failure: { kind: "signal-failed", cause } });
    expect(removed).toBe(true);
    cleanup.resolve();
    expect(await sibling).toEqual({ ok: true, value: undefined });
  } finally {
    cleanup.resolve();
    await stream.close();
  }
});

it.each(["aborted", "reason"])(
  "contains a signal %s getter failing after input starts",
  async (field) => {
    const controller = new AbortController();
    const cause = new Error("signal read failed");
    let released = false;
    function* source() {
      try {
        yield '{"a":1,';
        if (field === "reason")
          Object.defineProperty(controller.signal, "aborted", { value: true });
        Object.defineProperty(controller.signal, field, {
          get() {
            throw cause;
          },
        });
        yield '"b":2}';
      } finally {
        released = true;
      }
    }
    const stream = parseStream(source(), { signal: controller.signal });
    try {
      expect(await Array.fromAsync(stream)).toMatchObject([
        { ok: false, failure: { kind: "signal-failed", cause, recovered: { value: { a: 1 } } } },
      ]);
      expect(released).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await stream.close();
    }
  },
);

it.each(["aborted", "reason"])(
  "contains a signal %s getter failure between whole-input results",
  async (field) => {
    await Promise.all(
      [false, true].map(async (configured) => {
        const controller = new AbortController();
        const cause = new Error("signal read failed");
        const parser = initAsyncParser({ execution: auto, signal: new AbortController().signal });
        const options = {
          signal: controller.signal,
          execution: cooperative,
        };
        const sequence = configured
          ? parseManyAsync('{"a":1}{"b":2}', parser, options)
          : parseManyAsync('{"a":1}{"b":2}', options);
        try {
          expect(await sequence.next()).toMatchObject({
            done: false,
            value: { ok: true, value: { a: 1 } },
          });
          if (field === "reason")
            Object.defineProperty(controller.signal, "aborted", { value: true });
          Object.defineProperty(controller.signal, field, {
            get() {
              throw cause;
            },
          });
          expect(await sequence.next()).toMatchObject({
            done: false,
            value: { ok: false, failure: { kind: "signal-failed", cause } },
          });
          expect((await sequence.next()).done).toBe(true);
          expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        } finally {
          await sequence.return();
          parser.close();
        }
      }),
    );
  },
);

it.each([false, true])(
  "contains failed signal subscriptions after native registration %s",
  async (registered) => {
    const cause = new Error("subscription refused");
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "addEventListener", {
      value(type: string, listener: EventListener, options: AddEventListenerOptions) {
        if (registered)
          EventTarget.prototype.addEventListener.call(signal, type, listener, options);
        throw cause;
      },
    });
    let reads = 0;
    function* source() {
      reads++;
      yield '{"a":1}';
    }
    const configured = initParser({ diagnostics });
    const task = new AbortController();
    const asynchronous = initAsyncParser({ execution: auto, signal: task.signal });
    try {
      await Promise.all(
        [
          parseStream(source(), { signal, summary: true, view: ownedView }),
          parseStream(source(), configured, { signal, summary: true, view: ownedView }),
        ].map(async (stream) => {
          try {
            expect(await Array.fromAsync(stream)).toMatchObject([
              { ok: false, failure: { kind: "signal-failed", cause } },
              { kind: "summary", complete: false, roots: 0 },
            ]);
            expect(stream.snapshot()).toEqual({ ok: true, value: undefined });
          } finally {
            expect(await stream.close()).toEqual({ ok: true, value: undefined });
          }
        }),
      );
      expect(reads).toBe(0);
      expect(await configuredParseAsync("{}", asynchronous, { signal })).toEqual({
        ok: false,
        failure: { kind: "signal-failed", cause },
      });
      const sequence = parseManyAsync("{}", asynchronous, { signal });
      try {
        expect(await Array.fromAsync(sequence)).toEqual([
          { ok: false, failure: { kind: "signal-failed", cause } },
        ]);
      } finally {
        await sequence.return();
      }
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
      expect(getEventListeners(task.signal, "abort")).toHaveLength(0);
    } finally {
      configured.close();
      asynchronous.close();
    }
  },
);

it("preserves subscription and cleanup causes together", async () => {
  const setup = new Error("subscription refused");
  const cleanup = new Error("removal refused");
  const signal = new AbortController().signal;
  Object.defineProperties(signal, {
    addEventListener: {
      value(type: string, listener: EventListener, options: AddEventListenerOptions) {
        EventTarget.prototype.addEventListener.call(signal, type, listener, options);
        throw setup;
      },
    },
    removeEventListener: {
      value(type: string, listener: EventListener) {
        EventTarget.prototype.removeEventListener.call(signal, type, listener);
        throw cleanup;
      },
    },
  });
  const stream = parseStream(["{}"], { signal });
  const parser = initAsyncParser({ execution: auto, signal: new AbortController().signal });
  try {
    const outcomes = [
      ...(await Array.fromAsync(stream)),
      await configuredParseAsync("{}", parser, { signal }),
    ];
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        ok: false,
        failure: { kind: "signal-failed", cause: { errors: [setup, cleanup], cause: cleanup } },
      });
    }
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  } finally {
    await stream.close();
    parser.close();
  }
});
