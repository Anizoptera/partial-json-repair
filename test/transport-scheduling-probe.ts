import type Assert from "node:assert/strict";
import type * as Timers from "node:timers";
import type * as Library from "../src/index";

async function verifyEofCancellation(
  library: typeof Library,
  assert: typeof Assert,
  timers: typeof Timers,
): Promise<void> {
  // The missing root closer holds final selected matches until EOF; their drain must service a
  // queued host cancellation and preserve every unread match exactly once.
  const count = 2000;
  const { parseStream, select } = library;
  const input =
    '{"items":[' + Array.from({ length: count }, (_, id) => JSON.stringify({ id })).join(",") + "]";
  const task = new AbortController();
  let timer: ReturnType<typeof timers.setImmediate> | undefined;
  let delivered = 0;
  let terminal: Library.StreamFailure | undefined;
  const stream = parseStream([input], {
    select: select([["items", library.ANY]]),
    signal: task.signal,
  });
  try {
    for await (const item of stream) {
      if (item.ok) {
        assert.deepEqual(item.value.value, { id: delivered++ });
        timer ??= timers.setImmediate(() => {
          task.abort("host-stop");
        });
      } else terminal = item.failure;
    }
    assert.ok(terminal?.kind === "aborted", "EOF delivery starved host cancellation");
    assert.equal(terminal.reason, "host-stop");
    assert.ok(delivered < count);
    const unread = terminal.recovered?.value;
    assert.ok(Array.isArray(unread), "EOF cancellation lost unread matches");
    const pending: readonly unknown[] = unread;
    assert.equal(pending.length + delivered, count);
    pending.forEach((match, index) => {
      assert.ok(typeof match === "object" && match !== null && "value" in match);
      assert.deepEqual(match.value, { id: delivered + index });
    });
  } finally {
    timers.clearImmediate(timer);
    await stream.close();
  }
}

async function verifyBorrowedChunks(
  { parseStream }: typeof Library,
  assert: typeof Assert,
): Promise<void> {
  // Pause after a completed root, while the resumed decoder still borrows the caller's storage.
  const cases = ["unchanged", "shrink", "grow", "detach"];
  const completed = await Promise.allSettled(
    cases.map(async (resize) => {
      const text = new TextEncoder().encode(
        JSON.stringify({ ready: true }) + " " + JSON.stringify({ pending: "x".repeat(3000) }),
      );
      const buffer = new ArrayBuffer(text.length, { maxByteLength: text.length + 1 });
      const bytes = new Uint8Array(buffer);
      bytes.set(text);
      const stream = parseStream([bytes]);
      try {
        const first = await stream.next();
        assert.ok(first.done !== true && first.value.ok, "first borrowed-chunk delivery failed");
        assert.deepEqual(first.value.value, { ready: true });
        if (resize === "shrink") buffer.resize(0);
        if (resize === "grow") buffer.resize(text.length + 1);
        if (resize === "detach") structuredClone(buffer, { transfer: [buffer] });
        const second = await stream.next();
        assert.ok(second.done !== true, "missing borrowed-chunk outcome");
        if (resize === "unchanged") {
          assert.ok(second.value.ok);
          assert.deepEqual(second.value.value, { pending: "x".repeat(3000) });
        } else {
          assert.ok(!second.value.ok && second.value.failure.kind === "invalid-source");
          const recovered = second.value.failure.recovered;
          assert.ok(recovered && !recovered.complete);
          assert.equal(recovered.cut.kind, "string");
          assert.deepEqual(recovered.cut.path, ["pending"]);
          const value = recovered.value;
          assert.ok(
            typeof value === "object" &&
              value !== null &&
              "pending" in value &&
              typeof value.pending === "string",
          );
          assert.ok(value.pending.length > 0);
          assert.equal(value.pending, "x".repeat(value.pending.length));
        }
      } finally {
        await stream.close();
      }
    }),
  );
  const failures = completed.flatMap((result, index) =>
    result.status === "rejected"
      ? [new Error(`Borrowed chunk ${cases[index]} failed`, { cause: result.reason })]
      : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Borrowed chunk probes failed");
}

async function verifyReadySources(
  { parseStream }: typeof Library,
  assert: typeof Assert,
  timers: typeof Timers,
): Promise<void> {
  // Always-ready producers can starve task callbacks through microtasks, even without heavy input.
  const earlyStop = new AbortController();
  const earlyTimer = timers.setImmediate(() => {
    earlyStop.abort("stop");
  });
  const early = parseStream(['{"ready":true}' + " ".repeat(1024)], { signal: earlyStop.signal });
  try {
    const first = await early.next();
    assert.ok(
      first.done !== true && first.value.ok,
      "completed first value was delayed past cancellation",
    );
    assert.deepEqual(first.value.value, { ready: true });
  } finally {
    timers.clearImmediate(earlyTimer);
    await early.close();
  }
  const cases = ["", '{"a":1}'].flatMap((chunk) =>
    [false, true].map((asyncSource) => ({ chunk, asyncSource })),
  );
  const completed = await Promise.allSettled(
    cases.map(async ({ chunk, asyncSource }) => {
      let controlValues = 0;
      for await (const item of parseStream([chunk, chunk])) if (item.ok) controlValues++;
      assert.equal(controlValues, chunk === "" ? 0 : 2, "valid ready-source control failed");
      const task = new AbortController();
      const timer = timers.setTimeout(() => {
        task.abort("host-stop");
      }, 0);
      let reads = 0;
      function* ready() {
        while (reads++ < 20000) yield chunk;
      }
      async function* asynchronous() {
        yield* ready();
      }
      let terminal: Library.StreamItem | undefined;
      const stream = parseStream(asyncSource ? asynchronous() : ready(), { signal: task.signal });
      try {
        for await (const item of stream) terminal = item;
        assert.ok(
          reads < 20000,
          `ready source starved cancellation: async=${asyncSource}, empty=${chunk === ""}`,
        );
        assert.ok(
          terminal && "ok" in terminal && !terminal.ok && terminal.failure.kind === "aborted",
        );
        assert.equal(terminal.failure.reason, "host-stop");
      } finally {
        timers.clearTimeout(timer);
        await stream.close();
      }
    }),
  );
  const failures = completed.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          new Error(
            `Ready source async=${cases[index]?.asyncSource}, empty=${cases[index]?.chunk === ""} failed`,
            { cause: result.reason },
          ),
        ]
      : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Ready source probes failed");
}

async function verifyStalledCleanup(
  { parseStream }: typeof Library,
  assert: typeof Assert,
): Promise<void> {
  // A generator queues return behind a pending finally; cancellation must not wait for it.
  const cases = [false, true];
  const completed = await Promise.allSettled(
    cases.map(async (stalled) => {
      const task = new AbortController();
      let cleaning = false;
      const source = async function* () {
        try {
          yield '{"a":1} {"b":2}';
        } finally {
          cleaning = true;
          if (stalled) await new Promise<never>(() => {});
        }
      };
      const stream = parseStream(source(), { signal: task.signal, summary: true });
      try {
        const tags = [];
        for await (const item of stream) {
          tags.push("kind" in item ? item.kind : item.ok ? "value" : item.failure.kind);
          if (!("kind" in item)) {
            if (item.ok) {
              assert.deepEqual(item.value, { a: 1 });
              task.abort("stop");
            } else {
              assert.equal(item.failure.kind, "aborted");
              if (item.failure.kind === "aborted") assert.equal(item.failure.reason, "stop");
            }
          }
        }
        assert.deepEqual(tags, ["value", "aborted", "summary"]);
        assert.equal(cleaning, true);
      } finally {
        // Abandon only the wait on caller-owned cleanup, which deliberately never resolves.
        await stream.close({ signal: AbortSignal.abort() });
      }
    }),
  );
  const failures = completed.flatMap((result, index) =>
    result.status === "rejected"
      ? [new Error(`Stalled cleanup=${cases[index]} failed`, { cause: result.reason })]
      : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Producer cleanup probes failed");
}

async function verifyMalformedProducers(
  { parseStream }: typeof Library,
  assert: typeof Assert,
): Promise<void> {
  // A valid source controls reach; malformed results must terminate instead of spinning forever.
  const control = [];
  for await (const item of parseStream(['{"a":1}'], { summary: true }))
    control.push("kind" in item ? item.kind : item.ok ? "value" : item.failure.kind);
  assert.deepEqual(control, ["value", "summary"]);
  const cases = [{}, undefined, 5, { done: false, value: 123 }];
  const completed = await Promise.allSettled(
    cases.map(async (result) => {
      const source = { [Symbol.iterator]: () => ({ next: () => result }) };
      const stream = parseStream(source as never, { summary: true });
      try {
        const tags = [];
        for await (const item of stream)
          tags.push("kind" in item ? item.kind : item.ok ? "value" : item.failure.kind);
        assert.deepEqual(tags, ["invalid-source", "summary"]);
      } finally {
        await stream.close();
      }
    }),
  );
  const failures = completed.flatMap((result, index) =>
    result.status === "rejected"
      ? [new Error(`Malformed producer result ${index} failed`, { cause: result.reason })]
      : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Malformed producer probes failed");
}

export function transportSchedulingProbe(module: string): string {
  // The subprocess owns real scheduling and borrowed storage; its parent runner adds no evidence.
  // Explicit arguments keep serialized functions independent of their original module bindings.
  return [
    `import * as library from ${JSON.stringify(module)};`,
    'import assert from "node:assert/strict";',
    'import * as timers from "node:timers";',
    `await (${verifyEofCancellation.toString()})(library, assert, timers);`,
    `await (${verifyBorrowedChunks.toString()})(library, assert);`,
    `await (${verifyReadySources.toString()})(library, assert, timers);`,
    `await (${verifyStalledCleanup.toString()})(library, assert);`,
    `await (${verifyMalformedProducers.toString()})(library, assert);`,
  ].join("\n");
}
