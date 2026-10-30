// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * A worker's result crosses `postMessage`, whose structured clone drops prototypes and frozenness.
 * `describeWorkerValue` records where exact numbers, null-prototype objects and frozen containers
 * sit, and `restoreWorkerValue` puts them back, so a forced worker returns what a cooperative call
 * returns. `async:conform` compares the cooperative verbs only, so this seam is tested here: bounded
 * corpus text and explicit marker hazards, under each profile, must survive describe, clone and
 * restore with the same prototypes and the same frozen containers at every node.
 */

import { readFileSync } from "node:fs";
import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import {
  ANY,
  ANY_DEPTH,
  diagnostics,
  isExactNumber,
  locations,
  parse,
  select,
  STRICT,
} from "../src/index";
import { ExactNumber } from "../src/exact-number";
import { encodeWorkerOptions } from "../src/worker-message";
import { describeWorkerValue, PIECE_WEIGHT, planWorkerPieces } from "../src/worker-output";
import { assembleWorkerPieces } from "../src/worker-executor";
import { restoreWorkerValue } from "../src/worker-receive";
import { same } from "./corpus-population";

const CORPUS = new URL("../corpus/", import.meta.url).pathname;

const texts = (): string[] => {
  const out: string[] = [];
  for (const file of ["corpus.jsonl", "seeds.jsonl"])
    for (const line of readFileSync(`${CORPUS}${file}`, "utf8").split("\n")) {
      if (line === "") continue;
      const row = JSON.parse(line) as { text?: unknown };
      if (typeof row.text === "string" && row.text.length <= 4096) out.push(row.text);
    }
  out.push(
    // Markers nested in arrays, which a walk over object keys alone would miss.
    '[1, 123456789012345678901234567890, {"a": [1e400, {"b": 0.1}]}, [[-0]]]',
    // A string longer than a piece's text run, and a dangerous key in a filled object.
    `{"__proto__": {"x": 1}, "s": "${"long text ".repeat(40)}", "n": [1, 2, 3]}`,
    // An exact number heavier than a piece crosses as one value, never split.
    `1${"0".repeat(200)}`,
  );
  return out;
};

/** First path where frozenness differs, or undefined. `same` already compares prototypes. */
const frozenDifference = (a: unknown, b: unknown, path = "$"): string | undefined => {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return undefined;
  if (Object.isFrozen(a) !== Object.isFrozen(b)) return path;
  for (const key of Object.keys(a)) {
    const found = frozenDifference(Reflect.get(a, key), Reflect.get(b, key), `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Whether an exact number sits anywhere under an array, the case the control below needs. */
const exactInArray = (value: unknown, inArray = false): boolean => {
  if (isExactNumber(value)) return inArray;
  if (typeof value !== "object" || value === null) return false;
  const array = Array.isArray(value);
  return Object.keys(value).some((key) => exactInArray(Reflect.get(value, key), inArray || array));
};

const PROFILES = [
  ["exact numbers", { exactNumbers: true }],
  ["null prototype", { nullPrototype: true }],
  ["report and locations", { diagnostics, locations }],
] as const;

describe("worker transfer restores what structured clone drops", () => {
  const inputs = texts();

  it("does not resend a large member key to restore its exact number", () => {
    // Compare encoded payloads: parent-slot metadata must not duplicate an unbounded source key.
    const key = "k".repeat(65536);
    const small = parse('{"k":9007199254740993}');
    const large = parse(`{"${key}":9007199254740993}`);
    const envelope = describeWorkerValue(large);
    const added = serialize(envelope).byteLength - serialize(describeWorkerValue(small)).byteLength;
    expect(added).toBeGreaterThanOrEqual(key.length - 1);
    expect(added).toBeLessThan(key.length * 1.1);
    const restored = restoreWorkerValue(structuredClone(envelope), ExactNumber);
    expect(same(large, restored)).toBe(true);
    expect(frozenDifference(large, restored)).toBeUndefined();
  });

  it("delivers source cuts and reports before exposing a split recovery", () => {
    // A cut path can itself need pieces; a shell is not evidence that its metadata arrived.
    const key = "nested-key";
    const text = `{"${key}":`.repeat(32) + '{"rows":[{"id":0},{"id":1},{"id":2}';
    const expected = parse(text, { diagnostics });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const sequence = planWorkerPieces(expected, 8, expected);
    expect(sequence).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let ready = false;
    let arrived = false;
    let step = sequence?.next();
    while (step !== undefined && step.done !== true) {
      const piece = step.value;
      assembly.add(structuredClone(piece));
      if (piece.kind === "recovery") {
        ready = true;
        expect(assembly.recovery()).toBeUndefined();
        expect((assembly.value() as typeof expected).cut).toEqual(expected.cut);
        expect((assembly.value() as typeof expected).diagnostics).toEqual(expected.diagnostics);
      }
      const item: unknown =
        piece.kind === "items" && Array.isArray(piece.envelope.value)
          ? piece.envelope.value[0]
          : undefined;
      if (typeof item === "object" && item !== null && Object.hasOwn(item, "id")) {
        expect(ready).toBe(true);
        arrived = true;
        expect(assembly.recovery()?.complete).toBe(false);
        break;
      }
      step = sequence?.next();
    }
    expect(arrived).toBe(true);
  });

  it.each([
    "{rows:[{id:0}],}",
    '"x" /*comment*/',
    "0 /*comment*/",
    "null /*comment*/",
    "false /*comment*/",
    '"" /*comment*/',
    "9007199254740993 /*comment*/",
  ])("keeps light recovery behind its heavier metadata: %s", (text) => {
    // The whole source value fits in a piece; only its requested report causes splitting.
    const expected = parse(text, { diagnostics });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const sequence = planWorkerPieces(expected, 8, expected);
    expect(sequence).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let ready = false;
    let arrived = false;
    for (let step = sequence?.next(); step?.done === false; step = sequence?.next()) {
      const piece = step.value;
      assembly.add(structuredClone(piece));
      if (piece.kind === "recovery") {
        ready = true;
        expect(assembly.recovery()).toBeUndefined();
        expect((assembly.value() as typeof expected).diagnostics).toEqual(expected.diagnostics);
      }
      if (piece.kind === "members" && Object.hasOwn(piece.envelope.value as object, "value")) {
        expect(ready).toBe(true);
        expect(same(assembly.recovery()?.value, expected.value)).toBe(true);
        arrived = true;
        break;
      }
    }
    expect(arrived).toBe(true);
    for (let step = sequence?.next(); step?.done === false; step = sequence?.next())
      assembly.add(structuredClone(step.value));
    expect(same(expected, assembly.value())).toBe(true);
  });

  it("exposes only received mutable array indexes when delivery is interrupted", () => {
    const expected = parse("[" + Array.from({ length: 128 }, (_, index) => index).join(",") + "]");
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const sequence = planWorkerPieces(expected, 8, expected);
    expect(sequence).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let received = 0;
    for (let step = sequence?.next(); step?.done === false; step = sequence?.next()) {
      assembly.add(structuredClone(step.value));
      if (step.value.kind === "items") {
        received += (step.value.envelope.value as unknown[]).length;
        const partial = assembly.recovery()?.value as number[];
        expect(partial).toHaveLength(received);
        expect(Reflect.ownKeys(partial)).toHaveLength(received + 1);
        expect(partial).toEqual(Array.from({ length: received }, (_, index) => index));
      }
    }
    expect(received).toBe(128);
    expect(same(expected, assembly.value())).toBe(true);
  });

  it("restores refusal metadata before partial recovery and keeps wrapper key order", () => {
    const expected = parse('{"rows":[' + '{"id":0},'.repeat(128) + "]}", {
      ...STRICT,
      diagnostics,
    });
    expect(expected.ok).toBe(false);
    if (expected.ok) return;
    expect("recovered" in expected.failure).toBe(true);
    if (!("recovered" in expected.failure)) return;
    const sequence = planWorkerPieces(expected, 8, expected.failure.recovered);
    expect(sequence).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let arrived = false;
    for (let step = sequence?.next(); step?.done === false; step = sequence?.next()) {
      const piece = step.value;
      assembly.add(structuredClone(piece));
      if (!arrived && piece.kind === "items" && Array.isArray(piece.envelope.value)) {
        const row: unknown = piece.envelope.value[0];
        if (typeof row === "object" && row !== null && Object.hasOwn(row, "id")) {
          arrived = true;
          const report = (assembly.value() as typeof expected).diagnostics;
          expect(same(expected.diagnostics, report)).toBe(true);
          expect(frozenDifference(expected.diagnostics, report)).toBeUndefined();
        }
      }
    }
    expect(arrived).toBe(true);
    expect(same(expected, assembly.value())).toBe(true);
  });

  it.each([false, true])("bounds selected-path freezing with one wide path %s", (wide) => {
    const limit = 32;
    const depth = wide ? 128 : 8;
    const rows = wide ? 1 : 96;
    const path = Array.from({ length: depth }, () => "a");
    const input =
      '{"a":'.repeat(depth) +
      `{"rows":[${Array.from({ length: rows }, (_, i) => i).join(",")}]}` +
      "}".repeat(depth);
    const expected = parse(input, {
      maxDepth: depth + 2,
      select: select([[...path, "rows", ANY]]),
    });
    expect(expected.ok).toBe(true);
    const sequence = planWorkerPieces(expected, limit);
    expect(sequence).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    const nativeFreeze = Object.freeze;
    const nativeDefine = Object.defineProperty;
    const previousValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    let inheritedReads = 0;
    let work = 0;
    let frozenWork = 0;
    try {
      const inheritedValue = {
        __proto__: null,
        configurable: true,
        get() {
          inheritedReads++;
          return "invented";
        },
      };
      // eslint-disable-next-line no-extend-native -- Native descriptor conversion must ignore ambient values.
      nativeDefine(Object.prototype, "value", inheritedValue);
      // Observe actual native operations without replacing their behavior; producer work is excluded.
      Object.freeze = (value: unknown) => {
        if (typeof value === "object" && value !== null) work += Reflect.ownKeys(value).length;
        return nativeFreeze(value);
      };
      Object.defineProperty = (target, key, descriptor) => {
        // A first readonly index can convert the entire array; counting calls misses that work.
        if (Array.isArray(target) && key === 0 && descriptor.writable === false)
          expect(target.length).toBeLessThanOrEqual(limit);
        if (descriptor.configurable === false && descriptor.writable === false) work++;
        return nativeDefine(target, key, descriptor);
      };
      for (let step = sequence?.next(); step?.done === false; step = sequence?.next()) {
        const piece = structuredClone(step.value);
        work = 0;
        assembly.add(piece);
        if (piece.kind === "freeze") {
          frozenWork += work;
          // A native small-container freeze can overshoot by one container, never one wide path.
          expect(work).toBeLessThanOrEqual(limit * 2);
        }
      }
    } finally {
      Object.freeze = nativeFreeze;
      Object.defineProperty = nativeDefine;
      Reflect.deleteProperty(Object.prototype, "value");
      if (previousValue !== undefined) nativeDefine(Object.prototype, "value", previousValue);
    }
    expect(inheritedReads).toBe(0);
    expect(frozenWork).toBeGreaterThan(depth * rows);
    expect(same(expected, assembly.value())).toBe(true);
    expect(frozenDifference(expected, assembly.value())).toBeUndefined();
  });

  it("finishes a split first path key before locking its array prefix", () => {
    const key = "long-key-" + "x".repeat(1024);
    const input = `{"${key}":` + '{"a":'.repeat(64) + '{"leaf":1}' + "}".repeat(65);
    const original = parse(input, { maxDepth: 80, select: select([[ANY_DEPTH, "leaf"]]) });
    if (!original.ok) throw new Error("Deep path fixture failed");
    const pieces = planWorkerPieces(original, 8);
    if (pieces === undefined) throw new Error("Path fixture must cross in pieces");
    const assembly = assembleWorkerPieces(ExactNumber);
    for (let piece = pieces.next(); piece.done !== true; piece = pieces.next())
      assembly.add(structuredClone(piece.value));
    const restored = assembly.value() as typeof original;
    expect(same(original, restored)).toBe(true);
    expect(restored.value[0]?.path[0]).toBe(key);
    expect(Object.isFrozen(restored.value[0]?.path)).toBe(true);
  });

  it("keeps deferred freeze messages independent of tree depth and key length", () => {
    let deep: object = Object.freeze({ value: 1 });
    for (let level = 0; level < 600; level++) deep = Object.freeze({ ["k".repeat(256)]: deep });
    const root = Object.freeze({ first: deep, second: deep });
    const sequence = planWorkerPieces(root, 8);
    expect(sequence).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let freezes = 0;
    let addressCharacters = 0;
    for (let step = sequence?.next(); step?.done === false; step = sequence?.next()) {
      const path = Reflect.get(step.value, "path") as readonly string[] | undefined;
      const addresses = Reflect.get(step.value, "addresses") as
        | readonly (readonly [number, object, string | number])[]
        | undefined;
      for (const label of path ?? []) addressCharacters += label.length;
      for (const [, , key] of addresses ?? [])
        addressCharacters += typeof key === "string" ? key.length : String(key).length;
      if (step.value.kind === "items" || step.value.kind === "members")
        for (const [, , key] of step.value.aliases ?? [])
          addressCharacters += typeof key === "string" ? key.length : String(key).length;
      if (step.value.kind === "freeze") {
        freezes++;
        // Freeze commands must not retransmit even one long source key.
        expect(JSON.stringify(step.value).length).toBeLessThan(256);
      }
      assembly.add(structuredClone(step.value));
    }
    expect(freezes).toBeGreaterThan(0);
    // Address metadata may identify each source key, but must not repeat whole ancestor paths.
    expect(addressCharacters).toBeLessThanOrEqual(600 * 256 * 2);
    const restored = assembly.value() as { first: object; second: object };
    expect(restored.first).toBe(restored.second);
    expect(same(root, restored)).toBe(true);
    expect(frozenDifference(root, restored)).toBeUndefined();
  });

  it("bounds deferred freezing with long keys", () => {
    const limit = 8;
    const root = Object.freeze({
      ["a".repeat(256)]: Object.freeze(Array.from({ length: 16 }, (_, index) => index)),
      ["b".repeat(256)]: Object.freeze(Array.from({ length: 16 }, (_, index) => index + 16)),
    });
    const sequence = planWorkerPieces(root, limit);
    expect(sequence).toBeDefined();
    const result = assembleWorkerPieces(ExactNumber);
    let freezePackets = 0;
    for (let step = sequence?.next(); step?.done === false; step = sequence?.next()) {
      if (step.value.kind === "freeze") {
        freezePackets++;
        expect(step.value.count).toBeLessThanOrEqual(limit);
      }
      result.add(structuredClone(step.value));
    }
    expect(freezePackets).toBeGreaterThan(0);
    expect(result.value()).toEqual(root);
    expect(frozenDifference(root, result.value())).toBeUndefined();
  });

  it("batches overlapping selected matches without recounting a linked exact token", () => {
    // Public selection creates independent ancestor containers sharing one immutable exact leaf.
    const text = '{"a":'.repeat(64) + "9".repeat(131072) + "}".repeat(64);
    const outcome = parse(text, { select: select([[], [ANY_DEPTH, "a"]]) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const plan = planWorkerPieces(outcome);
    expect(plan).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let largestBatch = 0;
    if (plan !== undefined)
      for (let step = plan.next(); step.done !== true; step = plan.next()) {
        if (step.value.kind === "items")
          largestBatch = Math.max(largestBatch, (step.value.envelope.value as unknown[]).length);
        assembly.add(structuredClone(step.value));
      }
    // A linked token contributes no repeated text payload; these small match wrappers fit together.
    expect(largestBatch).toBeGreaterThan(2);
    const restored = assembly.value() as typeof outcome;
    expect(same(outcome, restored)).toBe(true);
    const leaves = restored.value.map((match) => {
      let value: unknown = match.value;
      while (typeof value === "object" && value !== null && !isExactNumber(value))
        value = Reflect.get(value, "a");
      return value;
    });
    expect(isExactNumber(leaves[0])).toBe(true);
    expect(leaves.every((leaf) => leaf === leaves[0])).toBe(true);
  });

  it.each([undefined, 2])(
    "preserves selected exact-number aliases with piece limit %s",
    (limit) => {
      const outcome = parse('{"a":9007199254740993,"b":9007199254740993}', {
        select: select([[], ["a"], ["b"]]),
      });
      expect(outcome.ok).toBe(true);
      const plan = planWorkerPieces(outcome, limit);
      expect(plan === undefined).toBe(limit === undefined);
      let restored: unknown;
      if (plan === undefined)
        restored = restoreWorkerValue(structuredClone(describeWorkerValue(outcome)), ExactNumber);
      else {
        const assembly = assembleWorkerPieces(ExactNumber);
        for (let step = plan.next(); step.done !== true; step = plan.next())
          assembly.add(structuredClone(step.value));
        restored = assembly.value();
      }
      const result = restored as {
        ok: true;
        value: [{ value: { a: unknown; b: unknown } }, { value: unknown }, { value: unknown }];
      };
      expect(result.ok).toBe(true);
      expect(isExactNumber(result.value[1].value)).toBe(true);
      expect(result.value[0].value.a).toBe(result.value[1].value);
      expect(result.value[0].value.b).toBe(result.value[2].value);
      // Equal tokens from different source values must not be interned into one object.
      expect(result.value[1].value).not.toBe(result.value[2].value);
    },
  );

  it("restores aliases across array batches before freezing their parents", () => {
    const shared = Object.freeze(
      Object.defineProperty(Object.create(null) as object, "__proto__", {
        enumerable: true,
        value: { a: 1 },
      }),
    );
    // A separate deep branch must keep its frozen shells when aliases delay freezing.
    let deep: object = Object.freeze({ value: 1 });
    for (let level = 0; level < 600; level++) deep = Object.freeze({ child: deep });
    const root = Object.freeze(
      Array.from({ length: 5000 }, (_, index) =>
        index === 0 || index === 4096 ? shared : index === 1 ? deep : Object.freeze({ a: index }),
      ),
    );
    const plan = planWorkerPieces(root);
    expect(plan).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    if (plan !== undefined)
      for (let step = plan.next(); step.done !== true; step = plan.next()) {
        if (step.value.kind === "freeze")
          expect(step.value.count).toBeLessThanOrEqual(PIECE_WEIGHT);
        assembly.add(structuredClone(step.value));
      }
    const restored = assembly.value() as object[];
    expect(same(root, restored)).toBe(true);
    expect(restored[4096]).toBe(restored[0]);
    expect(Object.getPrototypeOf(restored[0])).toBeNull();
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored[0])).toBe(true);
    expect(frozenDifference(root, restored)).toBeUndefined();
  });

  it.each(["array", "object"])(
    "pieces a repeated heavy node in a %s without copying it",
    (shape) => {
      const shared = Object.freeze({
        rows: Object.freeze(Array.from({ length: 5000 }, (_, i) => i)),
      });
      const root =
        shape === "array" ? [shared, shared] : { first: shared, second: { nested: shared } };
      const plan = planWorkerPieces(root);
      expect(plan).toBeDefined();
      const assembly = assembleWorkerPieces(ExactNumber);
      let deliveredNumbers = 0;
      if (plan !== undefined)
        for (let step = plan.next(); step.done !== true; step = plan.next()) {
          if (step.value.kind === "items")
            deliveredNumbers += (step.value.envelope.value as unknown[]).filter(
              (value) => typeof value === "number",
            ).length;
          assembly.add(structuredClone(step.value));
        }
      expect(deliveredNumbers).toBe(shared.rows.length);
      const restored = assembly.value();
      expect(same(root, restored)).toBe(true);
      expect(frozenDifference(root, restored)).toBeUndefined();
      if (Array.isArray(restored)) expect(restored[1]).toBe(restored[0]);
      else {
        const object = restored as { first: object; second: { nested: object } };
        expect(object.second.nested).toBe(object.first);
      }
    },
  );

  it("sends a shared light container's payload once across batches", () => {
    const shared = Object.freeze({ rows: Object.freeze(Array.from({ length: 128 }, (_, i) => i)) });
    const root = Object.freeze(Array.from({ length: 5000 }, () => shared));
    const plan = planWorkerPieces(root);
    expect(plan).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let payloads = 0;
    let registered = 0;
    let aliases = 0;
    if (plan !== undefined)
      for (let step = plan.next(); step.done !== true; step = plan.next()) {
        if (step.value.kind === "items") {
          registered += step.value.addresses?.length ?? 0;
          aliases += step.value.aliases?.length ?? 0;
          expect(step.value.aliases?.length ?? 0).toBeLessThanOrEqual(PIECE_WEIGHT);
          // Clone identity within a batch is cheap; distinct batches must not resend the rows.
          const members = step.value.envelope.value as readonly { rows?: readonly number[] }[];
          payloads += new Set(members.filter((member) => member.rows !== undefined)).size;
        }
        assembly.add(structuredClone(step.value));
      }
    const restored = assembly.value() as (typeof shared)[];
    expect(payloads).toBe(1);
    expect(registered).toBe(1);
    expect(aliases).toBeGreaterThan(0);
    expect(restored).toHaveLength(root.length);
    expect(restored.every((member) => member === restored[0])).toBe(true);
    expect(restored[0]?.rows).toEqual(shared.rows);
    expect(frozenDifference(root, restored)).toBeUndefined();
  });

  it("omits registered light payloads inside frozen wrappers without extra fills", () => {
    const shared = Object.freeze({ rows: Object.freeze(Array.from({ length: 128 }, (_, i) => i)) });
    const root = Object.freeze(
      Array.from({ length: 5000 }, () => Object.freeze({ child: shared })),
    );
    const plan = planWorkerPieces(root);
    expect(plan).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    let payloads = 0;
    let fills = 0;
    if (plan !== undefined)
      for (let step = plan.next(); step.done !== true; step = plan.next()) {
        if (step.value.kind === "members" || step.value.kind === "text") fills++;
        if (step.value.kind === "items") {
          const members = step.value.envelope.value as readonly {
            child: { rows?: readonly number[] };
          }[];
          payloads += new Set(
            members.map((member) => member.child).filter((node) => node.rows !== undefined),
          ).size;
        }
        assembly.add(structuredClone(step.value));
      }
    const restored = assembly.value() as typeof root;
    expect(payloads).toBe(1);
    expect(fills).toBe(0);
    expect(restored).toHaveLength(root.length);
    expect(restored.every((member) => member.child === restored[0]?.child)).toBe(true);
    expect(restored[0]?.child.rows).toEqual(shared.rows);
    expect(frozenDifference(root, restored)).toBeUndefined();
  });

  it("pieces a large refusal without losing its shared diagnostic issue", () => {
    const outcome = parse("[" + '{"a":1},'.repeat(5000) + "]", { ...STRICT, diagnostics });
    const plan = planWorkerPieces(outcome);
    expect(plan).toBeDefined();
    const assembly = assembleWorkerPieces(ExactNumber);
    if (plan !== undefined)
      for (let step = plan.next(); step.done !== true; step = plan.next()) {
        if (step.value.kind === "freeze")
          expect(step.value.count).toBeLessThanOrEqual(PIECE_WEIGHT);
        assembly.add(structuredClone(step.value));
      }
    const restored = assembly.value() as typeof outcome;
    expect(same(outcome, restored)).toBe(true);
    expect(frozenDifference(outcome, restored)).toBeUndefined();
    expect(restored.ok ? undefined : restored.failure.kind).toBe("policy-refused");
    if (!restored.ok && restored.failure.kind === "policy-refused")
      expect(restored.failure.issue).toBe(restored.diagnostics.errors[0]);
  });

  it.each([
    ["object", false],
    ["object", true],
    ["object", "alternating"],
    ["array", false],
    ["array", true],
    ["array", "alternating"],
    ["mixed", true],
    ["mixed", "alternating"],
  ] as const)(
    "preserves a deep %s tree and frozen state (%s) through cloned pieces",
    (shape, frozen) => {
      let root: object = { a: 1 };
      const depth = 1024;
      if (frozen === true) Object.freeze(root);
      for (let level = 0; level < depth; level++) {
        root =
          shape === "array" || (shape === "mixed" && level % 2 === 0)
            ? [root]
            : shape === "mixed"
              ? Object.defineProperty(Object.create(null) as object, "__proto__", {
                  configurable: true,
                  enumerable: true,
                  writable: true,
                  value: root,
                })
              : { a: root };
        if (frozen === true || (frozen === "alternating" && level % 2 === 0)) Object.freeze(root);
      }
      const plan = planWorkerPieces(root);
      expect(plan).toBeDefined();
      const assembly = assembleWorkerPieces(ExactNumber);
      if (plan !== undefined)
        for (let step = plan.next(); step.done !== true; step = plan.next())
          assembly.add(structuredClone(step.value));
      let restored = assembly.value() as object;
      let original = root;
      for (let level = 0; level < depth; level++) {
        expect(Object.isFrozen(restored)).toBe(Object.isFrozen(original));
        expect(Object.getPrototypeOf(restored)).toBe(Object.getPrototypeOf(original));
        const key = Array.isArray(original) ? "0" : shape === "mixed" ? "__proto__" : "a";
        restored = Reflect.get(restored, key) as object;
        original = Reflect.get(original, key) as object;
      }
      expect(Object.isFrozen(restored)).toBe(Object.isFrozen(original));
      expect(restored).toEqual({ a: 1 });
    },
  );

  it.each(PROFILES)("%s", (_name, options) => {
    const divergences: string[] = [];
    let nestedExact = 0;
    for (const text of inputs) {
      const outcome = parse(text, options);
      if (exactInArray(outcome)) nestedExact++;
      const restored = restoreWorkerValue(
        structuredClone(describeWorkerValue(outcome)),
        ExactNumber,
      );
      const frozen = frozenDifference(outcome, restored);
      if (!same(outcome, restored) || frozen !== undefined)
        divergences.push(`${JSON.stringify(text)} frozen differs at ${String(frozen)}`);
    }
    if (options === PROFILES[0][1]) expect(nestedExact).toBeGreaterThan(0);
    expect(divergences.slice(0, 5)).toEqual([]);
  });

  // Different piece bounds vary batching while the original outcome remains the behavioral oracle.
  it.each(PROFILES)("%s, in pieces", (_name, options) => {
    const divergences: string[] = [];
    let compared = 0;
    for (const text of inputs) {
      const outcome = parse(text, options);
      for (const limit of [3, 40]) {
        const plan = planWorkerPieces(outcome, limit);
        if (plan === undefined) continue;
        const assembly = assembleWorkerPieces(ExactNumber);
        for (let piece = plan.next(); piece.done !== true; piece = plan.next()) {
          assembly.add(structuredClone(piece.value));
        }
        const frozen = frozenDifference(outcome, assembly.value());
        if (!same(outcome, assembly.value()) || frozen !== undefined)
          divergences.push(
            `${JSON.stringify(text)} by ${limit}: frozen differs at ${String(frozen)}`,
          );
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(divergences.slice(0, 5)).toEqual([]);
  });
});

describe("worker options", () => {
  it("defines encoded features without invoking inherited setters", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "locations");
    let calls = 0;
    let encoded: ReturnType<typeof encodeWorkerOptions>;
    // eslint-disable-next-line no-extend-native -- The owned result must survive a setter on its real prototype.
    Object.defineProperty(Object.prototype, "locations", {
      configurable: true,
      get() {
        return undefined;
      },
      set() {
        calls++;
      },
    });
    try {
      encoded = encodeWorkerOptions({ locations });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, "locations");
      else {
        // eslint-disable-next-line no-extend-native -- Restore the exact caller-owned prototype descriptor.
        Object.defineProperty(Object.prototype, "locations", previous);
      }
    }
    expect(calls).toBe(0);
    expect(Object.hasOwn(encoded, "locations")).toBe(true);
    expect(encoded.locations).toBe(true);
  });
  it("encodes only own feature keys, as the main thread validates them", () => {
    // A key planted on a prototype (`Object.prototype` pollution) is ignored by `validateOptions`;
    // reading it here gave the worker spans the same call on the main thread never had.
    const inherited = Object.create({
      get locations() {
        throw new Error("Inherited locations must not be read");
      },
      get diagnostics() {
        throw new Error("Inherited diagnostics must not be read");
      },
    }) as never;
    expect(Object.keys(encodeWorkerOptions(inherited))).toEqual([]);
  });
});
