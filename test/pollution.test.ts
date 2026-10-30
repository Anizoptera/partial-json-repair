// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * Dangerous-key recovery must leave the guarded host prototypes unchanged.
 * Removing a member under reject/drop must also stop later path reads at that missing own slot;
 * otherwise a pending value can reach Object.prototype. Prefixes exercise that pending path,
 * across the dangerous-key policies and both views, which complete documents alone cannot reach.
 */
import { describe, expect, it } from "vitest";

import type { StreamItem } from "../src/index";
import {
  createStreamParser,
  diagnostics,
  isExactNumber,
  LLM_FULL,
  parse,
  parseMany,
  parseStream,
  repair,
  stringify,
  tryParsers,
} from "../src/index";
import { auto, initAsyncParser, parseAsync } from "../src/async";
import { DANGEROUS_KEY_NAMES } from "../src/builder";
import { ownedView, sharedView } from "../src/index";

/** Nested under each dangerous key; no prototype holds this name, so a write through one adds it. */
const PROBE = "pollutionProbe";

const GUARDED = [Object.prototype, Array.prototype, Function.prototype, String.prototype];

const globalState = () =>
  GUARDED.map((target) => ({
    target,
    prototype: Object.getPrototypeOf(target) as object | null,
    extensible: Object.isExtensible(target),
    properties: Reflect.ownKeys(target).map((key) => ({
      key,
      descriptor: Object.getOwnPropertyDescriptor(target, key),
    })),
  }));

const POLICIES = ["reject", "drop", "keep"] as const;

/** Documents that put a dangerous key in every structural position a walk can reach. */
const documentsFor = (key: string): string[] => [
  `{${JSON.stringify(key)}:{${JSON.stringify(PROBE)}:"par"}}`,
  `{${JSON.stringify(key)}:"v","safe":2}`,
  `[{${JSON.stringify(key)}:{${JSON.stringify(PROBE)}:"x"}}]`,
  `{"a":{${JSON.stringify(key)}:{${JSON.stringify(PROBE)}:"y"}},"b":1}`,
  `{${JSON.stringify(key)}:[{${JSON.stringify(PROBE)}:"z"}]}`,
];

/**
 * Runs `attempt` and reports the case if it moved any global. Returns a description rather than
 * asserting, so the whole matrix runs and the failure names the exact combination.
 */
const violation = (label: string, attempt: () => void): string | undefined => {
  const before = globalState();
  try {
    attempt();
  } catch (cause) {
    return `${label} threw: ${String(cause)}`;
  }
  // Names alone miss overwrites and freezing; descriptor values must retain identity too.
  const unchanged = before.every((saved) => {
    const keys = Reflect.ownKeys(saved.target);
    if (
      Object.getPrototypeOf(saved.target) !== saved.prototype ||
      Object.isExtensible(saved.target) !== saved.extensible ||
      keys.length !== saved.properties.length
    )
      return false;
    return keys.every((key, index) => {
      const previous = saved.properties[index];
      const descriptor = previous?.descriptor;
      const current = Object.getOwnPropertyDescriptor(saved.target, key);
      if (previous?.key !== key || descriptor === undefined || current === undefined) return false;
      const fields = Reflect.ownKeys(descriptor);
      return (
        fields.length === Reflect.ownKeys(current).length &&
        fields.every(
          (field) =>
            Object.hasOwn(current, field) &&
            Object.is(Reflect.get(descriptor, field), Reflect.get(current, field)),
        )
      );
    });
  });
  return unchanged ? undefined : `${label} changed global state`;
};

describe("no dangerous key reaches a prototype, through any verb or policy", () => {
  it("detects prototype mutations that preserve property names", () => {
    const saved = Object.getOwnPropertyDescriptor(Object.prototype, "toString");
    if (saved === undefined) throw new Error("missing prototype control");
    let observed: string | undefined;
    try {
      observed = violation("prototype attributes", () => {
        // eslint-disable-next-line no-extend-native -- Reversible mutation must falsify the safety oracle.
        Object.defineProperty(Object.prototype, "toString", {
          ...saved,
          enumerable: saved.enumerable !== true,
        });
      });
    } finally {
      // eslint-disable-next-line no-extend-native -- Restore before the runner reads the prototype.
      Object.defineProperty(Object.prototype, "toString", saved);
    }
    expect(observed).toBe("prototype attributes changed global state");
  });

  it("survives whole documents through the one-shot verbs", () => {
    const found: string[] = [];
    for (const key of DANGEROUS_KEY_NAMES) {
      for (const text of documentsFor(key)) {
        for (const onDangerousKey of POLICIES) {
          const options = { ...LLM_FULL, onDangerousKey };
          const at = `${key} ${onDangerousKey} ${text}`;
          found.push(
            ...[
              violation(`parse ${at}`, () => void parse(text, options)),
              violation(`repair ${at}`, () => void repair(text, options)),
              violation(`parseMany ${at}`, () => void [...parseMany(text, options)]),
            ].filter((v) => v !== undefined),
          );
        }
      }
    }
    expect(found).toEqual([]);
  });

  // Every prefix, because the defect needed a value the scanner had not finished reading. A whole
  // document never reaches the pending path at all, so a suite of complete inputs proves nothing
  // about it.
  it("survives every truncation of every document, fed and snapshotted", () => {
    const found: string[] = [];
    for (const key of DANGEROUS_KEY_NAMES) {
      for (const text of documentsFor(key)) {
        for (const onDangerousKey of POLICIES) {
          for (const view of [ownedView, sharedView]) {
            for (let cut = 1; cut <= text.length; cut++) {
              const at = `${key} ${onDangerousKey} ${view.mode} ${JSON.stringify(text.slice(0, cut))}`;
              const found1 = violation(at, () => {
                const sp = createStreamParser({ ...LLM_FULL, onDangerousKey, view });
                void [...sp.feed(text.slice(0, cut))];
                sp.snapshot();
                void [...sp.end()];
                sp.snapshot();
              });
              if (found1 !== undefined) found.push(found1);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe("options come from the caller, never from the prototype chain", () => {
  it("ignores settings a polluted or extended Object.prototype supplies", () => {
    // The inverse direction: not what we write to a prototype, but what we READ from one. Option
    // resolution is two dozen plain `options.x` reads, each of which consults the chain, so a host
    // that extends `Object.prototype` — an attacker, or an old library that still does it — could
    // refuse documents the caller's own settings accept: both of these would come back refused.
    const proto = Object.prototype as Record<string, unknown>;
    const planted = { maxDepth: 1, allowSingleQuotes: false };
    const previous = Object.keys(planted).map(
      (key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
    );
    try {
      for (const [key, value] of Object.entries(planted))
        Object.defineProperty(proto, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      expect(parse('{"a":{"b":{"c":1}}}', {}).ok).toBe(true);
      expect(parse("{'a':1}", {}).ok).toBe(true);
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) Reflect.deleteProperty(proto, key);
        else Object.defineProperty(proto, key, descriptor);
      }
    }
  });

  it("reads stream, async and helper options as own keys too", async () => {
    // These are read outside `validateOptions`, by entry points that peel their own keys off first.
    // Each call runs inside the window and is judged after it, because equality checks walk keys
    // with `for...in` and would see the planted ones.
    const proto = Object.prototype as Record<string, unknown>;
    const planted: Record<string, unknown> = {
      view: sharedView,
      summary: true,
      execution: "nope",
      signal: { aborted: true, reason: "planted" },
      diagnostics,
      allowRounding: true,
      maxOutput: 1,
      isResult: () => false,
    };
    const previous = Object.keys(planted).map(
      (key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
    );
    const huge = parse("123456789012345678901234567890", { exactNumbers: true });
    if (!huge.ok || !isExactNumber(huge.value)) throw new Error("expected an exact number");
    const exact = huge.value;
    let manual: StreamItem[] = [];
    let hasSnapshot = true;
    let source: AsyncIterable<unknown> = parseStream([]);
    let whole: Promise<unknown> = Promise.resolve();
    let bound: unknown;
    let closed: Promise<unknown> = Promise.resolve();
    let helpers: unknown[] = [];
    try {
      for (const [key, value] of Object.entries(planted))
        Object.defineProperty(proto, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      const sp = createStreamParser({});
      hasSnapshot = typeof (sp as { snapshot?: unknown }).snapshot === "function";
      manual = [...sp.feed('{"a":1}'), ...sp.end()];
      source = parseStream(['{"a":1}'], {});
      whole = parseAsync('{"a":1}', { execution: auto });
      closed = parseStream(['{"a":1}']).close({});
      // Awaited inside the window: a bound parser plans its call on a later microtask, and the calls
      // started above take their first steps meanwhile, still under the planted keys.
      bound = await parseAsync('{"a":1}', initAsyncParser({ execution: auto }), {});
      helpers = [exact.toNumber({}), stringify({ a: 1 }, {}), tryParsers("x", [() => ({})], {})];
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) Reflect.deleteProperty(proto, key);
        else Object.defineProperty(proto, key, descriptor);
      }
    }
    const plain = { ok: true, value: { a: 1 }, complete: true };
    expect(hasSnapshot).toBe(false);
    expect(manual).toEqual([plain]);
    const pulled: unknown[] = [];
    for await (const item of source) pulled.push(item);
    expect(pulled).toEqual([plain]);
    expect(await whole).toEqual(plain);
    expect(bound).toEqual(plain);
    expect(await closed).toEqual({ ok: true, value: undefined });
    expect(helpers).toEqual([
      { ok: false, failure: { kind: "inexact" } },
      { ok: true, value: '{"a":1}' },
      { ok: true, value: {} },
    ]);
  });
});
