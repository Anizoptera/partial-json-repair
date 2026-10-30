// SPDX-License-Identifier: Apache-2.0

/**
 * The one way an entry point refuses its options. A module of its own so a lean feature import (an
 * `ExactNumber` method, `stringify`) can refuse a bad option without pulling in the option resolver.
 */

import type { ConfigurationFailure } from "./types";
import type { StopSignal } from "./stop-signal";
import { signalFailures } from "./stop-signal";

/**
 * What each refusal means, in the words a caller fixing their options needs. Exhaustive by type,
 * except reasons whose owner supplies the text: every app ships this table, so text only an
 * optional entry can raise (`execution`, from `/async`) lives with that entry.
 */
type OwnedReason = "import-required" | "execution";
const REASON_TEXT: Readonly<Record<Exclude<ConfigurationFailure["reason"], OwnedReason>, string>> =
  {
    object: "must be a plain object",
    // "This call", because `signal`, `view` or `execution` given to a verb that does not take them
    // lands here too: options of the package, but not of that verb.
    unknown: "is not an option of this call (check the spelling)",
    boolean: "must be true or false",
    policy: 'must be "drop", "keep" or "reject"',
    "string-array": "must be an array of strings",
    "positive-integer": "must be a positive safe integer",
    scope: 'must be "all" or "selected"',
    view: 'takes imported `sharedView` or `ownedView` from "partial-json-repair"; pass `{ view: sharedView }` or `{ view: ownedView }`',
    // Short on purpose: every lean helper that can refuse an option ships this table.
    "cut-suffix":
      "must be true (appends an ellipsis, U+2026), false, or the string to append to a cut string",
    selector: "must be a list of paths made of keys, indexes and wildcards",
    "skip-tail": "must end every path in a key, so an array element is never removed",
    "fragments-stream":
      "with `fragments` requires a stream: use `parseStream` or `createStreamParser`",
    "root-filter":
      "with `occurrences` or `fragments` delivers matches before roots close; cannot combine with `objectOnly` or `requiredKeys`",
    "fragments-view": "cannot be combined with `view`: fragments retain no value to show",
    "parse-option-on-stream":
      "is a parse option, and this parser's parse options are fixed: set it in `initParser` instead",
    "metrics-report":
      "is always on in `createMetrics`, which counts repairs from the report: remove it",
    function: "must be a function",
    signal:
      "must have a boolean `aborted` and callable event methods when supplied (pass `controller.signal`, not the controller)",
  };

/**
 * Invalid options are the caller's bug (HLD): the types reject every misuse they can express, and
 * the rest throws HERE, before any input is read. The typed reason rides as `cause` for callers who
 * load options at run time; every other failure stays a typed result.
 */
export const configurationError = (
  failure: ConfigurationFailure,
  // Feature owners supply specialized guidance so unrelated helpers never import that text; the one
  // `execution` refusal (`async-operation.ts` `strategyOf`) always passes its own.
  explanation = failure.reason === "import-required"
    ? importText(failure.field)
    : REASON_TEXT[failure.reason as Exclude<ConfigurationFailure["reason"], OwnedReason>],
): TypeError =>
  new TypeError(`partial-json-repair: option \`${failure.field}\` ${explanation}.`, {
    cause: failure,
  });

/**
 * `import-required` names the import for its key, because `true` is the spelling a caller migrating
 * from booleans writes, and an error that only says "invalid" sends them to the docs for the fix.
 * The same answer covers any other wrong value: a copy that lost the feature's methods (a JSON
 * round trip) or another key's feature.
 */
const importText = (field: string): string => {
  const use =
    field === "select" ? "select: select(paths)" : field === "skip" ? "skip: skip(paths)" : field;
  return `takes the imported feature itself, never \`true\`, a copy or another feature: \`import { ${field} } from "partial-json-repair"\` and pass \`{ ${use} }\`, or \`false\` to turn it off`;
};

/**
 * The one test every entry point applies to an options argument before reading a key from it. A
 * wrapper that reads keys first (`Object.keys`, destructuring) lets `null` throw an untyped
 * `TypeError` and lets an array or a string pass as a set of unknown or no options.
 *
 * Plain means a null prototype or one whose own prototype is null, so a literal from another realm
 * passes. A `Map`, a `Date` or a class instance keeps its settings where own-key reads never look,
 * and would otherwise pass as no options at all. `stringify` applies the same test to the values it
 * encodes, so an object from an iframe or `vm` context is encoded like a local one.
 */
export const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
};

/**
 * One option read as an OWN property. A plain read or a destructuring consults the prototype chain,
 * so a host that extends `Object.prototype` would supply settings nobody passed; `validateOptions`
 * copies own keys for the same reason.
 */
export const ownOption = (options: object, key: string, snapshot?: object): unknown => {
  // Reuse copied accessor values, but retain named non-enumerable options omitted by spread.
  if (snapshot !== undefined && Object.hasOwn(snapshot, key))
    return (snapshot as Record<string, unknown>)[key];
  return Object.hasOwn(options, key) ? (options as Record<string, unknown>)[key] : undefined;
};

/** Snapshot each own setting once; spreading silently drops nonenumerable limits and policies. */
export const copyOwnOptions = <Options extends object>(source: Options): Options => {
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(source))
    copy[name] = (source as Record<string, unknown>)[name];
  return copy as Options;
};

/**
 * Checks a helper's own options argument (`stringify`, `tryParsers`, `toNumber`, `toBigInt`) the
 * way `validateOptions` checks parser options: a non-object or a misspelt key is refused, typed,
 * instead of reading as the defaults. Lives here rather than in `options.ts` so a helper bundled
 * alone does not carry the parser's option code.
 *
 * Returns the own keys on a null prototype, the copy every read must use: a read off the caller's
 * object would take a setting an extended `Object.prototype` supplies.
 */
export const checkHelperOptions = (
  options: unknown,
  known: readonly string[],
): Readonly<Record<string, unknown>> => {
  if (!isPlainObject(options))
    throw configurationError({ kind: "invalid-options", field: "options", reason: "object" });
  const own: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!known.includes(key))
      throw configurationError({ kind: "invalid-options", field: key, reason: "unknown" });
    own[key] = (options as Record<string, unknown>)[key];
  }
  return own;
};

/**
 * A `signal` that is not one would be ignored silently and the call could never be cancelled. The
 * common slip is passing the `AbortController` instead of its `signal`; it has no `aborted` flag.
 */
export const resolveSignal = (signal: unknown): StopSignal | undefined => {
  if (signal === undefined) return undefined;
  try {
    if (typeof signal === "object" && signal !== null && "aborted" in signal) {
      const aborted = signal.aborted;
      const add = "addEventListener" in signal ? signal.addEventListener : undefined;
      const remove = "removeEventListener" in signal ? signal.removeEventListener : undefined;
      if (
        typeof aborted === "boolean" &&
        (add === undefined || typeof add === "function") &&
        (remove === undefined || typeof remove === "function")
      )
        return signal as StopSignal;
    }
  } catch (cause) {
    // Host inspection failed, not option shape: the existing stop channel preserves its cause.
    const failed = { aborted: true };
    signalFailures.set(failed, { kind: "signal-failed", cause });
    return failed;
  }
  throw configurationError({ kind: "invalid-options", field: "signal", reason: "signal" });
};
