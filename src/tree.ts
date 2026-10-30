// SPDX-License-Identifier: Apache-2.0

/**
 * Writing into and copying the value tree, shared by the builder that grows it and the views that
 * copy it. Nothing here decides policy; the one insertion point stays in the builder.
 */
import { isExactNumber } from "./exact-number";

/**
 * What one scalar costs against `maxRetained`, in the contract's logical units: one per value, plus
 * one per UTF-16 unit of a string or per character of an exact-number token. The single definition;
 * the builder charges with it and the stream counts unread results with it.
 */
export const scalarUnits = (v: unknown): number => {
  if (typeof v === "string") return 1 + v.length;
  if (isExactNumber(v)) return 1 + v.text.length;
  return 1;
};

/** What a whole value costs against `maxRetained`: every scalar, container and key in it. */
export const retainedUnits = (root: unknown): number => {
  let units = 0;
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || isExactNumber(value)) {
      units += scalarUnits(value);
      continue;
    }
    units += 1;
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    for (const key of Object.keys(value)) {
      units += key.length;
      pending.push((value as Record<string, unknown>)[key]);
    }
  }
  return units;
};

/** Writes one enumerable own data property without invoking an inherited setter. */
export const defineOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (!(key in target) || Object.hasOwn(target, key)) {
    target[key] = value;
    return;
  }
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/**
 * A shallow copy: the container, its own members, and nothing beneath them.
 *
 * One built-in copy per shape rather than a key-by-key loop, because this runs once per open
 * container on every snapshot and the open root of a streamed array can be 100 000 items wide. The
 * loop through `defineOwn` cost 24.7 ms per snapshot at that width on Bun and 2.0 ms on Node; `slice`
 * copies 10 000 items in 2-5 us on both. Each built-in is chosen because it cannot reach the
 * `__proto__` setter: spread and `Object.assign` onto a null-prototype target both CREATE own data
 * properties, so a member named `__proto__` is copied as data, exactly as `defineOwn` wrote it. The
 * builder makes only these two prototypes, so no third shape exists to preserve.
 */
export const copyFrame = (source: object): unknown[] | Record<string, unknown> => {
  if (Array.isArray(source)) return (source as unknown[]).slice();
  return Object.getPrototypeOf(source) === null
    ? (Object.assign(Object.create(null), source) as Record<string, unknown>)
    : { ...(source as Record<string, unknown>) };
};

/**
 * Copies a JSON tree iteratively while preserving the parser's chosen object prototype.
 *
 * Each container is copied shallowly by `copyFrame`, then only its container members are replaced
 * by their copies. Leaves — and exact numbers, which are frozen leaves — are already in place from the
 * shallow copy, so the per-member work is a type test rather than a write.
 */
export const cloneJson = (root: unknown): unknown => {
  if (typeof root !== "object" || root === null || isExactNumber(root)) return root;
  const copy = copyFrame(root);
  const pending: (unknown[] | Record<string, unknown>)[] = [copy];
  while (pending.length > 0) {
    const target = pending.pop() as unknown[] | Record<string, unknown>;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        const value = target[i];
        if (typeof value !== "object" || value === null || isExactNumber(value)) continue;
        const child = copyFrame(value);
        target[i] = child;
        pending.push(child);
      }
      continue;
    }
    for (const key of Object.keys(target)) {
      const value = target[key];
      if (typeof value !== "object" || value === null || isExactNumber(value)) continue;
      const child = copyFrame(value);
      // `defineOwn`, not assignment: the key is already an OWN member here, so this is a plain write,
      // but routing every tree write through one function keeps the `__proto__` rule in one place.
      defineOwn(target, key, child);
      pending.push(child);
    }
  }
  return copy;
};
