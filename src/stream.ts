// SPDX-License-Identifier: Apache-2.0

import type {
  Exact,
  Given,
  ParserOptions,
  StreamCallOptions,
  StreamParserOptions,
} from "./options";
import type { Parser } from "./parser-configuration";
import { isParser, ParserConfiguration } from "./parser-configuration";
import type { ChunkSource, ParsedStream } from "./transport";
import type { StopSignal } from "./stop-signal";
import { driveStream } from "./parser";
import { buildStreamParser, rejectedStream, splitSignal, streamSettings } from "./parser-stream";
import { drive } from "./transport";

export type StreamOptions = StreamParserOptions & {
  /**
   * Stops the parse. Once it aborts, no further chunk is READ **and** a chunk already in hand is
   * not parsed either. The second half is the one an implementation gets wrong: breaking out of the
   * loop gives the first for free, so a test that only checks "no more chunks were pulled" passes
   * against code that still parsed the chunk it was holding.
   *
   * Cancellation yields an `aborted` failure carrying the signal's reason and available recovery,
   * unless an earlier source or terminal parser failure stays primary. A requested summary follows.
   */
  signal?: StopSignal;
};

/**
 * Every value in a stream of chunks, as an item when it completes.
 *
 * The portable core, and deliberately the ONLY streaming entry point that also builds its parser.
 * It takes an async iterable rather than a platform stream type, so one function serves Node, Deno,
 * Bun, the browser and a hand-rolled generator with no `node:` import anywhere in the built graph —
 * asserted by `artifact:check` against `dist/`, never against source, since a source-level grep
 * would pass while the bundle carried `node:stream`. A caller whose downstream is a web stream
 * wraps it with `ReadableStream.from(parseStream(source))`: same values, same cancellation,
 * measured on node 24.20.0 and bun 1.4.0.
 *
 * Serving many streams on one configuration uses `parseStream(source, parser, streamOptions)`
 * instead, which is this same transport without re-validating options that cannot have changed.
 * This function is the one-shot form of exactly that call.
 *
 * Chunks may be text or bytes, mixed freely; a multi-byte character split across a chunk boundary
 * survives, because the decode is owned by the stream parser rather than done per chunk by a caller.
 *
 * Invalid options throw at the call, before the source is touched (HLD: the caller's bug, not an
 * ending). Every way the stream can end short of its input is the LAST item, typed: a
 * source of the wrong shape, a bound the scanner hit, a source that threw, an abort, a source that
 * finished and then refused to be released. A refused root is an ordinary failed item and the next
 * root still follows. Whatever the input left open is closed at the end, as one-shot `parse` does —
 * except after an abort, because then the input did not end. With `summary: true` the summary
 * follows the last item on every path.
 */
export function parseStream<O extends ParserOptions, S extends StreamCallOptions>(
  source: ChunkSource,
  parser: Parser<O>,
  options: Exact<S, StreamCallOptions>,
): ParsedStream<O & S>;
export function parseStream<O extends ParserOptions, S extends StreamCallOptions | undefined>(
  source: ChunkSource,
  parser: Parser<O>,
  options: Exact<S, StreamCallOptions>,
): ParsedStream<O & Given<S>>;
export function parseStream<O extends ParserOptions>(
  source: ChunkSource,
  parser: Parser<O>,
): ParsedStream<O>;
export function parseStream<O extends ParserOptions, S extends StreamCallOptions = never>(
  source: ChunkSource,
  parser: Parser<O>,
  options?: Exact<NoInfer<S>, StreamCallOptions>,
): ParsedStream<O & S>;
export function parseStream<O extends StreamOptions>(
  source: ChunkSource,
  options: Exact<O, StreamOptions>,
): ParsedStream<O>;
export function parseStream<O extends StreamOptions | undefined>(
  source: ChunkSource,
  options: Exact<O, StreamOptions>,
): ParsedStream<Given<O>>;
export function parseStream<O extends StreamOptions = Record<never, never>>(
  source: ChunkSource,
): ParsedStream<O>;
export function parseStream<O extends StreamOptions = never>(
  source: ChunkSource,
  options?: Exact<NoInfer<O>, StreamOptions>,
): ParsedStream<O>;
export function parseStream(
  source: ChunkSource,
  options?: StreamOptions | Parser,
  streamOptions?: StreamCallOptions,
): ParsedStream {
  if (isParser(options)) {
    const state = ParserConfiguration.state(options);
    const [requested, signal] = splitSignal(streamOptions);
    if (state.closed) {
      streamSettings(requested, state.options);
      return rejectedStream(
        { kind: "parser-closed" },
        streamOptions ?? {},
        state.options.diagnostics,
      );
    }
    if (state.observer === undefined)
      return drive(buildStreamParser(requested, state.options), source, signal);
    const observed = state.observer.stream((cursorFor) =>
      buildStreamParser(requested, state.options, cursorFor),
    );
    return observed.parsed(drive(observed.built, source, signal));
  }
  return driveStream(source, options);
}
