// SPDX-License-Identifier: Apache-2.0

/**
 * The built-in parser route for whole text: `JSON.parse`, or the pre-scan gate's completion of it,
 * taken only where the answer provably equals the scanner's. Its own module so the synchronous verbs
 * and the async whole-input operation share one copy of every guard.
 */

import type { ResolvedOptions } from "./options";
import { DANGEROUS_KEY_NAMES } from "./builder";
import { closingQuote } from "./chars";
import { ownText } from "./lexical-window";
import { MAX_EXACT_INT_DIGITS, needsExact, UNDERFLOW_FRACTION_DIGITS } from "./number-fidelity";
import { bareFailure, spanOf } from "./parser-outcome";
import { parseRouted, type Routed } from "./pre-scan";
import { acceptsBuiltRoot, noMatch } from "./root-filter";
import type { WholeInputSource } from "./whole-source";
import type { Cut } from "./types";

/**
 * How far `JSON.parse` reads the text faithfully: up to a number it cannot keep unchanged, or a
 * container deeper than `maxDepth`.
 *
 * This exists because `JSON.parse` drops excess digits SILENTLY and offers no hook to notice — a
 * reviver only ever sees the already-rounded value. Keeping the package's promise that such a
 * value comes back as an `ExactNumber` therefore means declining the fast path, so the scanner
 * reads the token itself.
 *
 * Strings are skipped because their digits are data, not number tokens. The shared verdict covers
 * integer loss, overflow and underflow; ordinary fractional IEEE-754 approximation is what a
 * double is for, and is protected only by `exactNumbers`.
 */
/**
 * It also finds where a member closes for `native-slice.ts`, in the same pass: the walk already
 * tracks strings and brackets, so a separate bracket scan read every member twice. The answer is
 * past the closer that ends the container opening at `from` when `closes`, else `limit`; or
 * `-1 - at` where reading stopped: a hazard, a raw control character in a string (`JSON.parse`
 * rejects it, so the attempt would only throw), or, when `closes`, a container still open at `limit`.
 */
export const faithfulEnd = (
  text: string,
  from: number,
  limit: number,
  maxDepth: number,
  closes: boolean,
): number => {
  // A value deeper than the limit needs at least one opener and closer per level plus a scalar.
  // Below that byte floor the depth contract is already proven, so the fidelity scan need not
  // count containers at all, unless it must find the closer.
  const trackDepth = closes || limit - from > maxDepth * 2;
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      i = closingQuote(text, i + 1, limit);
      if (i < 0) return closes ? -1 - limit : limit;
      continue;
    }
    if (trackDepth && (c === 0x7b || c === 0x5b)) {
      if (++depth > maxDepth) return -1 - i;
      continue;
    }
    if (trackDepth && (c === 0x7d || c === 0x5d)) {
      if (--depth === 0 && closes) return i + 1;
      continue;
    }
    if ((c < 0x30 || c > 0x39) && c !== 0x2d) continue;
    // Split exactly where the number grammar splits: the integer digits, then everything after them.
    // The token has to be walked to find its end regardless, so the one count that can ACQUIT it is
    // free, and acquitting is the only safe direction -- `losesInteger` remains the verdict and still
    // sees every token this cannot clear.
    const digitsFrom = c === 0x2d ? i + 1 : i;
    let end = digitsFrom;
    while (end < limit && text.charCodeAt(end) >= 0x30 && text.charCodeAt(end) <= 0x39) end++;
    const intDigits = end - digitsFrom;
    let fractionDigits = 0;
    if (text.charCodeAt(end) === 0x2e) {
      const fractionFrom = ++end;
      while (end < limit && text.charCodeAt(end) >= 0x30 && text.charCodeAt(end) <= 0x39) end++;
      fractionDigits = end - fractionFrom;
    }
    let exponent = false;
    while (end < limit && isNumeric(text.charCodeAt(end))) {
      const d = text.charCodeAt(end);
      if (d === 0x65 || d === 0x45) exponent = true;
      end++;
    }
    // Digits before the point bound integer loss and overflow: under 10^15 the value is exact if it
    // is an integer at all, and nowhere near Infinity. Digits after it bound underflow: a fraction
    // short enough is a normal double however it rounds. A fraction cannot excuse the first two --
    // clearing `1000...0.5` because it has one would return Infinity -- and an exponent restores all
    // three, so it forfeits. Zero digits means the token is malformed, which `JSON.parse` will
    // reject anyway.
    //
    // This only ever ACQUITS. Digit count as the VERDICT cost 3.3x on ordinary float data, since
    // `0.3333333333333333` is sixteen digits and exact -- here it has one integer digit and clears
    // without the BigInt work, which is the point.
    const exact =
      intDigits > 0 &&
      intDigits <= MAX_EXACT_INT_DIGITS &&
      fractionDigits <= UNDERFLOW_FRACTION_DIGITS &&
      !exponent;
    if (!exact && needsExact(text.slice(i, end))) return -1 - i;
    i = end - 1;
  }
  return closes ? -1 - limit : limit;
};

/** Digits, sign, point and exponent — the characters a JSON number token can be made of. */
const isNumeric = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d || c === 0x2b || c === 0x65 || c === 0x45;

/**
 * The options under which `JSON.parse` may serve a call at all, whatever the text.
 *
 * Declined outright when a report was asked for: `JSON.parse` collapses a duplicate key before any
 * reviver runs, so it cannot supply the duplicate diagnostics the caller requested, and a report
 * that silently omits them is not the report that was requested.
 */
export const builtinAllowed = (opts: ResolvedOptions): boolean =>
  opts.builtinParsers &&
  opts.diagnostics === false &&
  !opts.exactNumbers &&
  // Declined under any selection too: `JSON.parse` builds everything, and the contract is that
  // nothing outside a match or under a skip is built.
  opts.selection === undefined &&
  // `JSON.parse` collapses a duplicate key before any reviver runs, so it cannot honour a caller who
  // REFUSED that repair: it would answer `ok` for a document the scanner refuses, which is the fast
  // path changing the verdict rather than only the route. It is the only such kind, and for a
  // structural reason — every other repair needs syntax `JSON.parse` rejects, so the scanner runs
  // anyway, and a byte-order mark makes it throw rather than strip. `test/kind-coverage.test.ts`
  // fails if a second kind ever becomes reachable from text `JSON.parse` accepts.
  opts.recover["duplicate-key"] &&
  !opts.nullPrototype;

/**
 * Whether text `JSON.parse` accepts holds nothing it would read differently from the scanner.
 *
 * `JSON.parse` defines own properties rather than assigning them, so it cannot pollute a prototype
 * and needs no guard for the default `keep` policy. It cannot honour `drop` or `reject`, though — so
 * when one of those is set, the text is scanned ONCE for the six key spellings and for `\u`, which
 * could spell one. No hit means the tree provably cannot contain a dangerous key, so the fast path
 * is still safe: the common case pays one substring scan and nothing else. Counting on the tree
 * afterwards, as the extracted package did, erases the advantage the fast path exists for.
 */
const textIsFaithful = (text: string, opts: ResolvedOptions): boolean => {
  const span = nativeSpan(text);
  const first = text.charCodeAt(span.start);
  if (
    first !== 0x22 &&
    first !== 0x5b &&
    first !== 0x7b &&
    span.end - span.start > opts.maxScalar
  ) {
    return false;
  }
  // Before the key-policy shortcut below, not after: numeric fidelity and depth are independent,
  // and the default policy is `keep`, so ordering this second would make the check unreachable in
  // exactly the configuration almost every caller runs.
  return (
    faithfulEnd(text, 0, text.length, opts.maxDepth, false) >= 0 && keysAreFaithful(text, opts)
  );
};

/** Whether no key in `text` could be one the dangerous-key policy governs. */
export const keysAreFaithful = (text: string, opts: ResolvedOptions): boolean => {
  if (opts.onDangerousKey === "keep" && opts.customDangerousKeys.length === 0) return true;
  // `\u` can spell any character. The six built-in names are letters and underscores, which no
  // other escape spells; a custom key holding a character a short escape spells (`\/`, `\"`, `\n`)
  // could hide behind ANY backslash, so then every escape declines.
  if (text.includes(opts.customDangerousKeys.some(shortEscapable) ? "\\" : "\\u")) return false;
  for (const k of DANGEROUS_KEY_NAMES) if (text.includes(k)) return false;
  for (const k of opts.customDangerousKeys) if (text.includes(k)) return false;
  return true;
};

/** Whether a key holds a character JSON's short escapes spell: `"` `\` `/` and the five controls. */
const shortEscapable = (key: string): boolean => {
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x2f || (c >= 0x08 && c <= 0x0d && c !== 0x0b))
      return true;
  }
  return false;
};

/** `JSON.parse` accepts these four characters around a value; they are outside its source span. */
function nativeSpan(text: string): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  while (start < end) {
    const c = text.charCodeAt(start);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    start++;
  }
  while (end > start) {
    const c = text.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    end--;
  }
  return { start, end };
}

/** `JSON.parse` of the whole text, or `undefined` when it throws: JSON has no `undefined` value. */
const parsedWhole = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON as written: the caller's next route decides what it is.
    return undefined;
  }
};

/**
 * Whether the text opens a container and does not end with a closer: cut off, the streamed-LLM
 * shape, on which a `JSON.parse` attempt builds nearly the whole tree before throwing. O(1) beyond
 * the surrounding whitespace, and it only orders work: every route it picks is held to the scanner.
 */
const cutOffContainer = (text: string): boolean => {
  const { start, end } = nativeSpan(text);
  const first = text.charCodeAt(start);
  const last = text.charCodeAt(end - 1);
  return (first === 0x7b || first === 0x5b) && last !== 0x7d && last !== 0x5d;
};

/**
 * A built-in parser's reading of whole text, or `undefined` when only the scanner may answer. Every
 * value returned here equals the scanner's: `textIsFaithful` guards the `JSON.parse` attempt and
 * `test/pre-scan.test.ts` holds the pre-scan gate's routes to the scanner.
 *
 * Which goes first is decided by the text's ends, because each order wastes work on a different
 * shape. A container whose last character is not a closer is cut off, the streamed-LLM shape this
 * package exists for: `JSON.parse` would build almost the whole tree before throwing, so the gate
 * goes first and reads it in one pass (4-7x faster than attempt-then-scanner on Bun 1.4.2 and Node 24, M4 Max). Any
 * other text is most often complete, and there the gate's grammar work is wasted, since
 * `JSON.parse` validates the grammar itself: it goes first, with only the cheaper hazard check after
 * it (the gate cost Node 24 5-19% on clean input). If it throws, the text was not JSON as written and
 * the gate may still read it (comments, trailing commas, a fence, a cut ending at an inner closer).
 */
export const builtinRead = (text: string, opts: ResolvedOptions): Routed | undefined => {
  if (!builtinAllowed(opts)) return undefined;
  if (cutOffContainer(text)) return parseRouted(text, opts);
  const value = parsedWhole(text);
  if (value === undefined) return parseRouted(text, opts);
  return textIsFaithful(text, opts) ? { value, complete: true } : undefined;
};

/**
 * `parse` on the built-in route: its outcome, or `undefined` when only the scanner may answer. Text
 * decoded with a replacement character goes to the scanner, because that is an error a report must
 * count and `JSON.parse` cannot. Never reported: `builtinAllowed` declines every call that asks.
 */
export const builtinParse = (source: WholeInputSource, opts: ResolvedOptions) => {
  if (source.malformed.length > 0) return undefined;
  const { text } = source;
  const built = builtinRead(text, opts);
  if (built === undefined) return undefined;
  const { value } = built;
  const completion =
    built.cut === undefined
      ? { complete: true as const }
      : { complete: false as const, cut: built.cut };
  if (!acceptsBuiltRoot(value, opts)) {
    const recovered =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? { value, ...completion }
        : undefined;
    return bareFailure(noMatch(opts, recovered), false);
  }
  // Only the whole-text attempt serves `locations` (the gate declines it), so a value here under
  // `locations` is the whole text's.
  return opts.locations
    ? { ok: true as const, value, ...completion, span: spanOf(nativeSpan(text), source.positionAt) }
    : { ok: true as const, value, ...completion };
};

/**
 * `repair` on the built-in route: already valid JSON comes back untouched, cut to the candidate,
 * or `undefined` when only the scanner may answer. The whitespace `JSON.parse` tolerates around a
 * value is not part of it, and the scanner path returns the candidate too. `textIsFaithful` applies
 * the policies `JSON.parse` cannot report, while returning the source slice guarantees byte
 * identity without relying on the edit log. The attempt is skipped where it cannot serve: options
 * it cannot honour, or a cut-off container, which `JSON.parse` would build nearly whole before
 * throwing. The pre-scan gate cannot serve `repair` either: its text drops source whitespace the
 * edit log keeps (`"a", ` repairs to `"a" }`, the gate writes `"a"}`), and repairs are byte edits
 * to the source.
 */
export const builtinRepair = (
  source: WholeInputSource,
  opts: ResolvedOptions,
  retain?: (value: unknown, cut: Cut | undefined) => void,
) => {
  const { text } = source;
  if (source.malformed.length > 0 || !builtinAllowed(opts) || cutOffContainer(text))
    return undefined;
  const parsed = parsedWhole(text);
  // Invalid JSON always needs the scanner; valid JSON may still need a configured policy.
  if (parsed === undefined || !textIsFaithful(text, opts)) return undefined;
  if (!acceptsBuiltRoot(parsed, opts)) {
    const recovered =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? { value: parsed, complete: true as const }
        : undefined;
    return bareFailure(noMatch(opts, recovered), false);
  }
  const span = nativeSpan(text);
  // A cancellable worker may need the original recovery after text projection; never reparse it.
  retain?.(parsed, undefined);
  // A small input or native span can borrow an arbitrarily large caller source.
  const value = ownText(text.slice(span.start, span.end));
  return opts.locations
    ? { ok: true as const, value, complete: true as const, span: spanOf(span, source.positionAt) }
    : { ok: true as const, value, complete: true as const };
};
