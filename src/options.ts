// SPDX-License-Identifier: Apache-2.0

/**
 * Parser options: what a caller may set, and the resolved shape everything internal reads.
 *
 * **Only options that are WIRED live here.** The package this was extracted from advertised
 * `customDangerousKeys` and connected it to nothing — the validator that consumed it was dead code
 * whose only occurrence in the whole package was its own definition. An option a caller can set and
 * the parser never reads is worse than a missing feature: it reads as a security control being
 * configured. Every field below reaches the code that acts on it, and this file grows only when
 * another one does.
 */

import type {
  ConfigurationFailure,
  DiagnosticsFeature,
  LocationsFeature,
  SelectFeature,
  SourceFragmentsFeature,
  SkipFeature,
  SwitchableRepair,
  ViewFeature,
} from "./types";
import { configurationError, isPlainObject, ownOption } from "./configuration-error";
import type { FilterFactory, SelectionFeature } from "./selection-feature";
import type { ReportFeature } from "./report";
import type { Compiled } from "./selector";
import type { StopSignal } from "./stop-signal";

/** What to do with a key that can reach `Object.prototype`. */
export type DangerousKeyPolicy =
  /** Omit the key. The object keeps its other members. */
  | "drop"
  /**
   * Keep it as ordinary data, written with `defineProperty` so it cannot reach the prototype.
   * Safe, and the right answer when the key is data — `{"constructor": "Acme Ltd"}` is a company,
   * not an attack.
   */
  | "keep"
  /** Refuse the whole object and report it. For callers who must fail closed. */
  | "reject";

/** The coarse leniency flags, each naming a family of spellings rather than a single repair. */
type LeniencyFlag =
  | "allowComments"
  | "allowSingleQuotes"
  | "allowTrailingComma"
  | "allowUnquotedKeys"
  | "allowJavaScript"
  | "repairBroken";

/**
 * Which coarse flag decides each repair by default — the one place that mapping is written.
 *
 * It used to be written 21 times, once at each site that emits a repair, so the answer to "what
 * turns this off" could only be had by reading the scanner. `null` marks the two repairs no flag
 * has ever governed: a byte-order mark is an encoding declaration every reader strips, and a
 * duplicate key reports what the input did rather than changing how it is read. Both stay on
 * unless a caller names them in `recover`. `false` marks a reading no flag turns on: it stays off
 * unless a caller or preset names it, because the default does better without it. Off, the reader
 * either takes the other honest reading (`leading-zero-number`, `guessed-string-end`) or refuses as any switch does
 * (`unquoted-root-string`); the kind's own comment in `src/types.ts` says which and why.
 */
// Check keys before freezing; a result annotation permits obsolete extra keys.
export const RECOVERY_FLAG = /* @__PURE__ */ Object.freeze<
  Record<SwitchableRepair, LeniencyFlag | null | false>
>({
  "unclosed-string": "repairBroken",
  "missing-quote": "repairBroken",
  "guessed-string-end": false,
  "unclosed-object": "repairBroken",
  "unclosed-array": "repairBroken",
  "missing-comma": "repairBroken",
  "missing-colon": "repairBroken",
  "missing-brackets": "repairBroken",
  "escaped-delimiter": "repairBroken",
  "non-json-whitespace": "repairBroken",
  "bracket-mismatch": "repairBroken",
  "invalid-escape": "repairBroken",
  "extra-colon": "repairBroken",
  "unquoted-string": "repairBroken",
  "unquoted-root-string": false,
  "literal-case": "repairBroken",
  "null-alias": "repairBroken",
  "invalid-number": "repairBroken",
  "leading-dot-number": "repairBroken",
  "leading-plus-number": "repairBroken",
  "dropped-member": "repairBroken",
  "js-literal": "allowJavaScript",
  "hex-number": "allowJavaScript",
  "binary-number": "allowJavaScript",
  "octal-number": "allowJavaScript",
  "numeric-separator": "allowJavaScript",
  "leading-zero-number": false,
  "single-quote": "allowSingleQuotes",
  "quote-mismatch": "allowSingleQuotes",
  "trailing-comma": "allowTrailingComma",
  "comment-removed": "allowComments",
  "unquoted-key": "allowUnquotedKeys",
  "bom-removed": null,
  "duplicate-key": null,
});

/**
 * Decides every switchable kind once, so nothing downstream has to know which flag owns which
 * repair. A caller's `recover` entry wins over the flag; a kind no flag governs stays on.
 */
const resolveRecover = (
  flags: Readonly<Record<LeniencyFlag, boolean>>,
  overrides?: Readonly<Partial<Record<SwitchableRepair, boolean>>>,
): Readonly<Record<SwitchableRepair, boolean>> => {
  const decided = {} as Record<SwitchableRepair, boolean>;
  for (const kind of Object.keys(RECOVERY_FLAG) as SwitchableRepair[]) {
    const flag = RECOVERY_FLAG[kind];
    decided[kind] = overrides?.[kind] ?? (flag === null || (flag !== false && flags[flag]));
  }
  return Object.freeze(decided);
};

export type ParserOptions = {
  /**
   * The leniency axes. Each names a spelling JSON forbids and models emit anyway, and each is
   * independent — the presets exist so most callers never touch them.
   *
   * **Off does not mean "unrecognised".** The construct is still consumed, and reported as an
   * `unparsable-span` error instead of as a repair. Refusing to recognise it would make the parser
   * build a DIFFERENT tree per preset out of the same bytes, so a caller tightening a flag would get
   * both a diagnostic change and a silent restructuring. Consumed-but-reported keeps the tree stable
   * and makes strictness a pure function of `errors` — which is what lets `maxErrors: 1` be the whole
   * mechanism behind `STRICT` rather than a second code path.
   *
   * Each flag names a FAMILY of spellings. `recover` below addresses a single repair kind, and wins
   * where the two overlap — that is the only precedence between them.
   *
   * Two readings are the exceptions, and necessarily so, because each picks between two values that
   * cannot both be produced. `allowJavaScript` decides for the LITERALS whether a non-JSON value
   * exists at all (`undefined` or `"undefined"`). The `leading-zero-number` kind decides whether
   * `0123` is 123 or keeps its text `"0123"`; off, the token falls to the `invalid-number` reading
   * rather than to a refusal. Every other flag governs a spelling, and a spelling cannot change a
   * tree. The non-decimal number spellings are an ordinary axis and obey the rule above: `0xFF` is
   * 255 either way, and only the diagnostic changes.
   */
  allowComments?: boolean;
  allowSingleQuotes?: boolean;
  allowTrailingComma?: boolean;
  allowUnquotedKeys?: boolean;
  /**
   * `undefined`, `NaN` and `Infinity` as values, and the non-decimal number spellings `0xFF`, `0b1010`
   * and the leading-zero `0123`. **On by default** for recovery; `repair` still refuses non-JSON
   * values rather than silently converting them. Off, the literals are read as the strings they
   * were spelled with, which loses nothing and invents nothing; the numbers keep their value and are
   * reported as `unparsable-span` instead of as a repair.
   *
   * One flag for both because the package this came from gated the number spellings on this same
   * option, and its default had it on — so a `COMPAT` caller who lost either half would lose the other
   * with it. A separate `allowNonDecimalNumbers` would be a sixth axis nobody has asked to set
   * independently.
   */
  allowJavaScript?: boolean;
  /**
   * Recover input that is not JSON in any dialect: a string or container the text left open, a
   * member whose value never arrived, a missing comma or colon, a bare word where a value belongs,
   * a number JSON does not spell that way. Off, each of those is reported as an `unparsable-span`
   * error instead of a repair, and the value is unchanged — the same consumed-but-reported contract
   * as every leniency flag above.
   *
   * **This is what makes `STRICT` strict, and it is one option rather than a family.** Without it,
   * most of the documents JSONTestSuite says a JSON parser MUST reject would come back as values
   * with an empty error list, because a leniency the options do not offer cannot be refused. It is
   * ONE flag because the kinds it decides fire on the same fact — the input was broken rather than
   * merely written in a different dialect — and a caller who wants a single one of them names it in
   * `recover` instead of carrying a knob per kind they never set.
   *
   * It also keeps a meaning no repair kind covers, and so cannot be replaced by `recover` entries:
   * a stray closer or a second colon inside a container alters no value, so nothing is repaired and
   * no kind names it, yet `{"x"::"b"}` is still not JSON. This flag alone decides whether that is
   * refused.
   *
   * Closing a string appends **nothing**. The package this came from appended `...` by default, so
   * `{"msg": "hello` parsed to `hello...` and a consumer could not tell invented characters from
   * text the model wrote.
   *
   * An integer past 2^53 is valid JSON and is not gated by this: it comes back as an `ExactNumber`
   * under every preset, so `STRICT` never rejects a document `JSON.parse` accepts.
   */
  repairBroken?: boolean;
  /**
   * Per-repair overrides, for a caller who knows their source. Each key is a `RepairKind` and wins
   * over whichever coarse flag above would otherwise decide it, in both directions: switch on a
   * recovery the preset leaves off, or switch off one the preset allows.
   *
   * The reason to reach for it is knowing something about the input that the parser cannot: a model
   * that never writes single quotes means our reading of one is a guess about damage that is not
   * there, and a caller who sets `{"quote-mismatch": false}` is told when that assumption breaks
   * instead of quietly receiving a re-quoted string. The coarse flags cannot express this, because
   * `repairBroken` alone decides most of them — a caller whose model never truncates cannot decline
   * truncation-healing without also declining comma and bracket repair.
   *
   * Off means what it means everywhere else here: the construct is still consumed, reported as an
   * `unparsable-span` error rather than a repair, and the outcome fails. The VALUE does not change,
   * so a caller cannot use this to get a different tree — only a different verdict about the same
   * one. `dangerous-key` is absent because `onDangerousKey` already governs it with three choices.
   *
   * **Not a speed knob, and switching kinds off will not make parsing faster.** On undamaged input
   * none of these repairs is reached whatever this is set to, and on damaged input a switched-off
   * kind still consumes its construct, only reporting it as an error instead of a repair.
   */
  recover?: Readonly<Partial<Record<SwitchableRepair, boolean>>>;
  /**
   * How many policy refusals the scan tolerates before it stops with `limit-reached`. A refusal is
   * a construct a leniency flag turned off; each one already makes the outcome `policy-refused`, so
   * this bounds how far the scanner keeps reading past the first one to recover the rest.
   *
   * With every leniency off, `maxErrors: 1` means the first refusal ends the parse, so `STRICT`
   * needs no second code path to reject what RFC 8259 forbids.
   */
  maxErrors?: number;
  /**
   * The imported `diagnostics` feature puts the report of what was repaired, refused and lost on
   * every result. Off by default: the ordinary caller wants the data, and recording costs an
   * allocation per repair. Asking for the report also turns the `JSON.parse` attempt off. That
   * attempt cannot see a duplicate key in valid JSON — a reviver runs after the duplicate has
   * already been collapsed — and a report that silently omits duplicates is not the one requested.
   */
  diagnostics?: false | DiagnosticsFeature;
  /** The imported `locations` feature adds each successful value's source `span` to its result. */
  locations?: false | LocationsFeature;
  /**
   * Hand over EVERY number as an `ExactNumber` holding its source token, fractions included. Off by
   * default: a double is what nearly every consumer wants, and it is what ordinary mode gives for
   * every value a double holds exactly. What a double cannot hold — an integer past 2^53, an
   * overflow, a nonzero underflow — is an `ExactNumber` in BOTH modes; this flag only decides
   * whether `0.1` is one too. Turning it on also turns the `JSON.parse` attempt off.
   */
  exactNumbers?: boolean;
  /**
   * Whether whole input may be handed to the runtime's built-in `JSON.parse` instead of the scanner:
   * clean text as it is, and text cut off or holding comments or trailing commas once the pre-scan
   * has rewritten it into the JSON the scanner would recover (closers appended, comments and
   * trailing commas deleted). On by default. The built-in parser is an ATTEMPT rather than a mode:
   * it runs only where it is proved to give the scanner's answer, and anything it refuses falls
   * straight through to the scanner. Clean text and a cut-off reply, the commonest damage, read
   * several times faster this way; the README's Performance section points to the measurements.
   *
   * The attempt declines whenever `JSON.parse` could hide something the scanner would report: a key
   * the policy governs, an integer long enough to lose digits, a requested report (see
   * `diagnostics`). `false` keeps every input on the scanner — for a caller who distrusts the host's
   * parser or wants one route to measure. The answer is the same either way; only the route differs.
   */
  builtinParsers?: boolean;
  /**
   * Text appended to a string the source cut off: `true` appends `…`, a string appends itself.
   * Off by default, because an appended marker is content the source never wrote and a caller
   * cannot tell it from input; `cut` on the result already says where the value ended without
   * touching it. Only a cut STRING gets it — on a number it would turn the value into a string, and
   * on a missing item it would invent one — and it is the same on every route: the final value, a
   * match, the last fragment piece, `repair()` text (escaped inside the literal) and the view a
   * snapshot copies, never the live tree a later chunk continues.
   */
  cutSuffix?: boolean | string;
  /**
   * Largest source window a STREAM will retain. Exceeding it is a terminal `limit-reached` failure
   * naming the `buffer` resource.
   *
   * It bounds the stream only, never a one-shot parse: a caller of `parse(text)` already holds the
   * whole string, so refusing to parse the second half of it is truncation dressed as a resource
   * bound. A stream is where unbounded growth is real, because chunks arrive without end.
   */
  maxBuffer?: number;
  /**
   * Maximum container nesting. Exceeding it is a recoverable `depth-budget` error, never a throw.
   *
   * There is deliberately **no upper cap**: the scan is iterative, so a large value cannot overflow
   * the JavaScript stack, and the real bound is memory. The package this came from hardcoded 50 as a
   * private field, which was a stack-safety guard misread as a preference — with recursion, exposing
   * it would have handed callers a denial-of-service switch.
   */
  maxDepth?: number;
  /**
   * What happens to `__proto__` and its five siblings. Default `keep`, which is safe because there
   * is one insertion point and it uses `defineProperty`.
   *
   * The extracted package had no option and destroyed the ENTIRE object: `{"__proto__":{"x":1},
   * "safe":2}` returned `{}` on both its paths, so a consumer could not tell the result from empty
   * input. That is neither `drop` nor `reject` — it is the worst of both.
   */
  onDangerousKey?: DangerousKeyPolicy;
  /**
   * Build objects with `Object.create(null)`. Makes pollution impossible by construction, and breaks
   * `hasOwnProperty`, `toString` and `instanceof` for every consumer of the result — so it is
   * offered and never imposed.
   */
  nullPrototype?: boolean;
  /** Extra keys treated as dangerous, beyond the six built in. Matched exactly, like the built-ins. */
  customDangerousKeys?: readonly string[];
  /**
   * Longest bare scalar a stream will hold while waiting to learn whether it is the whole text.
   *
   * A top-level scalar counts as a value only when it stands alone, and in
   * a stream that cannot be known until the stream ends — so the candidate is buffered. Without a
   * bound, a stream of digits with no delimiter grows that buffer forever, because nothing in the
   * grammar ever ends the token. 1 KB is far past any real number or literal.
   * Exceeding it is a terminal `limit-reached` failure naming the `scalar` resource; the token is
   * never reinterpreted as prose.
   */
  maxScalar?: number;
  /**
   * Bounds stream-owned content; whole-input calls do not enforce this limit.
   * Largest amount held for the caller at once, in logical units: one per
   * value or container entry, one per UTF-16 unit of a string or key, one per character of an
   * exact-number token, of a number still being read, or of repaired text kept for `repair`. Defaults to `maxBuffer`. Exceeding
   * it is a terminal `limit-reached` naming `retained`. Values a manual stream completed that the
   * caller has not read yet are held against the same bound, report entries included; past it the
   * stream ends with `limit-reached` naming `unread`, after every held item.
   *
   * `maxBuffer` bounds the source a stream still holds; it says nothing about what has been
   * DECODED from it. A 10 MB window will happily stream a 1 GB string into a value, because the
   * source of it is compacted away as it is read. This is the bound on that side, and it counts
   * what the caller would receive rather than allocator bytes, so it means the same on every
   * runtime. Delivered values are the caller's and leave the charge.
   */
  maxRetained?: number;
  /**
   * `select(paths)`: the parts of each value to hand back, as paths from the root — a string is a
   * key, a number an index, `ANY` one of either, `ANY_DEPTH` any run of them. Present, every verb
   * returns MATCHES rather than values, and nothing outside a match is built. `[]` names the root;
   * an empty list selects nothing. A `fragments` selection is for the stream verbs only.
   */
  select?: false | SelectFeature<false>;
  /**
   * `skip(paths)`: object members not to build, as paths ending in a key. Where a `skip` and a
   * `select` overlap the skip wins, so selecting a parent cannot force an excluded member to be
   * built. The skipping itself is not reported: the caller wrote the selector.
   */
  skip?: false | SkipFeature;
  /** Accept object roots only. Other recognized roots are skipped while searching for a match. */
  objectOnly?: boolean;
  /** Accept object roots containing every named own key. A non-empty list implies `objectOnly`. */
  requiredKeys?: readonly string[];
};

export type OptionKeys<O> = O extends undefined ? never : keyof O;

/**
 * `O` with every key the option type `A` lacks mapped to `never`, so a misspelt or foreign key is a
 * compile error naming that key. Needed because a generic parameter skips TypeScript's excess-property
 * check: the literal is inferred as `O`, and any `O` sharing one key with an all-optional type is
 * assignable to it, so `{ allowComent: true, maxDepth: 3 }` compiled. Runtime validation still
 * throws for the same key; this moves the report to where the caller is typing.
 */
// Check the whole union before its members: a wider valid member can hide a narrower typo.
// Intersect accepted members with A for completions and weak-type checking; {} would admit
// objects sharing no option keys. O keeps supplied literals for the result type.
export type Exact<O, A> = O &
  ([Exclude<OptionKeys<O>, keyof A>] extends [never]
    ? [MisspeltKinds<O>] extends [never]
      ? [FragmentView<O>] extends [never]
        ? O extends undefined
          ? O
          : O & A
        : { readonly view: never }
      : { readonly recover: { readonly [K in MisspeltKinds<O>]: never } }
    : Record<Exclude<OptionKeys<O>, keyof A>, never>);

// Distribute violations, not accepted shapes: otherwise a wider legal member absorbs an illegal one.
type FragmentView<O> = O extends {
  select: SelectFeature<true | SourceFragmentsFeature>;
  view: ViewFeature;
}
  ? "view"
  : never;

// Infer supplied options through required overloads: optional parameters can infer only the wider
// member of a union and hide another member's typo. NoInfer limits optional overloads to explicit
// generic forwarding; separate no-argument overloads preserve feature-free defaults. The defined
// overload also preserves a forwarded generic unchanged, rather than wrapping it in Given.
/** Omitted options contribute no features; preserve each branch of a caller's settings union. */
export type Given<O> = O extends undefined ? Record<never, never> : O;

/**
 * The same check one level down, for the one nested option map: `recover` is inferred as part of
 * `O`, so a misspelt kind beside a valid one (`{ "trailing-coma": false, "single-quote": true }`)
 * escapes the weak-type check that catches a map of misspellings alone.
 */
type MisspeltKinds<O> = O extends { readonly recover?: infer R } ? MisspeltRecovery<R> : never;

// Distribute map unions too; computed keys remain a runtime check because their spelling is unknown.
type MisspeltRecovery<R> = R extends undefined
  ? never
  : string extends keyof R
    ? never
    : Exclude<keyof R, SwitchableRepair>;

/**
 * Selector lists compiled once at validation: immutable, so a parser shares them across calls.
 * `select` absent means whole values; `skip` empty means nothing removed.
 */
export type CompiledSelection = {
  readonly select: Compiled | undefined;
  readonly skip: Compiled | undefined;
  /** The requested filter factory, carried by the feature so the core imports no selector implementation. */
  readonly picks: FilterFactory;
};

/** Public feature keys must not pull their scanner implementations into declaration output. */
type PublicFeatureValue = {
  diagnostics: DiagnosticsFeature;
  locations: LocationsFeature;
  select: SelectFeature;
  skip: SkipFeature;
};
type FeatureKey = keyof PublicFeatureValue;

/** What the core reads off each imported feature, by its option key. */
type FeatureValue = PublicFeatureValue & {
  diagnostics: ReportFeature;
  select: SelectionFeature & SelectFeature;
  skip: SelectionFeature & SkipFeature;
};

/** Every default filled in for Parser.options, without compiled selection or report internals. */
export type ParserSettings = Readonly<
  Omit<Required<ParserOptions>, "recover" | "cutSuffix" | FeatureKey>
> & {
  /** What a cut string gets appended; `""` when the caller asked for nothing. */
  readonly cutSuffix: string;
  /** Every switchable kind, decided. Resolved once so no reader has to fall back to a flag. */
  readonly recover: Readonly<Record<SwitchableRepair, boolean>>;
  readonly diagnostics: false | DiagnosticsFeature;
  readonly locations: boolean;
  /** From the `select` feature: matches leave as source occurrences. */
  readonly occurrences: boolean;
  /** From the `select` feature: selected scalars leave in pieces. Streams only. */
  readonly fragments: boolean;
};

/**
 * Internal feature implementations extend the public settings, rather than exposing an Omit of
 * this type: declaration emit follows omitted references too and would ship the scanner graph.
 */
export type ResolvedOptions = Omit<ParserSettings, "diagnostics"> & {
  // Readers ask !== false; only requested diagnostics open a report through this implementation.
  readonly diagnostics: false | ReportFeature;
  /** Present when `select` or `skip` was given. */
  readonly selection: CompiledSelection | undefined;
};

/**
 * What a STREAM parser takes BEYOND the parse options. Named separately because these are the only
 * options a caller can still supply once the parse options are validated and fixed — which is what
 * `createStreamParser(parser, controls)` accepts, and why passing a parse option there is refused rather than ignored.
 *
 * Each shapes what the stream does from its first chunk, so each is declared when the stream is
 * built and none can change mid-stream. `view: sharedView` in particular switches on freezing every
 * container as it closes, so it cannot be decided later at `snapshot()` time.
 */
export type StreamOnlyOptions = {
  /**
   * Builds `snapshot()`. Absent, the stream keeps no view and the method is absent from the type.
   * `shared` hands out frozen snapshots that share every finished branch and copy only the open
   * spine — O(depth + width of the open containers), and identity-stable where nothing changed, which is
   * what a diffing UI wants. Pull it once per rendered frame, not once per chunk: each pull copies the
   * open containers, so per-chunk pulls of a growing array cost quadratic time;
   * every value the stream delivers is then frozen too, since those are the branches being shared.
   * `owned` is a deep copy the caller may keep and modify; it costs the whole tree each time.
   */
  view?: ViewFeature;
  /** Append one `summary` item after the last result: how many roots, and whether all was read. */
  summary?: boolean;
};

/** What `parseStream` on a parser takes per call: the stream-only options and a stop signal. */
export type StreamCallOptions = StreamOnlyOptions & { signal?: StopSignal };

/**
 * Everything a stream parser takes: the parse options plus the stream-only ones, and a `select`
 * that may stream its scalars as `fragments` — which only a stream can deliver.
 */
export type StreamParserOptions = Omit<ParserOptions, "select"> &
  StreamOnlyOptions & { select?: false | SelectFeature };

// Encoding shares this bound without importing and constructing every parser default.
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * The defaults ARE `LLM_BALANCED`: comments, single quotes, trailing commas and unquoted keys on,
 * JavaScript literals on. A caller who passes nothing is parsing model output, which is what this
 * package is for.
 */
const DEFAULT_FIELDS = {
  allowComments: true,
  allowSingleQuotes: true,
  allowTrailingComma: true,
  allowUnquotedKeys: true,
  allowJavaScript: true,
  repairBroken: true,
  maxErrors: 1000,
  diagnostics: false,
  locations: false,
  exactNumbers: false,
  maxBuffer: DEFAULT_MAX_BUFFER,
  builtinParsers: true,
  cutSuffix: "",
  maxDepth: 512,
  onDangerousKey: "keep",
  nullPrototype: false,
  customDangerousKeys: /* @__PURE__ */ Object.freeze([]),
  maxScalar: 1024,
  maxRetained: 10 * 1024 * 1024,
  occurrences: false,
  fragments: false,
  objectOnly: false,
  requiredKeys: /* @__PURE__ */ Object.freeze([]),
} as const;
// Built inside a function: a spread in a call argument may run getters, so esbuild would keep this
// statement, and with it this module, in bundles that never resolve options.
const DEFAULTS: ResolvedOptions = /* @__PURE__ */ (() =>
  // An absent field would read inherited host state; resolved options always own every field.
  Object.freeze({
    ...DEFAULT_FIELDS,
    selection: undefined,
    recover: resolveRecover(DEFAULT_FIELDS),
  }))();

/** A value check with no context: the refusal reason is the kind's own name. */
const CHECKS = {
  boolean: (value: unknown) => typeof value === "boolean",
  // Only omission resets a bound; accepting null would silently discard the caller's limit.
  "positive-integer": (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1,
  "string-array": (value: unknown) => isStringArray(value),
  policy: (value: unknown) => value === "drop" || value === "keep" || value === "reject",
  "cut-suffix": (value: unknown) => typeof value === "boolean" || typeof value === "string",
} as const;

/**
 * Every parse option, once, with the kind of value it takes. The unknown-name refusal and every
 * context-free check derive from this table, and `satisfies` fails the build when `ParserOptions`
 * gains or loses a key without it, so a new option cannot be accepted unchecked or refused as a
 * misspelling. `feature` and `recover` values need typed results, so `validateOptions` checks them
 * by hand. Entry order is check order: with several bad values, the first entry's is reported.
 */
const OPTION_KINDS = {
  allowComments: "boolean",
  allowSingleQuotes: "boolean",
  allowTrailingComma: "boolean",
  allowUnquotedKeys: "boolean",
  allowJavaScript: "boolean",
  repairBroken: "boolean",
  exactNumbers: "boolean",
  builtinParsers: "boolean",
  nullPrototype: "boolean",
  objectOnly: "boolean",
  cutSuffix: "cut-suffix",
  onDangerousKey: "policy",
  customDangerousKeys: "string-array",
  requiredKeys: "string-array",
  maxDepth: "positive-integer",
  maxScalar: "positive-integer",
  maxErrors: "positive-integer",
  maxBuffer: "positive-integer",
  maxRetained: "positive-integer",
  diagnostics: "feature",
  locations: "feature",
  select: "feature",
  skip: "feature",
  recover: "recover",
} as const satisfies Record<keyof ParserOptions, keyof typeof CHECKS | "feature" | "recover">;

/** Whether `name` is a parse option, for refusals that must tell a misplaced key from a misspelt one. */
export const isParseOption = (name: string): boolean => Object.hasOwn(OPTION_KINDS, name);
const invalid = (
  field: string,
  reason: Extract<ConfigurationFailure, { kind: "invalid-options" }>["reason"],
): ConfigurationFailure => Object.freeze({ kind: "invalid-options", field, reason });

/**
 * An optional feature's value: `false` when absent or turned off, the imported value when its tag
 * matches the key, else the `import-required` refusal — `true` above all, the spelling from before
 * features were imports, whose message then names the import. Checked by tag rather than identity
 * so a value configured by a call (`diagnostics({ maxEntries })`) passes too, and by the members the
 * core reads, so a copy that kept the tag but lost them (a JSON round trip of the options), or an
 * object written by hand to the public type, is refused here, typed, instead of crashing untyped or
 * being read as no selection.
 */
const featureOf = <K extends FeatureKey>(
  key: K,
  value: unknown,
): FeatureValue[K] | false | ConfigurationFailure => {
  if (value === undefined || value === false) return false;
  if (
    (typeof value !== "function" && typeof value !== "object") ||
    value === null ||
    // An inherited tag is host state, not the imported capability the caller supplied.
    ownOption(value, "feature") !== key
  )
    return invalid(key, "import-required");
  const members = value as Record<string, unknown>;
  for (const [member, kind] of READ[key]) {
    const read = members[member];
    // `compiled` is read at once for its `paths`; an object without them crashes the resolver.
    const ok =
      kind === "function"
        ? typeof read === "function"
        : typeof read === "object" &&
          read !== null &&
          Array.isArray((read as { paths?: unknown }).paths);
    if (!ok) return invalid(key, "import-required");
  }
  return value as FeatureValue[K];
};

/**
 * The members the core reads off each feature that its public type does not show: a method, or the
 * compiled selector set. `wire` is read only when the options cross to a worker, after validation,
 * so it is checked here or it would fail there untyped. `locations` is data only.
 */
const READ: Readonly<Record<FeatureKey, readonly (readonly [string, "function" | "compiled"])[]>> =
  {
    diagnostics: [
      ["open", "function"],
      ["project", "function"],
    ],
    locations: [],
    select: [
      ["picks", "function"],
      ["wire", "function"],
      ["compiled", "compiled"],
    ],
    skip: [
      ["picks", "function"],
      ["wire", "function"],
      ["compiled", "compiled"],
    ],
  };

/**
 * Resolves caller options against the defaults, or throws the `configurationError` saying why not.
 * The non-throwing `validateOptions` is for the one caller that must report rather than throw: the
 * worker, which answers its host with a typed message.
 */
export const resolveOptions = (
  source?: ParserOptions | StreamParserOptions,
  inherited?: ParserOptions,
  capture?: (settings: ParserOptions) => void,
  stream = false,
): ResolvedOptions => {
  const resolved = validateOptions(source, inherited, capture, stream);
  if ("kind" in resolved) throw configurationError(resolved);
  return resolved;
};

const isStringArray = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value)) return false;
  // `some` skips holes; a hole later becomes undefined during capture and must be refused here.
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") return false;
  return true;
};

/** Resolve options before input is read; runtime validation also covers unchecked configuration. */
export const validateOptions = (
  source: unknown = {},
  inherited?: ParserOptions,
  capture?: (settings: ParserOptions) => void,
  /** Only a stream delivers `fragments`; every other verb refuses a selection asking for them. */
  stream = false,
): ResolvedOptions | ConfigurationFailure => {
  if (!isPlainObject(source)) return invalid("options", "object");
  /**
   * An own-only, null-prototype copy, taken in the loop that had to walk the caller's keys anyway.
   *
   * Every read below is a plain `options.x`, and a plain read consults the PROTOTYPE CHAIN — so a
   * host whose `Object.prototype` carries `maxDepth` or `allowJavaScript`, whether from an attacker
   * or from an old library that still extends it, would supply settings nobody passed and silently
   * change how a parse behaves. The unknown-name scan cannot see them either, since `Object.getOwnPropertyNames`
   * is own keys only. Guarding two dozen reads one at a time is the version that rots: a missed one
   * looks exactly like a guarded one. Copying once makes the whole function safe by construction.
   */
  const options: ParserOptions = { __proto__: null, ...inherited } as ParserOptions;
  for (const name of Object.getOwnPropertyNames(source)) {
    if (!isParseOption(name)) return invalid(name, "unknown");
    const value = (source as Record<string, unknown>)[name];
    // An own `undefined` override keeps the parser's setting, as `Overridden` types it: a wrapper
    // forwarding `{ maxDepth: opts.depth }` would otherwise reset a configured limit to the default.
    if (value === undefined && inherited !== undefined && Object.hasOwn(inherited, name)) continue;
    (options as Record<string, unknown>)[name] = value;
  }
  for (const name in OPTION_KINDS) {
    const kind = OPTION_KINDS[name as keyof typeof OPTION_KINDS];
    const value = options[name as keyof ParserOptions];
    if (value !== undefined && kind in CHECKS && !CHECKS[kind as keyof typeof CHECKS](value))
      return invalid(name, kind as keyof typeof CHECKS);
  }
  const suffix = options.cutSuffix;
  const diagnostics = featureOf("diagnostics", options.diagnostics);
  if (diagnostics !== false && "kind" in diagnostics) return diagnostics;
  const locations = featureOf("locations", options.locations);
  if (locations !== false && "kind" in locations) return locations;
  const selected = featureOf("select", options.select);
  if (selected !== false && "kind" in selected) return selected;
  const skipped = featureOf("skip", options.skip);
  if (skipped !== false && "kind" in skipped) return skipped;
  const custom = options.customDangerousKeys;
  const required = options.requiredKeys;
  const {
    maxDepth = DEFAULTS.maxDepth,
    maxScalar = DEFAULTS.maxScalar,
    maxErrors = DEFAULTS.maxErrors,
    maxBuffer = DEFAULTS.maxBuffer,
  } = options;
  const { maxRetained = maxBuffer } = options;
  // The paths were validated and compiled by the factory that made each value. A `skip([])` excludes
  // nothing, so it is no selection: it builds no `Picks`, and its report covers `"all"`.
  const skipping = skipped !== false && skipped.compiled.paths.length > 0 ? skipped : false;
  const carrier = selected === false ? skipping : selected;
  const selection: CompiledSelection | undefined =
    carrier === false
      ? undefined
      : Object.freeze({
          select: selected === false ? undefined : selected.compiled,
          skip: skipping === false ? undefined : skipping.compiled,
          picks: carrier.picks,
        });
  const occurrences = selected !== false && selected.occurrences;
  const fragments = selected !== false && selected.fragments !== false;
  if (fragments && !stream) return invalid("select", "fragments-stream");
  // Root acceptance is known only when a root closes, and eager matches have left by then.
  if (
    (occurrences || fragments) &&
    (options.objectOnly === true || (required !== undefined && required.length > 0))
  ) {
    return invalid("select", "root-filter");
  }
  const flags = {
    allowComments: options.allowComments ?? DEFAULTS.allowComments,
    allowSingleQuotes: options.allowSingleQuotes ?? DEFAULTS.allowSingleQuotes,
    allowTrailingComma: options.allowTrailingComma ?? DEFAULTS.allowTrailingComma,
    allowUnquotedKeys: options.allowUnquotedKeys ?? DEFAULTS.allowUnquotedKeys,
    allowJavaScript: options.allowJavaScript ?? DEFAULTS.allowJavaScript,
    repairBroken: options.repairBroken ?? DEFAULTS.repairBroken,
  };
  let overrides = options.recover;
  if (overrides !== undefined) {
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
      return invalid("recover", "object");
    }
    // Only supplied switches count; inherited properties must never change recovery policy.
    const own = { __proto__: null } as Partial<Record<SwitchableRepair, boolean>>;
    // Named per entry rather than as one "bad recover": a mistyped kind is the likely mistake here,
    // and `recover.trailing-coma` names the key to look at rather than the object holding it.
    for (const kind of Object.getOwnPropertyNames(overrides)) {
      if (!Object.hasOwn(RECOVERY_FLAG, kind)) return invalid(`recover.${kind}`, "unknown");
      const value = overrides[kind as SwitchableRepair];
      if (typeof value !== "boolean") return invalid(`recover.${kind}`, "boolean");
      own[kind as SwitchableRepair] = value;
    }
    overrides = own;
  }
  // Keep authored settings, not defaults: flags and maxBuffer must still derive their dependents
  // on a later override. Feature values are frozen and own their paths, so they are kept as given.
  // Absent policies share frozen defaults; caller arrays still need owned copies before scheduling.
  const customDangerousKeys =
    custom === undefined ? DEFAULTS.customDangerousKeys : Object.freeze([...custom]);
  const requiredKeys =
    required === undefined ? DEFAULTS.requiredKeys : Object.freeze([...required]);
  if (capture !== undefined) {
    if (overrides !== undefined) options.recover = overrides;
    options.customDangerousKeys = customDangerousKeys;
    options.requiredKeys = requiredKeys;
    capture(options);
  }
  return Object.freeze({
    ...flags,
    recover: resolveRecover(flags, overrides),
    selection,
    maxRetained,
    occurrences,
    fragments,
    maxErrors,
    maxBuffer,
    diagnostics,
    locations: locations !== false,
    exactNumbers: options.exactNumbers ?? DEFAULTS.exactNumbers,
    builtinParsers: options.builtinParsers ?? DEFAULTS.builtinParsers,
    // Built, never a literal: a bundle read as Latin-1 would turn a literal "\u2026" into three characters.
    cutSuffix:
      suffix === true
        ? String.fromCharCode(0x2026)
        : suffix === false || suffix === undefined
          ? ""
          : suffix,
    maxDepth,
    maxScalar,
    onDangerousKey: options.onDangerousKey ?? DEFAULTS.onDangerousKey,
    nullPrototype: options.nullPrototype ?? DEFAULTS.nullPrototype,
    customDangerousKeys,
    objectOnly: options.objectOnly ?? DEFAULTS.objectOnly,
    requiredKeys,
  });
};

/** The resolved defaults, for callers that pass nothing. Frozen, so no caller can reconfigure another. */
export const DEFAULT_OPTIONS = DEFAULTS;
