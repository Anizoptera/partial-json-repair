// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { createStreamParser, diagnostics, parseStream, select } from "../src/index";

it.each([
  { name: "object member", input: '{"content":"par', value: { content: "par" }, path: ["content"] },
  { name: "array item", input: '{"files":["par', value: { files: ["par"] }, path: ["files", 0] },
  {
    name: "nested member",
    input: '{"files":[{"content":"par',
    value: { files: [{ content: "par" }] },
    path: ["files", 0, "content"],
  },
  {
    name: "duplicate member",
    input: '{"content":"old","content":"par',
    value: { content: "par" },
    path: ["content"],
  },
])(
  "keeps the decoded $name string when cancellation stops input",
  async ({ input, value, path }) => {
    const stop = new AbortController();
    let released = 0;
    async function* source() {
      try {
        yield input;
        // Resuming the source proves its previous chunk drained; no clock or private phase is needed.
        stop.abort("caller-stop");
      } finally {
        released++;
      }
    }
    const stream = parseStream(source(), { signal: stop.signal });
    try {
      const outcomes = [];
      for await (const outcome of stream) outcomes.push(outcome);
      expect(outcomes).toEqual([
        {
          ok: false,
          failure: {
            kind: "aborted",
            reason: "caller-stop",
            recovered: { value, complete: false, cut: { path, kind: "string" } },
          },
        },
      ]);
      expect(released).toBe(1);
    } finally {
      expect((await stream.close()).ok).toBe(true);
    }
  },
);

it("keeps the selected scalar prefix in failed recovery without delivering it as final", async () => {
  const stop = new AbortController();
  async function* source() {
    yield '{"files":[{"content":"par';
    stop.abort("caller-stop");
  }
  const stream = parseStream(source(), {
    signal: stop.signal,
    select: select([["files", 0, "content"]]),
  });
  try {
    const outcomes = [];
    for await (const outcome of stream) outcomes.push(outcome);
    expect(outcomes).toEqual([
      {
        ok: false,
        failure: {
          kind: "aborted",
          reason: "caller-stop",
          recovered: {
            value: [expect.objectContaining({ path: ["files", 0, "content"], value: "par" })],
            complete: false,
            cut: { path: ["files", 0, "content"], kind: "string" },
          },
        },
      },
    ]);
  } finally {
    await stream.close();
  }
});

it.each(
  (["eof", "abort", "source", "limit"] as const).flatMap((ending) =>
    [false, true].map((selected) => ({ ending, selected })),
  ),
)(
  "keeps filtered fallback data and its report at $ending with selection $selected",
  async ({ ending, selected }) => {
    const stop = new AbortController();
    const cause = new Error("source stopped");
    async function* source() {
      yield "{a:1} ";
      if (ending === "abort") stop.abort("caller-stop");
      if (ending === "source") throw cause;
      yield "{b:2} ";
    }
    const stream = parseStream(source(), {
      requiredKeys: ["id"],
      diagnostics,
      signal: stop.signal,
      ...(selected ? { select: select([["a"]]) } : {}),
      ...(ending === "limit" ? { maxRetained: selected ? 4 : 3 } : {}),
    });
    try {
      const outcomes = [];
      for await (const outcome of stream) outcomes.push(outcome);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        ok: false,
        failure: {
          kind: {
            eof: "no-match",
            abort: "aborted",
            source: "source-failed",
            limit: "limit-reached",
          }[ending],
          recovered: {
            value: selected ? [expect.objectContaining({ path: ["a"], value: 1 })] : { a: 1 },
            complete: true,
          },
        },
        diagnostics: {
          repairs: [expect.objectContaining({ kind: "unquoted-key", valueIndex: 0 })],
          counts: { repairs: 1, errors: 0 },
        },
      });
      if (ending === "source") expect(outcomes[0]).toMatchObject({ failure: { cause } });
    } finally {
      await stream.close();
    }
  },
);

it("keeps the fallback report across manual feed drains", () => {
  const parser = createStreamParser({ requiredKeys: ["id"], diagnostics });
  try {
    expect([...parser.feed("{a:1} ")]).toEqual([]);
    expect([...parser.feed("{b:2} ")]).toEqual([]);
    expect([...parser.end()]).toMatchObject([
      {
        ok: false,
        failure: { recovered: { value: { a: 1 }, complete: true } },
        diagnostics: {
          repairs: [expect.objectContaining({ kind: "unquoted-key", valueIndex: 0 })],
        },
      },
    ]);
  } finally {
    parser.close();
  }
});

it("charges the filtered fallback while building the next root", () => {
  const parser = createStreamParser({ requiredKeys: ["id"], maxRetained: 16 });
  try {
    expect([...parser.feed('{"a":"12345678"} ')]).toEqual([]);
    expect([...parser.feed('{"id":"12345678"}')]).toMatchObject([
      { ok: false, failure: { kind: "limit-reached", resource: "retained" } },
    ]);
  } finally {
    parser.close();
  }
});

it.each(
  [false, true].flatMap((selected) =>
    ['{b:"par', '{"id":2} {b:3} '].map((tail) => ({ selected, tail })),
  ),
)(
  "prefers live recovery and forgets accepted roots with selection $selected and tail $tail",
  async ({ selected, tail }) => {
    const stop = new AbortController();
    async function* source() {
      yield "{a:1} ";
      yield tail;
      stop.abort("caller-stop");
    }
    const stream = parseStream(source(), {
      requiredKeys: ["id"],
      signal: stop.signal,
      ...(selected ? { select: select([["b"], ["id"]]) } : {}),
    });
    try {
      const outcomes = [];
      for await (const outcome of stream) outcomes.push(outcome);
      const last = outcomes.at(-1);
      expect(last).toMatchObject({ ok: false, failure: { kind: "aborted" } });
      if (last === undefined || !("ok" in last) || last.ok) throw new Error("missing abort");
      if (tail.includes("par")) {
        expect(last.failure).toMatchObject({
          recovered: {
            complete: false,
            value: selected
              ? [expect.objectContaining({ path: ["b"], value: "par" })]
              : { b: "par" },
          },
        });
      } else expect(last.failure).not.toHaveProperty("recovered");
    } finally {
      await stream.close();
    }
  },
);
