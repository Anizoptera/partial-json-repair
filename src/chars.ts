// SPDX-License-Identifier: Apache-2.0

/**
 * Character classification for the scanner: code-unit names, lookup tables and the state tags.
 *
 * Pure data with no scan state, kept apart from `scan.ts` because it is a different job — deciding
 * what class a byte belongs to, rather than what to do about it — and because it is the module the
 * Rust port writes first and shares with everything downstream of it.
 *
 * Every shape here is measured rather than chosen (`bench/primitives.bench.ts`, table in
 * `bench/AGENTS.md`): a `Uint8Array` lookup beats regex `.test` per character by 10.3x and `switch` by
 * 1.5x, and the two tables are 128 entries because anything above 0x7f is neither JSON whitespace
 * nor an escape, so the bounds test doubles as the non-ASCII fast path.
 */

// Code units the grammar branches on. Named because `0x7b` in a condition is unreadable, and a
// `Map` or object lookup would allocate on a path that runs per character.
export const TAB = 0x09;
export const LF = 0x0a;
export const CR = 0x0d;
export const SPACE = 0x20;
export const QUOTE = 0x22;
export const APOSTROPHE = 0x27;
export const STAR = 0x2a;
export const PLUS = 0x2b;
export const COMMA = 0x2c;
export const MINUS = 0x2d;
export const DOT = 0x2e;
export const SLASH = 0x2f;
export const ZERO = 0x30;
export const NINE = 0x39;
export const COLON = 0x3a;
const UPPER_A = 0x41;
export const UPPER_E = 0x45;
const UPPER_F = 0x46;
const UPPER_Z = 0x5a;
export const OPEN_BRACKET = 0x5b;
export const BACKSLASH = 0x5c;
export const CLOSE_BRACKET = 0x5d;
export const UNDERSCORE = 0x5f;
export const BACKTICK = 0x60;
const LOWER_A = 0x61;
export const LOWER_B = 0x62;
export const LOWER_E = 0x65;
const LOWER_F = 0x66;
const LOWER_N = 0x6e;
export const LOWER_O = 0x6f;
const LOWER_R = 0x72;
const LOWER_T = 0x74;
export const LOWER_U = 0x75;
export const LOWER_X = 0x78;
const LOWER_Z = 0x7a;
export const OPEN_BRACE = 0x7b;
export const CLOSE_BRACE = 0x7d;

/**
 * A 128-entry ASCII lookup holding `value` at each listed code. Tables are built by this call, never
 * by element writes at module level: a bundler must keep any statement that writes to an object at
 * import, so those writes kept this module in apps that never parse; one annotated call drops.
 */
const table = (entries: readonly (readonly [code: number, value: number])[]): Uint8Array => {
  const built = new Uint8Array(128);
  for (const [code, value] of entries) built[code] = value;
  return built;
};

/** A table holding 1 at each listed code. Arguments stay literals: a call inside them would run. */
const flags = (codes: readonly number[]): Uint8Array => {
  const built = new Uint8Array(128);
  for (const code of codes) built[code] = 1;
  return built;
};

/** 1 wherever either table holds one, plus each listed code. */
const union = (a: Uint8Array, b: Uint8Array, codes: readonly number[]): Uint8Array => {
  const built = new Uint8Array(128);
  for (let i = 0; i < 128; i++) built[i] = a[i] === 1 || b[i] === 1 ? 1 : 0;
  for (const code of codes) built[code] = 1;
  return built;
};

/**
 * Whitespace, as a 128-entry lookup. JSON's whitespace is exactly these four; anything above 0x7f is
 * not whitespace to this grammar, so the table needs no more entries and the bounds test doubles as
 * the non-ASCII fast path.
 */
export const IS_WS = /* @__PURE__ */ flags([SPACE, TAB, LF, CR]);

/** ECMAScript spacing outside JSON's four characters; keep it as content inside values.
 * https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-white-space
 */
export const isExtraWhitespace = (c: number): boolean =>
  c === 0x0b ||
  c === 0x0c ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

/**
 * Characters that end a bare word wherever one is read: the structural delimiters, plus a line
 * break, which ends one even inside a value where an ordinary space does not.
 *
 * A double quote ends one because `{a: b"c"}` is two tokens the source spelled separately. An
 * apostrophe does NOT: `don't` is one word, and splitting it would lose the rest of the value.
 */
export const ENDS_WORD = /* @__PURE__ */ flags([
  LF,
  CR,
  COMMA,
  QUOTE,
  OPEN_BRACE,
  CLOSE_BRACE,
  OPEN_BRACKET,
  CLOSE_BRACKET,
]);

/**
 * Characters that may legally FOLLOW a completed scalar token. Anything else means the token was
 * never a scalar of that kind: `1_000` is not the number 1 with junk after it, it is one damaged
 * token, and reading it as `1` hands back a number the source never wrote while `_000` goes on to
 * become an invented key that swallows the member after it.
 *
 * A slash counts, so a comment straight after a number still ends it.
 */
const ENDS_SCALAR = /* @__PURE__ */ union(ENDS_WORD, IS_WS, [COLON, SLASH]);

/** True past the end of the input too: nothing following a token cannot contradict it. */
// Non-ASCII content stays in the word unless it is whitespace.
export const endsScalar = (c: number): boolean =>
  Number.isNaN(c) || ENDS_SCALAR[c] === 1 || isExtraWhitespace(c);

/** Single-character escapes, indexed by the character AFTER the backslash. 0 means "not an escape". */
export const ESCAPE = /* @__PURE__ */ table([
  [QUOTE, QUOTE],
  [BACKSLASH, BACKSLASH],
  [0x2f, 0x2f], // `/`
  [LOWER_B, 0x08],
  [LOWER_F, 0x0c],
  [LOWER_N, LF],
  [LOWER_R, CR],
  [LOWER_T, TAB],
]);

/**
 * Whether this code unit ends a member. Used only by the quote-mismatch lookahead, where it is what
 * separates a real quote-style switch from an apostrophe inside ordinary prose. `NaN` at end of
 * input is not a separator, so a trailing apostrophe stays inside its string.
 */
export const isSeparator = (c: number): boolean =>
  c === COMMA || c === COLON || c === CLOSE_BRACE || c === CLOSE_BRACKET;

/** Structural punctuation can follow a stray escape; letters and quoted content cannot. */
export const isDelimiter = (c: number): boolean =>
  isSeparator(c) || c === OPEN_BRACE || c === OPEN_BRACKET;

/** Value of a hex digit, or -1. Range comparisons rather than a table: three branches, no memory. */
export const hexValue = (c: number): number => {
  if (c >= ZERO && c <= NINE) return c - ZERO;
  if (c >= LOWER_A && c <= LOWER_F) return c - LOWER_A + 10;
  if (c >= UPPER_A && c <= UPPER_F) return c - UPPER_A + 10;
  return -1;
};

/** What the scanner is waiting for. The grammar is small enough that these four cover it. */
export const ST_VALUE = 0;
export const ST_KEY = 1;
export const ST_COLON = 2;
export const ST_AFTER = 3;

/**
 * Bare words that are JavaScript values but not JSON ones, and what they mean when `allowJavaScript`
 * lets them through. `-Infinity` uses numeric boundaries: `[-Infinity 2]` keeps two numbers,
 * while a bare string may contain spaces. The scalar reader owns that distinction.
 */
export const JS_LITERAL = /* @__PURE__ */ (() =>
  // Inside a function: as a call argument, the `Number.POSITIVE_INFINITY` read counts as possible
  // work to esbuild, which then keeps this module in bundles that never parse.
  new Map<string, number | undefined>([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ]))();

/** Literal spellings the reader folds case for, so their prefixes are matched without case. */
const FOLDED_LITERALS = ["true", "false", "null", "none", "nil"] as const;
const CASED_LITERALS = ["undefined", "NaN", "Infinity", "-Infinity"] as const;

/** An unfinished word may still become a literal, including one already spelled in full. */
export const canBeLiteral = (word: string): boolean => {
  // Only a word short enough to match a folded literal needs a case-converted copy.
  let folded: string | undefined;
  return (
    FOLDED_LITERALS.some(
      (literal) =>
        word.length <= literal.length && literal.startsWith((folded ??= word.toLowerCase())),
    ) || CASED_LITERALS.some((literal) => literal.startsWith(word))
  );
};

/**
 * Whether a bare word is a proper prefix of a literal the reader would recognise: `tru`, `nul`,
 * `Infin`. At end of input such a word is a literal the source never finished, not prose, and
 * reading it as the string `"tru"` would invent a type the source did not write (HLD P1). A complete
 * literal is not a prefix of itself, and a word that is no literal's prefix stays an unquoted string.
 */
export const isLiteralPrefix = (word: string): boolean => {
  if (word === "") return false;
  const folded = word.toLowerCase();
  for (const literal of FOLDED_LITERALS)
    if (literal.length > word.length && literal.startsWith(folded)) return true;
  for (const literal of CASED_LITERALS)
    if (literal.length > word.length && literal.startsWith(word)) return true;
  return false;
};

/**
 * Whether this code unit belongs to a fenced block's info string (the ` ```json ` after the ticks).
 *
 * The info string runs to end of line in Markdown, but an LLM writes ` ```js{"a":1} ` often enough
 * that consuming the rest of the line would swallow the value it was announcing. A language name is
 * a bare word, so the word is what gets consumed and the content starts wherever it stops.
 */
export const isInfoChar = (c: number): boolean =>
  (c >= LOWER_A && c <= LOWER_Z) ||
  (c >= UPPER_A && c <= UPPER_Z) ||
  (c >= ZERO && c <= NINE) ||
  c === MINUS ||
  c === PLUS ||
  c === UNDERSCORE;

/** Value of a digit in any base up to 16, or 99 — which is below no radix, so it always stops a run. */
export const digitValue = (c: number): number =>
  c >= ZERO && c <= NINE
    ? c - ZERO
    : c >= LOWER_A && c <= LOWER_F
      ? c - LOWER_A + 10
      : c >= UPPER_A && c <= UPPER_F
        ? c - UPPER_A + 10
        : 99;
