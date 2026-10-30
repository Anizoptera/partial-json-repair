// SPDX-License-Identifier: Apache-2.0

/** Marks a side of a {@link Difference} where the member does not exist, as distinct from `undefined`. */
export const ABSENT: unique symbol = Symbol("absent");

/** Where two values first diverge, and what each side holds there. */
export type Difference = {
  readonly path: readonly (string | number)[];
  readonly a: unknown;
  readonly b: unknown;
};

/**
 * The first place two parsed values differ under strict structural equality, or `undefined` when they
 * are equal: same types, same own keys in any order, `Object.is` on leaves. A key holding `undefined`
 * is NOT the same as a missing key, deliberately — a serialiser would drop it, and print `NaN` as
 * `null`, which are the differences a wrong answer shows. Arrays compare element by element before
 * length, so a shorter array reports the first index the other side has and it lacks.
 */
export const firstDifference = (a: unknown, b: unknown): Difference | undefined =>
  differences(a, b).next().value;

/**
 * Every place two values differ, in the order {@link firstDifference} finds the first. A judge of
 * differences needs all of them: one pair can differ for two unrelated causes, and grouping it by its
 * first path alone hides the second cause from every later review.
 */
export function* differences(
  a: unknown,
  b: unknown,
  path: (string | number)[] = [],
): Generator<Difference, undefined> {
  if (Object.is(a, b)) return;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    yield { path, a, b };
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    yield { path, a, b };
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) yield { path: [...path, i], a: ABSENT, b: b[i] };
      else if (i >= b.length) yield { path: [...path, i], a: a[i], b: ABSENT };
      else yield* differences(a[i], b[i], [...path, i]);
    }
    return;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of Object.keys(ra)) {
    if (Object.hasOwn(rb, k)) yield* differences(ra[k], rb[k], [...path, k]);
    else yield { path: [...path, k], a: ra[k], b: ABSENT };
  }
  for (const k of Object.keys(rb))
    if (!Object.hasOwn(ra, k)) yield { path: [...path, k], a: ABSENT, b: rb[k] };
}

/** Strict structural equality; see {@link firstDifference}, which defines it. */
export const sameValue = (a: unknown, b: unknown): boolean => firstDifference(a, b) === undefined;
