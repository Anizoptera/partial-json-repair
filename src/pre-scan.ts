// SPDX-License-Identifier: Apache-2.0

/**
 * The pre-scan gate: one pass over whole-input text deciding whether a built-in parser can give the
 * scanner's exact answer, and how to hand it the text.
 *
 * **It decides a ROUTE, never a meaning.** The scanner is the one mechanism that decides what the
 * bytes mean (root `AGENTS.md`). This pass recognises only a narrow strict-JSON shape, plus the
 * shapes whose scanner answer is that same JSON after a mechanical edit: closers appended at a cut,
 * comments and trailing commas deleted, or plain identifier keys quoted. One unquoted key in a large
 * reply otherwise sends the whole text to the scanner, several times slower than `JSON.parse`. Anything else, and anything the policy would treat
 * differently from `JSON.parse`, answers `scanner`. Every non-scanner verdict is held to the scanner
 * by `test/pre-scan.test.ts`, a differential test over the corpus, its prefixes and seeded mutations;
 * a shape that test does not reach must stay on the scanner.
 *
 * **Conservative by construction.** A wrong `scanner` costs speed; a wrong fast route returns a
 * different value from the same bytes (HLD P3). So every unclear case — a comment outside the root
 * container, a comment beside a cut, a fence that is not exactly three backticks, `\r` inside a line
 * comment — declines rather than imitating the scanner's handling of it.
 *
 * Allocation-light: a `charCodeAt` loop, no regex (none may decide structure, `src/AGENTS.md`), and
 * one small numeric stack per call. Keys are decoded only for the policy check when a key policy
 * is active, and for the cut path once, at the end.
 */

import type { ResolvedOptions } from "./options";
import type { Cut, CutKind } from "./types";
import { DANGEROUS_KEY_NAMES } from "./builder";
import { isExtraWhitespace, isInfoChar } from "./chars";
import { keyText } from "./cut";
import { MAX_EXACT_INT_DIGITS, needsExact, UNDERFLOW_FRACTION_DIGITS } from "./number-fidelity";

/**
 * Where the input goes. On the strict and lenient routes `start` and `end` bound the text a built-in
 * parser reads: the whole input, whose surrounding whitespace `JSON.parse` skips itself, or the value
 * inside a fence. On the cut-off route `start` is where the value begins.
 */
type PreScan =
  | { readonly route: "scanner" }
  | { readonly route: "strict"; readonly start: number; readonly end: number }
  | {
      readonly route: "lenient";
      readonly start: number;
      readonly end: number;
      /**
       * Half-open spans as flat pairs in source order. `[from, to)` is deleted; `[-1 - from, to)`
       * is an unquoted key kept and wrapped in double quotes. One array for both keeps a single
       * source-order walk in `routeText`, where two lists would need a merge.
       */
      readonly edits: readonly number[];
    }
  | {
      readonly route: "cut-off";
      readonly start: number;
      /** Source kept: `[start, keep)`. */
      readonly keep: number;
      /** Whether the kept text ends inside a string value that needs its closing quote. */
      readonly closeString: boolean;
      /** The closers for every container still open, innermost first. */
      readonly closers: string;
      readonly cut: Cut;
    };

/** Every verdict that hands the input to a built-in parser. */
type BuiltinRoute = Exclude<PreScan, { readonly route: "scanner" }>;

const SCANNER: PreScan = /* @__PURE__ */ Object.freeze({ route: "scanner" });

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const STAR = 0x2a;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const BACKTICK = 0x60;
const LOWER_E = 0x65;
const LOWER_U = 0x75;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

// Parser states, one per position in the JSON grammar the loop can be waiting at.
/** A value: the root, or an object member's value after its colon. */
const S_VALUE = 0;
/** Just after `[`: a value or `]`. */
const S_FIRST_ITEM = 1;
/** After a comma in an array: a value, or `]` (a trailing comma). */
const S_NEXT_ITEM = 2;
/** Just after `{`: a key or `}`. */
const S_FIRST_KEY = 3;
/** After a comma in an object: a key, or `}` (a trailing comma). */
const S_NEXT_KEY = 4;
/** After a key: its colon. */
const S_COLON = 5;
/** After a value inside a container: a comma or the closer. */
const S_AFTER = 6;
/** After the root value: only whitespace, or a closing fence when one opened. */
const S_END = 7;

const ARRAY = 0;
const OBJECT = 1;
/** Stack entries per open container: kind, then array item count or object key start, then key end. */
const STRIDE = 3;

const isWs = (c: number): boolean =>
  c <= SPACE && (c === SPACE || c === LF || c === CR || c === TAB);
const isDigit = (c: number): boolean => c >= ZERO && c <= NINE;
const isHex = (c: number): boolean =>
  (c >= ZERO && c <= NINE) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x66);
/**
 * The options under which no built-in parser can serve the call at all: anything requested that
 * `JSON.parse` cannot report (a report, locations), cannot build (selection, exact numbers,
 * null-prototype objects) or cannot refuse (a caller who switched duplicate-key recovery off, since
 * `JSON.parse` collapses the duplicate silently).
 */
const eligible = (opts: ResolvedOptions): boolean =>
  opts.builtinParsers &&
  opts.diagnostics === false &&
  !opts.locations &&
  !opts.exactNumbers &&
  !opts.nullPrototype &&
  opts.selection === undefined &&
  opts.recover["duplicate-key"];

/** Every repair a cut can make the scanner emit; the cut-off route needs all of them enabled. */
const cutAllowed = (opts: ResolvedOptions): boolean =>
  opts.recover["unclosed-string"] &&
  opts.recover["unclosed-object"] &&
  opts.recover["unclosed-array"] &&
  opts.recover["dropped-member"] &&
  opts.recover["trailing-comma"];

/**
 * Decides the route for `text` under `opts` in one pass. See the module comment for what each route
 * promises; `routeText` builds the text a built-in parser then reads.
 */
export const preScan = (text: string, opts: ResolvedOptions): PreScan => {
  if (!eligible(opts)) return SCANNER;
  const n = text.length;
  // `maxBuffer` bounds streams only, but declining here costs nothing on any realistic input and
  // keeps the gate from ever being the one path that reads past a configured bound.
  if (n > opts.maxBuffer) return SCANNER;
  // `keep` writes dangerous keys as own data, which is exactly what `JSON.parse` does; only `drop`,
  // `reject` and extra keys need the keys read.
  const dangerous: ReadonlySet<string> | undefined =
    opts.onDangerousKey !== "keep" || opts.customDangerousKeys.length > 0
      ? new Set([...DANGEROUS_KEY_NAMES, ...opts.customDangerousKeys])
      : undefined;
  const maxDepth = opts.maxDepth;

  let i = 0;
  while (i < n && isWs(text.charCodeAt(i))) i++;
  let fenced = false;
  if (i < n && text.charCodeAt(i) === BACKTICK) {
    // Exactly one leading fence, of exactly three backticks at a line head. Only whitespace can sit
    // before it here, so the line-head test is: nothing but spaces and tabs back to a LF or the start.
    if (!atLineHead(text, i)) return SCANNER;
    if (
      text.charCodeAt(i + 1) !== BACKTICK ||
      text.charCodeAt(i + 2) !== BACKTICK ||
      text.charCodeAt(i + 3) === BACKTICK
    ) {
      return SCANNER;
    }
    i += 3;
    while (i < n && isInfoChar(text.charCodeAt(i))) i++;
    if (i < n && text.charCodeAt(i) === LF) i++;
    // The scanner accepts a fenced value without other data marks only when it starts exactly where
    // the fence's content does (`"```json [1]\n```"` finds no candidate), and finds none in a
    // CRLF-fenced block (`"```json\r\n[1]\r\n```"`). Both decline.
    if (i < n && isWs(text.charCodeAt(i))) return SCANNER;
    for (let j = 0; j < i; j++) if (text.charCodeAt(j) === CR) return SCANNER;
    fenced = true;
  }
  if (i >= n) return SCANNER;
  const start = i;

  const stack: number[] = [];
  let depth = 0;
  let state = S_VALUE;
  /** End of the source the value represents so far: after the last finished item or opener. */
  let keep = start;
  /** The last comma read, for a trailing-comma deletion. */
  let commaAt = -1;
  let edits: number[] | undefined;
  let end = -1;

  // On EOF inside a token, these record what the token was, for the cut.
  let cutKind: CutKind | undefined;
  let cutItem = false;
  let cutKeep = -1;
  /** Where the unfinished token the cut reports as `text` begins, when one was cut. */
  let cutToken = -1;
  let closeString = false;

  /** A value finished at `e`: the item count moves on, and the parent waits for a comma or closer. */
  const finished = (e: number): void => {
    keep = e;
    if (depth === 0) {
      end = e;
      state = S_END;
      return;
    }
    const top = (depth - 1) * STRIDE;
    if (stack[top] === ARRAY) stack[top + 1] = (stack[top + 1] as number) + 1;
    state = S_AFTER;
  };

  /** The string just finished may hold an apostrophe the scanner could read as its closer. */
  let risky = false;

  scan: while (i < n) {
    let c = text.charCodeAt(i);
    // Whitespace runs are skipped in one tight loop: pretty-printed JSON is mostly indentation.
    if (c <= SPACE) {
      if (c !== SPACE && c !== LF && c !== CR && c !== TAB) return SCANNER;
      do c = text.charCodeAt(++i);
      while (c === SPACE || c === LF || c === CR || c === TAB);
      if (i >= n) break;
    }
    // Comments inside the root container.
    if (risky) {
      if (c === SLASH || c === BACKTICK) return SCANNER;
      risky = false;
    }
    if (c === SLASH) {
      if (depth === 0 || state === S_END) return SCANNER;
      const next = text.charCodeAt(i + 1);
      let j: number;
      if (next === STAR) {
        j = text.indexOf("*/", i + 2);
        if (j < 0) return SCANNER;
        j += 2;
      } else if (next === SLASH) {
        j = i + 2;
        while (j < n) {
          const d = text.charCodeAt(j);
          if (d === LF) break;
          // Where a line comment ends at a lone CR is the scanner's call; decline rather than guess.
          if (d === CR) return SCANNER;
          j++;
        }
        if (j >= n) return SCANNER;
      } else {
        return SCANNER;
      }
      (edits ??= []).push(i, j);
      i = j;
      continue;
    }

    switch (state) {
      case S_END: {
        if (!fenced || c !== BACKTICK || !atLineHead(text, i)) return SCANNER;
        for (let j = end; j < i; j++) if (text.charCodeAt(j) === CR) return SCANNER;
        if (
          text.charCodeAt(i + 1) !== BACKTICK ||
          text.charCodeAt(i + 2) !== BACKTICK ||
          text.charCodeAt(i + 3) === BACKTICK
        ) {
          return SCANNER;
        }
        i += 3;
        while (i < n) if (!isWs(text.charCodeAt(i++))) return SCANNER;
        break scan;
      }
      case S_AFTER: {
        const top = (depth - 1) * STRIDE;
        if (c === COMMA) {
          commaAt = i;
          state = stack[top] === ARRAY ? S_NEXT_ITEM : S_NEXT_KEY;
          i++;
          continue;
        }
        if (c !== (stack[top] === ARRAY ? CLOSE_BRACKET : CLOSE_BRACE)) return SCANNER;
        depth--;
        finished(++i);
        continue;
      }
      case S_COLON: {
        if (c !== COLON) return SCANNER;
        state = S_VALUE;
        i++;
        continue;
      }
      case S_FIRST_KEY:
      case S_NEXT_KEY: {
        if (c === CLOSE_BRACE) {
          if (state === S_NEXT_KEY) edits = insertSpan(edits, commaAt);
          depth--;
          finished(++i);
          continue;
        }
        if (c === APOSTROPHE) {
          const close = singleQuotedEnd(text, i);
          if (close < 0) return SCANNER;
          if (dangerous !== undefined && dangerous.has(text.slice(i + 1, close))) return SCANNER;
          edits = pushSingleQuoted(edits, i, close);
          risky = true;
          i = close + 1;
          state = S_COLON;
          continue;
        }
        if (c !== QUOTE) {
          const j = unquotedKeyEnd(text, i);
          if (j < 0) return SCANNER;
          if (dangerous !== undefined && dangerous.has(text.slice(i, j))) return SCANNER;
          // A cut with any edit declines below, so the cut path never decodes these positions.
          (edits ??= []).push(-1 - i, j);
          i = j;
          state = S_COLON;
          continue;
        }
        const close = stringEnd(text, i + 1);
        if (close === INVALID) return SCANNER;
        if (close < 0) {
          // Input ends inside a key: no member was written, so the cut is between items. Its `text`
          // is the key re-spelled from its decoded form (`keyText`), so the raw source serves only
          // where re-spelling the raw characters changes nothing: never across an escape (its
          // backslash would be doubled) or a lone surrogate (it would be escaped).
          if (quoteRisk) return SCANNER;
          if (keyText(QUOTE, text.slice(i + 1)) !== text.slice(i)) return SCANNER;
          cutKind = "between";
          cutToken = i;
          break scan;
        }
        risky = quoteRisk;
        const top = (depth - 1) * STRIDE;
        stack[top + 1] = i;
        stack[top + 2] = close;
        if (dangerous !== undefined && dangerous.has(keyAt(text, i, close))) return SCANNER;
        i = close + 1;
        state = S_COLON;
        continue;
      }
      case S_FIRST_ITEM:
      case S_NEXT_ITEM: {
        if (c === CLOSE_BRACKET) {
          if (state === S_NEXT_ITEM) edits = insertSpan(edits, commaAt);
          depth--;
          finished(++i);
          continue;
        }
        break;
      }
      default:
        break;
    }

    // A value.
    if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      if (++depth > maxDepth) return SCANNER;
      // Frames are addressed by `depth` and never popped: a closed frame is overwritten by the next
      // container at its depth. Shrinking with `stack.length = top` cost V8 a runtime trim per
      // closer, 10% of the whole pass on compact JSON.
      const at = (depth - 1) * STRIDE;
      if (c === OPEN_BRACE) {
        stack[at] = OBJECT;
        stack[at + 1] = -1;
        stack[at + 2] = -1;
        state = S_FIRST_KEY;
      } else {
        stack[at] = ARRAY;
        stack[at + 1] = 0;
        stack[at + 2] = 0;
        state = S_FIRST_ITEM;
      }
      keep = ++i;
      continue;
    }
    if (c === APOSTROPHE) {
      const close = singleQuotedEnd(text, i);
      if (close < 0) return SCANNER;
      edits = pushSingleQuoted(edits, i, close);
      risky = true;
      finished((i = close + 1));
      continue;
    }
    if (c === QUOTE) {
      const close = stringEnd(text, i + 1);
      if (close === INVALID) return SCANNER;
      if (close < 0) {
        if (quoteRisk) return SCANNER;
        cutKind = "string";
        cutItem = true;
        closeString = true;
        // `-1 - close` is where an unfinished escape starts, or the end of input.
        cutKeep = -1 - close;
        break scan;
      }
      risky = quoteRisk;
      finished((i = close + 1));
      continue;
    }
    if (c === MINUS || isDigit(c)) {
      const s = i;
      // The JSON number grammar, read once: sign, integer, fraction, exponent.
      if (c === MINUS) c = text.charCodeAt(++i);
      let intDigits = 0;
      let fracDigits = 0;
      let exponent = false;
      let valid = false;
      if (c === ZERO) {
        i++;
        intDigits = 1;
        valid = true;
      } else if (isDigit(c)) {
        while (i < n && isDigit(text.charCodeAt(i))) i++;
        intDigits = i - s - (text.charCodeAt(s) === MINUS ? 1 : 0);
        valid = true;
      }
      if (valid && text.charCodeAt(i) === DOT) {
        const from = ++i;
        while (i < n && isDigit(text.charCodeAt(i))) i++;
        fracDigits = i - from;
        valid = fracDigits > 0;
      }
      if (valid && (text.charCodeAt(i) | 0x20) === LOWER_E) {
        exponent = true;
        i++;
        const sign = text.charCodeAt(i);
        if (sign === PLUS || sign === MINUS) i++;
        const from = i;
        while (i < n && isDigit(text.charCodeAt(i))) i++;
        valid = i > from;
      }
      if (i >= n && !valid) {
        // An unfinished prefix (`-`, `1.`, `1e`, `1e+`) at the end of input: the scanner drops the
        // item. At the root it ends the candidate search instead, which only the scanner reports.
        if (depth === 0) return SCANNER;
        cutKind = "missing";
        cutItem = true;
        cutToken = s;
        break scan;
      }
      if (!valid) return SCANNER;
      if (
        !(
          intDigits > 0 &&
          intDigits <= MAX_EXACT_INT_DIGITS &&
          fracDigits <= UNDERFLOW_FRACTION_DIGITS &&
          !exponent
        ) &&
        needsExact(text.slice(s, i))
      ) {
        return SCANNER;
      }
      if (depth === 0 && i - s > opts.maxScalar) return SCANNER;
      if (i >= n && depth > 0) {
        // A valid number touching the end may be the start of a longer one: kind `number`.
        cutKind = "number";
        cutItem = true;
        cutKeep = n;
        break scan;
      }
      finished(i);
      continue;
    }
    const literal: string | undefined =
      c === 0x74 ? "true" : c === 0x66 ? "false" : c === 0x6e ? "null" : undefined;
    if (literal === undefined) return SCANNER;
    let k = 1;
    while (k < literal.length && i + k < n && text.charCodeAt(i + k) === literal.charCodeAt(k)) k++;
    if (k < literal.length) {
      if (i + k < n || depth === 0) return SCANNER;
      // A literal cut by the end of input (`tru`): the scanner drops the item.
      cutKind = "missing";
      cutItem = true;
      cutToken = i;
      break scan;
    }
    if (depth === 0 && literal.length > opts.maxScalar) return SCANNER;
    i += literal.length;
    // With no space before it, the scanner reads `//` or `/*` as part of the word (`true//c` is the
    // string "true//c", which keeps `http://x` whole), where deleting the comment would give `true`.
    if (text.charCodeAt(i) === SLASH) return SCANNER;
    finished(i);
  }

  if (depth === 0 && cutKind === undefined) {
    if (state !== S_END) return SCANNER;
    // Unfenced, the whole text goes to `JSON.parse`: slicing off whitespace it skips anyway would
    // copy every document that ends in a newline.
    const from = fenced ? start : 0;
    const to = fenced ? end : n;
    if (edits === undefined) return { route: "strict", start: from, end: to };
    if (!lenientAllowed(text, edits, opts)) return SCANNER;
    return { route: "lenient", start: from, end: to, edits };
  }

  // The input ended inside the value. A string with a risky apostrophe right before the end has no
  // follower to vindicate its closing quote, so the scanner may re-read it.
  if (edits !== undefined || risky || !cutAllowed(opts)) return SCANNER;
  if (depth === 0) {
    // A root string must fill the trimmed document; an unfinished one ending in whitespace does not,
    // and the scanner then finds no candidate at all.
    const last = text.charCodeAt(n - 1);
    if (isWs(last) || isExtraWhitespace(last)) return SCANNER;
  }
  if (cutKind === undefined) {
    // Ended between tokens. After a key, or after its colon, the member was named and its value never
    // came: that item is `missing`. Everywhere else no item was started.
    if (state === S_COLON || state === S_VALUE) {
      cutKind = "missing";
      cutItem = true;
    } else {
      cutKind = "between";
    }
  }
  const kept = cutKeep >= 0 ? cutKeep : keep;
  let closers = "";
  for (let f = depth - 1; f >= 0; f--) closers += stack[f * STRIDE] === ARRAY ? "]" : "}";
  const path = cutPath(text, stack, depth, cutItem);
  // `text` is the unfinished token the value leaves out (`src/cut.ts` says why not more): a cut
  // key, literal or number prefix, or the half escape a string kept out; nothing between tokens.
  const from = cutToken >= 0 ? cutToken : cutKeep >= 0 ? cutKeep : n;
  const cut: Cut =
    from < n ? { path, kind: cutKind, text: text.slice(from) } : { path, kind: cutKind };
  return { route: "cut-off", start, keep: kept, closeString, closers, cut };
};

/**
 * Whether the string `stringEnd` last read holds an apostrophe directly before `,` `:` `}` or `]`.
 * The scanner treats that apostrophe as a possible mismatched closer and keeps it only when the real
 * closing quote is followed by what a closer must be followed by. Strict JSON always supplies that,
 * except where a comment or a closing fence follows the string, or where the string is cut, so those
 * three decline. Module state rather than a second return value: the gate is synchronous and
 * re-entrant use is impossible.
 */
let quoteRisk = false;

/**
 * Sentinel for a string the scanner would read differently from `JSON.parse`: a raw control
 * character, or an escape JSON does not define.
 */
const INVALID = -0x7fffffff;

/**
 * The index of the closing quote of the string whose content starts at `from`. At end of input,
 * `-1 - at`, where `at` is the start of an unfinished escape (`\`, `\u00`) or the end of input; the
 * escape goes to `cut.text`, never into the value, because half an escape names no character.
 */
const stringEnd = (text: string, from: number): number => {
  const n = text.length;
  let i = from;
  quoteRisk = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    // Lowercase letters and everything above `\` are content: one comparison for the common case.
    if (c > BACKSLASH) {
      i++;
      continue;
    }
    if (c === QUOTE) return i;
    if (c < SPACE) return INVALID;
    if (c !== BACKSLASH) {
      if (c === APOSTROPHE) {
        const d = text.charCodeAt(i + 1);
        if (d === COMMA || d === COLON || d === CLOSE_BRACE || d === CLOSE_BRACKET)
          quoteRisk = true;
      }
      i++;
      continue;
    }
    const at = i;
    if (i + 1 >= n) return -1 - at;
    const e = text.charCodeAt(i + 1);
    if (e === LOWER_U) {
      for (let h = 2; h < 6; h++) {
        if (i + h >= n) return -1 - at;
        if (!isHex(text.charCodeAt(i + h))) return INVALID;
      }
      i += 6;
      continue;
    }
    if (
      e !== QUOTE &&
      e !== BACKSLASH &&
      e !== SLASH &&
      e !== 0x62 &&
      e !== 0x66 &&
      e !== 0x6e &&
      e !== 0x72 &&
      e !== 0x74
    ) {
      return INVALID;
    }
    i += 2;
  }
  return -1 - n;
};

/** The decoded key whose quotes sit at `open` and `close`. Escapes are rare, so they alone pay a decode. */
const keyAt = (text: string, open: number, close: number): string => {
  const raw = text.slice(open + 1, close);
  return raw.includes("\\") ? (JSON.parse(text.slice(open, close + 1)) as string) : raw;
};

/**
 * Adds the one-character span at `at` in source order. A trailing comma is only known to be one at
 * the closer, after any comment between it and the closer was already recorded.
 */
const insertSpan = (edits: number[] | undefined, at: number): number[] => {
  const spans = edits ?? [];
  let d = spans.length;
  while (d > 0 && spanStart(spans[d - 2] as number) > at) d -= 2;
  spans.splice(d, 0, at, at + 1);
  return spans;
};

/** Whether only spaces and tabs separate `i` from a LF or the start of the text. */
const atLineHead = (text: string, i: number): boolean => {
  let j = i;
  while (j > 0) {
    const c = text.charCodeAt(j - 1);
    if (c === LF) return true;
    if (c !== SPACE && c !== TAB) return false;
    j--;
  }
  return true;
};

/**
 * The closing apostrophe of a single-quoted string opening at `open`, or -1 to decline. Only content
 * that needs no re-escaping and gives the scanner's apostrophe heuristics nothing to weigh: no inner
 * quote of either kind, no backslash, no control character, and a closer before the end of input.
 */
const singleQuotedEnd = (text: string, open: number): number => {
  for (let i = open + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === APOSTROPHE) return i;
    if (c < SPACE || c === QUOTE || c === BACKSLASH) return -1;
  }
  return -1;
};

/** `'abc'` as three source-order spans: drop the opening quote, wrap the content, drop the closer. */
const pushSingleQuoted = (edits: number[] | undefined, open: number, close: number): number[] => {
  const spans = edits ?? [];
  spans.push(open, open + 1, -1 - (open + 1), close, close, close + 1);
  return spans;
};

/** Where a span in `edits` starts in the source, whatever its kind. */
const spanStart = (encoded: number): number => (encoded < 0 ? -1 - encoded : encoded);

/**
 * The end of an unquoted key starting at `i`, or -1 to decline. Only a plain ASCII identifier ending
 * at whitespace or its colon: the scanner reads any bare word as a key, so a narrower set is safe, and
 * anything wider (a `/` it would read into the word, a word it may read as a literal) stays with it.
 */
const unquotedKeyEnd = (text: string, i: number): number => {
  if (!isIdentStart(text.charCodeAt(i))) return -1;
  let j = i + 1;
  while (j < text.length && (isIdentStart(text.charCodeAt(j)) || isDigit(text.charCodeAt(j)))) j++;
  const after = text.charCodeAt(j);
  if (after !== COLON && !isWs(after)) return -1;
  return LITERAL_WORDS.has(text.slice(i, j)) ? -1 : j;
};
const isIdentStart = (c: number): boolean =>
  ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a) || c === 0x5f || c === 0x24;
const LITERAL_WORDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
]);

/** Whether the policy enables every repair the edits stand for. */
const lenientAllowed = (text: string, edits: readonly number[], opts: ResolvedOptions): boolean => {
  for (let d = 0; d < edits.length; d += 2) {
    const at = edits[d] as number;
    // A wrapped span right after an apostrophe is a single-quoted string's content, else a bare key.
    const kind =
      at < 0
        ? text.charCodeAt(-2 - at) === APOSTROPHE
          ? "single-quote"
          : "unquoted-key"
        : text.charCodeAt(at) === COMMA
          ? "trailing-comma"
          : text.charCodeAt(at) === APOSTROPHE
            ? "single-quote"
            : "comment-removed";
    if (!opts.recover[kind]) return false;
  }
  return true;
};

/**
 * The cut path: each open container's label in its parent, then, when the source made the item
 * addressable, the item's own label (an array index, or a COMPLETE key).
 */
const cutPath = (
  text: string,
  stack: readonly number[],
  depth: number,
  item: boolean,
): (string | number)[] => {
  const path: (string | number)[] = [];
  const last = item ? depth : depth - 1;
  for (let f = 0; f < last; f++) {
    const at = f * STRIDE;
    path.push(
      stack[at] === ARRAY
        ? (stack[at + 1] as number)
        : keyAt(text, stack[at + 1] as number, stack[at + 2] as number),
    );
  }
  return path;
};

/**
 * The text a built-in parser reads for a non-scanner verdict. `suffix` is the caller's `cutSuffix`,
 * appended inside a cut string literal only, JSON-escaped so it stays one string: a suffix on a
 * number would turn it into a string, and one on a missing item would invent a value.
 */
export const routeText = (text: string, verdict: BuiltinRoute, suffix?: string): string => {
  if (verdict.route === "cut-off") {
    let out = text.slice(verdict.start, verdict.keep);
    if (verdict.closeString) {
      if (suffix !== undefined) out += JSON.stringify(suffix).slice(1, -1);
      out += '"';
    }
    return out + verdict.closers;
  }
  if (verdict.route === "strict") {
    return verdict.start === 0 && verdict.end === text.length
      ? text
      : text.slice(verdict.start, verdict.end);
  }
  const { edits } = verdict;
  let out = "";
  let from = verdict.start;
  for (let d = 0; d < edits.length; d += 2) {
    const at = edits[d] as number;
    const to = edits[d + 1] as number;
    out +=
      at < 0 ? `${text.slice(from, -1 - at)}"${text.slice(-1 - at, to)}"` : text.slice(from, at);
    from = to;
  }
  return out + text.slice(from, verdict.end);
};

/** What a built-in parser returns on a non-scanner route, in the shape the wiring needs. */
export type Routed = { readonly value: unknown; readonly complete: boolean; readonly cut?: Cut };

/**
 * Runs the gate and, when it picks a built-in route, `JSON.parse` on that route's text. `undefined`
 * means the scanner must run. Root filters (`objectOnly`, `requiredKeys`) stay with the caller, as
 * they do on today's `JSON.parse` attempt in `parser.ts`.
 */
export const parseRouted = (text: string, opts: ResolvedOptions): Routed | undefined => {
  const verdict = preScan(text, opts);
  if (verdict.route === "scanner") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(
      routeText(text, verdict, opts.cutSuffix === "" ? undefined : opts.cutSuffix),
    );
  } catch {
    // Unreachable when the gate is right; the scanner's answer is the correct one either way.
    return undefined;
  }
  return verdict.route === "cut-off"
    ? { value, complete: false, cut: verdict.cut }
    : { value, complete: true };
};
