// SPDX-License-Identifier: Apache-2.0

/**
 * The four presets, as constants.
 *
 * Import constants directly so unused presets can be dropped without a runtime name lookup.
 * Each names a recovery contract so callers can choose by their input instead of setting each flag.
 *
 * Streams use the same recovery presets as whole-input calls. Select reporting separately; a
 * recovery preset must not silently change transport, snapshot ownership or result validation.
 */

import type { ParserOptions } from "./options";

/*
 * Each preset is `as const` and `satisfies ParserOptions` rather than annotated `: ParserOptions`.
 * The annotation would put every optional key into the constant's TYPE, and the result types read
 * the options they were given: an annotated preset carries a `select` of unknown presence, so
 * `parse(text, STRICT)` would hand back "value or matches" and make every caller narrow a union
 * that cannot occur. `satisfies` keeps the check and leaves the absent keys absent.
 */

/**
 * Every leniency off plus `maxErrors: 1`: the first forbidden construct ends the scan, so no second
 * recovery path exists to disagree with the ordinary one. This reports strict syntax; it is not a
 * replacement for `JSON.parse`, because the package still extracts the first value from prose. A
 * refusal inside prose that is then rejected leaves with the prose, so it neither fails nor stops.
 *
 * Named for what it guarantees, strict syntax, rather than for how fast it feels.
 */
export const STRICT = /* @__PURE__ */ Object.freeze({
  allowComments: false,
  allowSingleQuotes: false,
  allowTrailingComma: false,
  allowUnquotedKeys: false,
  allowJavaScript: false,
  repairBroken: false,
  maxErrors: 1,
} as const) satisfies ParserOptions;

/**
 * The preset matching the private package's default parsing leniency: native first, fuzzy on
 * failure, no report because the compatibility callers discarded it.
 *
 * **Leniency stays ON, and the conformance corpus is why.** The name suggests strictness, but the
 * recording of `parseJsonCompat` on `{"a": 'b', 'c': "d"}` returns `{"a":"b","c":"d"}`: those
 * functions accept single quotes and their callers depend on it. `COMPAT` promises the OLD
 * behaviour, not a tidy one; `STRICT` is where a caller goes for RFC 8259.
 *
 * `allowJavaScript` is named explicitly even though the package default now agrees with it. A preset
 * promising OLD behaviour must be read off the old code's DEFAULTS, not off ours: `parseJsonCompat`
 * constructed its parser with no options and so ran under `LLM_BALANCED`, which set it on. Recorded:
 * `{hex: 0xFF}` returns `{"hex":255}` and `score: NaN` survives as `NaN`. Leaning on our default
 * instead would make this preset's promise change silently the day that default does.
 */
// Recorded: `{octal: 0123}` returned `{"octal":123}`. The default keeps the text `"0123"` instead,
// because the zero cannot be recovered once dropped; the legacy callers relied on the number.
// A lone word read as a string: `parseJsonCompat("invalid")` returned `"invalid"`.
// Frozen on its own: freezing `COMPAT` is shallow, and a write here would change the preset for
// every caller in the realm.
const COMPAT_RECOVER = /* @__PURE__ */ Object.freeze({
  "leading-zero-number": true,
  "unquoted-root-string": true,
} as const);

export const COMPAT = /* @__PURE__ */ Object.freeze({
  allowJavaScript: true,
  recover: COMPAT_RECOVER,
} as const) satisfies ParserOptions;

/**
 * The default, and what `initParser()` with no arguments gives you. Everything a model reliably gets
 * wrong about JSON syntax is forgiven, `allowJavaScript` included, because the default gives the most
 * helpful recovery reasonably possible; healing is silent unless a report was asked for.
 *
 * `undefined`, `NaN` and `Infinity` really are different VALUES rather than misspellings, which is
 * the argument for asking first — but the alternative is worse. With them refused, recorded inputs
 * holding them fail outright, and BOTH verbs refuse them: `parse` returns a failure whose data the
 * caller must dig out of `recovered`, and `repair` returns `policy-refused`, which names the flag
 * rather than the obstacle. With them recognised, `parse` returns the real values and `repair`
 * writes each as `null`, keeping its key or array position and reporting it as `js-literal`.
 */
export const LLM_BALANCED = /* @__PURE__ */ Object.freeze({} as const) satisfies ParserOptions;

/**
 * Maximum recovery, for "parse whatever the model emitted". Dangerous keys are dropped rather than
 * kept. `allowJavaScript` is named although the default already sets it, for the reason `COMPAT`
 * gives: a preset promising a maximum must name what it needs, or it quietly loses it when a default
 * moves.
 */
export const LLM_FULL = /* @__PURE__ */ Object.freeze({
  allowJavaScript: true,
  onDangerousKey: "drop",
} as const) satisfies ParserOptions;
