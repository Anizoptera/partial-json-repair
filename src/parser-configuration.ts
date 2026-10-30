// SPDX-License-Identifier: Apache-2.0

import type {
  Exact,
  Given,
  ParserOptions,
  ParserSettings,
  ResolvedOptions,
  StreamParserOptions,
} from "./options";
import type { StreamParser } from "./parser";
import type { StreamBuild } from "./parser-stream";
import type { PositionAt } from "./positions";
import type { ScanCursor } from "./scan-cursor";
import type { ParsedStream } from "./transport";
import type { Diagnostics, Input, ParseError, ParserClosedFailure, Result } from "./types";
import { resolveOptions } from "./options";
import { bareFailure, RELEASED } from "./parser-outcome";

/** Validated reusable configuration; imported verbs choose which operation code is reachable. */
export class ParserConfiguration<Options extends ParserOptions = ParserOptions> {
  // Native private storage carries the option type and cannot be forged by an option object's keys.
  #state: {
    readonly options: ResolvedOptions;
    readonly inherited: Options;
    readonly observer: ParseObserver | undefined;
    closed: boolean;
  };

  private constructor(options: ResolvedOptions, inherited: Options, observer?: ParseObserver) {
    this.#state = { options, inherited, observer, closed: false };
  }

  /** @internal */
  static create<Options extends ParserOptions, Members extends object = Record<never, never>>(
    options: ResolvedOptions,
    inherited: Options,
    observer?: ParseObserver,
    members?: Members,
  ): Parser<Options> & Members {
    const parser = new ParserConfiguration(options, inherited, observer);
    // Compute the disposal key only at construction; an unused import must do no setup work.
    const configured = Object.assign(parser, members, {
      [Symbol.dispose](): void {
        parser.close();
      },
    });
    Object.freeze(configured);
    return configured;
  }

  get options(): ParserSettings {
    return this.#state.options;
  }

  readonly close: (this: void) => Result<undefined, never> = () => {
    // A synchronous configuration owns no running calls; closing prevents only future operations.
    this.#state.closed = true;
    return RELEASED;
  };

  /** @internal */
  static is(value: object): value is ParserConfiguration {
    return #state in value;
  }

  /** @internal */
  static state(parser: ParserConfiguration): Readonly<{
    options: ResolvedOptions;
    inherited: ParserOptions;
    observer: ParseObserver | undefined;
    closed: boolean;
  }> {
    return parser.#state;
  }
}

export type Parser<Options extends ParserOptions = ParserOptions> = ParserConfiguration<Options> &
  Disposable;

/**
 * Counting hooks a metrics scope attaches to its configuration. Each verb hands the scope its
 * result and, for streams, its own builder and driver output, so the scope imports no stream code:
 * a scope used only for whole input keeps the stream machinery out of the bundle (HLD D5).
 */
export type ParseObserver = {
  /** Counts a whole-input outcome, or each `parseMany` item as it leaves; returns it unchanged. */
  readonly whole: (
    result: Counted | IterableIterator<Counted>,
    started: number,
  ) => Counted | IterableIterator<Counted>;
  /** Builds a stream whose cursor reports retained-input peaks and compactions to the scope. */
  readonly stream: <O extends StreamParserOptions>(
    build: (cursorFor: (positionAt: PositionAt) => ScanCursor) => StreamBuild<O>,
  ) => ObservedStream<O>;
};

/** What the counter reads from any outcome or item; every verb's result has this shape. */
export type Counted = {
  readonly ok: boolean;
  readonly diagnostics?: Diagnostics;
  readonly failure?: { readonly kind: string; readonly issue?: ParseError };
};

export type ObservedStream<O extends StreamParserOptions> = {
  readonly built: StreamBuild<O>;
  /** The push parser, counting what it yields and folding its buffer record once it closes. */
  readonly parser: () => StreamParser<O>;
  /** Wraps what `drive` returned, counting items as they leave its iterator. */
  readonly parsed: (stream: ParsedStream<O>) => ParsedStream<O>;
};

export const isParser = (value: unknown): value is Parser =>
  typeof value === "object" && value !== null && ParserConfiguration.is(value);

/** Resolve overrides even after close so a typed failure cannot hide an invalid option. */
export function configuredCall<
  Output extends Counted | IterableIterator<Counted>,
  Closed extends Counted | IterableIterator<Counted>,
>(
  parser: Parser,
  input: Input,
  overrides: ParserOptions | undefined,
  operation: (options: ResolvedOptions, input: Input) => Output,
  onClosed: (options: ResolvedOptions) => Closed,
): Output | Closed;
export function configuredCall<Output extends Counted | IterableIterator<Counted>>(
  parser: Parser,
  input: Input,
  overrides: ParserOptions | undefined,
  operation: (options: ResolvedOptions, input: Input) => Output,
): Output | ReturnType<typeof closedParser>;
export function configuredCall(
  parser: Parser,
  input: Input,
  overrides: ParserOptions | undefined,
  operation: (options: ResolvedOptions, input: Input) => Counted | IterableIterator<Counted>,
  onClosed: (options: ResolvedOptions) => Counted | IterableIterator<Counted> = closedParser,
): Counted | IterableIterator<Counted> {
  const state = ParserConfiguration.state(parser);
  const options =
    overrides === undefined ? state.options : resolveOptions(overrides, state.inherited);
  const started = state.observer === undefined ? 0 : performance.now();
  const result = state.closed ? onClosed(options) : operation(options, input);
  return state.observer === undefined ? result : state.observer.whole(result, started);
}

export const closedParser = (options: ResolvedOptions) =>
  bareFailure({ kind: "parser-closed" } satisfies ParserClosedFailure, options.diagnostics);

export const closedParserIterator = (options: ResolvedOptions) => [closedParser(options)].values();

/** Validate once and capture caller-owned options before any input is consumed. */
export function initParser<Options extends ParserOptions>(
  options: Exact<Options, ParserOptions>,
): Parser<Options>;
export function initParser<Options extends ParserOptions | undefined>(
  options: Exact<Options, ParserOptions>,
): Parser<Given<Options>>;
export function initParser<Options extends ParserOptions = Record<never, never>>(): Parser<Options>;
export function initParser<Options extends ParserOptions = never>(
  options?: Exact<NoInfer<Options>, ParserOptions>,
): Parser<Options>;
export function initParser(options?: ParserOptions): Parser {
  let inherited: ParserOptions = {};
  const resolved = resolveOptions(options, undefined, (captured) => {
    inherited = captured;
  });
  return ParserConfiguration.create(resolved, inherited);
}
