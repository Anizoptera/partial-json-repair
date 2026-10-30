// SPDX-License-Identifier: Apache-2.0

/**
 * Outcome types and per-stream state keep status outside recovered data.
 * Reusable configuration has a separate lifetime: overrides affect one operation, while scan
 * state and counters belong to their own owners so later calls cannot change earlier outcomes.
 *
 * **Every outcome is `{ ok, value }` or `{ ok, failure }`, and the report is a separate field.**
 * Status outside the data means `{"ok":false}` parses to a success holding that object; a report
 * outside the value means asking for one changes nothing about how the data is read. Recovered data
 * on failure sits INSIDE the failure, so a refused or stopped root can never be mistaken for a
 * finished one.
 */

import type { ParserOptions, StreamParserOptions } from "./options";
import type {
  Fragment,
  SourceFragment,
  SourceFragmentsFeature,
  SelectFeature,
  Match,
  OptionOf,
  ParseFailure,
  RepairFailure,
  Reportable,
  Completed,
  Result,
  Selected,
  Shaped,
  Snapshot,
  SnapshotFailure,
  Span,
  StreamFailure,
  StreamSummary,
  Value,
  ViewFeature,
} from "./types";
export type { Parser } from "./parser-configuration";
export { initParser } from "./parser-configuration";
export { createStreamParser, driveStream } from "./parser-stream";
export type { StreamBuild } from "./parser-stream";

/**
 * A single-value verb's success: `more: true` when the input holds a value after the returned one,
 * the one `parseMany` would deliver next (HLD P4), so a caller reading only the value can tell.
 */
type First<R> = R extends { readonly ok: true } ? R & { readonly more?: true } : R;

/**
 * What `parse` hands back: the value, or under `select` the matches from the first root; the
 * report and `span` fields follow the options.
 */
export type ParseOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  First<Completed<Result<Selected<O, Value, readonly Match[]>, ParseFailure | F>>>,
  O
>;
/** One item of `parseMany`: a value, or under `select` one match. */
export type ManyOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  Completed<Result<Selected<O, Value, Match>, ParseFailure | F>>,
  O
>;
/** The repaired text says, like a parsed value, whether the source finished it. */
export type RepairOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  First<Completed<Result<Selected<O, string, readonly Match<string>[]>, RepairFailure | F>>>,
  O
>;
/**
 * The value IS a location, so `locations` adds nothing here and only the report follows the options.
 * A span carries no completion facts: it locates the source, it is not a recovered value.
 */
export type SpanOutcome<O extends ParserOptions = ParserOptions, F = never> = Reportable<
  First<Result<Selected<O, Span, readonly Match<Span>[]>, ParseFailure | F>>,
  OptionOf<O, "diagnostics">
>;
/**
 * One item from a stream drain: a value, a failed root, the terminal failure that ends the stream,
 * or — when `summary: true` asked for it — the one summary after everything else. A summary has
 * `kind` and no `ok`, so `"kind" in item` tells the two apart. Under `select` the value is one
 * match, under `fragments` one fragment.
 */
export type StreamItem<O extends StreamParserOptions = StreamParserOptions> =
  | Shaped<StreamResult<O>, O>
  | Summarised<OptionOf<O, "summary">>;

/** A fragment is a piece of a scalar, not a value, so only values and matches carry completion. */
type StreamResult<O extends StreamParserOptions> = FragmentResult<FragmentsOf<O>, O>;

// Distribute settings unions so a dynamic mode keeps every possible result without widening literals.
type FragmentResult<F, O extends StreamParserOptions> = F extends true
  ? Result<Fragment, StreamFailure>
  : F extends SourceFragmentsFeature
    ? Result<SourceFragment, StreamFailure>
    : Completed<Result<Selected<O, Value, Match>, StreamFailure>>;

/** Whether the stream's `select` delivers fragments; `boolean` when that is only known at run time. */
type FragmentsOf<O> = SelectionFragments<OptionOf<O, "select">>;
type SelectionFragments<S> = S extends SelectFeature<infer F> ? F : false;

type Summarised<S> = [S] extends [false | undefined] ? never : StreamSummary;

/**
 * Own override fields replace settings; optional fields can also leave the base value in place.
 * Distributes with `extends unknown` and tests overrides with `extends object`: `ParserOptions` has
 * only optional keys, so TypeScript's weak-type rule fails `{ execution }` or `{ signal }` against
 * it, which turned a strategy-only parser's outcome into `never` and ignored a signal-only override.
 */
export type Overridden<O extends ParserOptions, C> = O extends unknown
  ? OverrideMember<O, C>
  : never;
type OverrideMember<O, C> = C extends object
  ? Omit<O, keyof C> & {
      [K in keyof C]: Record<never, never> extends Pick<C, K>
        ? Exclude<C[K] | (K extends keyof O ? O[K] : never), undefined>
        : C[K];
    }
  : O;

/**
 * A parser's scan state for ONE stream. Disposable, mutable, never shared.
 *
 * `feed` and `end` hand back LAZY drains: the chunk is taken at the call, the scan runs as the
 * drain is pulled, and one root is produced per pull. Every value is delivered exactly once: a drain
 * the caller skipped is finished by the next `feed`, `end` or `snapshot`, and its values lead the
 * next iteration read, counted against `maxRetained` meanwhile. Leaving a drain early with `break`
 * closes the stream, since the input it held can be neither replayed nor resumed.
 */
export type StreamParser<O extends StreamParserOptions = StreamParserOptions> = {
  /**
   * The items completed BY THIS CHUNK — preceded by any an earlier, unread `feed()` completed — one
   * per finished root, plus the terminal failure if a bound stopped the stream inside it. A consumer
   * accumulates; it is not a running total. After `end()`,
   * `close()` or a terminal failure, the one item is `stream-closed`.
   *
   * Bytes are accepted as well as text, and the incremental decode is owned HERE. A string-only API
   * hands every streaming caller the job of decoding per chunk, which corrupts any multi-byte
   * character split across a chunk boundary — silent data loss at the exact point a network read is
   * most likely to split. A leading BOM is stripped by the decoder.
   */
  feed(chunk: string | Uint8Array): IterableIterator<StreamItem<O>>;
  /**
   * Closes whatever the input left open and hands back only the TAIL: the root that was still
   * open, or `no-json-found` when the whole stream held no root, then the `summary` when one was
   * asked for, preceded by any values an unread `feed()` completed. Values already delivered are
   * never repeated. A second call is `stream-closed`.
   */
  end(): IterableIterator<StreamItem<O>>;
  /**
   * Stops the stream: later `feed` and `end` answer `stream-closed`, and the retained input is
   * released. Idempotent. A manual stream holds no source of its own, so there is nothing whose
   * cleanup could fail — the outcome is always success, and the type says so.
   */
  close(): Result<undefined, never>;
} & Viewed<OptionOf<O, "view">, O>;

/**
 * `snapshot()` exists exactly when a view was configured: a literal `view` puts it on the type, no
 * `view` leaves it out, and a value only known at run time makes it optional — the same rule as
 * the report, and for the same reason.
 */
export type Viewed<V, O extends StreamParserOptions> = [V] extends [ViewFeature]
  ? { snapshot(): SnapshotResult<O> }
  : [V] extends [undefined]
    ? Record<never, never>
    : { snapshot?(): SnapshotResult<O> };

/**
 * The root in progress, or the last one delivered, as the configured view. `undefined` before any
 * root exists. A refused or stopped root is a failure with the view under `recovered`.
 */
export type SnapshotResult<O extends StreamParserOptions = StreamParserOptions> = Result<
  Snapshot<Selected<O, Value, readonly Match[]>> | undefined,
  SnapshotFailure
>;
