// SPDX-License-Identifier: Apache-2.0

import type { ExecutionUnavailableFailure } from "./async";
import type { Exact } from "./options";
import type { SelectorPath } from "./selector";
import type { TryParsersFailure } from "./try-parsers";

/**
 * The public vocabulary. Nothing a caller branches on is a string: every outcome carries a
 * literal-tagged `kind`, so an unhandled case is a compile error rather than a runtime surprise, and
 * each union maps one-for-one onto a Rust `enum` for the port that follows.
 *
 * English lives in a formatter at the edge, never in these types. The package this was extracted from
 * shipped `recommendations: string[]` and `ParseError.message`, and a caller branching on prose is a
 * caller whose code breaks when the wording improves.
 */

/**
 * Every way the parser can alter what the input said. **The single source of truth**: metrics are
 * `count by kind`, `confidence` is a table keyed by it, and the conformance corpus records it. Three
 * consumers, one list — the package this came from kept 17 hand-maintained counters beside the
 * repairs and they could disagree, which is a defect one union cannot have.
 *
 * A repair means the output differs from a literal reading of the input. It is NOT an error: the
 * parse succeeded, and the caller is being told what it cost.
 */
export type RepairKind =
  // Structure the input opened and never closed. The parser finishes it.
  | "unclosed-string"
  /**
   * A string whose closing quote is missing, ended at a raw line break (LF, CR or CR LF) after
   * which, past blank lines and comments, a quote of the string's own kind opens a key and its colon
   * or follows a comma (`{"a": "x⏎ "b": 1}`, `["a⏎, "b"]`). On by default: the literal reading
   * closes the string at that quote and reads the word after it as a new member, so it returns a
   * key and value the input never had (`{a: "x⏎ ", b: ": 1}"}`), while this reading keeps every
   * member the line spells. That quote never fits as the string's closer, so the break is certain.
   * Also where only closers and whitespace follow the break up to the end of input and the string
   * left no `{` or `[` of its own open (`{"d": "x⏎ }`, `["a⏎]`): those closers close the JSON, while
   * cut code keeps the closer its own text opened (`"f() {⏎}`). A stream waits for the end of input
   * or the rest of the line before deciding; text after the closers keeps them in the string.
   * Also on one line, where closers the string did not open, a comma, an optional `{` and a quoted
   * key with its colon follow (`{"a": "x, "b": 1}`, `[{"n": "a},{"n": "b"}]`): the string ends
   * before them. Off, the same value is returned with an `unparsable-span` error, as for any switched-off kind.
   */
  | "missing-quote"
  /**
   * A string whose closing quote is missing, ended at the first raw line break after which, past
   * blank lines and comments, comes other structure: a closer, a comma, or a bare-word key and its
   * colon (`{a: 'x⏎ b: 2⏎}`, `{"code": "f() {⏎}`); also wherever `missing-quote` applies. Off by
   * default: here the literal reading is also coherent, and it is the right one for multi-line text,
   * such as a graph or code value whose stream was cut before its quote (`"digraph {⏎ a -> b⏎}`),
   * which this would end before `}`: a wrong value that looks right (HLD P1), or prose that writes `Note:` on its own line. Earlier
   * breaks followed by text stay in the string, and a later quote
   * that fits structurally proves the break was content and keeps it there.
   */
  | "guessed-string-end"
  | "unclosed-object"
  | "unclosed-array"
  // Punctuation the input omitted or added.
  | "trailing-comma"
  | "missing-comma"
  | "missing-colon"
  /**
   * Values separated by commas with no brackets around them (`1,2,3`, `{"a":1},{"b":2}`, MongoDB
   * shell output): read as the one array they spell. A comma joins two values only where it touches
   * the first one, so line-separated values (JSONL) stay separate documents.
   */
  | "missing-brackets"
  // A backslash before structural punctuation outside a quoted value.
  | "escaped-delimiter"
  // Non-JSON spacing between tokens, never whitespace inside a value.
  | "non-json-whitespace"
  // Spellings JSON forbids and models emit anyway.
  | "single-quote"
  | "unquoted-key"
  | "quote-mismatch"
  /**
   * A container closed by the other shape of bracket — `[{"b":2]`. The container is closed, which is
   * what every lenient parser does and the only reading under which the rest of the document still
   * lines up. Named for what the input did, not for what was inferred: the object is not "unclosed",
   * it was closed by a character of the wrong shape. Pairs with `quote-mismatch`, which is this rule
   * for the two quote styles.
   */
  | "bracket-mismatch"
  | "comment-removed"
  | "js-literal"
  // Complete true/false/null tokens with noncanonical case; never quoted content or prefixes.
  | "literal-case"
  // Complete None/nil tokens, in any letter case, recovered as null.
  | "null-alias"
  // An escape JSON does not define, or a `\u` with too few hex digits. The character it introduced
  // is kept, which is what every lenient parser does and what a model writing `\d` in a regex means.
  | "invalid-escape"
  // A colon where a value begins (`{"a"::1}`, `[1,:2]`), removed as a doubled separator. A reading,
  // not formatting: the colon could have been content, so unlike a doubled comma it is not free.
  | "extra-colon"
  /**
   * Unquoted text kept as a string — `{"a": foo}`, `{"a": @#$}`, `{"a": tru}` alike. ONE kind, and
   * the name is chosen to be true of all of them: the package this came from counted these as two
   * (`unquotedStrings` for non-word junk, `invalidLiterals` for a word that is no literal), and the
   * union inherited both while the scanner emitted only one, leaving the other declared, penalised,
   * name-mapped and produced by nothing. The distinction is about the input's characters, not about
   * what the parser did, and a caller's action is identical either way, so it buys a second name for
   * one fact. `unknown-literal` was the survivor until measurement showed it false of `@#$`, which
   * holds no literal at all; this name is true of every case and pairs with `unquoted-key`.
   */
  | "unquoted-string"
  /**
   * A whole root that is one unquoted word (`Sorry`, `id-123`) or one token that is no number (`1..5`,
   * a `-` a stray closer ended), or a root string opened by an apostrophe that never closes
   * (`'tis the season`), kept as its text. Off by default: such a root holds no JSON
   * evidence, so it is refused with the text recovered rather than handed over as near-clean data. `COMPAT` turns it on because the legacy `parseJsonCompat` returned such words as strings.
   */
  | "unquoted-root-string"
  // Numbers JSON forbids, or that JavaScript cannot hold.
  | "invalid-number"
  // A decimal fraction without an integer digit, including signed forms.
  | "leading-dot-number"
  // An explicit positive sign; combines with the token's other spelling repairs.
  | "leading-plus-number"
  | "hex-number"
  | "binary-number"
  // `0o17`: the JavaScript and Python octal prefix.
  | "octal-number"
  // `1_000`: digit-group underscores where JavaScript and Python both allow them.
  | "numeric-separator"
  /**
   * `0123` read as 123. No grammar gives a leading-zero integer a decimal value, and the reading
   * deletes the zero for good (a postal code, an id), so it is off by default and the token keeps
   * its source text; `COMPAT` turns it on because the legacy callers it serves relied on it.
   */
  | "leading-zero-number"
  // A byte-order mark is an encoding declaration, not content; JSON text never begins with one.
  | "bom-removed"
  // Data the input gave twice, that policy refused, or that no reading could place.
  | "duplicate-key"
  | "dangerous-key"
  | "dropped-member";

/**
 * Every repair a caller may govern individually.
 *
 * `dangerous-key` is the one exclusion, and excluding it is what keeps one behaviour under one
 * option: its policy is already richer than a disposition — `keep`, `drop` or `reject` under
 * `onDangerousKey` — so a second control here would be a second way to say the same thing, and the
 * two could disagree.
 */
export type SwitchableRepair = Exclude<RepairKind, "dangerous-key">;

/**
 * How much each repair costs `confidence`, as a fraction of remaining certainty.
 *
 * **Formatting repairs are free, and that is the whole design.** A trailing comma, a single quote or
 * a comment tells us the input was sloppy, not that anything was GUESSED — the value is exactly what
 * the author wrote. Only repairs that invented, dropped or reinterpreted data reduce confidence.
 *
 * Multiplicative, never additive: `∏(1 - penalty)`. That is what the package this came from does and
 * what its published thresholds were calibrated against, and it degrades smoothly — an additive sum
 * needs a clamp and hits zero after enough small repairs, which is a different promise to consumers.
 */
// Check keys before freezing; a result annotation permits obsolete extra keys.
export const REPAIR_PENALTY = /* @__PURE__ */ Object.freeze<Record<RepairKind, number>>({
  // Something was manufactured to close a structure the input left open.
  "unclosed-string": 0.1,
  // Where the text ended is a guess, as for a string the end of input cut.
  "missing-quote": 0.1,
  "guessed-string-end": 0.1,
  "unclosed-object": 0.1,
  "unclosed-array": 0.1,
  // Punctuation was inferred: the shape is a reading of the input, not a statement of it.
  "missing-comma": 0.03,
  "missing-colon": 0.03,
  "missing-brackets": 0.03,
  // A token was reinterpreted rather than invented.
  "unquoted-key": 0.03,
  "unquoted-string": 0.03,
  "js-literal": 0.03,
  "literal-case": 0.03,
  "null-alias": 0.03,
  "invalid-number": 0.03,
  "leading-dot-number": 0.03,
  "leading-plus-number": 0.03,
  "hex-number": 0.03,
  "binary-number": 0.03,
  "octal-number": 0.03,
  "leading-zero-number": 0.03,
  "unquoted-root-string": 0.03,
  "quote-mismatch": 0.03,
  "bracket-mismatch": 0.03,
  "invalid-escape": 0.03,
  "extra-colon": 0.03,
  // Data was LOST, which a consumer most needs to know about.
  "duplicate-key": 0.1,
  "dangerous-key": 0.1,
  "dropped-member": 0.1,
  // Free: nothing was guessed, so nothing is less certain.
  "trailing-comma": 0,
  "escaped-delimiter": 0,
  "non-json-whitespace": 0,
  "single-quote": 0,
  "comment-removed": 0,
  "bom-removed": 0,
  // Digit grouping is layout: `1_000` and `1000` name one number in every language that has both.
  "numeric-separator": 0,
});

/**
 * `confidence` for a set of repairs. 1.0 is untouched input; the documented reading is that below
 * 0.7 a caller should consider retrying the model and below 0.5 the output is likely garbled.
 *
 * Those thresholds are a published promise, so `REPAIR_PENALTY` is their one source: this function
 * and the report's running product (`Report`) both read it. The report keeps its own product because
 * it also counts repairs past its entry cap, which this function, given the stored entries, cannot.
 */
export const confidenceOf = (repairs: readonly Repair[]): number =>
  repairs.reduce((acc, r) => acc * (1 - REPAIR_PENALTY[r.kind]), 1);

/**
 * Where something sits in the input the caller handed us. The offset counts the units that input is
 * made of — UTF-16 code units for a string, bytes for a byte view — so it indexes the caller's own
 * data without a second representation. For a stream, `chunk` says which chunk the offset indexes:
 * chunks may switch between text and bytes, so an offset means nothing without the chunk it belongs to.
 */
export type Position = {
  offset: number;
  unit: "utf16" | "byte";
  chunk?: number;
};

/** Half-open `[start, end)` in the source. */
export type Span = { start: Position; end: Position };

/** Where a value sits in its root: object keys and array indexes from the root down. */
export type SourcePath = readonly (string | number)[];

/** A single alteration, located in the source AND inside the value, so a caller can act on either. */
export type Repair = {
  kind: RepairKind;
  /** Where in the SOURCE it happened, so the caller can show the user what was changed. */
  at: Position;
  /** Where inside the value it happened. Empty at the root. */
  path: SourcePath;
  /**
   * WHICH top-level value this belongs to, counted from 0 across the whole parse or stream.
   * A streaming UI has already rendered value 0 by the time value 1 is repaired; without this it
   * cannot tell which rendered object to annotate.
   */
  valueIndex: number;
};

/**
 * Something the scanner observed and could not accept as written. Each is located in the source; what
 * it means for the outcome is decided elsewhere: `unparsable-span` and `dangerous-key` are policy
 * refusals, `depth-budget` is a limit, and `invalid-utf8` decides nothing because the bytes were
 * recovered with replacement characters.
 */
export type ErrorKind = "depth-budget" | "dangerous-key" | "invalid-utf8" | "unparsable-span";

export type ParseError = {
  kind: ErrorKind;
  /** Top-level value this error belongs to, counted from 0 across the parse or stream. */
  valueIndex: number;
  /** Location in the recovered value at the point the error was encountered. */
  path: SourcePath;
  /** Where in the source. `line`/`column` are derived from it for humans. */
  at: Position;
  line: number;
  column: number;
  /**
   * A bounded slice of source around `at`. Bounded deliberately: the error budget defaults to 1000,
   * and 1000 unbounded context strings is the memory hazard, not the error count. A stream quotes
   * only the input it still holds, never input kept for quoting, so the same error fed in smaller
   * chunks can carry a shorter slice; `at`, `line` and `column` do not change.
   */
  context: string;
  /**
   * The recovery this error is a refusal OF, when one was declined here.
   *
   * Every refusal reports as `unparsable-span`, so without this a caller who switched two kinds off
   * learns that something at an offset was refused but not WHICH assumption about their input broke
   * — which is the only thing they can act on. Absent where no recovery was declined: a stray closer
   * or a second colon inside a container alters no value, so no kind names it.
   */
  refused?: SwitchableRepair | undefined;
};

/**
 * Everything a parse can hand back as data: JSON values, plus `ExactNumber` and the JavaScript
 * literals the options allow. Kept `unknown` on purpose: there is no `parse<T>()`, and a caller
 * narrows it with the validator they already have.
 */
export type Value = unknown;

/** What the one-shot calls read: text in the caller's units, or UTF-8 bytes. */
export type Input = string | Uint8Array;

/** What kind of thing the end of the source cut. */
export type CutKind =
  /** A string still open: the value holds every character the source wrote. */
  | "string"
  /** A number touching the end: valid as written, though more digits may have followed. */
  | "number"
  /** The item at `path` was started or named but never written, so the value leaves it out. */
  | "missing"
  /** The source stopped between items of the container at `path`. */
  | "between";

/**
 * Where the source ended inside a value. Text is written front to back, so a value has at most one
 * cut, and every container on `path` may be missing later items.
 */
export type Cut = {
  readonly path: SourcePath;
  readonly kind: CutKind;
  /** The unfinished token the value leaves out (`"tru"`, a half `\u00`, a partial key); never a delimiter. */
  readonly text?: string;
};

/**
 * Whether the source finished the value (HLD: every recovered value says so). `cut` is present
 * exactly when `complete` is false, so a caller may test either; the value itself is never changed
 * to show it unless `cutSuffix` asks.
 */
export type Completion =
  | { readonly complete: true; readonly cut?: undefined }
  | { readonly complete: false; readonly cut: Cut };

/** `R` with the completion facts on its success branch. */
export type Completed<R> = R extends { readonly ok: true } ? R & Completion : R;

/**
 * Data a failed operation still recovered. Absent when nothing was recovered; `null` is a value.
 * Under `select` it is the matches gathered for the root so far, as `readonly Match[]`.
 */
export type Recovery = { readonly value: Value } & Completion;

/**
 * One selected value and where it came from. Every match carries its path because a caller who
 * selected two things could not otherwise tell which one arrived; `selectors` are the indexes into
 * the `select` list that name it, ascending, so one occurrence named by two paths is one match.
 * `span` is always present — it is the location the selection was made from, not an option.
 */
export type Match<T = Value> = {
  readonly value: T;
  readonly path: SourcePath;
  readonly valueIndex: number;
  readonly span: Span;
  readonly selectors: readonly number[];
};

/**
 * A selected scalar delivered in pieces. Strings leave incrementally; numeric and literal
 * candidates wait under the storage limits until their type and spelling settle. `start` names
 * the occurrence; its `id` ties the pieces together. `data` carries a piece, and `end` closes it with the span.
 * Strings arrive decoded, numbers as their number spelling, literals as their spelling; a number
 * piece is never a partial number. An `end` confirms the occurrence only, not that a later
 * duplicate key keeps it. Its `complete` is `false` when the source ended inside the value — a
 * string without its closing quote, or a number that more input could extend. A terminal failure
 * closes unfinished occurrences without an `end`.
 */
export type Fragment =
  | {
      readonly kind: "start";
      readonly id: number;
      readonly valueIndex: number;
      readonly path: SourcePath;
      readonly selectors: readonly number[];
      readonly scalar: "string" | "number" | "literal";
    }
  | { readonly kind: "data"; readonly id: number; readonly text: string }
  | { readonly kind: "end"; readonly id: number; readonly span: Span; readonly complete: boolean };

/** Source pieces preserve spelling; only completion can identify the recovered scalar kind. */
export type SourceFragment =
  | Omit<Extract<Fragment, { kind: "start" }>, "scalar">
  | Extract<Fragment, { kind: "data" }>
  | ({ readonly kind: "end"; readonly id: number; readonly span: Span } & (
      | { readonly scalar: "string" | "number" | "literal"; readonly complete: boolean }
      | { readonly scalar: "missing"; readonly complete: false }
    ));

/** Import this capability as `sourceFragments`; a string switch would retain its reader in select. */
export type SourceFragmentsFeature = { readonly feature: "source-fragments" };

/** Import decoded delivery so selecting whole values does not retain fragment delivery code. */
export type DecodedFragmentsFeature = { readonly feature: "decoded-fragments" };

/**
 * What a verb hands back under the options it was given: the whole value when `select` is absent,
 * the matches when it is present, and either when `select` is only known at run time.
 */
export type Selected<O, Whole, Matched> = [OptionOf<O, "select">] extends [false | undefined]
  ? Whole
  : [OptionOf<O, "select">] extends [SelectFeature]
    ? Matched
    : Whole | Matched;

/**
 * The one outcome shape: `ok` with the data, or `ok: false` with a typed reason. Status lives OUTSIDE
 * the data, so `{"ok":false}` parses to a success holding that object, and a failure never has a
 * `value` to mistake for one. Recovered data on failure sits inside the failure, never beside it.
 */
export type Result<T, F> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: F };

/**
 * What made options unusable: the `cause` of the `TypeError` every entry point throws before
 * reading input. Never a result — invalid options are the caller's bug, not an outcome (HLD).
 */
export type ConfigurationFailure = {
  kind: "invalid-options";
  field: string;
  reason:
    | "object"
    | "unknown"
    | "boolean"
    | "policy"
    | "string-array"
    | "positive-integer"
    | "scope"
    | "view"
    /** `execution` is missing, or is not one of the imported `auto`, `cooperative` or `worker` values. */
    | "execution"
    /** `cutSuffix` is `true`, `false` or the string to append to a cut string. */
    | "cut-suffix"
    /** A `select` or `skip` entry is not a list of keys, indexes and wildcards. */
    | "selector"
    /** A `skip` path must end in a key: an index or wildcard tail could remove an array element. */
    | "skip-tail"
    /**
     * An optional feature was given as anything but its imported value or `false` — usually `true`,
     * the spelling before features were imports. The message names the import.
     */
    | "import-required"
    /** A `fragments` selection went to a verb that returns whole results; only streams deliver pieces. */
    | "fragments-stream"
    /**
     * A selection with `occurrences` or `fragments` delivers each match when it closes, before its
     * root does, while `objectOnly` and `requiredKeys` can accept a root only once it has closed.
     */
    | "root-filter"
    /** Fragments never retain a value, so there is nothing a view could show. */
    | "fragments-view"
    /**
     * A parse option was given to `createStreamParser(parser, controls)`, whose parse options are already fixed.
     * Refused rather than ignored: the caller asked for something that would not happen, and
     * silently dropping it is how a stream ends up parsing under settings nobody chose.
     */
    | "parse-option-on-stream"
    /**
     * `diagnostics` was given to `createMetrics`, which always reads the report to count repairs.
     * Refused rather than overridden, so an explicit setting is never dropped without a word.
     */
    | "metrics-report"
    /** A helper option that takes a callback (`tryParsers`' `isResult`) got something else. */
    | "function"
    /** `signal` has no boolean `aborted`: often the `AbortController` passed instead of its signal. */
    | "signal";
};

/** A configured parser was explicitly released and cannot own more work. */
export type ParserClosedFailure = { kind: "parser-closed"; recovered?: undefined };

/** Recovery available when an asynchronous operation observes cancellation. */
export type AbortedFailure = {
  readonly kind: "aborted";
  readonly reason: unknown;
  readonly recovered?: Recovery;
};

/** A cancellation provider failed during subscription or observation. */
export type SignalFailure = {
  readonly kind: "signal-failed";
  readonly cause: unknown;
  readonly recovered?: Recovery;
  readonly cleanupFailure?: CleanupFailure;
};

/** A host-task yield failed during scheduling or cleanup. */
export type SchedulingFailure = {
  readonly kind: "scheduling-failed";
  readonly cause: unknown;
  // Independent port cleanup must not replace the scheduling cause.
  readonly cleanupFailure?: CleanupFailure;
  readonly recovered?: Recovery;
};

/**
 * Why a parse did not succeed. None of these throws, and each says what to do next.
 *
 * `no-json-found` is NOT the same as parsing the literal `null`, which succeeds with `value: null`;
 * absence and a null value stay distinguishable without inspecting the value.
 *
 * `policy-refused` and `limit-reached` carry `recovered` when data exists: a strict refusal or a
 * stopped scan is never an ordinary success, but the caller still gets what was read.
 */
export type ParseFailure =
  | {
      kind: "invalid-input";
      received: string;
      recovered?: Recovery;
      // Recovering a decoded prefix can itself encounter policy or storage limits.
      cause?: Exclude<ParseFailure, { kind: "invalid-input" }>;
    }
  /** Bytes opened with a UTF-16 or UTF-32 mark. Decode them yourself; only UTF-8 is read here. */
  | {
      kind: "unsupported-encoding";
      encoding: "utf-16be" | "utf-16le" | "utf-32be" | "utf-32le";
      // `recovered?: undefined` on members that never recover lets callers read
      // `failure.recovered?.value` across the whole union instead of guarding with `in` first.
      recovered?: undefined;
    }
  | { kind: "no-json-found"; recovered?: undefined }
  /** JSON roots were found, but none satisfied the requested object and own-key filter. */
  | {
      kind: "no-match";
      expected: "object";
      requiredKeys: readonly string[];
      recovered?: Recovery;
    }
  /** A construct the configured policy does not accept. `issue` is the first refusal. */
  | { kind: "policy-refused"; issue: ParseError; recovered?: Recovery }
  /** A resource bound stopped processing. `at` is where, when the scanner knows. */
  | {
      kind: "limit-reached";
      /**
       * Which bound. `unread` is the stream's own: values completed by earlier `feed()` calls whose
       * iterators were never read, held for the next iteration, passed `maxRetained`. Read what
       * `feed()` returns, or raise `maxRetained`.
       */
      resource: "buffer" | "depth" | "errors" | "scalar" | "retained" | "unread";
      limit: number;
      at?: Position;
      recovered?: Recovery;
    };

/**
 * A value JSON cannot spell, and where it sits, in a value a caller built and passed to `stringify`.
 * `stringify` refuses rather than writing `null` because its promise is lossless output of the
 * caller's own value; `repair` writes recovered input and reports each conversion instead.
 */
export type NonJsonValueFailure = {
  kind: "non-json-value";
  valueKind:
    | "undefined"
    | "nan"
    | "infinity"
    | "bigint"
    | "function"
    | "symbol"
    /** An object whose prototype is neither `Object.prototype` nor `null`: a Date, a Map, a class. */
    | "non-plain-object";
  path: SourcePath;
};

/**
 * `repair` fails exactly when `parse` fails on the same input: it reads the same candidate and only
 * writes it as text. A value JSON cannot spell is written as `null` and reported, never refused.
 */
export type RepairFailure = ParseFailure;

/**
 * Why `stringify` produced no text. Nothing here is recoverable text: a partial encoding of a
 * value with a cycle in it is not JSON, and an output that stops at a bound is not the value.
 */
export type EncodingFailure =
  | NonJsonValueFailure
  /** The value contains itself. */
  | { kind: "cycle"; path: SourcePath }
  /** A getter or setter where a data property was expected; encoding never runs caller code. */
  | { kind: "accessor"; path: SourcePath }
  /** Reading the value threw — a proxy trap, in practice. `cause` is what it threw. */
  | { kind: "invalid-value"; path: SourcePath; cause: unknown }
  | { kind: "limit-reached"; resource: "output"; limit: number };

/** Why an `ExactNumber` gave no `number`. Only `inexact` is lifted by `allowRounding`. */
export type NumberConversionFailure =
  | { kind: "overflow" }
  | { kind: "underflow" }
  | { kind: "inexact" };

/** Why an `ExactNumber` gave no `bigint`. `digits` is how long the integer would have been. */
export type BigIntConversionFailure =
  | { kind: "not-integer" }
  | { kind: "digits-exceeded"; digits: number; maxDigits: number };

/**
 * Failures a stream can deliver as items. `parser-closed` answers a stream asked of a released
 * parser; `stream-closed` answers feeding or ending a stream that already ended, or that a failure
 * stopped reading.
 */
export type StreamFailure =
  | ParserClosedFailure
  | ParseFailure
  | SignalFailure
  | SchedulingFailure
  /** The source, or a chunk it produced, is not a shape this package reads. */
  | {
      kind: "invalid-source";
      sourceKind: string;
      recovered?: Recovery;
      cleanupFailure?: CleanupFailure;
    }
  /**
   * The source threw. `recovered` is the root left open, closed under the recovery policy. A
   * cleanup that then failed as well rides along as `cleanupFailure`; it never replaces the cause.
   */
  | { kind: "source-failed"; cause: unknown; recovered?: Recovery; cleanupFailure?: CleanupFailure }
  /** The caller's signal fired. No end-of-input repair runs: the input did not end, it was stopped. */
  // Share recovery with whole-input cancellation; cleanup remains specific to a stream's source.
  | (AbortedFailure & { cleanupFailure?: CleanupFailure })
  /** The source finished normally and then refused to be released. `cause` is what it threw. */
  | CleanupFailure
  | { kind: "stream-closed"; recovered?: undefined }
  /** A `fragments` selection named a container. Fragments carry scalar content; select its scalars. */
  | { kind: "non-scalar-selection"; path: SourcePath; recovered?: undefined };

/** Releasing the source threw. The source is the caller's; closing it again is theirs to decide. */
export type CleanupFailure = { kind: "cleanup-failed"; cause: unknown; recovered?: undefined };

/**
 * What `close()` on a parsed stream answers. `aborted` here means the WAIT was abandoned through
 * `close({ signal })`, which says nothing about whether the source ever released.
 */
export type CloseFailure = (
  | CleanupFailure
  | SignalFailure
  | { kind: "aborted"; reason: unknown }
) & {
  // Independent listener cleanup must not replace the source failure or abandoned-wait reason.
  readonly cleanupFailure?: CleanupFailure;
};

/**
 * One item after the last result of a stream, when `summary: true` asked for it. It has no `ok`,
 * so `"kind" in item` tells it from a result. `complete` is whether the whole source was examined;
 * `roots` counts every recognised root, refused ones included. `matches` counts delivered matches,
 * or started occurrences under `fragments`; `unmatched` lists the `select` indexes that never
 * produced one — not found in what was examined, which at an early stop says nothing about the
 * rest. Both are `0` and empty without `select`.
 */
export type StreamSummary = {
  readonly kind: "summary";
  readonly complete: boolean;
  readonly roots: number;
  readonly matches: number;
  readonly unmatched: readonly number[];
};

/**
 * Which view `snapshot()` builds: chosen once when the stream parser is made, like the report.
 * `shared` is read-only by contract: its open-container copy is unfrozen only for speed, and pulls
 * with no input between them return the same object, so a caller's change would show in the next
 * one. `owned` is a deep copy the caller may modify.
 */
export type ViewMode = "shared" | "owned";

// An imported ownership policy carries the optional implementation; a string cannot remove its code.
export type ViewFeature<Mode extends ViewMode = ViewMode> = {
  readonly feature: "view";
  readonly mode: Mode;
};

/**
 * The root a stream is assembling, or has just delivered, at the moment of the call.
 *
 * `complete` is the root's finality, not the source's end. While the root is open, `cut` says
 * where the view stops: the slot of a string still arriving (`string`), an item the source started
 * that is held back until it finishes (`missing`, its characters in `text`), else the innermost open
 * container (`between`) — where a renderer puts its cursor.
 */
export type Snapshot<T = Value> = { readonly value: T; readonly valueIndex: number } & Completion;

/** A root the policy refused or a bound stopped. Any view of it is under `recovered`. */
export type SnapshotFailure = Extract<ParseFailure, { kind: "policy-refused" | "limit-reached" }>;

/**
 * Every failure kind, for a formatter that turns them into words. Includes `invalid-options`, which
 * is never returned: it is the `cause` of the TypeError thrown for invalid options.
 */
export type FailureKind = (
  | ConfigurationFailure
  | ParserClosedFailure
  | RepairFailure
  | StreamFailure
  | CloseFailure
  | EncodingFailure
  | NumberConversionFailure
  | BigIntConversionFailure
  | ExecutionUnavailableFailure
  | SchedulingFailure
  | TryParsersFailure
)["kind"];

/**
 * What was changed, refused or lost while recovering a value. Present on a result only when the
 * caller asked for it, on success and failure alike.
 *
 * `counts` are totals; `repairs` and `errors` hold at most `maxEntries` entries between them,
 * and `entriesComplete` says whether anything was left out. `confidence` is computed from EVERY
 * repair, retained or not, because a cap on what is stored must not raise the score.
 */
export type Diagnostics = {
  repairs: readonly Repair[];
  errors: readonly ParseError[];
  counts: { repairs: number; errors: number };
  entriesComplete: boolean;
  /** False when a limit stopped the scanner before the end of the input. */
  scanComplete: boolean;
  /**
   * What the report covers. `"all"` is the whole candidate; `"selected"` is the selected values and
   * the recovery on the way to them — repairs inside skipped or unselected subtrees are neither
   * stored nor counted, though a policy refusal there still decides the outcome. Under
   * `occurrences` or `fragments` each delivered item carries the entries recorded since the previous
   * item of its root, with the counts and confidence running for the root so far.
   */
  scope: "all" | "selected";
  /** `∏(1 - penalty)` over the repairs; 1 is untouched input, below 0.7 consider a retry. */
  confidence: number;
  /**
   * The source span of each value after the returned one, in order: the rest of what `parseMany`
   * with the same options would deliver. `parse`, `repair` and `findJsonSpan` return one value, so
   * without this a reply holding two objects reads exactly like one holding the first. Empty from
   * every route that delivers each value itself. At most `maxEntries` spans; past it
   * `entriesComplete` is false, and a limit that stops the scan past the returned value makes
   * `scanComplete` false.
   */
  laterValues: readonly Span[];
};

export type Reported<R> = R & { readonly diagnostics: Diagnostics };

/**
 * Optional features are VALUES the caller imports and passes under their option key, never `true`.
 * A boolean keeps the feature's code reachable from every call, so every app would ship the report
 * and the selector compiler whether it used them or not (HLD D5); an imported value is the only
 * route to that code, so an app that never imports it never bundles it. Each key also takes `false`,
 * which turns a parser's feature off for one call. Settings travel with the feature, because a
 * setting for a feature that was not imported would type-check and do nothing.
 */
export type DiagnosticsSettings = {
  /**
   * How many repair and error entries one root's report stores, between them. Past it entries are
   * still counted and still lower `confidence`; only their storage stops. Default 1000. This bounds
   * what a hostile document can make a report cost; `maxErrors` is what stops the scan.
   */
  readonly maxEntries?: number;
  /**
   * `"all"` also records repairs inside skipped and unselected content; `"selected"`, the default,
   * covers the selected values and the recovery on the way to them, and leaves out what a `skip`
   * excluded. With neither `select` nor `skip` both are the whole candidate.
   */
  readonly scope?: "all" | "selected";
};

/**
 * The report of what was repaired, refused and lost, and the `confidence` score: pass `diagnostics`,
 * or `diagnostics({ maxEntries, scope })` for other settings. Asking for it also keeps input off
 * `JSON.parse`, which collapses a duplicate key before anything could report it.
 */
export type DiagnosticsFeature = {
  <Settings extends DiagnosticsSettings>(
    settings: Exact<Settings, DiagnosticsSettings>,
  ): DiagnosticsFeature;
  readonly feature: "diagnostics";
  readonly maxEntries: number;
  readonly scope: "all" | "selected" | undefined;
};

/** Adds each successful value's source `span` to its result: pass `locations`. */
export type LocationsFeature = { readonly feature: "locations" };

/**
 * The parts of each value to hand back, made by `select(paths, settings)`. Every verb then returns
 * matches — each with its path, root index and source span — rather than values, and nothing
 * outside a match is built. `Fragments` chooses recovered or source pieces, or complete matches.
 */
export type SelectFeature<
  Fragments extends boolean | SourceFragmentsFeature = boolean | SourceFragmentsFeature,
> = {
  readonly feature: "select";
  readonly paths: readonly SelectorPath[];
  /**
   * Deliver matches as source occurrences, as soon as each closes, rather than once the root has
   * finished. Off, a match waits for its ancestors so that a later duplicate key replacing one of
   * them takes the match with it, exactly as it takes the value; on, every occurrence is delivered
   * — the replaced ones included — and a stream hands them out as they arrive.
   */
  readonly occurrences: boolean;
  /**
   * Deliver each selected scalar in pieces as it arrives — a `start`, the `data`, an `end` — and
   * release string content incrementally, so one selected string may exceed memory. `sourceFragments`
   * preserves scalar spelling without constructing its full value; decodedFragments keeps recovered content.
   * Stream verbs only; implies
   * `occurrences` and excludes `view`, since nothing is retained for a view to show.
   */
  readonly fragments: Fragments;
};

/** Object members not to build, made by `skip(paths)`; works with or without `select`. */
export type SkipFeature = { readonly feature: "skip"; readonly paths: readonly SelectorPath[] };

/**
 * A result's shape follows the options it was made with: the `diagnostics` feature puts the report
 * in the type, `false` or nothing leaves it out, and a value only known at run time makes it
 * optional. The `locations` feature adds the value's source `span` to a success.
 */
export type Shaped<
  R,
  O extends { diagnostics?: false | DiagnosticsFeature; locations?: false | LocationsFeature },
> = Reportable<Located<R, OptionOf<O, "locations">>, OptionOf<O, "diagnostics">>;

/** An option's literal type, or `undefined` when the options type never mentions it. */
// keyof a union sees only shared keys; absent keys must contribute undefined, not erase a feature.
export type OptionOf<O, K extends string> = O extends O
  ? K extends keyof O
    ? O[K]
    : undefined
  : never;

/**
 * The report half of `Shaped` alone, for a result whose value already is a location. The checks
 * are wrapped in tuples so a `diagnostics` only known at run time — the whole union — lands in the
 * optional branch instead of being split into one result type per member.
 */
export type Reportable<R, D> = [D] extends [DiagnosticsFeature]
  ? Reported<R>
  : [D] extends [false | undefined]
    ? R
    : R & { readonly diagnostics?: Diagnostics };

type Located<R, L> = R extends { ok: true }
  ? [L] extends [LocationsFeature]
    ? R & { readonly span: Span }
    : [L] extends [false | undefined]
      ? R
      : R & { readonly span?: Span }
  : R;
