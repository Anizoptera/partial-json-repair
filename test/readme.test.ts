// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { decodedFragments } from "../src/index";

/**
 * Every example the README prints an output for, asserted.
 *
 * Documentation drifts because nothing measures it: a behaviour changes for a good reason, the
 * suite stays green, and the README keeps promising the old answer to everyone who has not read the
 * code. These are the same values a reader will copy, so a change that makes one wrong turns the
 * lane red and names the paragraph.
 *
 * A case here is NOT a substitute for the behaviour's own test. It pins what the README claims;
 * `parser.test.ts` and the corpus pin parser behavior. HLD decides disagreements; correct the code
 * or README where it conflicts with that contract.
 */
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { compileFunction } from "node:vm";

import { describe, expect, it } from "vitest";
import { ScriptTarget, transpile } from "typescript-6";
import { DEFAULT_OPTIONS } from "../src/options";

import {
  ANY,
  ANY_DEPTH,
  createMetrics,
  createStreamParser,
  findJsonSpan,
  initParser,
  isExactNumber,
  LLM_FULL,
  parse,
  parseMany,
  parseStream,
  repair,
  STRICT,
  stringify,
  diagnostics,
  select,
  skip,
} from "../src/index";
import { ownedView, sharedView } from "../src/index";

const REPORT = { diagnostics } as const;

function compilePreviewRecipe(recipe: "sdk" | "generic" = "sdk") {
  // Execute the printed recipe so documentation changes cannot escape runtime checks.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(
    recipe === "sdk" ? "export async function showReply(" : "const stop = new AbortController();",
  );
  expect(start).toBeGreaterThan(0);
  const end = readme.indexOf("\n```", start);
  expect(end).toBeGreaterThan(start);
  const body = readme.slice(start, end);
  const printed =
    recipe === "sdk"
      ? body.replace("export async", "async")
      : `async function showReply(result) { const chunks = result.textStream; ${body} }`;
  const run = compileFunction(
    `${transpile(printed, { target: ScriptTarget.ES2022 })}\nreturn showReply;`,
    [
      "sharedView",
      "parseStream",
      "render",
      "handleFailure",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  ) as (
    view: typeof sharedView,
    parse: typeof parseStream,
    render: (value: unknown) => void,
    fail: (failure: unknown) => void,
    request: (draw: () => void) => number,
    cancel: (frame: number) => void,
  ) => (result: { textStream: AsyncIterable<string> }) => Promise<unknown>;
  return run.bind(undefined, sharedView);
}

it("renders the README preview's completed value before another animation frame", async () => {
  // Frames need not run before EOF.
  const renders: unknown[] = [];
  const cancelled: number[] = [];
  const run = compilePreviewRecipe();
  const showReply = run(
    parseStream,
    (value) => {
      renders.push(value);
    },
    (failure) => {
      throw new Error(`unexpected recipe failure: ${inspect(failure)}`);
    },
    () => 1,
    (frame) => {
      cancelled.push(frame);
    },
  );
  const input = '{"done":true}';
  async function* chunks() {
    yield input;
  }
  expect(await showReply({ textStream: chunks() })).toEqual({ done: true });
  expect(renders).toEqual([{ done: true }]);
  expect(cancelled).toEqual([1]);
});

it.each(["source", "limit"] as const)(
  "does not return an earlier README preview value after a later %s failure",
  async (fault) => {
    // A completed root remains visible, but cannot stand for successful source completion.
    const cause = new Error("source failed after a completed root");
    const renders: unknown[] = [];
    const failures: unknown[] = [];
    const cancelled: number[] = [];
    let released = false;
    const showReply = compilePreviewRecipe()(
      parseStream,
      (value) => {
        renders.push(value);
      },
      (failure) => {
        failures.push(failure);
      },
      () => 1,
      (frame) => {
        cancelled.push(frame);
      },
    );
    async function* chunks() {
      try {
        yield '{"done":true}\n';
        if (fault === "source") throw cause;
        const depth = DEFAULT_OPTIONS.maxDepth + 1;
        yield '{"deep":' + "[".repeat(depth) + "0" + "]".repeat(depth) + "}";
      } finally {
        released = true;
      }
    }
    expect(await showReply({ textStream: chunks() })).toBeUndefined();
    expect(renders[0]).toEqual({ done: true });
    expect(failures).toMatchObject([
      fault === "source"
        ? { kind: "source-failed", cause }
        : { kind: "limit-reached", resource: "depth" },
    ]);
    expect(cancelled).toEqual([1]);
    expect(released).toBe(true);
  },
);

it.each(["source", "render", "failure handler"] as const)(
  "releases the README preview's source and latest frame after %s failure",
  async (fault) => {
    const sourceCause = new Error("source stopped");
    const handlerCause = new Error("handler stopped");
    const failures: unknown[] = [];
    const cancelled: number[] = [];
    let released = false;
    let frameCount = 0;
    let draw: (() => void) | undefined;
    const showReply = compilePreviewRecipe()(
      parseStream,
      () => {
        if (fault === "render") throw handlerCause;
      },
      (failure) => {
        failures.push(failure);
        if (fault === "failure handler") throw handlerCause;
      },
      (next) => {
        draw = next;
        return ++frameCount;
      },
      (frame) => {
        cancelled.push(frame);
      },
    );
    async function* chunks() {
      try {
        // Advance a preview frame before completion; cleanup must cancel its replacement.
        expect(draw).toBeTypeOf("function");
        draw?.();
        // The line break settles the value; one that ends the received text waits for a possible
        // list comma, and the failure would then carry it as recovery instead.
        yield '{"done":true}\n';
        throw sourceCause;
      } finally {
        released = true;
      }
    }
    const result = showReply({ textStream: chunks() });
    if (fault === "source") {
      expect(await result).toBeUndefined();
    } else {
      await expect(result).rejects.toBe(handlerCause);
    }
    expect(failures).toEqual(
      fault === "render" ? [] : [{ kind: "source-failed", cause: sourceCause }],
    );
    expect(released).toBe(true);
    expect(frameCount).toBe(2);
    expect(cancelled).toEqual([2]);
  },
);

it.each(["sdk", "generic"] as const)(
  "stops the README %s preview when its scheduled renderer throws",
  async (recipe) => {
    const cause = new Error("scheduled render failed");
    let draw: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    let readStarted: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let released = false;
    const cancelled: number[] = [];
    const showReply = compilePreviewRecipe(recipe)(
      parseStream,
      () => {
        throw cause;
      },
      () => undefined,
      (next) => {
        draw = next;
        return 1;
      },
      (frame) => {
        cancelled.push(frame);
      },
    );
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          next() {
            if (first) {
              first = false;
              return Promise.resolve({ done: false as const, value: '{"title":"Hel' });
            }
            return new Promise<IteratorResult<string>>((resolve) => {
              releaseRead = () => {
                resolve({ done: true, value: undefined });
              };
              readStarted?.();
            });
          },
          return() {
            released = true;
            releaseRead?.();
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };
    const result = showReply({ textStream: source });
    try {
      // Setup failure must surface before waiting for a source phase it can no longer reach.
      await Promise.race([
        reading,
        result.then(() => {
          throw new Error("Preview finished before requesting the held source read");
        }),
      ]);
      expect(draw).toBeTypeOf("function");
      expect(() => draw?.()).not.toThrow();
      await expect(result).rejects.toBe(cause);
      expect(released).toBe(true);
      expect(cancelled).toEqual([1]);
    } finally {
      releaseRead?.();
      await result.catch(() => undefined);
    }
  },
);

it.each([
  ["returning", false],
  ["throwing", true],
] as const)(
  "renders the README preview's failed prefix before a %s failure handler",
  async (_handler, throws) => {
    const sourceCause = new Error("source stopped inside a string");
    const handlerCause = new Error("failure handler stopped");
    const renders: unknown[] = [];
    const failures: unknown[] = [];
    const order: string[] = [];
    const cancelled: number[] = [];
    const showReply = compilePreviewRecipe()(
      parseStream,
      (value) => {
        renders.push(value);
        order.push("render");
      },
      (failure) => {
        failures.push(failure);
        order.push("failure");
        if (throws) throw handlerCause;
      },
      () => 1,
      (frame) => {
        cancelled.push(frame);
      },
    );
    async function* chunks() {
      // No preview frame runs before the source fails; the final failed prefix must still appear.
      yield '{"title":"Hel';
      throw sourceCause;
    }
    const result = showReply({ textStream: chunks() });
    if (throws) await expect(result).rejects.toBe(handlerCause);
    else expect(await result).toBeUndefined();
    expect(failures).toMatchObject([
      { kind: "source-failed", cause: sourceCause, recovered: { value: { title: "Hel" } } },
    ]);
    expect(renders).toEqual([{ title: "Hel" }]);
    expect(order).toEqual(["render", "failure"]);
    expect(cancelled).toEqual([1]);
  },
);

it.each(
  (["toolArguments", "readMessage"] as const).flatMap((name) =>
    (["complete", "source", "handler"] as const).map((fault) => [name, fault] as const),
  ),
)("routes and closes the README %s recipe after %s", async (name, fault) => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(0);
  const end = readme.indexOf("\n```", start);
  expect(end).toBeGreaterThan(start);
  const printed = readme.slice(start, end).replace("export async", "async");
  const run = compileFunction(
    `${transpile(printed, { target: ScriptTarget.ES2022 })}\nreturn ${name};`,
    ["createStreamParser", "handleResult"],
  ) as (
    create: () => ReturnType<typeof createStreamParser>,
    handle: (result: unknown, source?: string | number) => void,
  ) => (input: AsyncIterable<object>) => Promise<void>;
  const observed: { result: unknown; source: string | number | undefined }[] = [];
  const created: ReturnType<typeof createStreamParser>[] = [];
  const cause = new Error("recipe stopped");
  let released = false;
  const consume = run(
    () => {
      const parser = createStreamParser();
      created.push(parser);
      return parser;
    },
    (result, source) => {
      observed.push({ result, source });
      if (fault === "handler") throw cause;
    },
  );
  // Equal payloads cannot identify their call; EOF recovery must carry the source too.
  const pieces = [
    [0, '{"same":'],
    [1, '{"same":true}'],
    [0, "true}"],
    [1, ' {"last":true'],
  ] as const;
  async function* events() {
    try {
      for (const [index, delta] of pieces) {
        yield name === "toolArguments"
          ? { type: "tool-input-delta", id: String(index), delta }
          : { type: "content_block_delta", index, delta: { partial_json: delta } };
      }
      if (fault === "source") throw cause;
    } finally {
      released = true;
    }
  }
  if (fault === "complete") await consume(events());
  else await expect(consume(events())).rejects.toBe(cause);
  expect(released).toBe(true);
  expect(created).toHaveLength(2);
  for (const parser of created)
    expect(parser.feed("null").next().value).toMatchObject({
      ok: false,
      failure: { kind: "stream-closed" },
    });
  if (fault !== "complete") return;
  expect(observed.map((item) => item.source)).toEqual(
    name === "toolArguments" ? ["1", "0", "1"] : [1, 0, 1],
  );
  expect(observed.map((item) => item.result)).toMatchObject([
    { ok: true, value: { same: true }, complete: true },
    { ok: true, value: { same: true }, complete: true },
    { ok: true, value: { last: true }, complete: false },
  ]);
});

const parser = initParser(REPORT);

const stream = () => createStreamParser({ ...REPORT, view: ownedView });

/** The value in a stream's view, as the README prints it. */
const viewOf = (sp: ReturnType<typeof stream>): unknown => {
  const seen = sp.snapshot();
  if (!seen.ok) throw new Error(inspect(seen.failure));
  return seen.value?.value;
};

describe("README: the problem", () => {
  it("recovers a truncated value and reports all three repairs", () => {
    const r = parse('{"name": "Ada", "tags": ["x", "y', REPORT);
    expect(r.ok && r.value).toEqual({ name: "Ada", tags: ["x", "y"] });
    expect(r.diagnostics.confidence).toBeCloseTo(0.729, 3);
    expect(r.diagnostics.repairs.map((x) => [x.kind, x.at.offset, x.path])).toEqual([
      ["unclosed-string", 30, ["tags", 1]],
      ["unclosed-array", 32, ["tags", 2]],
      ["unclosed-object", 32, []],
    ]);
    expect(parse('{"name": "Ada", "tags": ["x", "y')).toEqual({
      ok: true,
      value: { name: "Ada", tags: ["x", "y"] },
      complete: false,
      cut: { path: ["tags", 1], kind: "string" },
    });
  });
});

describe("README: the three calls", () => {
  const messy = "{'a': 1, // note\n b: 2,}";

  it("parse reports each leniency it used", () => {
    const r = parse(messy, REPORT);
    expect(r.ok && r.value).toEqual({ a: 1, b: 2 });
    expect(r.diagnostics.repairs.map((x) => x.kind)).toEqual([
      "single-quote",
      "comment-removed",
      "unquoted-key",
      "trailing-comma",
    ]);
    expect(r.diagnostics.confidence).toBeCloseTo(0.97, 5);
  });

  it("repair returns text, spliced rather than re-serialised", () => {
    expect(repair(messy)).toEqual({ ok: true, complete: true, value: '{"a": 1, \n "b": 2}' });
  });

  it("a stream yields nothing until a value closes, and snapshots what is placed", () => {
    const sp = stream();
    expect([...sp.feed('{"title": "Hel')]).toEqual([]);
    expect(viewOf(sp)).toEqual({ title: "Hel" });
    expect(sp.snapshot()).toMatchObject({
      ok: true,
      value: { cut: { path: ["title"], kind: "string" } },
    });
    expect([...sp.feed('lo", "items": [1,2')]).toEqual([]);
    expect(viewOf(sp)).toEqual({ title: "Hello", items: [1] });

    const [done, ...rest] = sp.end();
    expect(rest).toEqual([]);
    expect(done).toMatchObject({
      ok: true,
      value: { title: "Hello", items: [1, 2] },
      cut: { path: ["items", 1], kind: "number" },
    });
    expect(done?.diagnostics.repairs.map((x) => x.kind)).toEqual([
      "unclosed-array",
      "unclosed-object",
    ]);
  });

  it("parseMany reads JSONL, findJsonSpan locates the value in prose", () => {
    expect([...parseMany('{"a":1}\n{"b":2}\n{"c":3}')].map((r) => r.ok && r.value)).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ]);
    expect(findJsonSpan('here you go: {"a":1} hope that helps')).toEqual({
      ok: true,
      value: { start: { offset: 13, unit: "utf16" }, end: { offset: 20, unit: "utf16" } },
    });
  });
});

describe("README: what you get back", () => {
  it("finding no JSON is a value, not an exception", () => {
    expect(parse("no json here at all")).toEqual({ ok: false, failure: { kind: "no-json-found" } });
  });
});

describe("README: presets", () => {
  it("STRICT consumes the construct and refuses the value, keeping what it read", () => {
    expect(parse("{'a': 1}", STRICT)).toEqual({
      ok: false,
      failure: {
        kind: "policy-refused",
        issue: expect.objectContaining({ kind: "unparsable-span" }) as unknown,
        recovered: { value: {}, complete: false, cut: { path: ["a"], kind: "missing" } },
      },
    });
  });
});

describe("README: per-kind recovery", () => {
  it("declining one kind refuses the document and still hands back the value", () => {
    expect(parse(`{"a": {'b': 1}}`, { recover: { "single-quote": false } })).toEqual({
      ok: false,
      failure: {
        kind: "policy-refused",
        issue: expect.objectContaining({ kind: "unparsable-span", path: ["a"] }) as unknown,
        recovered: { value: { a: { b: 1 } }, complete: true },
      },
    });
  });

  it("switching one on reaches past a preset that leaves it off", () => {
    expect(parse('{"a": NaN}', { recover: { "js-literal": true } })).toEqual({
      ok: true,
      complete: true,
      value: { a: NaN },
    });
  });
});

describe("README: prototype pollution", () => {
  const text = '{"__proto__": {"x":1}, "safe": 2}';

  it("keep stores the key as data and touches no prototype", () => {
    const r = parse(text);
    if (!r.ok) throw new Error("expected a value");
    const value = r.value as Record<string, unknown>;
    // Asserted through `Object.keys` and `getOwnPropertyDescriptor` rather than against an object
    // literal: writing `{ __proto__: {x:1} }` as the EXPECTATION sets that object's prototype
    // instead of giving it the key, so the comparison would pass for the wrong reason — the same
    // trap the parser uses `defineProperty` to avoid, met while writing the test for it.
    expect(Object.keys(value).toSorted()).toEqual(["__proto__", "safe"]);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ x: 1 });
    expect(value.safe).toBe(2);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as { x?: number }).x).toBeUndefined();
  });

  it("drop removes the key, reports it, and keeps the sibling", () => {
    const r = parse(text, { ...LLM_FULL, ...REPORT });
    expect(r.ok && r.value).toEqual({ safe: 2 });
    expect(r.diagnostics.repairs.map((x) => x.kind)).toEqual(["dangerous-key"]);
  });
});

describe("README: snapshots", () => {
  it("mints a stream from a shared parser, with a view", () => {
    // The README tells a server to validate once at startup and mint state per stream. If that
    // example ever stops compiling or answering the same as the one-shot form above it, the advice
    // is worse than absent: a reader copies it into the hot path and gets different behaviour.
    const sp = createStreamParser(parser, { view: sharedView });
    expect(Array.from(sp.feed('{"title": "Hel'))).toEqual([]);
    const seen = sp.snapshot();
    if (!seen.ok) throw new Error(inspect(seen.failure));
    expect(seen.value?.value).toEqual({ title: "Hel" });
  });

  it("a shared view keeps the identity of branches nothing touched", () => {
    // The README's claim for `view: sharedView`: a diffing UI re-renders exactly what moved.
    const sp = createStreamParser({ view: sharedView });
    void Array.from(sp.feed('{"done":{"x":1},"open":[1,'));
    const first = sp.snapshot();
    void Array.from(sp.feed("2"));
    const second = sp.snapshot();
    if (!first.ok || !second.ok || first.value === undefined || second.value === undefined) {
      throw new Error("no view");
    }
    expect((first.value.value as { done: object }).done).toBe(
      (second.value.value as { done: object }).done,
    );
    expect(Object.isFrozen((first.value.value as { done: object }).done)).toBe(true);
  });
});

describe("README: limitations", () => {
  it("a string still being read is in a snapshot; a number or a key is not", () => {
    const sp = stream();
    void Array.from(sp.feed('{"key": "val'));
    expect(viewOf(sp)).toEqual({ key: "val" });

    const partialNumber = stream();
    void Array.from(partialNumber.feed('{"n": 12'));
    expect(viewOf(partialNumber)).toEqual({});

    const [done] = sp.end();
    expect(done).toMatchObject({ ok: true, value: { key: "val" } });
    expect(done?.diagnostics.repairs.map((x) => x.kind)).toEqual([
      "unclosed-string",
      "unclosed-object",
    ]);
  });

  it("a number a double cannot hold stays exact", () => {
    const r = parse('{"id": 12345678901234567890, "tiny": 1e-400}');
    const id = r.ok ? (r.value as { id: unknown }).id : undefined;
    expect(isExactNumber(id)).toBe(true);
    if (!isExactNumber(id)) return;
    expect(id.text).toBe("12345678901234567890");
    expect(id.toBigInt({ maxDigits: 30 })).toEqual({ ok: true, value: 12345678901234567890n });
    expect(id.toNumber()).toEqual({ ok: false, failure: { kind: "inexact" } });
    expect(id.toNumber({ allowRounding: true })).toEqual({ ok: true, value: 12345678901234567000 });
    expect(r.ok && stringify(r.value)).toEqual({
      ok: true,
      value: '{"id":12345678901234567890,"tiny":1e-400}',
    });
  });

  it("duplicate keys are reported whenever a report is asked for", () => {
    expect(parse('{"a":1,"a":2}', REPORT).diagnostics.repairs.map((x) => x.kind)).toEqual([
      "duplicate-key",
    ]);
    expect(parse('{"a":1,"a":2}')).toEqual({ ok: true, complete: true, value: { a: 2 } });
  });

  it("nesting past the budget fails the value and keeps what was read", () => {
    const r = parse("[[[1]]]", { maxDepth: 2 });
    expect(r.ok ? undefined : r.failure).toMatchObject({
      kind: "limit-reached",
      resource: "depth",
      recovered: { value: [[[]]] },
    });
  });

  it("brackets in a sentence are not JSON", () => {
    expect(parse("see [1] for the citation")).toEqual({
      ok: false,
      failure: { kind: "no-json-found" },
    });
  });

  it("a bare scalar counts only when it is the whole text", () => {
    expect(parse("42")).toEqual({ ok: true, complete: true, value: 42 });
    expect(parse('answer is 42, data: {"a":1}')).toEqual({
      ok: true,
      complete: true,
      value: { a: 1 },
    });
  });
});

describe("README: selection", () => {
  const doc = '{"items":[{"id":1,"name":"a"},{"id":2,"name":"b"}],"meta":{"id":9}}';

  it("returns matches carrying value and path, and finds a field at any depth", () => {
    const names = parse(doc, { select: select([["items", ANY, "name"]]) });
    expect(names.ok && names.value.map((m) => [m.value, m.path])).toEqual([
      ["a", ["items", 0, "name"]],
      ["b", ["items", 1, "name"]],
    ]);
    const ids = parse(doc, { select: select([[ANY_DEPTH, "id"]]) });
    expect(ids.ok && ids.value.map((m) => m.path)).toEqual([
      ["items", 0, "id"],
      ["items", 1, "id"],
      ["meta", "id"],
    ]);
  });

  it("skip trims the named member out of the document", () => {
    expect(
      parse('{"text":"hi","embedding":[0.1,0.2,0.3]}', { skip: skip([["embedding"]]) }),
    ).toEqual({
      ok: true,
      complete: true,
      value: { text: "hi" },
    });
  });

  it("streams a selected string as fragments", () => {
    const sp = createStreamParser({ select: select([["msg"]], { fragments: decodedFragments }) });
    const kinds = (chunk: string): unknown[] =>
      [...sp.feed(chunk)].map((i) => "ok" in i && i.ok && i.value.kind);
    expect(kinds('{"msg":"hello wo')).toEqual(["start", "data"]);
    expect(kinds('rld"}')).toEqual(["data", "end"]);
  });
});

describe("README: cut suffix, argument finality, metrics", () => {
  it("appends the suffix to a cut string, the default one or the caller's", () => {
    expect(parse('{"msg": "hello wor', { cutSuffix: true })).toMatchObject({
      value: { msg: "hello wor…" },
    });
    expect(parse('{"msg": "hello wor', { cutSuffix: " [cut]" })).toMatchObject({
      value: { msg: "hello wor [cut]" },
    });
  });

  it("tells a closed argument from one still arriving by the cut path", () => {
    const args = createStreamParser({ view: sharedView });
    for (const _ of args.feed('{"city": "Paris", "units": "metr'));
    const seen = args.snapshot();
    const cut = seen.ok ? seen.value?.cut : undefined;
    expect(cut?.path[0]).toBe("units");
    expect(seen.ok && seen.value?.value).toEqual({ city: "Paris", units: "metr" });
  });

  it("counts a repair kind and a blocked key in a metrics snapshot", () => {
    const measured = createMetrics({ onDangerousKey: "drop" });
    parse('{id: 1, "__proto__": 2}', measured);
    const snapshot = measured.read();
    expect(snapshot.repairs["unquoted-key"]).toBe(1);
    expect(snapshot.security.dangerousKeysBlocked).toBe(1);
  });
});
