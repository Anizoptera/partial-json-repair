// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * Bytes as input: decoded once and reported in bytes; byte-order marks stripped or refused; and
 * stream positions that name the chunk and count in that chunk's own unit (HLD).
 */
import { inspect } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  auto,
  cooperative,
  findJsonSpanAsync,
  parseAsync,
  parseManyAsync,
  repairAsync,
  worker,
} from "../src/async";
import { WHOLE_INPUT_SLICE } from "../src/whole-reader";
import { wholeOperation } from "../src/whole-operation";
import { resolveOptions } from "../src/options";
import { repairOperation } from "../src/repair-operation";
import { spanOperation } from "../src/span-operation";

import {
  createStreamParser,
  findJsonSpan,
  parse,
  parseMany,
  parseStream,
  repair,
  diagnostics,
  locations,
  select,
} from "../src/index";

const enc = new TextEncoder();
const REPORT = { diagnostics, locations } as const;
const WHOLE_REQUESTS = [
  ["parse", "parse"],
  ["repair", repairOperation],
  ["span", spanOperation],
] as const;
const bytes = (...parts: (string | number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? Array.from(enc.encode(p)) : p)));

/** The whole result of a one-shot parse over these bytes, so a refusal is compared as a value. */
const rejected = (b: number[]): unknown => parse(new Uint8Array(b));

it.each(["before", "across"] as const)(
  "keeps byte positions and refusal context %s a slice",
  (edge) => {
    const body = '{keep:"é𝄞",}';
    const prefix = WHOLE_INPUT_SLICE - (edge === "before" ? enc.encode(body).length : 1);
    const text = " ".repeat(prefix) + body + " ".repeat(64);
    const settings = { ...REPORT, select: select([["keep"]]), recover: { "unquoted-key": false } };
    const control = parse(text, settings);
    const actual = parse(enc.encode(text), settings);
    if (
      control.ok ||
      actual.ok ||
      control.failure.kind !== "policy-refused" ||
      actual.failure.kind !== "policy-refused"
    )
      throw new Error("slice fixture must preserve its policy refusal");
    const byteAt = (at: { readonly offset: number }) => ({
      offset: enc.encode(text.slice(0, at.offset)).length,
      unit: "byte" as const,
    });
    // The text route supplies full context independently of incremental byte lookahead.
    expect(actual.diagnostics).toEqual({
      ...control.diagnostics,
      repairs: control.diagnostics.repairs.map((entry) => ({ ...entry, at: byteAt(entry.at) })),
      errors: control.diagnostics.errors.map((entry) => ({ ...entry, at: byteAt(entry.at) })),
    });
    expect(actual.diagnostics.errors.length).toBeGreaterThan(0);
    expect(actual.failure.issue).toEqual({
      ...control.failure.issue,
      at: byteAt(control.failure.issue.at),
    });
    expect(actual.failure.recovered).toMatchObject({
      complete: true,
      value: [{ value: "é𝄞", path: ["keep"] }],
    });
  },
);

it.each(["slice", "dimensions"] as const)(
  "reads native byte storage despite shadowed %s",
  async (kind) => {
    const text = '{"a":1}';
    // Private windows must preserve the visible range, not adjacent backing storage.
    const backing = enc.encode("prefix" + text + "suffix");
    const input = backing.subarray(6, 6 + text.length);
    Object.defineProperty(input, "subarray", { value: () => enc.encode('{"a":2}') });
    if (kind === "dimensions") {
      for (const key of ["length", "buffer", "byteOffset", "byteLength", "constructor"])
        Object.defineProperty(input, key, {
          get() {
            throw new Error("caller " + key);
          },
        });
    }
    for (const call of [parse, repair, findJsonSpan])
      expect(call(input)).toEqual(call(enc.encode(text)));
    expect([...parseMany(input)]).toEqual([...parseMany(enc.encode(text))]);
    const stream = createStreamParser();
    try {
      expect([...stream.feed(input), ...stream.end()].map((item) => item.ok && item.value)).toEqual(
        [{ a: 1 }],
      );
    } finally {
      stream.close();
    }
    const transported = [];
    for await (const item of parseStream([input])) transported.push(item.ok && item.value);
    expect(transported).toEqual([{ a: 1 }]);
    await Promise.all(
      [{ execution: auto }, { execution: cooperative }].map(async (options) => {
        const [actual, control] = await Promise.all([
          parseAsync(input, options),
          parseAsync(enc.encode(text), options),
        ]);
        expect(control).toMatchObject({ ok: true, value: { a: 1 } });
        expect(actual).toEqual(control);
      }),
    );
  },
);

it("accepts cross-realm bytes through whole-input and stream routes", async () => {
  // A separate realm changes prototypes, not the UTF-8 input contract.
  const input = runInNewContext("new Uint8Array([123,34,97,34,58,49,125])") as Uint8Array;
  expect(input instanceof Uint8Array).toBe(false);
  const text = '{"a":1}';
  for (const call of [parse, repair, findJsonSpan])
    expect(call(input)).toEqual(call(enc.encode(text)));
  expect([...parseMany(input)]).toEqual([...parseMany(enc.encode(text))]);
  const stream = createStreamParser();
  try {
    expect([...stream.feed(input), ...stream.end()].map((item) => item.ok && item.value)).toEqual([
      { a: 1 },
    ]);
  } finally {
    stream.close();
  }
  await Promise.all(
    [{ execution: auto }, { execution: cooperative }].map(async (options) => {
      const [foreign, local] = await Promise.all([
        parseAsync(input, options),
        parseAsync(enc.encode(text), options),
      ]);
      expect(local).toMatchObject({ ok: true, value: { a: 1 } });
      expect(foreign).toEqual(local);
    }),
  );
});

it("uses the intrinsic byte brand rather than a caller-supplied tag", () => {
  const input = enc.encode('{"a":1}');
  Object.defineProperty(input, Symbol.toStringTag, {
    get() {
      throw new Error("caller tag");
    },
  });
  expect(parse(input).ok).toBe(true);
  const wrong = new Uint16Array([123, 125]);
  Object.defineProperty(wrong, Symbol.toStringTag, { value: "Uint8Array" });
  expect(parse(wrong as unknown as Uint8Array)).toEqual({
    ok: false,
    failure: { kind: "invalid-input", received: "object" },
  });
});

it.each([
  ["object", {}],
  ["array", []],
  ["bytes", new Uint8Array()],
] as const)("returns typed invalid input for a revoked %s proxy", (_kind, target) => {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  // Deliberately bypass the static input contract to exercise runtime rejection.
  const input = proxy as Uint8Array;
  const invalid = { ok: false, failure: { kind: "invalid-input", received: "object" } };
  for (const call of [parse, repair, findJsonSpan]) expect(call(input)).toEqual(invalid);
  expect([...parseMany(input)]).toEqual([invalid]);
  const stream = createStreamParser();
  try {
    expect([...stream.feed(input)]).toEqual([invalid]);
  } finally {
    stream.close();
  }
});

it.each([
  ["auto", { execution: auto }],
  ["cooperative", { execution: cooperative }],
  ["worker", { execution: worker }],
] as const)(
  "returns typed invalid input for a revoked proxy through %s execution",
  async (_label, options) => {
    const { proxy, revoke } = Proxy.revocable(new Uint8Array(), {});
    revoke();
    const invalid = { ok: false, failure: { kind: "invalid-input", received: "object" } };
    const results = await Promise.all([
      parseAsync(proxy, options),
      repairAsync(proxy, options),
      findJsonSpanAsync(proxy, options),
    ]);
    for (const result of results) expect(result).toEqual(invalid);
    const items = [];
    for await (const item of parseManyAsync(proxy, options)) items.push(item);
    expect(items).toEqual([invalid]);
  },
);

const UNREADABLE_BYTES = ["detached", "out-of-bounds"] as const;
const unreadableBytes = (kind: (typeof UNREADABLE_BYTES)[number]): Uint8Array => {
  const buffer = new ArrayBuffer(8, { maxByteLength: 8 });
  const input = new Uint8Array(buffer, 1, 7);
  input.set(enc.encode('{"a":1}'));
  if (kind === "detached") structuredClone(buffer, { transfer: [buffer] });
  else buffer.resize(1);
  return input;
};

it.each(UNREADABLE_BYTES)("rejects %s bytes through every input boundary", async (kind) => {
  const input = unreadableBytes(kind);
  const invalid = { ok: false, failure: { kind: "invalid-input", received: "object" } };
  for (const call of [parse, repair, findJsonSpan]) expect(call(input)).toEqual(invalid);
  expect([...parseMany(input)]).toEqual([invalid]);
  const parser = createStreamParser();
  try {
    expect([...parser.feed(input)]).toEqual([invalid]);
  } finally {
    parser.close();
  }
  const pulled = [];
  for await (const item of parseStream([input])) pulled.push(item);
  expect(pulled).toEqual([
    { ok: false, failure: { kind: "invalid-source", sourceKind: "chunk:object" } },
  ]);
  await Promise.all(
    [{ execution: auto }, { execution: cooperative }, { execution: worker }].map(
      async (options) => {
        const results = await Promise.all([
          parseAsync(input, options),
          repairAsync(input, options),
          findJsonSpanAsync(input, options),
        ]);
        for (const result of results) expect(result).toEqual(invalid);
        const items = [];
        for await (const item of parseManyAsync(input, options)) items.push(item);
        expect(items).toEqual([invalid]);
      },
    ),
  );
});

it.each(["ordinary", "shared"] as const)("keeps empty %s byte views readable", (kind) => {
  const encoded = enc.encode('{"v":"é"}');
  const buffer =
    kind === "shared" ? new SharedArrayBuffer(encoded.length) : new ArrayBuffer(encoded.length);
  const input = new Uint8Array(buffer);
  input.set(encoded);
  const empty = new Uint8Array(buffer, encoded.length, 0);
  expect(parse(empty)).toEqual(parse(""));
  const parser = createStreamParser();
  try {
    // An empty byte chunk must preserve the unfinished UTF-8 sequence, not flush a replacement.
    const split = input.indexOf(0xc3) + 1;
    const items = [
      ...parser.feed(input.subarray(0, split)),
      ...parser.feed(empty),
      ...parser.feed(input.subarray(split)),
      ...parser.end(),
    ];
    expect(items.map((item) => item.ok && item.value)).toEqual([{ v: "é" }]);
    expect(Array.from(input)).toEqual(Array.from(encoded));
  } finally {
    parser.close();
  }
});

it.each(
  WHOLE_REQUESTS.flatMap(([name, request]) =>
    (["detach", "shrink"] as const).map((loss) => [name, loss, request] as const),
  ),
)("keeps available %s recovery after byte %s", (_name, loss, request) => {
  const units = 64;
  const encoded = enc.encode('{"a":1,"b":"' + "x".repeat(units * 2) + '"}');
  const buffer = new ArrayBuffer(encoded.length, { maxByteLength: encoded.length });
  const input = new Uint8Array(buffer);
  input.set(encoded);
  const operation = wholeOperation(request, input, resolveOptions(), undefined, units);
  try {
    let step = operation.next();
    expect(step).toEqual({ done: false, value: { kind: "checkpoint" } });
    if (loss === "detach") structuredClone(buffer, { transfer: [buffer] });
    else buffer.resize(1);
    while (step.done !== true) step = operation.next();
    expect(step.value).toMatchObject({
      ok: false,
      failure: {
        kind: "invalid-input",
        recovered: {
          value: { a: 1 },
          complete: false,
          cut: { kind: "string", path: ["b"] },
        },
      },
    });
    expect(step.value).toHaveProperty("failure.recovered.value.b", expect.stringMatching(/^x+$/u));
  } finally {
    operation.return(undefined);
  }
});

it.each(WHOLE_REQUESTS)(
  "keeps policy refusal when bytes disappear without diagnostics: %s",
  (_name, request) => {
    const input = enc.encode('{a:1,"b":"' + "x".repeat(128) + '"}');
    const operation = wholeOperation(
      request,
      input,
      resolveOptions({ recover: { "unquoted-key": false } }),
      undefined,
      64,
    );
    try {
      let step = operation.next();
      expect(step.done).toBe(false);
      structuredClone(input.buffer, { transfer: [input.buffer] });
      while (step.done !== true) step = operation.next();
      expect(step.value).toMatchObject({
        ok: false,
        failure: {
          kind: "invalid-input",
          cause: { kind: "policy-refused" },
          recovered: {
            value: { a: 1 },
            complete: false,
          },
        },
      });
      expect(step.value).toHaveProperty(
        "failure.recovered.value.b",
        expect.stringMatching(/^x+$/u),
      );
      expect(step.value).not.toHaveProperty("diagnostics");
    } finally {
      operation.return(undefined);
    }
  },
);

it.each(["parse", repairOperation] as const)(
  "does not report a decoded root as success when later bytes disappear: %s",
  (request) => {
    const input = enc.encode('{"a":1}' + " ".repeat(128));
    const operation = wholeOperation(request, input, resolveOptions(), undefined, 64);
    try {
      let step = operation.next();
      expect(step.done).toBe(false);
      structuredClone(input.buffer, { transfer: [input.buffer] });
      while (step.done !== true) step = operation.next();
      expect(step.value).toMatchObject({
        ok: false,
        failure: { kind: "invalid-input", recovered: { value: { a: 1 }, complete: true } },
      });
    } finally {
      operation.return(undefined);
    }
  },
);

it("keeps the original byte window when its backing buffer grows", () => {
  const text = '{"a":1,"b":"' + "x".repeat(128);
  const encoded = enc.encode(text);
  const buffer = new ArrayBuffer(encoded.length, { maxByteLength: encoded.length + 2 });
  const input = new Uint8Array(buffer);
  input.set(encoded);
  const operation = wholeOperation("parse", input, resolveOptions(), undefined, 64);
  try {
    let step = operation.next();
    expect(step).toEqual({ done: false, value: { kind: "checkpoint" } });
    buffer.resize(encoded.length + 2);
    input.set(enc.encode('"}'), encoded.length);
    while (step.done !== true) step = operation.next();
    expect(step.value).toEqual(parse(text));
  } finally {
    operation.return(undefined);
  }
});

it.each(
  WHOLE_REQUESTS.flatMap(([name, request]) =>
    (["input", "abort", "scheduler"] as const).flatMap((stop) =>
      [false, true].map(
        (selected) => [name, stop, selected ? "selected" : "whole", request, selected] as const,
      ),
    ),
  ),
)(
  "keeps filtered %s recovery on %s stop with %s output",
  (_name, stop, _shape, request, selected) => {
    const text = '{"a":1}' + " ".repeat(256);
    const input = stop === "input" ? enc.encode(text) : text;
    const controller = new AbortController();
    const options = resolveOptions({
      requiredKeys: ["wanted"],
      builtinParsers: false,
      ...(selected ? { select: select([["a"]]) } : {}),
    });
    const operation = wholeOperation(request, input, options, controller.signal, 64);
    const schedulerFailure = { kind: "scheduling-failed", cause: "host stopped" } as const;
    try {
      const first = operation.next();
      expect(first).toEqual({ done: false, value: { kind: "checkpoint" } });
      if (typeof input !== "string") structuredClone(input.buffer, { transfer: [input.buffer] });
      if (stop === "abort") controller.abort("caller stopped");
      let step = operation.next(stop === "scheduler" ? schedulerFailure : undefined);
      while (step.done !== true) step = operation.next();
      expect(step.value).toMatchObject({
        ok: false,
        failure: {
          kind:
            stop === "input" ? "invalid-input" : stop === "abort" ? "aborted" : "scheduling-failed",
          recovered: { complete: true, value: selected ? [{ path: ["a"], value: 1 }] : { a: 1 } },
        },
      });
    } finally {
      operation.return(undefined);
    }
  },
);

it("does not replay filtered fallback after a matching root was delivered", async () => {
  const input = enc.encode('{"a":1}\n{"wanted":2}' + " ".repeat(2048));
  const stream = parseManyAsync(input, { execution: cooperative, requiredKeys: ["wanted"] });
  try {
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { ok: true, value: { wanted: 2 } },
    });
    structuredClone(input.buffer, { transfer: [input.buffer] });
    const stopped = await stream.next();
    expect(stopped).toMatchObject({
      done: false,
      value: { ok: false, failure: { kind: "invalid-input" } },
    });
    expect(stopped).not.toHaveProperty("value.failure.recovered");
    expect((await stream.next()).done).toBe(true);
  } finally {
    await stream.return(undefined);
  }
});

it.each(["whole", "selected"] as const)(
  "keeps live %s recovery ahead of an older filtered fallback",
  (shape) => {
    const controller = new AbortController();
    const input = '{"a":1}\n{"wanted":{"b":"' + "x".repeat(256) + '"}}';
    const operation = wholeOperation(
      "parse",
      input,
      resolveOptions({
        builtinParsers: false,
        requiredKeys: ["wanted"],
        ...(shape === "selected" ? { select: select([["a"], ["wanted"]]) } : {}),
      }),
      controller.signal,
      64,
    );
    try {
      expect(operation.next()).toEqual({ done: false, value: { kind: "checkpoint" } });
      controller.abort("caller stopped");
      let step = operation.next();
      while (step.done !== true) step = operation.next();
      expect(step.value).toMatchObject({
        ok: false,
        failure: { kind: "aborted", recovered: { complete: false } },
      });
      expect(step.value).toHaveProperty(
        shape === "selected"
          ? "failure.recovered.value.0.value.b"
          : "failure.recovered.value.wanted.b",
        expect.stringMatching(/^x+$/u),
      );
      if (shape === "selected")
        expect(step.value).toHaveProperty("failure.recovered.value.0.path", ["wanted"]);
    } finally {
      operation.return(undefined);
    }
  },
);

it.each(
  (["eof", "many-eof", "abort", "input"] as const).flatMap((stop) =>
    ["whole", "selected"].map((shape) => [stop, shape] as const),
  ),
)("keeps the fallback report on %s with %s output", (stop, shape) => {
  const text = "{a:1}\n{b:2}" + " ".repeat(256);
  const options = {
    diagnostics,
    requiredKeys: ["wanted"],
    builtinParsers: false,
    ...(shape === "selected" ? { select: select([["a"]]) } : {}),
  };
  const first = parse(stop === "input" ? enc.encode("{a:1}") : "{a:1}", {
    diagnostics,
    ...(shape === "selected" ? { select: select([["a"]]) } : {}),
  });
  let result: unknown;
  if (stop === "eof") result = parse(text, options);
  else if (stop === "many-eof") result = [...parseMany(text, options)].at(-1);
  else {
    const input = stop === "input" ? enc.encode(text) : text;
    const controller = new AbortController();
    const operation = wholeOperation(
      "parse",
      input,
      resolveOptions(options),
      controller.signal,
      64,
    );
    try {
      expect(operation.next()).toEqual({ done: false, value: { kind: "checkpoint" } });
      if (typeof input === "string") controller.abort("caller stopped");
      else structuredClone(input.buffer, { transfer: [input.buffer] });
      let step = operation.next();
      while (step.done !== true) step = operation.next();
      result = step.value;
    } finally {
      operation.return(undefined);
    }
  }
  expect(result).toMatchObject({
    ok: false,
    diagnostics: {
      repairs: first.diagnostics.repairs,
      counts: { repairs: 1, errors: 0 },
      confidence: first.diagnostics.confidence,
    },
  });
  expect(result).not.toHaveProperty("failure.recovered.diagnostics");
});

it("keeps failed byte-stream recovery separate from earlier delivered roots", async () => {
  const input = enc.encode('{"first":1}\n{"b":"' + "x".repeat(2048) + '"}');
  const stream = parseManyAsync(input, { execution: cooperative });
  try {
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { ok: true, value: { first: 1 } },
    });
    structuredClone(input.buffer, { transfer: [input.buffer] });
    const stopped = await stream.next();
    expect(stopped).toMatchObject({
      done: false,
      value: {
        ok: false,
        failure: {
          kind: "invalid-input",
          recovered: { complete: false, cut: { kind: "string", path: ["b"] } },
        },
      },
    });
    if (stopped.done === true || stopped.value.ok || stopped.value.failure.kind !== "invalid-input")
      throw new Error("lost byte storage must retain a failed recovery");
    const value = stopped.value.failure.recovered?.value;
    if (typeof value !== "object" || value === null || !("b" in value))
      throw new Error("failed recovery must keep the consumed second root");
    expect(value.b).toMatch(/^x+$/u);
    expect((await stream.next()).done).toBe(true);
  } finally {
    await stream.return(undefined);
  }
});

it("continues decoded bytes after the caller transfers their original buffer", async () => {
  const input = enc.encode('{"first":1}\n{"second":2}');
  const stream = parseManyAsync(input, { execution: cooperative });
  try {
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { ok: true, value: { first: 1 } },
    });
    structuredClone(input.buffer, { transfer: [input.buffer] });
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { ok: true, value: { second: 2 } },
    });
    expect((await stream.next()).done).toBe(true);
  } finally {
    await stream.return(undefined);
  }
});

describe("one-shot bytes", () => {
  it("decodes once, reports in bytes, and replaces malformed sequences at their bytes", () => {
    const r = parse(bytes('{"é":"', [0xff], 'x"}'), REPORT);
    expect(r).toEqual({
      ok: true,
      complete: true,
      value: { é: "�x" },
      span: { start: { offset: 0, unit: "byte" }, end: { offset: 11, unit: "byte" } },
      diagnostics: expect.objectContaining({
        errors: [
          expect.objectContaining({
            kind: "invalid-utf8",
            at: { offset: 7, unit: "byte" },
            path: ["é"],
          }),
        ],
      }) as unknown,
    });
    expect(findJsonSpan(enc.encode('  {"a":1}  '))).toEqual({
      ok: true,
      value: { start: { offset: 2, unit: "byte" }, end: { offset: 9, unit: "byte" } },
    });
    expect(repair(bytes('{"é":"', [0xff], 'x"}'))).toEqual({
      ok: true,
      complete: true,
      value: '{"é":"�x"}',
    });
    expect([...parseMany(enc.encode('{"a":1}\n{"b":2}'))].map((i) => i.ok && i.value)).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it("gives clean bytes the same value as the same text, on the native path too", () => {
    const text = '{"a":[1,2,"é"]}';
    const fromBytes = parse(enc.encode(text), REPORT);
    expect(fromBytes.ok && fromBytes.value).toEqual(JSON.parse(text) as unknown);
    expect(fromBytes.ok && fromBytes.span.end).toEqual({
      offset: enc.encode(text).length,
      unit: "byte",
    });
  });

  it("strips a leading UTF-8 mark with a free repair, and refuses UTF-16 and UTF-32 marks", () => {
    const r = parse(bytes([0xef, 0xbb, 0xbf], '{"a":1}'), REPORT);
    expect(r.ok && r.span.start).toEqual({ offset: 3, unit: "byte" });
    expect(r.diagnostics.repairs).toEqual([
      { kind: "bom-removed", at: { offset: 0, unit: "byte" }, path: [], valueIndex: 0 },
    ]);
    expect(r.diagnostics.confidence).toBe(1);
    // As text too, and the value after it is still standalone; a later U+FEFF is data.
    expect(repair('﻿{"a":1}')).toEqual({ ok: true, complete: true, value: '{"a":1}' });
    expect(parse("﻿1")).toEqual({ ok: true, complete: true, value: 1 });
    expect(parse('["﻿"]')).toEqual({ ok: true, complete: true, value: ["﻿"] });
    expect(rejected([0xfe, 0xff, 0, 0x7b])).toEqual({
      ok: false,
      failure: { kind: "unsupported-encoding", encoding: "utf-16be" },
    });
    expect(rejected([0xff, 0xfe, 0x7b, 0])).toMatchObject({ failure: { encoding: "utf-16le" } });
    expect(rejected([0xff, 0xfe, 0, 0])).toMatchObject({ failure: { encoding: "utf-32le" } });
    expect(rejected([0, 0, 0xfe, 0xff])).toMatchObject({ failure: { encoding: "utf-32be" } });
    // A stray FE is not a mark, just a malformed byte. What it decodes to, `\uFFFD1`, is then a lone
    // unquoted root, which is refused like any other (`test/root-word.test.ts`).
    expect(
      parse(new Uint8Array([0xfe, 0x31]), REPORT).diagnostics.errors.map(
        (e) => e.refused ?? e.kind,
      ),
    ).toEqual(["invalid-utf8", "unquoted-root-string"]);
  });
});

/**
 * Every reported offset in `value`, mapped back to the whole input: a chunk-local offset plus the
 * lengths of the chunks before it. Walks the result rather than naming fields, so a position added
 * to a report later is covered without editing this.
 */
const absolutes = (v: unknown, chunks: readonly string[], out: number[]): void => {
  if (v === null || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (typeof o.offset === "number" && typeof o.unit === "string") {
    const c = o.chunk;
    const base = typeof c === "number" ? chunks.slice(0, c).reduce((n, s) => n + s.length, 0) : 0;
    out.push(base + o.offset);
    return;
  }
  for (const x of Object.values(o)) absolutes(x, chunks, out);
};

const positions = (v: unknown, chunks: readonly string[]): number[] => {
  const out: number[] = [];
  absolutes(v, chunks, out);
  return out;
};

describe("stream positions", () => {
  it("delivers a decoder-budget failure as soon as the continued token settles", () => {
    const stream = createStreamParser({ ...REPORT, maxErrors: 1 });
    expect([...stream.feed(bytes('{"a":foo', [0x81]))]).toEqual([]);
    const items = [...stream.feed("bar, b:2}")];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      ok: false,
      failure: {
        kind: "limit-reached",
        resource: "errors",
        limit: 1,
        at: { offset: 8, unit: "byte", chunk: 0 },
        recovered: { value: { a: "foo�bar" } },
      },
      diagnostics: { counts: { errors: 1 }, scanComplete: false },
    });
    // A settled failure closes the stream; EOF must neither trigger nor repeat recovery.
    expect([...stream.end()]).toMatchObject([{ failure: { kind: "stream-closed" } }]);
  });

  const drain = (chunks: (string | Uint8Array)[]) => {
    const sp = createStreamParser(REPORT);
    return [...chunks.flatMap((c) => [...sp.feed(c)]), ...sp.end()];
  };

  it("names the chunk and counts in its unit, placing a split character at its lead byte", () => {
    const euro = enc.encode('["€x');
    const tail = new Uint8Array([0x22, 0x2c, 0xc3, 0x5d]);
    const [item] = drain(['{"a":', euro.slice(0, 3), euro.slice(3), tail]);
    if (item?.ok !== true) throw new Error(inspect(item));
    expect(item).toMatchObject({
      ok: true,
      value: { a: ["€x", "�"] },
      span: {
        start: { offset: 0, unit: "utf16", chunk: 0 },
        end: { offset: 4, unit: "byte", chunk: 3 },
      },
    });
    expect(item.diagnostics.repairs.map((r) => [r.kind, r.at])).toEqual([
      ["unquoted-string", { offset: 2, unit: "byte", chunk: 3 }],
      ["unclosed-object", { offset: 4, unit: "byte", chunk: 3 }],
    ]);
    expect(item.diagnostics.errors.map((e) => e.at)).toEqual([
      { offset: 2, unit: "byte", chunk: 3 },
    ]);
    // The euro sign began in chunk 1 at byte 2, though it finished in chunk 2; an empty text chunk
    // between them supplies nothing and does not end the sequence.
    const [string] = drain([euro.slice(0, 3), "", euro.slice(3)]);
    if (string?.ok !== true) throw new Error(inspect(string));
    expect(string.diagnostics.repairs[0]?.at).toEqual({ offset: 1, unit: "byte", chunk: 0 });
    expect(string.diagnostics.errors).toEqual([]);
  });

  it("refuses a mark split across chunks, and keeps a mark split from its value", () => {
    // The mark completes with the second byte, but nothing is decoded until the text chunk flushes
    // the decoder, so the refusal surfaces there; the closed stream then answers `end()`.
    const items = drain([new Uint8Array([0xff]), new Uint8Array([0xfe]), "[1]"]);
    expect(items.map((i) => !i.ok && i.failure)).toEqual([
      { kind: "unsupported-encoding", encoding: "utf-16le" },
      { kind: "stream-closed" },
    ]);
    const [item] = drain(["", "﻿", "[1]"]);
    if (item?.ok !== true) throw new Error(inspect(item));
    expect(item).toMatchObject({
      value: [1],
      span: { start: { offset: 0, unit: "utf16", chunk: 2 } },
    });
    expect(item.diagnostics.repairs[0]?.at).toEqual({ offset: 0, unit: "utf16", chunk: 1 });
  });

  /**
   * Where a chunk boundary falls must not move where anything IS. Held over every split of each
   * text rather than at chosen boundaries, because the defect this caught was invisible at most of
   * them: a `SourceMark` was built from the REPORTED offset instead of the absolute one, so
   * `errorAt` converted a second time. Under one-shot text `positionAt` is the identity and the two
   * readings are the same number, which is why nothing but a stream can see it.
   */
  it("reports the same source locations however the input is split", () => {
    for (const text of [
      '{"a":"x\'}',
      '{"key1": "value1","key2": "value2\',\'key3": "value3"}',
      '{"a": /*c*/ 1, b: [2, 3,], "c": \'d\'}',
    ]) {
      const control = parse(text, REPORT);
      expect(control.ok).toBe(true);
      const whole = positions(control, []);
      for (let at = 1; at < text.length; at++) {
        const chunks = [text.slice(0, at), text.slice(at)];
        const [item, ...rest] = drain(chunks);
        expect(item).toMatchObject({ ok: true });
        expect([text, at, rest]).toEqual([text, at, []]);
        expect([text, at, positions(item, chunks)]).toEqual([text, at, whole]);
      }
    }
  });
});
