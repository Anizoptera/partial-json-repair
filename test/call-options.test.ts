// SPDX-License-Identifier: Apache-2.0

/** Per-call settings must change one operation without reconfiguring another consumer. */
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import type { ParserOptions } from "../src/index";
import {
  findJsonSpan,
  createStreamParser,
  initParser,
  parse,
  parseMany,
  repair,
  diagnostics,
  locations,
  select,
  skip,
  createMetrics,
  parseStream,
  stringify,
} from "../src/index";
import { auto, initAsyncParser, parseAsync } from "../src/async";
import { configurationCause, rejectedCause } from "./configuration-error";

// Enumerability is a serialization attribute, not permission to silently ignore a setting.
const nonenumerable = <Options extends object>(options: Options): Options => {
  for (const name of Object.keys(options))
    Object.defineProperty(options, name, { enumerable: false });
  return options;
};

it("honors nonenumerable limits through constructors, wrappers and per-call overrides", async () => {
  const input = '{"a":[1]}';
  const options = nonenumerable({ maxDepth: 1 });
  const failure = { ok: false, failure: { kind: "limit-reached", resource: "depth" } };
  expect(parse(input, options)).toMatchObject(failure);
  expect(parse(input, initParser(options))).toMatchObject(failure);
  expect(parse(input, initParser(), options)).toMatchObject(failure);
  expect(parse(input, createMetrics(options))).toMatchObject(failure);
  const stream = createStreamParser(options);
  try {
    // A root ending the chunk waits for the next character, which could start a list.
    expect([...stream.feed(`${input}\n`)]).toMatchObject([failure]);
  } finally {
    stream.close();
  }
  const pulled = parseStream([input], options);
  try {
    expect(await Array.fromAsync(pulled)).toMatchObject([failure]);
  } finally {
    await pulled.close();
  }
  // Copied by descriptor: a spread would drop the nonenumerable limit under test.
  const asyncOptions = Object.defineProperties(
    { execution: auto },
    Object.getOwnPropertyDescriptors(options),
  );
  expect(await parseAsync(input, asyncOptions)).toMatchObject(failure);
  const parser = initAsyncParser(asyncOptions);
  const overridden = initAsyncParser({ execution: auto });
  try {
    expect(await parseAsync(input, parser)).toMatchObject(failure);
    expect(await parseAsync(input, overridden, options)).toMatchObject(failure);
  } finally {
    parser.close();
    overridden.close();
  }
});

it("validates hidden helper settings and recovery switches", () => {
  expect(stringify("abcdef", nonenumerable({ maxOutput: 2 }))).toMatchObject({
    ok: false,
    failure: { kind: "limit-reached", resource: "output" },
  });
  expect(parse("[1,]", { recover: nonenumerable({ "trailing-comma": false }) })).toMatchObject({
    ok: false,
    failure: { kind: "policy-refused" },
  });
  expect(configurationCause(() => parse("[]", nonenumerable({ maxDepht: 1 }) as never))).toEqual({
    kind: "invalid-options",
    field: "maxDepht",
    reason: "unknown",
  });
  expect(configurationCause(() => diagnostics(nonenumerable({ maxEntires: 1 }) as never))).toEqual({
    kind: "invalid-options",
    field: "diagnostics.maxEntires",
    reason: "unknown",
  });
});

it("refuses null execution instead of silently choosing automatic execution", async () => {
  expect(await rejectedCause(parseAsync("[]", { execution: null } as never))).toEqual({
    kind: "invalid-options",
    field: "execution",
    reason: "execution",
  });
});

it.each(["maxDepth", "maxScalar", "maxErrors", "maxBuffer", "maxRetained"] as const)(
  "refuses a null %s instead of silently replacing the requested bound",
  async (field) => {
    const options = { [field]: null } as never;
    const defaults: ParserOptions = { [field]: 1 };
    const expected = { kind: "invalid-options", field, reason: "positive-integer" };
    for (const call of [
      () => parse("[[1]]", options),
      () => initParser(options),
      () => parse("[[1]]", initParser(defaults), options),
      () => createStreamParser(options),
    ])
      expect(configurationCause(call)).toEqual(expected);
    expect(
      await rejectedCause(parseAsync("[[1]]", { execution: auto, [field]: null } as never)),
    ).toEqual(expected);
  },
);

it("overrides a recovery flag for one call without changing the configured parser", () => {
  const parser = initParser({ diagnostics });
  const refused = parse("[1,]", parser, { allowTrailingComma: false, diagnostics: false });
  expect(refused).toMatchObject({ ok: false, failure: { kind: "policy-refused" } });
  expect(refused).not.toHaveProperty("diagnostics");
  expect(parse("[1,]", parser)).toMatchObject({ ok: true, value: [1], diagnostics: {} });
});

it("keeps the parser's setting when a call passes `undefined` for it, sync and async", async () => {
  // A wrapper forwarding `{ maxDepth: opts.depth }` with no depth set must not reset a configured
  // limit to the package default; that loosened `maxDepth: 1` to 512 and parsed `[[1]]`.
  // A JavaScript caller, or TypeScript without `exactOptionalPropertyTypes`, can pass `undefined`.
  const unset = { maxDepth: undefined } as never;
  const depth = { ok: false, failure: { kind: "limit-reached", resource: "depth" } };
  expect(parse("[[1]]", initParser({ maxDepth: 1 }), unset)).toMatchObject(depth);
  const asyncParser = initAsyncParser({ execution: auto, maxDepth: 1 });
  expect(await parseAsync("[[1]]", asyncParser, unset)).toMatchObject(depth);
  // A misspelt key is still refused whatever its value.
  expect(
    configurationCause(() => parse("[1]", initParser({}), { maxDeph: undefined } as never)),
  ).toEqual({ kind: "invalid-options", field: "maxDeph", reason: "unknown" });
});

it("keeps selector and policy settings independent of caller mutation and lazy iteration", () => {
  const paths: string[][] = [["a"]];
  const settings = { select: select(paths), recover: { "trailing-comma": true } };
  const built = initParser(settings);
  paths[0]?.splice(0, 1, "b");
  settings.recover["trailing-comma"] = false;
  const input = '{"a":[1,],"b":2}';
  const first = parseMany(input, built, { allowTrailingComma: false });
  const secondPaths: string[][] = [["b"]];
  const secondOptions: { select: typeof settings.select; diagnostics: false | typeof diagnostics } =
    { select: select(secondPaths), diagnostics };
  const second = parseMany(input, built, secondOptions);
  secondPaths[0]?.splice(0, 1, "a");
  secondOptions.diagnostics = false;
  expect([...second]).toMatchObject([
    { ok: true, value: { path: ["b"], value: 2 }, diagnostics: {} },
  ]);
  expect([...first]).toMatchObject([{ ok: true, value: { path: ["a"], value: [1] } }]);
  expect(parse(input, built, { locations })).toMatchObject({
    ok: true,
    value: [{ path: ["a"], value: [1] }],
    span: {},
  });
});

it("uses the same effective options for every one-shot verb", () => {
  const base = {
    diagnostics,
    allowTrailingComma: false,
    recover: { "trailing-comma": true },
  } as const;
  const built = initParser(base);
  const input = '{"a":[1,],"b":2}';
  const cases: ParserOptions[] = [
    { recover: {}, diagnostics: false },
    { select: select([["a"]]), locations },
    { skip: skip([["b"]]), diagnostics: diagnostics({ scope: "all" }) },
    { maxDepth: 1 },
    { builtinParsers: false },
  ];
  for (const options of cases) {
    const effective = { ...base, ...options };
    expect(parse(input, built, options)).toEqual(parse(input, effective));
    expect([...parseMany(input, built, options)]).toEqual([...parseMany(input, effective)]);
    expect(repair(input, built, options)).toEqual(repair(input, effective));
    expect(findJsonSpan(input, built, options)).toEqual(findJsonSpan(input, effective));
  }
  expect(repair(input, built)).toMatchObject({ ok: true, value: '{"a":[1],"b":2}' });
});

it("throws on invalid overrides before reading input", () => {
  const built = initParser({ diagnostics });
  // A detached byte buffer cannot be read; the configuration error must take precedence.
  const input = new Uint8Array([49]);
  structuredClone(input.buffer, { transfer: [input.buffer] });
  const refused = { kind: "invalid-options", field: "maxDepth", reason: "positive-integer" };
  expect(configurationCause(() => parse(input, built, { maxDepth: 0 }))).toEqual(refused);
  expect(configurationCause(() => repair(input, built, { maxDepth: 0 }))).toEqual(refused);
  expect(configurationCause(() => findJsonSpan(input, built, { maxDepth: 0 }))).toEqual(refused);
  // At the call, not on the first pull of the lazy iterator.
  expect(
    configurationCause(() => parseMany(input, built, { maxDepth: 0, diagnostics: false })),
  ).toEqual(refused);
});

it("refuses options that are not a plain object instead of reading them as none", () => {
  // Own-key validation finds nothing on a `Map` or a `Date`, so they once parsed with the defaults.
  // A class instance or an object inheriting its settings would lose any held off its own keys.
  const notObject = { kind: "invalid-options", field: "options", reason: "object" };
  class Settings {
    maxDepth = 1;
  }
  for (const options of [
    new Map([["maxDepth", 1]]),
    new Date(),
    new Settings(),
    Object.create({ maxDepth: 1 }),
  ])
    expect(configurationCause(() => parse("[[1]]", options as never))).toEqual(notObject);
  // Plain from another realm, and with no prototype at all, are still options.
  const depthOne = { ok: false, failure: { kind: "limit-reached", resource: "depth" } };
  expect(parse("[[1]]", runInNewContext("({ maxDepth: 1 })") as never)).toMatchObject(depthOne);
  const bare = Object.assign(Object.create(null) as object, { maxDepth: 1 });
  expect(parse("[[1]]", bare as never)).toMatchObject(depthOne);
});

it("rejects malformed recovery maps and ignores inherited recovery switches", () => {
  const inherited = Object.create({ "trailing-comma": false }) as { "trailing-comma"?: boolean };
  expect(parse("[1,]", { recover: inherited })).toEqual({ ok: true, complete: true, value: [1] });
  // @ts-expect-error -- JavaScript callers still need a typed refusal for null.
  expect(configurationCause(() => parse("[1,]", { recover: null }))).toEqual({
    kind: "invalid-options",
    field: "recover",
    reason: "object",
  });
});

// `options` reports what a configuration resolved to. Parser holds immutable validated options, so
// a write through the reported object (a caller "adjusting" a shared parser) must not reach later calls.
it("reports resolved settings that callers cannot rewrite", async () => {
  const sync = initParser({ maxDepth: 2 });
  const asyncParser = initAsyncParser({ execution: auto, maxDepth: 2 });
  for (const settings of [sync.options, asyncParser.options]) {
    expect(settings.maxDepth).toBe(2);
    try {
      (settings as { maxDepth: number }).maxDepth = 100;
    } catch {
      // A frozen report refusing the write is the other lawful answer.
    }
    expect(settings.maxDepth).toBe(2);
  }
  expect(parse("[[[1]]]", sync)).toMatchObject({ ok: false, failure: { kind: "limit-reached" } });
  expect(await parseAsync("[[[1]]]", asyncParser)).toMatchObject({
    ok: false,
    failure: { kind: "limit-reached" },
  });
  asyncParser.close();
});
