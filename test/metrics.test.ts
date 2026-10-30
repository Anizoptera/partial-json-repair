// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ANY,
  createMetrics,
  createStreamParser,
  diagnostics,
  findJsonSpan,
  parse,
  parseMany,
  parseStream,
  repair,
  select,
} from "../src/index";
import { configurationCause } from "./configuration-error";

const metrics = (options: Parameters<typeof createMetrics>[0] = {}) => createMetrics(options);

/** Two roots, the second split across the chunk boundary. */
async function* chunks(): AsyncGenerator<string> {
  yield '{"a":1,} {"b"';
  yield ":2}";
}

describe("opt-in metrics", () => {
  it("counts outcomes and repair kinds, then returns detached snapshots", () => {
    const measured = metrics({ onDangerousKey: "drop" });
    expect(parse("{safe:1,__proto__:2}", measured).ok).toBe(true);
    expect(parse("plain prose", measured).ok).toBe(false);

    const first = measured.read();
    expect(first.parseAttempts).toBe(2);
    expect(first.parseSuccesses).toBe(1);
    expect(first.parseFailures).toBe(1);
    expect(first.repairs["dangerous-key"]).toBe(1);
    expect(first.repairs["unquoted-key"]).toBe(1);
    expect(first.security.dangerousKeysBlocked).toBe(1);
    expect(Object.entries(first.security.blockedKeys)).toEqual([["__proto__", 1]]);

    // `reject` blocks the key by refusing the document: monitoring must see it under the strictest
    // policy too, once whole and once from a stream.
    const strict = metrics({ onDangerousKey: "reject" });
    expect(parse('{"constructor":1}', strict).ok).toBe(false);
    for (const _ of createStreamParser(strict).feed('{"__proto__":1}\n'));
    const { security } = strict.read();
    expect(Object.entries(security.blockedKeys)).toEqual([
      ["constructor", 1],
      ["__proto__", 1],
    ]);
    expect(security.dangerousKeysBlocked).toBe(2);

    (first.security.blockedKeys as Record<string, number>)["mutated-copy"] = 1;
    (first.repairs as Record<string, number>)["dangerous-key"] = 99;
    expect(measured.read().repairs["dangerous-key"]).toBe(1);
    expect(Object.entries(measured.read().security.blockedKeys)).toEqual([["__proto__", 1]]);
    measured.reset();
    expect(measured.read()).toMatchObject({
      parseAttempts: 0,
      parseSuccesses: 0,
      parseFailures: 0,
      repairs: { "dangerous-key": 0, "unquoted-key": 0 },
    });
  });

  it("measures compaction and refusal at the streaming buffer owner", () => {
    const measured = metrics({ maxBuffer: 1 });
    const completed = createStreamParser(measured);

    expect([...completed.feed('{"a":1}')]).toHaveLength(1);
    const refused = createStreamParser(measured);
    expect([...refused.feed("```")]).toMatchObject([
      { ok: false, failure: { kind: "limit-reached", resource: "buffer", limit: 1 } },
    ]);
    expect(measured.read()).toMatchObject({
      memory: { bufferCleanups: 1, bufferOverflows: 1, maxBufferSize: 7 },
    });
  });

  it("counts blocked keys per key, so the record cannot grow with the input", () => {
    // One entry per configured dangerous key, however many times the input repeats it. A list of
    // every occurrence would let an attacker size the caller's metrics memory.
    const measured = metrics({ onDangerousKey: "drop" });
    // Below `maxEntries`: repair counts come from the stored report, so this measures the bound
    // on `blockedKeys`, not the report cap.
    const text = `[${Array.from({ length: 900 }, () => '{"__proto__":1}').join(",")}]`;
    expect(parse(text, measured).ok).toBe(true);
    const { security } = measured.read();
    expect(security.dangerousKeysBlocked).toBe(900);
    expect(Object.keys(security.blockedKeys)).toEqual(["__proto__"]);
    // The counter is DATA: a plain object would send `__proto__` to the prototype setter.
    expect(Object.getPrototypeOf(security.blockedKeys)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(security.blockedKeys, "__proto__")?.value).toBe(900);
  });

  describe("past the report cap", () => {
    // `maxEntries` (default 1000) bounds the STORED report, never the counts. These inputs carry
    // more repairs of EACH kind than the cap, so a count read from the stored entries stops short.
    const N = 1500;
    const members = Array.from({ length: N }, () => '{"__proto__":1,"constructor":2,"ok":3,}');
    const text = `[${members.join(",")}]`;
    const expectExact = (read: ReturnType<ReturnType<typeof metrics>["read"]>): void => {
      expect(read.repairs["dangerous-key"]).toBe(2 * N);
      expect(read.repairs["trailing-comma"]).toBe(N);
      expect(read.security.dangerousKeysBlocked).toBe(2 * N);
      expect(Object.getOwnPropertyDescriptor(read.security.blockedKeys, "__proto__")?.value).toBe(
        N,
      );
      expect(read.security.blockedKeys["constructor"]).toBe(N);
    };

    it("counts every repair kind and blocked key exactly", () => {
      const measured = metrics({ onDangerousKey: "drop" });
      expect(parse(text, measured).ok).toBe(true);
      expectExact(measured.read());
    });

    it("counts the same when chunk boundaries make the scanner retract and re-read", () => {
      // Seven-unit chunks split keys, numbers and commas, and every split token is rewound and read
      // again; a retracted repair must leave the count as well as the report.
      const measured = metrics({ onDangerousKey: "drop" });
      const stream = createStreamParser(measured);
      for (let i = 0; i < text.length; i += 7) for (const _ of stream.feed(text.slice(i, i + 7)));
      for (const _ of stream.end());
      expectExact(measured.read());
    });

    it("counts every root of a long stream, not only the first", () => {
      const measured = metrics({ onDangerousKey: "drop" });
      const stream = createStreamParser(measured);
      const root = '{"__proto__":1,"ok":1}';
      const roots = 3000;
      for (const _ of stream.feed(Array.from({ length: roots }, () => root).join("\n")));
      for (const _ of stream.end());
      const read = measured.read();
      expect(read.parseSuccesses).toBe(roots);
      expect(read.repairs["dangerous-key"]).toBe(roots);
      expect(read.security.blockedKeys["__proto__"]).toBe(roots);
    });

    it("counts each delivered occurrence's share once", () => {
      const measured = metrics({
        onDangerousKey: "drop",
        select: select([["items", ANY]], { occurrences: true }),
      });
      const items = Array.from({ length: 1500 }, () => '{"__proto__":1,"x":1}').join(",");
      const stream = createStreamParser(measured);
      for (const _ of stream.feed(`{"items":[${items}]}`));
      for (const _ of stream.end());
      expect(measured.read().security.dangerousKeysBlocked).toBe(1500);
    });
  });

  it("counts every item parseStream delivers, failures included", async () => {
    const measured = metrics();
    const items = [];
    for await (const item of parseStream(chunks(), measured)) items.push(item);
    expect(items.map((item) => ("ok" in item ? item.ok : undefined))).toEqual([true, true]);
    const read = measured.read();
    expect(read).toMatchObject({ parseAttempts: 2, parseSuccesses: 2, parseFailures: 0 });
    expect(read.repairs["trailing-comma"]).toBe(1);

    const refused = metrics({ maxBuffer: 1 });
    const failed = [];
    for await (const item of parseStream(["```"], refused)) failed.push(item);
    expect(failed).toMatchObject([
      { ok: false, failure: { kind: "limit-reached", resource: "buffer", limit: 1 } },
    ]);
    expect(refused.read()).toMatchObject({ parseFailures: 1, memory: { bufferOverflows: 1 } });
  });

  it.each(["return", "throw", "close"] as const)(
    "records duration after early iterator %s",
    async (exit) => {
      const measured = metrics();
      // Elapsed time is the contract; a numeric field alone also accepts a constant zero.
      const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
      let clock = 10;
      try {
        performance.now = () => clock;
        const stream = parseStream(chunks(), measured);
        try {
          expect(await stream.next()).toMatchObject({
            done: false,
            value: { ok: true, value: { a: 1 } },
          });
          clock = 25;
          const cause = new Error("consumer stopped");
          if (stream.return === undefined || stream.throw === undefined)
            throw new Error("Measured transport must provide both iterator exits");
          if (exit === "return") await stream.return();
          else if (exit === "close") await stream.close();
          else await expect(stream.throw(cause)).rejects.toBe(cause);
          expect(measured.read().parseDuration).toBe(15);
          expect(await stream.next()).toMatchObject({ done: true });
        } finally {
          await stream.close();
        }
      } finally {
        if (originalNow === undefined) Reflect.deleteProperty(performance, "now");
        else Object.defineProperty(performance, "now", originalNow);
      }
    },
  );

  it("counts every whole-input verb given the scope, and parseMany only as items are read", () => {
    const measured = metrics();
    const many = parseMany("{a:1} {b:2} {c:3}", measured);
    many.next();
    many.return?.();
    repair("{d:4", measured);
    findJsonSpan("prose {e:5} prose", measured);
    const { parseAttempts, repairs } = measured.read();
    // Two parseMany items stay unread, so three attempts, and three unquoted keys: a, d and e.
    expect(parseAttempts).toBe(3);
    expect(repairs["unquoted-key"]).toBe(3);
  });

  it("read-and-reset returns the completed interval before clearing it", () => {
    const measured = metrics();
    parse("null", measured);
    expect(measured.read(true).parseAttempts).toBe(1);
    expect(measured.read().parseAttempts).toBe(0);
  });

  it("starts a new interval at what an open stream still retains", () => {
    const measured = metrics();
    // Paused after its first item, the chunk is still in the window: nothing compacts mid-chunk.
    const items = createStreamParser(measured).feed('{"a":1}\n{"b":2}\n');
    items.next();
    measured.reset();
    expect(measured.read().memory).toMatchObject({ bufferCleanups: 0, maxBufferSize: 16 });
  });

  it.each(["", ' {"b":2}'])("counts the buffer restored by ambiguous quote recovery %s", (tail) => {
    const body = "x".repeat(4096);
    const source = `{"a":"v',${body}}${tail}`;
    // Replay retains raw input outside the window; permit it so this case measures restoration.
    const measured = metrics({ maxBuffer: source.length, maxRetained: 65536 });
    const stream = createStreamParser(measured);
    const values = [];
    for (let at = 0; at < source.length; at += 16) {
      for (const item of stream.feed(source.slice(at, at + 16))) {
        if ("ok" in item) {
          expect(item.ok).toBe(true);
          expect(measured.read().memory.maxBufferSize).toBeGreaterThanOrEqual(body.length + 2);
          if (item.ok) values.push(item.value);
        }
      }
    }
    for (const item of stream.end()) {
      if ("ok" in item) {
        expect(item.ok).toBe(true);
        if (item.ok) values.push(item.value);
      }
    }
    expect(values).toEqual(tail === "" ? [{ a: "v" }] : [{ a: "v" }, { b: 2 }]);
    // Replay restores the comma, body and closer after their source chunks have been released.
    if (tail === "") expect(measured.read().memory.maxBufferSize).toBe(body.length + 2);
  });

  it("refuses options it would otherwise drop: a non-object, or a report setting it overrides", () => {
    // The spread inside once turned `null` into no options and replaced a caller's `diagnostics`.
    expect(configurationCause(() => createMetrics(null as never))).toMatchObject({
      field: "options",
      reason: "object",
    });
    const capped = { diagnostics: diagnostics({ maxEntries: 1 }) } as never;
    expect(configurationCause(() => createMetrics(capped))).toMatchObject({
      field: "diagnostics",
      reason: "metrics-report",
    });
  });
});
