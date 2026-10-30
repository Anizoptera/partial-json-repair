// SPDX-License-Identifier: Apache-2.0

/**
 * A JSON number kept as its validated source text, for values a double cannot hold.
 *
 * Every conversion is CHECKED and returns a result rather than rounding: a consumer who wants the
 * double accepts rounding explicitly, and one who wants the integer says how many digits it may
 * expand to, because `1e400` is a legal token and a 401-digit BigInt is a cost they choose.
 */
import type { BigIntConversionFailure, NumberConversionFailure, Result } from "./types";
import type { Exact } from "./options";
import { checkHelperOptions, configurationError } from "./configuration-error";
import { decompose } from "./number-fidelity";

/**
 * The runtime brand, shared by every copy of this module through the symbol registry so two bundled
 * copies of the package recognise each other's numbers. It sits on the prototype, so branding
 * costs nothing per value; the type is nominal through the private field.
 *
 * Installed by the first constructor call, not at import: a prototype write after the class is work
 * a bundler must keep, and esbuild keeps a class with a computed member key (`get [BRAND]()`) for
 * the same reason. Either would keep this module in apps that never read a number exactly.
 * Worker receivers take the prototype from a constructed number before restoring cloned leaves.
 */
const BRAND = /* @__PURE__ */ Symbol.for("partial-json-repair.exact-number");
let branded = false;

/**
 * The most significant digits any double's exact decimal expansion has (the largest subnormal's).
 * A decimal with more cannot equal a double, which settles it before any BigInt is built.
 */
const MAX_EXACT_DOUBLE_DIGITS = 767;

/** `|n|` as `mantissa × 2^exponent` with an integral mantissa, read off the IEEE-754 bits. */
const binary = (n: number): { mantissa: bigint; exponent: number } => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(n));
  const hi = view.getUint32(0);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  if (biased === 0) return { mantissa, exponent: -1074 };
  mantissa |= 1n << 52n;
  return { mantissa, exponent: biased - 1075 };
};

/**
 * Whether the double is EXACTLY `coefficient × 10^scale`. Both sides are cleared to integers —
 * `mantissa × 2^e × 10^-s` against `coefficient × 10^s × 2^-e` — so the comparison is arithmetic
 * on BigInts, never on doubles. Only reached for a finite nonzero double, which bounds both powers;
 * the digit cap bounds the coefficient.
 */
const isExactDouble = (n: number, digits: string, scale: number): boolean => {
  if (digits.length > MAX_EXACT_DOUBLE_DIGITS) return false;
  const coefficient = BigInt(digits);
  const { mantissa, exponent } = binary(n);
  const left = mantissa * 2n ** BigInt(Math.max(exponent, 0)) * 10n ** BigInt(Math.max(-scale, 0));
  const right =
    coefficient * 10n ** BigInt(Math.max(scale, 0)) * 2n ** BigInt(Math.max(-exponent, 0));
  return left === right;
};

/**
 * A number the source spelled that a `number` cannot hold exactly. Frozen, and holding only the
 * token — the value is derived on demand, in whichever form the consumer can check the cost of.
 *
 * Only this package constructs one, which is why the class itself is not exported: identity is
 * `isExactNumber`, never a field shape, so a parsed `{ "text": "1" }` stays an ordinary object.
 */
export class ExactNumber {
  /** The validated JSON number token, signed zero and spelling intact. */
  readonly text: string;
  // Present only in the type, so structurally identical objects do not pass as this class.
  declare private readonly brand: undefined;

  constructor(text: string) {
    if (!branded) {
      branded = true;
      Object.defineProperty(ExactNumber.prototype, BRAND, { value: true });
      Object.defineProperty(ExactNumber.prototype, Symbol.toPrimitive, { value: toPrimitive });
    }
    this.text = text;
    Object.freeze(this);
  }

  /**
   * The value as a double. Exact by default: `0.1` has no double, so it FAILS unless rounding is
   * allowed. Overflow and a nonzero magnitude rounding to zero fail in either mode — a consumer who
   * accepts rounding still cannot be handed `Infinity` or `0` for a number that is neither.
   */
  toNumber<Options extends { allowRounding?: boolean } | undefined>(
    options: Exact<Options, { allowRounding?: boolean }>,
  ): Result<number, NumberConversionFailure>;
  // eslint-disable-next-line typescript/no-unnecessary-type-parameters -- Explicit generic forwarding needs this non-inferred overload; optional inference hides union typos.
  toNumber<Options extends { allowRounding?: boolean } = never>(
    options?: Exact<NoInfer<Options>, { allowRounding?: boolean }>,
  ): Result<number, NumberConversionFailure>;
  toNumber(options?: { allowRounding?: boolean }): Result<number, NumberConversionFailure> {
    // Checked only when given: an omitted argument costs this per-number call nothing.
    let allowRounding: unknown;
    if (options !== undefined) {
      ({ allowRounding } = checkHelperOptions(options, ["allowRounding"]));
      if (allowRounding !== undefined && typeof allowRounding !== "boolean")
        throw configurationError({
          kind: "invalid-options",
          field: "allowRounding",
          reason: "boolean",
        });
    }
    const value = Number(this.text);
    if (!Number.isFinite(value)) return { ok: false, failure: { kind: "overflow" } };
    const { digits, scale } = decompose(this.text);
    if (value === 0 && digits !== "") return { ok: false, failure: { kind: "underflow" } };
    if (allowRounding === true || digits === "") return { ok: true, value };
    return isExactDouble(value, digits, scale)
      ? { ok: true, value }
      : { ok: false, failure: { kind: "inexact" } };
  }

  /**
   * The value as a BigInt, when it is an integer. `maxDigits` bounds the expansion of an exponent
   * BEFORE it happens, so a hostile `1e999999999` costs a comparison rather than a gigabyte.
   * `-0` converts to `0n`: BigInt holds integers, not spellings.
   */
  toBigInt<Options extends { maxDigits: number }>(
    options: Exact<Options, { maxDigits: number }>,
  ): Result<bigint, BigIntConversionFailure> {
    const { maxDigits } = checkHelperOptions(options, ["maxDigits"]);
    if (typeof maxDigits !== "number" || !Number.isSafeInteger(maxDigits) || maxDigits < 1)
      throw configurationError({
        kind: "invalid-options",
        field: "maxDigits",
        reason: "positive-integer",
      });
    const { negative, digits, scale } = decompose(this.text);
    if (digits === "") return { ok: true, value: 0n };
    // Integrality first: raising `maxDigits`, as `digits-exceeded` advises, must not then reveal
    // that the value was never an integer. `digits` has no trailing zero, so any negative scale is
    // a fractional part.
    if (scale < 0) return { ok: false, failure: { kind: "not-integer" } };
    const count = digits.length + scale;
    if (count > maxDigits) {
      return { ok: false, failure: { kind: "digits-exceeded", digits: count, maxDigits } };
    }
    const integer = BigInt(digits) * 10n ** BigInt(scale);
    return { ok: true, value: negative ? -integer : integer };
  }

  /**
   * Lets native `JSON.stringify` emit the token unquoted where the runtime can (`JSON.rawJSON`,
   * ES2025). Where it cannot, the only honest outcomes are to fail visibly or to lie — round, quote
   * the digits, or serialise `{ text }` — so this throws. The library's own `stringify` never does.
   */
  toJSON(): unknown {
    const raw = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
    if (raw !== undefined) return raw(this.text);
    throw new TypeError(
      "ExactNumber cannot be encoded by JSON.stringify on this runtime; use stringify() from partial-json-repair",
    );
  }

  /** The exact source token, so `String(id)` and `id.toString()` never print `[object Object]`. */
  toString(): string {
    return this.text;
  }
}

/**
 * Implicit conversion follows `toJSON`'s rule: lossless or loud. Without it a consumer treating a
 * 20-digit id as a value got `NaN` from `Number(id)` and carried on. String and default hints
 * (`${id}`, `"id=" + id`, like `Date`) get the exact token; a number hint would need the unchecked
 * rounding this class exists to prevent, so it throws and names the checked conversions.
 *
 * Installed with the brand on first construction, not as a computed class member: that key would be
 * evaluated at import and keep this module in apps that never meet an exact number (HLD D5).
 */
function toPrimitive(this: ExactNumber, hint: string): string {
  if (hint !== "number") return this.text;
  throw new TypeError(
    `ExactNumber ${this.text} has no exact JavaScript number; use toNumber() or toBigInt({ maxDigits }), which report rounding and overflow`,
  );
}

/** Narrows to an exact number by the library's brand, never by field shape. */
export const isExactNumber = (value: unknown): value is ExactNumber => {
  if (typeof value !== "object" || value === null) return false;
  // Library instances carry the registry brand on their immediate prototype; cross-copy identity
  // needs no property read, which could execute an impostor's getter.
  const own = Object.getOwnPropertyDescriptor(value, BRAND);
  const prototype: unknown = Object.getPrototypeOf(value);
  const brand =
    own ??
    (typeof prototype !== "object" || prototype === null
      ? undefined
      : Object.getOwnPropertyDescriptor(prototype, BRAND));
  // Accessor descriptors omit value; an inherited one must neither brand data nor run caller code.
  return brand !== undefined && Object.hasOwn(brand, "value") && brand.value === true;
};
