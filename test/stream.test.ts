// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { decodedFragments } from "../src/index";

/**
 * `parseStream`, attacked where it makes promises the types cannot check: that one entry point
 * covers every source shape, that an abort preserves available recovery without completing unread
 * input, and that leaving early does not strand a web stream locked.
 */
import { describe, expect, it } from "vitest";

import { parseStream } from "../src/stream";
import { initParser } from "../src/parser";
import type { Parser, StreamItem } from "../src/parser";
import type { Exact, ParserOptions } from "../src/options";
import { configurationCause } from "./configuration-error";
import { ANY, diagnostics, parse, select, skip } from "../src/index";
import {
  parseStream as configuredParseStream,
  createStreamParser as configuredCreateStreamParser,
} from "../src/index";
import { sharedView } from "../src/index";

const drain = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of source) out.push(v);
  return out;
};

const parsedValues = async (source: AsyncIterable<StreamItem>): Promise<unknown[]> =>
  (await drain(source)).map((item) => {
    if ("kind" in item) throw new Error("Unexpected stream summary");
    if (!item.ok)
      throw new Error(`Unexpected stream failure: ${item.failure.kind}`, { cause: item.failure });
    return item.value;
  });

const parserOf = <P extends ParserOptions>(parserOptions: Exact<P, ParserOptions>): Parser<P> =>
  initParser<P>(parserOptions);

const emit = async function* (
  ...chunks: (string | Uint8Array)[]
): AsyncGenerator<string | Uint8Array, void, undefined> {
  for (const c of chunks) yield c;
};

it.each(["signal", "view", "summary"] as const)(
  "ignores inherited %s getters in stream options",
  async (field) => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
    let reads = 0;
    try {
      // eslint-disable-next-line no-extend-native -- Host getters must not become caller settings.
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        get() {
          reads++;
          throw new Error("Inherited stream options must not be read");
        },
      });
      expect(await parsedValues(parseStream('{"a":1}', {}))).toEqual([{ a: 1 }]);
      expect(reads).toBe(0);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, field);
      // eslint-disable-next-line no-extend-native -- Restore the original host descriptor.
      else Object.defineProperty(Object.prototype, field, previous);
    }
  },
);

describe("parseStream covers every source shape with one entry point", () => {
  it("reads an async generator", async () => {
    expect(await parsedValues(parseStream(emit('{"a":1} [1,', "2]")))).toEqual([{ a: 1 }, [1, 2]]);
  });

  it("reads a plain array, which is only Iterable", async () => {
    // Not async-iterable. Worth its own case: the normaliser tests `Symbol.asyncIterator` first, and
    // a version that tested only that would silently fall through to the `getReader` branch.
    expect(await parsedValues(parseStream(['{"a":', "1}"]))).toEqual([{ a: 1 }]);
  });

  it("treats a primitive string as one chunk, not an iterable transport", async () => {
    expect(await parsedValues(parseStream('{"a":"é"}'))).toEqual([{ a: "é" }]);
  });

  it("keeps diagnostics attached to the value that caused them", async () => {
    const results = await drain(parseStream(["{'a':1} ", '{"b":2}'], { diagnostics }));
    expect(results).toMatchObject([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
    expect(
      results.map((result) => result.diagnostics.repairs.map((repair) => repair.kind)),
    ).toEqual([["single-quote"], []]);
  });

  it("reads a web ReadableStream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":"é'));
        c.enqueue(new TextEncoder().encode('nd"}'));
        c.close();
      },
    });
    expect(await parsedValues(parseStream(body))).toEqual([{ a: "énd" }]);
  });

  it("survives a multi-byte character split across a chunk boundary", async () => {
    // The decode belongs to the parser, not the caller. Split INSIDE the two bytes of `é`.
    const bytes = new TextEncoder().encode('{"a":"é"}');
    const cut = bytes.indexOf(0xc3) + 1;
    expect(
      await parsedValues(parseStream(emit(bytes.subarray(0, cut), bytes.subarray(cut)))),
    ).toEqual([{ a: "é" }]);
  });

  it("closes what the input left open, as one-shot parse does", async () => {
    expect(await parsedValues(parseStream(emit('{"a":[1,2')))).toEqual([{ a: [1, 2] }]);
  });

  it("throws invalid options at the call, before the source is touched", () => {
    let pulled = false;
    const source = {
      async *[Symbol.asyncIterator]() {
        pulled = true;
        yield '{"a":1}';
      },
    };
    expect(configurationCause(() => parseStream(source, { maxDepth: 0 }))).toEqual({
      kind: "invalid-options",
      field: "maxDepth",
      reason: "positive-integer",
    });
    expect(pulled).toBe(false);
  });

  it("reports a terminal limit as the last item, with the scan marked incomplete", async () => {
    const items = await drain(parseStream(["```"], { maxBuffer: 1, diagnostics }));
    expect(items.map((item) => (item.ok ? undefined : item.failure))).toEqual([
      expect.objectContaining({ kind: "limit-reached", resource: "buffer" }),
    ]);
    expect(items[0]?.diagnostics.scanComplete).toBe(false);
  });
});

describe("a slow consumer", () => {
  // A slow HTTP reader must not make the parser drain the request body ahead of it: that would
  // buffer an upload of any size. An endless zero-buffer source makes eager reading visible as
  // extra pulls; a host turn after each delivery lets any background loop run before counting.
  it("reads the source only when the consumer asks for the next item", async () => {
    let pulls = 0;
    const source = new ReadableStream<string>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(`{"n":${String(pulls)}} `);
        },
      },
      { highWaterMark: 0 },
    );
    const stream = parseStream(source);
    const iterator = stream[Symbol.asyncIterator]();
    // Sequential by design: each delivery must settle before its pulls are counted.
    const deliver = async (delivered: number): Promise<void> => {
      expect((await iterator.next()).value).toMatchObject({ ok: true });
      await new Promise<void>((settled) => {
        setTimeout(settled, 0);
      });
      // A root is complete only once the next chunk shows its end, so one chunk of lookahead.
      expect(pulls).toBeLessThanOrEqual(delivered + 1);
    };
    await deliver(1);
    await deliver(2);
    await deliver(3);
    await stream.close();
  });

  // A body that errors while the consumer is slow has no read pending to reject. Cancelling the
  // errored stream then only repeats its error, which must not read as a cleanup failure.
  it("does not report an errored body as a cleanup failure when no read was pending", async () => {
    let fail: (cause: Error) => void = () => undefined;
    const source = new ReadableStream<string>(
      {
        start(controller) {
          fail = (cause) => {
            controller.error(cause);
          };
        },
        pull(controller) {
          controller.enqueue('{"a":1} {"b":');
        },
      },
      { highWaterMark: 0 },
    );
    const stream = parseStream(source);
    expect((await stream[Symbol.asyncIterator]().next()).value).toMatchObject({ ok: true });
    fail(new Error("client disconnected"));
    expect(await stream.close()).toEqual({ ok: true, value: undefined });
    expect(source.locked).toBe(false);
  });
});

describe("a consumer that leaves early tears the source down", () => {
  // `break` out of a `for await` is the commonest consumer shape there is -- "give me the first
  // value" -- and it reaches cleanup by a different door from `abort`: the generator's `return()`,
  // with no signal and nothing that looks like cancellation. Releasing the reader's lock is NOT
  // tearing the source down; an HTTP body whose reader was merely released goes on streaming with
  // nobody reading it. Both source shapes are asserted together because they had drifted apart --
  // the iterable path called `iterator.return()` and the reader path only released.
  it("cancels a ReadableStream source on break", async () => {
    let cancelled = false;
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('{"a":1} ');
        controller.enqueue('{"b":2}');
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const item of parseStream(source)) {
      expect(item).toMatchObject({ ok: true, value: { a: 1 } });
      break;
    }
    expect(cancelled).toBe(true);
  });

  // The guard on the branch that was REMOVED. Cleanup cancels unconditionally instead of telling
  // exhaustion from early exit, which is only safe because cancelling an already-closed stream never
  // reaches the source's `cancel`. That is a claim about the platform, so it is measured here rather
  // than read from the specification -- and it is what a future "cancel more eagerly" change breaks.
  it("does not cancel a source the consumer drained to the end", async () => {
    let cancelCalls = 0;
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('{"a":1} ');
        controller.enqueue('{"b":2}');
        controller.close();
      },
      cancel() {
        cancelCalls++;
      },
    });
    expect(await parsedValues(parseStream(source))).toEqual([{ a: 1 }, { b: 2 }]);
    expect(cancelCalls).toBe(0);
  });

  it("returns an async-iterable source on break", async () => {
    let returned = false;
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: '{"a":1} ' }) as IteratorResult<string>,
          async return() {
            returned = true;
            return { done: true, value: undefined } as IteratorResult<string>;
          },
        };
      },
    };
    for await (const item of parseStream(source)) {
      expect(item).toMatchObject({ ok: true, value: { a: 1 } });
      break;
    }
    expect(returned).toBe(true);
  });
});

describe("abort", () => {
  it("cancels a stalled web read instead of waiting for another chunk", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stalled = new ReadableStream<string>({
      pull() {
        controller.abort("stop");
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        cancelled = reason === "stop";
      },
    });
    const parsing = parseStream(stalled, { signal: controller.signal });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        drain(parsing),
        new Promise<"stalled">((resolve) => {
          timeout = setTimeout(resolve, 50, "stalled");
        }),
      ]);
      // The abort is the stream's last item, so a consumer can tell "stopped" from "ended".
      expect(result).toEqual([{ ok: false, failure: { kind: "aborted", reason: "stop" } }]);
      expect(cancelled).toBe(true);
    } finally {
      clearTimeout(timeout);
      await parsing.close({ signal: controller.signal });
    }
  });

  it("cancels a stalled async iterator instead of waiting for another chunk", async () => {
    const controller = new AbortController();
    let returned = false;
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
          async return() {
            returned = true;
            throw new Error("late cancellation failure");
          },
        };
      },
    };
    const parsing = drain(parseStream(source, { signal: controller.signal }));
    controller.abort();

    // `abort()` with no argument still has a reason — the platform's AbortError — and it is passed
    // through untouched rather than normalised away.
    await expect(parsing).resolves.toMatchObject([
      {
        ok: false,
        failure: {
          kind: "aborted",
          reason: expect.objectContaining({ name: "AbortError" }) as unknown,
        },
      },
    ]);
    expect(returned).toBe(true);
  });

  it("delivers the abort while an async generator is stalled mid-read", async () => {
    // A generator's `return()` queues behind its pending `next()`, so awaiting that cleanup after an
    // abort hung the stream forever. The hand-written iterator above cannot show this: its `return()`
    // answers while `next()` is still pending.
    const controller = new AbortController();
    const stalled = async function* (): AsyncGenerator<string, void, undefined> {
      yield "[1,";
      // Inside the second `next()`: the read is in flight when the stop arrives, and never settles.
      controller.abort("stop");
      await new Promise<never>(() => {});
    };
    await expect(drain(parseStream(stalled(), { signal: controller.signal }))).resolves.toEqual([
      {
        ok: false,
        failure: {
          kind: "aborted",
          reason: "stop",
          recovered: {
            value: [1],
            complete: false,
            cut: { path: [], kind: "between" },
          },
        },
      },
    ]);
  });

  it("keeps upstream cancellation acknowledgement available through close", async () => {
    const controller = new AbortController();
    let released = false;
    const source = new ReadableStream<string>({
      pull() {
        controller.abort();
        return new Promise<void>(() => {});
      },
      async cancel() {
        await Promise.resolve();
        released = true;
      },
    });
    const stream = parseStream(source, { signal: controller.signal });
    await drain(stream);
    expect(await stream.close()).toEqual({ ok: true, value: undefined });
    expect(released).toBe(true);
  });

  it("does not parse the chunk already in hand", async () => {
    // THE case. The source aborts as it hands over the second chunk, so that chunk is in hand and
    // unparsed at the moment the signal fires. An implementation that feeds first and checks after
    // passes every "no further chunk was read" test and fails this one.
    const controller = new AbortController();
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      // The line break settles the first root inside its own chunk (see the test after this one).
      yield '{"a":1}\n';
      controller.abort("stop");
      yield '{"b":2}';
    };
    expect(await drain(parseStream(source(), { signal: controller.signal }))).toEqual([
      { ok: true, value: { a: 1 }, complete: true },
      { ok: false, failure: { kind: "aborted", reason: "stop" } },
    ]);
  });

  it("keeps a root that ends the received text as complete recovery when the stream stops", async () => {
    // A comma touching `}` would make the root the first element of a list, so it waits for one more
    // character. Stopped first, it is still whole: recovered, complete, never lost or cut.
    const controller = new AbortController();
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      yield '{"a":1}';
      controller.abort("stop");
      yield ',{"b":2}';
    };
    expect(await drain(parseStream(source(), { signal: controller.signal }))).toEqual([
      {
        ok: false,
        failure: {
          kind: "aborted",
          reason: "stop",
          recovered: { value: { a: 1 }, complete: true },
        },
      },
    ]);
    expect(await drain(parseStream(['{"a":1}', ',{"b":2}']))).toEqual([
      { ok: true, value: [{ a: 1 }, { b: 2 }], complete: true },
    ]);
  });

  it("delivers no further result of the chunk in hand once the consumer aborts", async () => {
    // One chunk completes three roots; the consumer aborts while holding the first. The other two
    // were already buffered and were still delivered before the abort.
    const controller = new AbortController();
    const items: unknown[] = [];
    for await (const item of parseStream(['{"a":1}\n{"b":2}\n{"c":3}\n'], {
      signal: controller.signal,
    })) {
      items.push(item);
      controller.abort("stop");
    }
    expect(items).toEqual([
      { ok: true, value: { a: 1 }, complete: true },
      { ok: false, failure: { kind: "aborted", reason: "stop" } },
    ]);
  });

  it("interrupts one ready large chunk while scanning an excluded subtree", async () => {
    const controller = new AbortController();
    const large = `{"drop":[${"0,".repeat(40_000)}0],"keep":1}`;
    const parsing = drain(
      parseStream([large], { signal: controller.signal, skip: skip([["drop"]]) }),
    );
    const abort = new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort("stop");
        resolve();
      }, 0);
    });
    const [items] = await Promise.all([parsing, abort]);
    expect(items).toMatchObject([
      {
        ok: false,
        failure: {
          kind: "aborted",
          reason: "stop",
          recovered: { value: {}, complete: false },
        },
      },
    ]);
  });

  it("manufactures no partial value from an aborted stream", async () => {
    // Unclosed input, so the ONLY way `{a:1}` could appear is the end-of-stream close. Aborting must
    // not hand back data invented after the caller said stop — and without the abort it does appear,
    // which is what makes this falsify rather than confirm.
    const controller = new AbortController();
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      yield '{"a":1';
      controller.abort("stop");
    };
    expect(await drain(parseStream(source(), { signal: controller.signal }))).toMatchObject([
      { ok: false, failure: { kind: "aborted", reason: "stop" } },
    ]);
    expect(await parsedValues(parseStream(emit('{"a":1')))).toEqual([{ a: 1 }]);
  });

  it("keeps built recovery on abort without finalizing a pending number", async () => {
    const task = new AbortController();
    async function* source() {
      yield '{"a":1,"b":2';
      task.abort("stop");
    }
    expect(await drain(parseStream(source(), { signal: task.signal }))).toEqual([
      {
        ok: false,
        failure: {
          kind: "aborted",
          reason: "stop",
          recovered: {
            value: { a: 1 },
            complete: false,
            cut: { path: ["b"], kind: "missing", text: "2" },
          },
        },
      },
    ]);
  });

  it("checks cancellation between selected values released by EOF repair", async () => {
    const task = new AbortController();
    const items = [];
    for await (const item of parseStream(['{"items":[{"a":1},{"a":2},{"a":3}]'], {
      select: select([["items", ANY]]),
      signal: task.signal,
      summary: true,
      diagnostics,
    })) {
      items.push(item);
      if (!("kind" in item) && item.ok) task.abort("stop");
    }
    expect(items).toMatchObject([
      { ok: true, value: { value: { a: 1 } } },
      {
        ok: false,
        failure: {
          kind: "aborted",
          reason: "stop",
          recovered: {
            value: [
              { value: { a: 2 }, path: ["items", 1] },
              { value: { a: 3 }, path: ["items", 2] },
            ],
            complete: false,
          },
        },
        diagnostics: { counts: { repairs: 1 }, scope: "selected" },
      },
      { kind: "summary", complete: false },
    ]);
  });

  it("reads nothing at all when already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    let pulled = 0;
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      pulled++;
      yield '{"a":1}';
    };
    expect(await drain(parseStream(source(), { signal: controller.signal }))).toEqual([
      { ok: false, failure: { kind: "aborted", reason: "stop" } },
    ]);
    expect(pulled).toBe(0);
  });

  it("does not pull another chunk after an observed abort", async () => {
    const controller = new AbortController();
    let pulled = 0;
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      for (const chunk of ['{"a":1} ', '{"b":2}']) {
        pulled++;
        yield chunk;
      }
    };
    const iterator = parseStream(source(), { signal: controller.signal });
    const first = await iterator.next();
    expect(first.done === true || !first.value.ok ? undefined : first.value.value).toEqual({
      a: 1,
    });
    controller.abort();
    const stopped = await iterator.next();
    expect(
      stopped.done === false && !stopped.value.ok ? stopped.value.failure.kind : undefined,
    ).toBe("aborted");
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(pulled).toBe(1);
  });
});

/** A source whose own cleanup throws, after handing over everything it had. */
const spiteful = (chunks: readonly string[], cause: unknown): AsyncIterable<string> => ({
  [Symbol.asyncIterator]() {
    let i = 0;
    return {
      async next() {
        return i < chunks.length
          ? { done: false, value: chunks[i++] as string }
          : { done: true, value: undefined };
      },
      async return(): Promise<IteratorResult<string>> {
        throw cause;
      },
    };
  },
});

/** A source that dies inside a value, for the recovery a `source-failed` item must carry. */
const cutMidValue = async function* (text = '{"a":[1,2'): AsyncGenerator<string, void, undefined> {
  yield text;
  throw new Error("cut");
};

describe("transport failures", () => {
  it.each(["iterator", "async iterator", "reader"] as const)(
    "accepts callable chunk sources with a %s protocol",
    async (protocol) => {
      const source = Object.assign(
        () => undefined,
        protocol === "iterator"
          ? {
              *[Symbol.iterator]() {
                yield '{"a":1}';
              },
            }
          : protocol === "async iterator"
            ? {
                async *[Symbol.asyncIterator]() {
                  yield '{"a":1}';
                },
              }
            : {
                getReader: () =>
                  new ReadableStream<string>({
                    start(controller) {
                      controller.enqueue('{"a":1}');
                      controller.close();
                    },
                  }).getReader(),
              },
      );
      expect(await drain(parseStream(source))).toEqual([
        { ok: true, complete: true, value: { a: 1 } },
      ]);
    },
  );
  it("delivers cleanup failure before the requested summary after a parser limit", async () => {
    const cause = new Error("cleanup failed");
    const items = await drain(
      parseStream(spiteful(["```"], cause), {
        maxBuffer: 1,
        summary: true,
      }),
    );
    expect(items).toMatchObject([
      { ok: false, failure: { kind: "limit-reached", resource: "buffer" } },
      { ok: false, failure: { kind: "cleanup-failed", cause } },
      { kind: "summary", complete: false },
    ]);
  });
  it("contains acquisition failures and preserves recovery when a producer returns a bad chunk", async () => {
    const cause = new Error("producer failed");
    const acquiring = {
      [Symbol.iterator](): Iterator<string> {
        throw cause;
      },
    };
    expect(await drain(parseStream(acquiring, { summary: true }))).toMatchObject([
      { ok: false, failure: { kind: "source-failed", cause } },
      { kind: "summary", complete: false, roots: 0 },
    ]);
    let first = true;
    const malformed = {
      [Symbol.iterator]: () => ({
        next: () => {
          const value = first ? '{"a":1,' : 42;
          first = false;
          return { done: false, value };
        },
        return: (): IteratorResult<string> => {
          throw cause;
        },
      }),
    };
    expect(await drain(parseStream(malformed as never, { summary: true }))).toMatchObject([
      {
        ok: false,
        failure: {
          kind: "invalid-source",
          recovered: { value: { a: 1 } },
          cleanupFailure: { kind: "cleanup-failed", cause },
        },
      },
      { kind: "summary", complete: false },
    ]);
  });

  it("preserves the original iterator failure as a typed result", async () => {
    const cause = new Error("source broke");
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      yield '{"a":1}\n';
      throw cause;
    };
    const results = await drain(parseStream(source()));
    expect(results[0]).toEqual({ ok: true, complete: true, value: { a: 1 } });
    expect(results[1]).toEqual({ ok: false, failure: { kind: "source-failed", cause } });
  });

  it("hands back the root left open when the source fails mid-value", async () => {
    // The prefix is real data the source did send; it arrives inside the failure, closed under the
    // recovery policy, never as a success that hides the failure.
    const [item] = await drain(parseStream(cutMidValue()));
    expect(item).toMatchObject({
      ok: false,
      failure: { kind: "source-failed", recovered: { value: { a: [1, 2] } } },
    });
  });

  it("hands back every match of the open root, with the root's cut, under select", async () => {
    // The open root drains as one item per match, and only the first was kept, marked complete.
    // The cut between items in the second text is the root's alone: no match item carries it.
    const options = { select: select([["items", ANY]]) };
    const texts = ['{"items":[{"a":1},{"b":2},{"c":', '{"items":[{"a":1},'];
    const drained = await Promise.all(
      texts.map((text) => drain(parseStream(cutMidValue(text), options))),
    );
    texts.forEach((text, i) => {
      const item = drained[i]?.[0];
      const whole = parse(text, options);
      const recovery = whole.ok && { value: whole.value, complete: whole.complete, cut: whole.cut };
      expect(item?.ok === false && item.failure, text).toMatchObject({
        kind: "source-failed",
        recovered: recovery,
      });
    });
  });

  it("reports an errored web stream's error once, as the source failure", async () => {
    // Cancelling an errored stream rejects with its stored error, which came back a second time
    // as a `cleanupFailure`: nothing failed to clean up.
    const cause = new Error("read failed");
    let pulls = 0;
    const body = new ReadableStream<string>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue('{"a":[1');
        else controller.error(cause);
      },
    });
    expect(await drain(parseStream(body))).toEqual([
      {
        ok: false,
        failure: {
          kind: "source-failed",
          cause,
          recovered: {
            value: { a: [1] },
            complete: false,
            cut: { path: ["a", 0], kind: "number" },
          },
        },
      },
    ]);
  });

  it.each([new Error("will not release"), "cleanup refused", undefined])(
    "reports a cleanup that fails after normal exhaustion as the terminal failure (%s)",
    async (cause) => {
      // The values are real and arrive first; the refusal to be released is the stream's last word.
      expect(await drain(parseStream(spiteful(['{"a":1} {"b":[1'], cause)))).toEqual([
        { ok: true, value: { a: 1 }, complete: true },
        { ok: true, value: { b: [1] }, complete: false, cut: { path: ["b", 0], kind: "number" } },
        { ok: false, failure: { kind: "cleanup-failed", cause } },
      ]);
    },
  );

  it("lets a cleanup failure accompany a source failure, never replace it", async () => {
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<string>> {
          throw new Error("broke");
        },
        async return(): Promise<IteratorResult<string>> {
          throw new Error("and would not release");
        },
      }),
    };
    const [item] = await drain(parseStream(source));
    expect(item).toMatchObject({
      ok: false,
      failure: {
        kind: "source-failed",
        cause: expect.objectContaining({ message: "broke" }) as unknown,
        cleanupFailure: {
          kind: "cleanup-failed",
          cause: expect.objectContaining({ message: "and would not release" }) as unknown,
        },
      },
    });
  });
});

describe("summary through the transport", () => {
  it.each([false, true])(
    "keeps removal failure secondary to source failure or abort %s",
    async (aborted) => {
      const cause = new Error("signal removal refused");
      const primary = new Error("source failed");
      const controller = new AbortController();
      Object.defineProperty(controller.signal, "removeEventListener", {
        configurable: true,
        value(...args: Parameters<AbortSignal["removeEventListener"]>) {
          AbortSignal.prototype.removeEventListener.call(controller.signal, ...args);
          throw cause;
        },
      });
      const stream = parseStream(
        {
          [Symbol.asyncIterator]: () => ({
            async next() {
              if (aborted) controller.abort(primary);
              throw primary;
            },
          }),
        },
        {
          summary: true,
          signal: controller.signal,
        },
      );
      expect(await drain(stream)).toMatchObject([
        {
          ok: false,
          failure: {
            kind: aborted ? "aborted" : "source-failed",
            ...(aborted ? { reason: primary } : { cause: primary }),
            cleanupFailure: { kind: "cleanup-failed", cause },
          },
        },
        { kind: "summary", complete: false },
      ]);
      expect(await stream.close()).toEqual({
        ok: false,
        failure: { kind: "cleanup-failed", cause },
      });
    },
  );
  it("reports caller listener removal failure before the terminal summary", async () => {
    const cause = new Error("signal removal refused");
    const stream = parseStream(['{"a":1} '], {
      summary: true,
      signal: {
        aborted: false,
        removeEventListener() {
          throw cause;
        },
      },
    });
    expect(await drain(stream)).toMatchObject([
      { ok: true, value: { a: 1 } },
      { ok: false, failure: { kind: "cleanup-failed", cause } },
      { kind: "summary", complete: false },
    ]);
    expect(await stream.close()).toEqual({ ok: false, failure: { kind: "cleanup-failed", cause } });
  });
  it("retains the terminal parser cause when the consumer cancels after receiving it", async () => {
    const task = new AbortController();
    const items = [];
    for await (const item of parseStream(["```"], {
      maxBuffer: 1,
      summary: true,
      signal: task.signal,
    })) {
      items.push(item);
      if (!("kind" in item)) task.abort("late");
    }
    expect(items).toMatchObject([
      { ok: false, failure: { kind: "limit-reached", resource: "buffer" } },
      { kind: "summary", complete: false },
    ]);
  });
  const summaryOf = async (items: AsyncIterable<StreamItem<{ summary: true }>>): Promise<unknown> =>
    (await drain(items)).find((item) => "kind" in item);

  it("follows the tail after normal exhaustion", async () => {
    expect(await summaryOf(parseStream(emit('{"a":1} ', "[1,2"), { summary: true }))).toEqual({
      kind: "summary",
      complete: true,
      roots: 2,
      matches: 0,
      unmatched: [],
    });
  });

  it("follows an abort and a failed source, reporting the source as not fully examined", async () => {
    const controller = new AbortController();
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      yield '{"a":1}\n';
      controller.abort();
      yield '{"b":2}';
    };
    expect(
      await drain(parseStream(source(), { signal: controller.signal, summary: true })),
    ).toEqual([
      { ok: true, complete: true, value: { a: 1 } },
      { ok: false, failure: { kind: "aborted", reason: controller.signal.reason as unknown } },
      { kind: "summary", complete: false, roots: 1, matches: 0, unmatched: [] },
    ]);
    const failed = await drain(parseStream(cutMidValue(), { summary: true }));
    expect(failed.at(-1)).toEqual({
      kind: "summary",
      complete: false,
      roots: 1,
      matches: 0,
      unmatched: [],
    });
  });

  it("comes after a cleanup failure, which is the terminal item", async () => {
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }) as IteratorResult<string>,
        async return(): Promise<IteratorResult<string>> {
          throw new Error("no");
        },
      }),
    };
    const items = await drain(parseStream(source, { summary: true }));
    expect(
      items.map((item) => ("kind" in item ? item.kind : item.ok || item.failure.kind)),
    ).toEqual(["no-json-found", "cleanup-failed", "summary"]);
  });
});

describe("a web stream of items needs no adapter", () => {
  it("is ReadableStream.from(parseStream(source)), values and cancellation alike", async () => {
    let cancelled = false;
    const body = new ReadableStream<string>({
      start(c) {
        c.enqueue('{"a":1} ');
        c.enqueue('{"b":2}');
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    // `ReadableStream.from` exists on node 24 and bun 1.4 but not yet in the type library.
    const items = (
      ReadableStream as unknown as { from<T>(it: AsyncIterable<T>): ReadableStream<T> }
    ).from(parseStream(body));
    const reader = items.getReader();
    expect(await reader.read()).toMatchObject({ value: { ok: true, value: { a: 1 } } });
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});

describe("leaving early", () => {
  it("releases a web stream's lock, so the caller can still read their own body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":1} '));
        c.enqueue(new TextEncoder().encode('{"b":2}'));
        c.close();
      },
    });
    for await (const v of parseStream(body)) {
      expect(v.ok ? v.value : undefined).toEqual({ a: 1 });
      break;
    }
    expect(body.locked).toBe(false);
  });

  it("has not read the rest of the source when only the first value is taken", async () => {
    // The laziness a generator signature promises. `pulled` counts chunks the source handed over.
    let pulled = 0;
    const source = async function* (): AsyncGenerator<string, void, undefined> {
      for (const c of ['{"a":1} ', '{"b":2} ', '{"c":3}']) {
        pulled++;
        yield c;
      }
    };
    for await (const v of parseStream(source())) {
      expect(v.ok ? v.value : undefined).toEqual({ a: 1 });
      break;
    }
    expect(pulled).toBe(1);
  });
});

describe("parseStream reuses validated configuration through the same transport", () => {
  it("keeps configured diagnostics attached to their source value", async () => {
    const chunks = ["{'a':1} ", '{"b":2}'];
    const got = await drain(configuredParseStream(chunks, parserOf({ diagnostics })));
    expect(got).toMatchObject([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
    expect(got.map((item) => item.diagnostics.repairs.map((r) => r.kind))).toEqual([
      ["single-quote"],
      [],
    ]);
  });

  it("mints independent state per stream, so one parser serves many sources", async () => {
    // Also why there is no spent-transport misuse to name here: the state belongs to the call, not
    // to the parser, so a second call cannot meet the first one's exhausted scanner. Feeding a spent
    // parser BY HAND is still reachable, and still answers `stream-closed`.
    const parser = parserOf({});
    expect(await parsedValues(configuredParseStream(['{"a":', "1}"], parser))).toEqual([{ a: 1 }]);
    expect(await parsedValues(configuredParseStream(['{"b":', "2}"], parser))).toEqual([{ b: 2 }]);
  });

  it("carries the view on the stream, so rendering partial JSON needs nothing else in hand", async () => {
    const items = configuredParseStream(['{"a":1} ', '{"b":2}'], parserOf({}), {
      view: sharedView,
    } as const);
    for await (const _ of items) break;
    const seen = items.snapshot();
    expect(seen.ok && seen.value?.value).toEqual({ a: 1 });
    await items.close();
  });

  it("throws on a selection a configured parser cannot change, never a silently empty stream", () => {
    // A parser's selection is fixed when it is built, so a stream from it cannot switch to
    // fragments: `select` here is a parse option, refused rather than ignored.
    const parser = parserOf({});
    const fragments = select([["a"]], { fragments: decodedFragments });
    expect(
      configurationCause(() =>
        configuredParseStream(['{"a":1}'], parser, { select: fragments } as never),
      ),
    ).toEqual({ kind: "invalid-options", field: "select", reason: "parse-option-on-stream" });
    expect(
      configurationCause(() =>
        configuredCreateStreamParser(parser, { select: fragments } as never),
      ),
    ).toEqual({ kind: "invalid-options", field: "select", reason: "parse-option-on-stream" });
  });

  it("sends only a real parse option to `initParser`; any other stray key is unknown", () => {
    // `initParser` would refuse a misspelling or `signal` as well, so naming it sends the caller from
    // one refusal to another. `signal` belongs to configured `parseStream`, which takes it.
    const parser = parserOf({});
    const cause = (options: object) =>
      configurationCause(() => configuredCreateStreamParser(parser, options as never));
    expect(cause({ maxDepth: 3 })).toEqual({
      kind: "invalid-options",
      field: "maxDepth",
      reason: "parse-option-on-stream",
    });
    for (const field of ["veiw", "sumary", "signal"])
      expect(cause({ [field]: field === "signal" ? new AbortController().signal : 1 })).toEqual({
        kind: "invalid-options",
        field,
        reason: "unknown",
      });
    expect(
      configurationCause(() =>
        configuredParseStream(['{"a":1}'], parser, { veiw: "shared" } as never),
      ),
    ).toEqual({ kind: "invalid-options", field: "veiw", reason: "unknown" });
  });
});

describe("bounded transport slices preserve source coordinates", () => {
  it("gives ready and yielding sources the same result", async () => {
    const text = `{"drop":[${"0,".repeat(20_000)}0],"keep":"done"}`;
    const options = { skip: skip([["drop"]]) } as const;
    const ready = await drain(parseStream([text], options));
    const yielding = await drain(
      parseStream(emit(text.slice(0, 10_000), text.slice(10_000)), options),
    );
    expect(ready).toMatchObject([{ ok: true, value: { keep: "done" } }]);
    expect(ready).toEqual(yielding);
  });

  it.each([
    ["text", (text: string): string | Uint8Array => text, "utf16"],
    ["bytes", (text: string): string | Uint8Array => new TextEncoder().encode(text), "byte"],
  ] as const)("keeps one logical %s chunk", async (_name, input, unit) => {
    const prefix = `{"value":"${"x".repeat(20_000)}",`;
    const [item] = await drain(parseStream([input(`${prefix}}`)], { diagnostics }));
    expect(item?.diagnostics.repairs[0]).toEqual(
      expect.objectContaining({
        kind: "trailing-comma",
        at: { offset: prefix.length - 1, unit, chunk: 0 },
      }),
    );
  });

  it("keeps a split UTF-8 scalar intact across an internal slice", async () => {
    const prefix = `{"value":"${"x".repeat(16_372)}`;
    const [item] = await drain(
      parseStream([new TextEncoder().encode(`${prefix}é"}`)], { diagnostics }),
    );
    expect(item !== undefined && item.ok ? item.value : undefined).toEqual({
      value: `${"x".repeat(16_372)}é`,
    });
  });
});
