// SPDX-License-Identifier: Apache-2.0

import { decodedFragments } from "../src/index";

import { describe, expect, it } from "vitest";

import { createStreamParser, diagnostics, parseStream, select } from "../src/index";

// Bun's Node-compatible counter can miss retained storage; use the engine counter after collection.
const heapUsed: () => number =
  typeof Bun === "undefined"
    ? () => process.memoryUsage().heapUsed
    : (await import(/* @vite-ignore */ "bun:jsc")).heapSize;

/** A full collection on either runner; vitest gets `--expose-gc` from `vitest.config.ts`. */
const collect = (): void => {
  const host = globalThis as { Bun?: { gc(force: boolean): void }; gc?: () => void };
  if (host.Bun) host.Bun.gc(true);
  else if (host.gc) host.gc();
  else throw new Error("no forced GC: run vitest with --expose-gc");
};

const stoppedQuoteOwner = (
  width: number,
  retain: boolean,
  closed: boolean,
  paused: boolean,
  summary: boolean,
) => {
  const input = '{"a":"body\',' + "x".repeat(width);
  const parser = createStreamParser({
    select: select([["a"]], { fragments: decodedFragments }),
    maxBuffer: 128,
    maxRetained: 16,
    summary,
  });
  let failed = false;
  const output = parser.feed(input);
  // Pausing uses next(), not a for-of break, which would close the parser and hide retention.
  for (let next = output.next(); next.done !== true; next = output.next()) {
    const item = next.value;
    if ("ok" in item && !item.ok) {
      expect(item.failure).toMatchObject({
        kind: "limit-reached",
        resource: "retained",
        limit: 16,
      });
      failed = true;
      if (paused) break;
    }
  }
  expect(failed).toBe(true);
  if (closed) parser.close();
  return {
    parser,
    input: retain ? input : undefined,
  };
};

const collectedHeap = (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    setImmediate(() => {
      // Reject inside the host callback so collection failure still reaches fixture cleanup.
      try {
        collect();
        resolve(heapUsed());
      } catch (error) {
        reject(new Error("Cannot measure collected heap", { cause: error }));
      }
    });
  });

const heldStoppedQuotes = async (
  width: number,
  retain: boolean,
  closed = false,
  paused = false,
  summary = false,
): Promise<{ held: number; released: number }> => {
  // Release prior cohorts before allocating the next input-sized control.
  await collectedHeap();
  // The collector never owns input text; only stopped parsers and the explicit control do.
  const owners = Array.from({ length: 8 }, () =>
    stoppedQuoteOwner(width, retain, closed, paused, summary),
  );
  let held: number;
  try {
    held = await collectedHeap();
  } finally {
    for (const owner of owners) {
      expect(owner.input !== undefined).toBe(retain);
      expect(owner.parser.close()).toEqual({ ok: true, value: undefined });
      owner.input = undefined;
    }
  }
  const released = await collectedHeap();
  // Read the same handles after collection; dead owners cannot prove closed-parser release.
  for (const owner of owners) {
    expect(owner.parser.close()).toEqual({ ok: true, value: undefined });
  }
  return { held, released };
};

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "releases quote-replay source while stopped fragment parsers remain reachable (paused: %s, summary: %s)",
  async (paused, summary) => {
    // The subject is measured right after its baseline and the retained control last: heap growth
    // the 8 MB control leaves behind (allocator pages, compiled code, or another file's garbage in a
    // shared parallel worker) landed between baseline and subject and failed the 1 MB bound by 0.5 MB.
    const small = await heldStoppedQuotes(100, false, false, paused, summary);
    const stopped = await heldStoppedQuotes(1048576, false, false, paused, summary);
    // Eight owners each retaining its 1 MB source would hold about 8 MB; a shared parallel worker
    // still moved this reading by 1.1 MB with no retention, so the bound sits between the two, at
    // the control's own threshold.
    // A delta alone misses source retained both before and after close.
    expect(stopped.held - small.held).toBeLessThan(3000000);
    expect(stopped.released - small.released).toBeLessThan(3000000);
    expect(stopped.held - stopped.released).toBeLessThan(3000000);
    const retained = await heldStoppedQuotes(1048576, true, true, paused, summary);
    // The control compares held readings: JavaScriptCore scans stacks conservatively, so a stale
    // stack slot can keep the inputs past release and shrink a held-minus-released control below
    // the bound under a parallel run, while it can only add to a held reading.
    expect(retained.held - stopped.held).toBeGreaterThan(3000000);
  },
);

// Keep producer payloads outside the collector's frame; only stream ownership is under test.
const finishedSourceOwner = (width: number, retain: boolean) => {
  const producer = {
    // eslint-disable-next-line unicorn/no-new-array -- Fixed backing storage exposes source retention.
    payload: new Array<number>(width).fill(17),
    next: (): IteratorResult<string, undefined> => ({ done: true, value: undefined }),
    return: (): IteratorResult<string, undefined> => ({ done: true, value: undefined }),
    [Symbol.iterator]() {
      return this;
    },
  };
  const stream = parseStream(producer);
  return { stream, producer: retain ? producer : undefined };
};

const finishSourceOwner = async (owner: ReturnType<typeof finishedSourceOwner>) => {
  for await (const item of owner.stream) expect(item.ok).toBe(false);
  expect(await owner.stream.close()).toEqual({ ok: true, value: undefined });
  return owner;
};

const heldFinishedSources = async (width: number, retain: boolean): Promise<number> => {
  const owners = await Promise.all(
    Array.from({ length: 10 }, () => finishSourceOwner(finishedSourceOwner(width / 10, retain))),
  );
  const held = await collectedHeap();
  await Promise.all(
    owners.map(async (owner) => {
      expect(await owner.stream.close()).toEqual({ ok: true, value: undefined });
      expect(owner.producer === undefined).toBe(!retain);
      owner.producer = undefined;
    }),
  );
  return held;
};

it("releases acquired producers while finished streams remain reachable", async () => {
  await heldFinishedSources(100, false);
  const base = await heldFinishedSources(100, false);
  expect((await heldFinishedSources(500_000, true)) - base).toBeGreaterThan(3_000_000);
  expect((await heldFinishedSources(500_000, false)) - base).toBeLessThan(1_000_000);
});

// A failed acquisition must release its source before the caller resumes terminal iteration.
const failedSourceOwner = (width: number, retain: boolean) => {
  const cause = new Error("source acquisition failed");
  const producer = {
    // eslint-disable-next-line unicorn/no-new-array -- Same backing storage as the retained control.
    payload: new Array<number>(width).fill(17),
    [Symbol.iterator](): Iterator<string> {
      throw cause;
    },
  };
  return { stream: parseStream(producer), producer: retain ? producer : undefined, cause };
};

const heldFailedSources = async (width: number, retain: boolean): Promise<number> => {
  const owners = Array.from({ length: 10 }, () => failedSourceOwner(width / 10, retain));
  await Promise.all(
    owners.map(async (owner) => {
      expect(await owner.stream.next()).toMatchObject({
        done: false,
        value: { ok: false, failure: { kind: "source-failed", cause: owner.cause } },
      });
    }),
  );
  const memory = await collectedHeap();
  await Promise.all(
    owners.map(async (owner) => {
      expect(owner.producer !== undefined).toBe(retain);
      owner.producer = undefined;
      expect(await owner.stream.close()).toEqual({ ok: true, value: undefined });
    }),
  );
  return memory;
};

it("releases failed acquisitions before terminal iteration resumes", async () => {
  await heldFailedSources(100, false);
  const base = await heldFailedSources(100, false);
  expect((await heldFailedSources(500_000, true)) - base).toBeGreaterThan(3_000_000);
  expect((await heldFailedSources(500_000, false)) - base).toBeLessThan(1_000_000);
});

// Keep controller and reason out of the async fixture's suspended frame.
const signalOwner = (width: number, retain: boolean, already: boolean) => {
  const controller = new AbortController();
  // eslint-disable-next-line unicorn/no-new-array -- A length-sized backing store makes signal retention observable.
  const reason = { payload: new Array<number>(width).fill(17) };
  if (already) controller.abort(reason);
  const stream = parseStream([], { signal: controller.signal });
  return {
    stream,
    signal: retain ? controller.signal : undefined,
    abort: already
      ? undefined
      : () => {
          controller.abort(reason);
        },
  };
};

// The delivered failure is consumer-owned; never keep it in the owner fixture's await slot.
const exhaustSignal = async (
  stream: ReturnType<typeof signalOwner>["stream"],
  already: boolean,
): Promise<void> => {
  const first = await stream.next();
  expect(first.done).toBe(false);
  if (first.done === false) {
    expect(first.value.ok).toBe(false);
    expect(first.value.ok ? undefined : first.value.failure.kind).toBe(
      already ? "aborted" : "no-json-found",
    );
  }
  expect(await stream.next()).toEqual({ done: true, value: undefined });
};

const closedSignalOwner = async (
  width: number,
  exhausted: boolean,
  retain: boolean,
  already: boolean,
) => {
  const owner = signalOwner(width, retain, already);
  const { stream } = owner;
  if (exhausted) await exhaustSignal(stream, already);
  else expect(await stream.close()).toEqual({ ok: true, value: undefined });
  // A later abort belongs to the caller; a finished stream must not keep its reason alive.
  owner.abort?.();
  owner.abort = undefined;
  return owner;
};

const heldStreamSignal = async (
  width: number,
  exhausted: boolean,
  retain: boolean,
  already: boolean,
) => {
  // Keep total payload fixed: retaining one reason per owner exceeds the bound,
  // while one payload remaining in the collector's active scopes does not.
  const owners = await Promise.all(
    Array.from({ length: 10 }, () => closedSignalOwner(width / 10, exhausted, retain, already)),
  );
  const held = await collectedHeap();
  // Keep every owner reachable through collection, including the same-shape positive control.
  await Promise.all(
    owners.map(async (owner) => {
      expect(await owner.stream.close()).toEqual({ ok: true, value: undefined });
      expect(owner.signal?.aborted).toBe(retain ? true : undefined);
      // The deliberately retained control must not contribute to the next heap measurement.
      owner.signal = undefined;
    }),
  );
  return held;
};

for (const [exhausted, already] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  it(`releases stream signals after termination (exhausted=${exhausted}, already aborted=${already})`, async () => {
    await heldStreamSignal(100, exhausted, false, already);
    const base = await heldStreamSignal(100, exhausted, false, already);
    expect((await heldStreamSignal(500_000, exhausted, true, already)) - base).toBeGreaterThan(
      3_000_000,
    );
    expect((await heldStreamSignal(500_000, exhausted, false, already)) - base).toBeLessThan(
      1_000_000,
    );
  });
}

// A separate call drops the controller, reason and failed result before measuring the stream owner.
const abandonClose = async (
  stream: ReturnType<typeof parseStream>,
  width: number,
  already: boolean,
  retain: boolean,
): Promise<AbortSignal | undefined> => {
  const controller = new AbortController();
  // eslint-disable-next-line unicorn/no-new-array -- The payload needs `width` elements, without per-element callbacks.
  const reason = { payload: new Array<number>(width).fill(17) };
  if (already) controller.abort(reason);
  const waiting = stream.close({ signal: controller.signal });
  if (!already) controller.abort(reason);
  const result = await waiting;
  // Assertion diagnostics must not themselves retain the payload being measured.
  expect(result.ok).toBe(false);
  expect(!result.ok && result.failure.kind === "aborted" && result.failure.reason === reason).toBe(
    true,
  );
  return retain ? controller.signal : undefined;
};

const closeWaitOwner = async (width: number, already: boolean, retain: boolean) => {
  const cleanup = Promise.withResolvers<IteratorResult<string, undefined>>();
  const stream = parseStream({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: '{"a":1}' }),
      return: () => cleanup.promise,
    }),
  });
  try {
    expect(await stream.next()).toMatchObject({ value: { ok: true } });
    const controls = await Promise.all(
      Array.from({ length: 10 }, () => abandonClose(stream, width / 10, already, retain)),
    );
    return { stream, cleanup, controls };
  } catch (error) {
    cleanup.resolve({ done: true, value: undefined });
    await stream.close();
    throw error;
  }
};

const heldCloseReasons = async (
  width: number,
  already: boolean,
  retain = false,
): Promise<number> => {
  const owner = await closeWaitOwner(width, already, retain);
  try {
    // Measure after fixture construction returns; its active scope is not parser-owned storage.
    return await collectedHeap();
  } finally {
    const controlled = owner.controls.every((signal) =>
      retain ? signal?.aborted === true : signal === undefined,
    );
    // Release the retained control before a later baseline can collect this completed fixture's frame.
    owner.controls.length = 0;
    owner.cleanup.resolve({ done: true, value: undefined });
    expect(await owner.stream.close()).toEqual({ ok: true, value: undefined });
    expect(controlled).toBe(true);
  }
};

it.each([false, true])("releases abandoned close reasons (already aborted=%s)", async (already) => {
  // Fixed total payload and a retained control distinguish population ownership from collector residue.
  await heldCloseReasons(100, already);
  const retained = await heldCloseReasons(500_000, already, true);
  const base = await heldCloseReasons(100, already);
  expect(retained - base).toBeGreaterThan(3_000_000);
  expect((await heldCloseReasons(500_000, already)) - base).toBeLessThan(1_000_000);
});

/** An endless source of one marked root per read: a bare `1` or `[1]` line is no root at all. */
const source = async function* (): AsyncGenerator<string, void, undefined> {
  for (;;) yield '{"a":1}\n';
};

/**
 * Heap held by a LIVE stream after `roots` roots were fed and every item read. A stream may run
 * forever, so what it holds must follow the roots not yet delivered, never every root it has seen:
 * before roots were released after delivery, 200 000 small roots held 29 MB.
 */
const heldAfter = (roots: number, reported: boolean): number => {
  const stream = createStreamParser({ diagnostics: reported && diagnostics });
  const chunk = "{'a':1,}\n".repeat(1000);
  for (let i = 0; i < roots / 1000; i++) for (const _ of stream.feed(chunk));
  collect();
  const held = heapUsed();
  for (const _ of stream.end());
  return held;
};

describe("a stream holds what it has not delivered, not what it has seen", () => {
  it("releases abandoned trees while closed parsers remain reachable", () => {
    const held = (width: number): number => {
      const streams = Array.from({ length: 4 }, () => createStreamParser());
      const text = `{"items":[${'{"a":1},'.repeat(width)}{"a":2}],"tail":"open`;
      for (const stream of streams) {
        for (const _ of stream.feed(text));
        stream.close();
      }
      collect();
      const memory = heapUsed();
      // Keep the owners live through collection; allocation churn is not the retention question.
      expect(streams.every((stream) => stream.close().ok)).toBe(true);
      return memory;
    };
    held(1000);
    const base = held(1000);
    expect(held(10_000) - base).toBeLessThan(1_000_000);
  });

  // Ten times the roots must not hold measurably more: the leak this guards held ~140 bytes per
  // delivered root with reports off and ~250 with them on, so 45 000 extra roots would add >6 MB.
  for (const reported of [false, true])
    it(`with diagnostics ${reported ? "on" : "off"}`, () => {
      heldAfter(5_000, reported);
      const base = heldAfter(5_000, reported);
      const grown = heldAfter(50_000, reported) - base;
      expect(grown).toBeLessThan(2_000_000);
    });

  /** Heap held by a live `parseStream` after `reads` one-root chunks were read from its source. */
  const heldAfterReads = async (reads: number): Promise<number> => {
    let seen = 0;
    let held = 0;
    for await (const _ of parseStream(source())) {
      if (++seen < reads) continue;
      collect();
      held = heapUsed();
      break;
    }
    return held;
  };

  // The transport's per-read wait once raced a stop promise that never settles, leaving one
  // reaction on it per chunk (~100-340 bytes): 45 000 extra reads would add >4 MB.
  it("through parseStream, per source read", async () => {
    await heldAfterReads(5_000);
    const base = await heldAfterReads(5_000);
    expect((await heldAfterReads(50_000)) - base).toBeLessThan(2_000_000);
  });
});
