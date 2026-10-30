// SPDX-License-Identifier: Apache-2.0

/** Define async benchmark cases and their synchronous public outcome oracle once. */

import {
  ANY,
  ANY_DEPTH,
  findJsonSpan,
  parse,
  parseMany,
  repair,
  diagnostics,
  select,
} from "partial-json-repair";
import type { Input, ParserOptions } from "partial-json-repair";
import { canonical } from "../scripts/corpus/canonical";

export type AsyncOperation = "parse" | "parseMany" | "repair" | "findJsonSpan";

export type AsyncWorkload = {
  readonly id: string;
  readonly input: Input;
  readonly operation: AsyncOperation;
  readonly options?: ParserOptions;
};

const repeatToSize = (body: string, size: number): string =>
  body.repeat(Math.ceil(size / body.length)).slice(0, size);

// A clean array needs whole tokens; clipping `0,` at an odd size leaves an invalid leading zero.
const arrayItems = (size: number): string => "0,".repeat(Math.floor(size / 2));

const spanStringWorkload = (size: number, earlyRoot: boolean): Omit<AsyncWorkload, "id"> => {
  // Equal length and limits isolate a whole string from an early marked object plus trailing text.
  const prefix = '"x"{"a":1}';
  const width = Math.max(size + 2, prefix.length);
  return {
    input: earlyRoot ? prefix + " ".repeat(width - prefix.length) : `"${"x".repeat(width - 2)}"`,
    operation: "findJsonSpan",
    options: { maxScalar: width, maxBuffer: width, maxRetained: width },
  };
};

const selectedDeepPath = (
  size: number,
  path: "literal" | "recursive",
): Omit<AsyncWorkload, "id"> => {
  const depth = Math.max(1, Math.floor(size / 6));
  return {
    input: '{"a":'.repeat(depth - 1) + '{"leaf":1}' + "}".repeat(depth - 1),
    operation: "parse",
    options: {
      maxDepth: depth + 1,
      // Compact selectors miss caller-sized literal-path validation and worker request transfer.
      select:
        path === "literal"
          ? select([Array.from({ length: depth - 1 }, () => "a").concat("leaf")])
          : select([[ANY_DEPTH, "leaf"]]),
    },
  };
};

const workloadFactories: Record<string, (size: number) => Omit<AsyncWorkload, "id">> = {
  "clean-array": (size) => ({ input: `[${arrayItems(size)}0]`, operation: "parse" }),
  // Match the text case byte for byte so decoding cost is measured without changing the job.
  "clean-bytes": (size) => ({
    input: new TextEncoder().encode(`[${arrayItems(size)}0]`),
    operation: "parse",
  }),
  "clean-repair": (size) => ({
    input: `[${arrayItems(size)}0]`,
    operation: "repair",
    options: { diagnostics: false },
  }),
  "nested-array": (size) => ({
    input: `${"[".repeat(256)}${arrayItems(size)}0${"]".repeat(256)}`,
    operation: "parse",
  }),
  "deep-long-keys": (size) => {
    // Vary key width at fixed depth to expose repeated ancestor-key transfer costs.
    const depth = 256;
    const key = "k".repeat(Math.max(1, Math.floor(size / depth)));
    return {
      input: `{"${key}":`.repeat(depth) + "9007199254740993" + "}".repeat(depth),
      operation: "parse",
      options: { nullPrototype: true, maxScalar: Math.max(32, size * 2) },
    };
  },
  "single-long-key": (size) => ({
    // One key cannot be split by the current member-batch protocol; vary its receipt cost directly.
    input: `{"${"k".repeat(size)}":9007199254740993}`,
    operation: "parse",
    options: { nullPrototype: true, maxScalar: Math.max(32, size * 2) },
  }),
  "plain-string": (size) => ({
    input: `"${repeatToSize("x", size)}"`,
    operation: "parse",
    options: { maxScalar: size * 2 },
  }),
  "escaped-string": (size) => ({
    input: `"${repeatToSize("\\n", size)}"`,
    operation: "parse",
    options: { maxScalar: size * 2 },
  }),
  "exact-digits": (size) => ({
    input: repeatToSize("1234567890", size),
    operation: "parse",
    options: { exactNumbers: true, maxScalar: size * 2 },
  }),
  "ordinary-digits": (size) => ({
    // Long canonical integers overflow in ordinary mode and still require lossless exact output.
    input: repeatToSize("1234567890", size),
    operation: "parse",
    options: { maxScalar: size * 2 },
  }),
  "nested-exact-digits": (size) => ({
    input: `[${repeatToSize("1234567890", size)}]`,
    operation: "parse",
    options: { exactNumbers: true, maxScalar: size * 2 },
  }),
  "overlapping-exact-digits": (size) => ({
    // Ancestor matches share one exact leaf; transfer must reuse it rather than count it per match.
    input: '{"a":'.repeat(64) + repeatToSize("1234567890", size) + "}".repeat(64),
    operation: "parse",
    options: {
      exactNumbers: true,
      maxScalar: size * 2,
      select: select([[], [ANY_DEPTH, "a"]]),
    },
  }),
  "dense-repair": (size) => ({
    input: `{${repeatToSize("a:0 ", size)}}`,
    operation: "repair",
    options: { diagnostics },
  }),
  "reverse-edits": (size) => ({
    input: `[0${repeatToSize(",", size)}]`,
    operation: "repair",
    options: { diagnostics: false },
  }),
  "selected-scalar": (size) => ({
    input: `{skip:"${repeatToSize("x", size)}",keep:1}`,
    operation: "parse",
    options: { maxScalar: size * 2, select: select([["keep"]]) },
  }),
  "early-selected-root": (size) => ({
    // Match selected-scalar's input length and options: neither predicts work before the first root.
    input: `{keep:1}${repeatToSize(" ", size + 8)}`,
    operation: "parse",
    options: { maxScalar: size * 2, select: select([["keep"]]) },
  }),
  "early-selected-bytes": (size) => ({
    // Decoding a suffix after first-root recovery is work the text counterpart never performs.
    input: new TextEncoder().encode(`{keep:1}${repeatToSize(" ", size + 8)}`),
    operation: "parse",
    options: { maxScalar: size * 2, select: select([["keep"]]) },
  }),
  "selected-array": (size) => ({
    // The same selector can return a large subtree; input size and selection alone cannot bound receipt cost.
    input: `{skip:1,keep:[${arrayItems(size)}0]}`,
    operation: "parse",
    options: { maxScalar: size * 2, select: select([["keep"]]) },
  }),
  "selected-deep-path": (size) => selectedDeepPath(size, "recursive"),
  "selected-deep-literal": (size) => selectedDeepPath(size, "literal"),
  "selected-repair": (size) => ({
    input: `{"items":[${"{name:'café',v:[1,2,]},".repeat(Math.max(1, Math.floor(size / 24)))}{name:'fin',v:[1,2`,
    operation: "repair",
    options: {
      select: select([
        ["items", ANY],
        ["items", ANY, "v"],
      ]),
    },
  }),
  // The large overlap case cannot price the fixed cost of repairing one selected value.
  "selected-repair-one": () => ({
    input: "{skip:0,keep:{name:'café',v:[1,2,]}}",
    operation: "repair",
    options: { select: select([["keep"]]) },
  }),
  "candidate-noise": (size) => ({
    input: `${repeatToSize("noise ", size)}{answer:1}`,
    operation: "findJsonSpan",
  }),
  "many-roots": (size) => ({ input: repeatToSize("{a:0} ", size), operation: "parseMany" }),
  // Final matches can drain after scanning ends; this route exposes delivery-only scheduling cost.
  "selected-many": (size) => ({
    input: `{"items":[${"0,".repeat(Math.max(1, Math.floor(size / 2)))}0]}`,
    operation: "parseMany",
    options: { select: select([["items", ANY]]) },
  }),
  // Span lookup assembles all matches before its one delivery; scanning alone does not bound it.
  "selected-spans": (size) => ({
    input: `{"items":[${arrayItems(size)}0]}`,
    operation: "findJsonSpan",
    options: { select: select([["items", ANY]]) },
  }),
  "span-string": (size) => spanStringWorkload(size, false),
  "span-early-root": (size) => spanStringWorkload(size, true),
  "malformed-bytes": (size) => ({
    input: new Uint8Array(size).fill(0xff),
    operation: "parse",
    options: { maxScalar: size * 2 },
  }),
  "null-prototype": () => ({
    input: '{"__proto__":{"polluted":true},"constructor":{"safe":true}}',
    operation: "parse",
    options: { nullPrototype: true, onDangerousKey: "keep" },
  }),
  "refused-root": (size) => ({
    input: `{ok:true,payload:"${repeatToSize("x", size)}"}`,
    operation: "parse",
    options: { requiredKeys: ["missing"] },
  }),
  "bounded-scalar": (size) => ({
    input: `{value:"${repeatToSize("x", size)}"}`,
    operation: "parse",
    options: { maxScalar: Math.max(1, Math.floor(size / 8)) },
  }),
};

export const asyncWorkloadIds = (): readonly string[] => Object.keys(workloadFactories);

// Filter factories before allocating input; a narrow large-input probe must pay only for its job.
export const asyncWorkloads = (
  size: number,
  accepts: (id: string) => boolean = () => true,
): readonly AsyncWorkload[] =>
  Object.entries(workloadFactories)
    .filter(([id]) => accepts(id))
    .map(([id, build]) => Object.assign({ id }, build(size)));

export const expectedAsyncOutcome = (
  { input, operation, options }: AsyncWorkload,
  cancelAfterFirst = false,
  encode: (value: unknown) => string = canonical,
): string => {
  const result = (() => {
    switch (operation) {
      case "parse":
        return options === undefined ? parse(input) : parse(input, options);
      case "parseMany": {
        const values = options === undefined ? parseMany(input) : parseMany(input, options);
        if (!cancelAfterFirst) return [...values];
        try {
          // A delivered root must survive cancellation without redelivery or a successful tail.
          const first = values.next();
          if (first.done || !first.value.ok)
            throw new Error("cancellation workload must deliver a successful first value");
          return [
            first.value,
            { ok: false, failure: { kind: "aborted", reason: "benchmark stop" } },
          ];
        } finally {
          values.return?.(undefined);
        }
      }
      case "repair":
        return options === undefined ? repair(input) : repair(input, options);
      case "findJsonSpan":
        return options === undefined ? findJsonSpan(input) : findJsonSpan(input, options);
    }
    throw new Error(`unknown async benchmark operation: ${String(operation)}`);
  })();
  return encode(result);
};
