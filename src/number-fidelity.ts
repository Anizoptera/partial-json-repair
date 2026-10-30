// SPDX-License-Identifier: Apache-2.0

/**
 * Decides which number tokens a `number` cannot hold, so that the tree carries them as
 * `ExactNumber` instead of a rounded double.
 *
 * Ordinary mode keeps a double for every fraction — `0.1` is `0.1` to a consumer — and protects
 * only the three cases where the double would be a DIFFERENT value: an integer past 2^53 that loses
 * digits, a magnitude that overflows to Infinity, and a nonzero magnitude that underflows to 0.
 */

import { digitValue, PLUS } from "./chars";

/**
 * The JSON spelling of a number `Number()` accepts but the grammar does not: leading zeros dropped,
 * a leading plus removed, a leading point given its zero, a trailing point removed. Returns the
 * input itself when it was already JSON, so the caller knows whether an edit is due.
 */
export const jsonSpelling = (raw: string): string => {
  const negative = raw.charCodeAt(0) === MINUS;
  let start = negative || raw.charCodeAt(0) === PLUS ? 1 : 0;
  while (raw.charCodeAt(start) === ZERO && digitValue(raw.charCodeAt(start + 1)) <= 9) start++;
  let body = raw.slice(start);
  const dot = body.indexOf(".");
  if (dot === 0) body = `0${body}`;
  else if (dot > 0 && digitValue(body.charCodeAt(dot + 1)) > 9) {
    body = body.slice(0, dot) + body.slice(dot + 1);
  }
  return negative ? `-${body}` : body;
};

const ZERO = 0x30;
const NINE = 0x39;
const MINUS = 0x2d;
const DOT = 0x2e;

/**
 * Integer digits a decimal token may carry and still be exactly representable as a `number`:
 * 10^15 - 1 is below 2^53 - 1, so no value that short can round.
 *
 * Both built-in pre-screens share this threshold: separate copies could admit integer loss on
 * one route while the recovery scanner preserves the digits on another.
 */
export const MAX_EXACT_INT_DIGITS = 15;

// Number.MAX_VALUE is below 10^309; a longer canonical integer cannot fit a finite double.
export const MAX_FINITE_INT_DIGITS = 309;

/**
 * Fraction digits a token without an exponent may carry and still be unable to underflow: a nonzero
 * value with this many digits after the point is at least 1e-300, a normal double. The fast-path
 * screen acquits such tokens without arithmetic; only an exponent or a longer fraction can reach 0.
 */
export const UNDERFLOW_FRACTION_DIGITS = 300;

/**
 * A decimal token as `digits × 10^scale`, sign apart. `digits` holds the significant digits only,
 * no leading or trailing zero, so `scale < 0` exactly when the value has a fractional part; zero is
 * `""`, and `-0` keeps `negative`.
 *
 * A string, not a BigInt: the token's length is bounded only by `maxBuffer`, and parsing millions of
 * digits into a BigInt is superlinear. Each caller builds a BigInt only once its size is bounded.
 */
type Decimal = {
  readonly negative: boolean;
  readonly digits: string;
  readonly scale: number;
};

const isDigit = (c: number): boolean => c >= ZERO && c <= NINE;

/**
 * Splits a VALID JSON number spelling into its parts. The scanner proves numeric syntax before
 * normalization, so an empty mantissa or exponent cannot arrive here.
 */
export const decompose = (text: string): Decimal => {
  const negative = text.charCodeAt(0) === MINUS;
  const start = negative ? 1 : 0;
  let at = start;
  let dot = -1;
  for (; at < text.length; at++) {
    const c = text.charCodeAt(at);
    if (c === DOT) dot = at;
    else if (!isDigit(c)) break;
  }
  const all = dot < 0 ? text.slice(start, at) : text.slice(start, dot) + text.slice(dot + 1, at);
  const exponent = at < text.length ? Number(text.slice(at + 1)) : 0;
  let first = 0;
  while (first < all.length && all.charCodeAt(first) === ZERO) first++;
  let end = all.length;
  while (end > first && all.charCodeAt(end - 1) === ZERO) end--;
  if (first === end) return { negative, digits: "", scale: 0 };
  const scale = exponent - (dot < 0 ? 0 : at - dot - 1) + (all.length - end);
  return { negative, digits: all.slice(first, end), scale };
};

/**
 * Whether ordinary mode must keep this token exact: the double `Number(text)` would be a different
 * value — an integer with digits lost, an overflow, or a nonzero magnitude rounded to zero.
 * Fractions that merely round are not protected; that is what `exactNumbers: true` is for.
 */
export const needsExact = (text: string, value = Number(text)): boolean => {
  if (!Number.isFinite(value)) return true;
  // Below 2^53, integers are exact and ordinary fractional rounding is permitted. Short zero
  // spellings cannot hide underflow; longer ones still need their significant digits checked.
  if (Math.abs(value) < 2 ** 53 && (value !== 0 || text.length <= 2)) return false;
  const at = text.charCodeAt(0) === MINUS ? 1 : 0;
  let digitsOnly = text.length > at;
  for (let i = at; i < text.length; i++) {
    if (!isDigit(text.charCodeAt(i))) {
      digitsOnly = false;
      break;
    }
  }
  // Below 1e21, fixed formatting exposes the double's exact integer rather than its shortest
  // round-tripping spelling. This distinguishes 1000000000000000100 from the stored
  // 1000000000000000128 without allocating either as a BigInt. Larger doubles switch to exponent
  // notation, so the general arithmetic proof below remains their path.
  if (digitsOnly && Math.abs(value) < 1e21) {
    return value.toFixed(0) !== text;
  }
  const { negative, digits, scale } = decompose(text);
  if (value === 0) return digits !== "";
  // A fraction that merely rounds is not protected (see the module note).
  if (scale < 0) return false;
  // A finite double has at most 309 integer digits, so `digits` and `scale` are short here and the
  // BigInt stays small whatever the token's length.
  const integer = BigInt(digits) * 10n ** BigInt(scale);
  // An integral decimal rounds to an integral finite double, so BigInt(value) cannot throw.
  return BigInt(value) !== (negative ? -integer : integer);
};
