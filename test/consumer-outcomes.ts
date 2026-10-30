// SPDX-License-Identifier: Apache-2.0

// Generated browser comparisons need this module without fixture-data or host dependencies.

/**
 * A JSON-safe, host-neutral description of a recovered value, so two realms (Node, a browser page,
 * workerd, a bundle) can be compared by plain deep equality. Every distinction `JSON.stringify` erases
 * is spelled out: `-0`, `NaN`, infinities, `undefined`, bigint, lone surrogates (as code units), null
 * prototypes, frozenness, functions, and own symbol-free keys in insertion order.
 */
export const describe = (value: unknown, seen: Set<object> = new Set()): unknown => {
  if (value === undefined) return { $: "undefined" };
  if (value === null) return null;
  switch (typeof value) {
    case "number":
      if (Number.isNaN(value)) return { $: "NaN" };
      if (Object.is(value, -0)) return { $: "-0" };
      if (!Number.isFinite(value)) return { $: value > 0 ? "Infinity" : "-Infinity" };
      return value;
    case "bigint":
      return { $: "bigint", v: value.toString() };
    case "string":
      return {
        $: "string",
        units: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)),
      };
    case "boolean":
      return value;
    case "function":
      return { $: "function" };
    case "symbol":
      return { $: "symbol", v: String(value) };
    case "object":
    case "undefined":
      break;
  }
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return { $: "cycle" };
  seen.add(object);
  const proto: unknown = Object.getPrototypeOf(object);
  const array = Array.isArray(object);
  const kind = array
    ? "array"
    : proto === null
      ? "null-proto"
      : proto === Object.prototype
        ? "object"
        : value instanceof Uint8Array
          ? "bytes"
          : // A consumer's minifier renames classes (`ExactNumber` becomes `D`), so identify a class by
            // its prototype's public members, which minifiers keep.
            `class:${Object.getOwnPropertyNames(proto).toSorted().join(",")}`;
  const entries = Object.keys(object).map((key) => [key, describe(object[key], seen)]);
  seen.delete(object);
  // Own enumerable keys omit trailing holes; length keeps missing array data observable.
  return {
    $: kind,
    ...(array ? { length: object.length } : {}),
    frozen: Object.isFrozen(object),
    entries,
  };
};

/** Deep equality over `describe` output: the trees hold only JSON-safe leaves, compared with `Object.is`. */
export const sameDescription = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k, i) =>
      k === kb[i] &&
      sameDescription((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
};

/** The first path where two descriptions differ, for a failure message that names the place. */
export const firstDifference = (a: unknown, b: unknown, path = "$"): string | undefined => {
  if (sameDescription(a, b)) return undefined;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const found = firstDifference(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${path}.${k}`,
    );
    if (found !== undefined) return found;
  }
  return `${path}: key order differs`;
};
