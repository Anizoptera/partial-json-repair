// SPDX-License-Identifier: Apache-2.0

import { JS_LITERAL } from "./chars";
import type { ResolvedOptions } from "./options";
import type { ScanDiagnostics } from "./scan-diagnostics";
import type { SwitchableRepair } from "./types";
import {
  type LexicalWindow,
  TOKEN_INVALID,
  TOKEN_STATUS,
  NUMBER_PLUS,
  NUMBER_HEX,
  NUMBER_BINARY,
  NUMBER_OCTAL,
  NUMBER_SEPARATED,
  NUMBER_LEADING_DOT,
  NUMBER_LEADING_ZERO,
  NUMBER_EMPTY_FRACTION,
} from "./lexical-window";

// Classification survives source delivery; this marker is never a recovered value.
export const WORD_TEXT: unique symbol = /* @__PURE__ */ Symbol("unquoted text");
// A source-selected leaf carries classification separately and is never inserted into a value tree.
export const SOURCE_VALUE: unique symbol = /* @__PURE__ */ Symbol("delivered scalar source");
export type WordValue = boolean | number | string | null | undefined | typeof WORD_TEXT;

function lenient(
  window: LexicalWindow,
  diagnostics: ScanDiagnostics,
  opts: ResolvedOptions,
  kind: SwitchableRepair,
  at: number,
): void {
  if (opts.recover[kind]) diagnostics.build.repair(kind, at);
  else diagnostics.record(window.tokenError("unparsable-span", kind));
}

// Policy follows the settled scanner verdict, never a conversion of retained source text.
export function numberKind(
  window: LexicalWindow,
  diagnostics: ScanDiagnostics,
  opts: ResolvedOptions,
  depth: number,
  token: number,
): "number" | "string" {
  const apply = (kind: SwitchableRepair): void => {
    lenient(window, diagnostics, opts, kind, window.numberStart);
  };
  const keepText = (): "string" => {
    apply(depth === 0 ? "unquoted-root-string" : "invalid-number");
    return "string";
  };
  if ((token & TOKEN_STATUS) === TOKEN_INVALID) return keepText();
  if (token & NUMBER_PLUS) apply("leading-plus-number");
  if (token & NUMBER_SEPARATED) apply("numeric-separator");
  if (token & NUMBER_HEX) apply("hex-number");
  else if (token & NUMBER_BINARY) apply("binary-number");
  else if (token & NUMBER_OCTAL) apply("octal-number");
  else if (token & NUMBER_LEADING_DOT) apply("leading-dot-number");
  else if (token & NUMBER_LEADING_ZERO) {
    // Off preserves source intent as text rather than silently deleting a leading zero.
    if (opts.recover["leading-zero-number"]) apply("leading-zero-number");
    else return keepText();
  } else if (token & NUMBER_EMPTY_FRACTION) apply("invalid-number");
  return "number";
}

// An absent candidate means proven nonliteral text, not an unknown or missing value.
export function wordValue(
  window: LexicalWindow,
  diagnostics: ScanDiagnostics,
  opts: ResolvedOptions,
  word: string | undefined,
  depth: number,
): WordValue {
  const start = window.wordStart;
  const apply = (kind: SwitchableRepair): void => {
    lenient(window, diagnostics, opts, kind, start);
  };
  if (word !== undefined) {
    const end = start + word.length;
    if (word === "true" || word === "false") return word === "true";
    if (word === "null") return null;
    // Prefixes and prose must remain text; only complete short tokens can fold to a literal.
    const folded = word.length <= 5 ? word.toLowerCase() : "";
    const canonical = folded === "none" || folded === "nil" ? "null" : folded;
    if (canonical === "true" || canonical === "false" || canonical === "null") {
      apply(canonical === folded ? "literal-case" : "null-alias");
      diagnostics.build.edit(start, end, canonical);
      return canonical === "null" ? null : canonical === "true";
    }
    if (JS_LITERAL.has(word)) {
      const asLiteral = opts.recover["js-literal"];
      apply("js-literal");
      if (diagnostics.build.editsEnabled)
        diagnostics.build.edit(start, end, asLiteral ? "null" : JSON.stringify(word));
      return asLiteral ? JS_LITERAL.get(word) : window.retainedText(word);
    }
  }
  // Nested prose has passed detection; a root word is still the complete candidate.
  apply(depth === 0 ? "unquoted-root-string" : "unquoted-string");
  return WORD_TEXT;
}
