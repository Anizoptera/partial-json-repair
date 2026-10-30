// SPDX-License-Identifier: Apache-2.0

/** Adapt one configured native or WASM engine to the parser's single backend seam. */

import type {
  EngineParseOutcome,
  EngineRepairOutcome,
  EngineSpanOutcome,
  EngineStreamItem,
} from "./engine-wire";
import type {
  CoreParser,
  ManyOutcome,
  ParserBackend,
  StreamBuild,
  StreamItem,
  StreamParser,
} from "./parser";
import { bareFailure, shaped, wantsReport } from "./parser";
import type { EngineStreamOptions } from "./engine-configuration";
import type {
  ParserOptions,
  ResolvedOptions,
  StreamOnlyOptions,
  StreamParserOptions,
} from "./options";
import type {
  ConfigurationFailure,
  EngineBoundaryFailure,
  Input,
  Result,
  StreamFailure,
} from "./types";

export type EngineStream = {
  feed(input: string | Uint8Array): readonly EngineStreamItem[];
  feedSlice(
    input: string | Uint8Array,
    sourceOffset: number,
    finalSlice: boolean,
  ): readonly EngineStreamItem[];
  end(): readonly EngineStreamItem[];
  close(): unknown;
  snapshot?: () => unknown;
  summary?: () => EngineStreamItem;
};

export type ConfiguredEngine = {
  configureResolved(options: ResolvedOptions): Result<ConfiguredEngine, EngineBoundaryFailure>;
  parse(input: Input): EngineParseOutcome;
  parseMany(input: Input): readonly EngineParseOutcome[];
  repair(input: Input): EngineRepairOutcome;
  findJsonSpan(input: Input): EngineSpanOutcome;
  createStream(
    options?: EngineStreamOptions,
  ): Result<EngineStream, ConfigurationFailure | EngineBoundaryFailure>;
  close(): boolean;
};

export const buildEngineBackend = <O extends ParserOptions>(
  engine: ConfiguredEngine,
  options: ResolvedOptions,
): ParserBackend<O, EngineBoundaryFailure> => ({
  core: engineCore<O>(engine, options, false),
  coreFor: (requested) => {
    const configured = engine.configureResolved(requested);
    return configured.ok
      ? { ok: true, value: engineCore(configured.value, requested, true) }
      : configured;
  },
  stream: <S extends StreamOnlyOptions = Record<never, never>>(streamOptions?: S) =>
    buildEngineStream<O & S>((requested) => engine.createStream(requested), streamOptions as O & S),
  close: () => engine.close(),
});

const engineCore = <O extends ParserOptions>(
  engine: ConfiguredEngine,
  options: ResolvedOptions,
  releaseAfterCall: boolean,
): CoreParser<O, EngineBoundaryFailure> => {
  const reported = options.diagnostics !== false;
  const finish = <T>(outcome: T): T =>
    releaseAfterCall && !engine.close()
      ? shaped(bareFailure(protocolFailure().failure, reported))
      : outcome;
  return {
    options,
    parse: (input) => finish(shaped(engine.parse(input))),
    parseMany: (input) => {
      const outcomes = engine.parseMany(input);
      if (releaseAfterCall && !engine.close())
        return [
          shaped<ManyOutcome<O, EngineBoundaryFailure>>(
            bareFailure(protocolFailure().failure, reported),
          ),
        ].values();
      return outcomes
        .map((outcome) => shaped<ManyOutcome<O, EngineBoundaryFailure>>(outcome))
        .values();
    },
    repair: (input) => finish(shaped(engine.repair(input))),
    findJsonSpan: (input) => finish(shaped(engine.findJsonSpan(input))),
  };
};

export const buildEngineStream = <O extends StreamParserOptions>(
  create: (
    options?: EngineStreamOptions,
  ) => Result<EngineStream, ConfigurationFailure | EngineBoundaryFailure>,
  options?: O,
): Result<StreamBuild<O>, ConfigurationFailure | EngineBoundaryFailure> => {
  const created = create(options as EngineStreamOptions | undefined);
  if (!created.ok) return created;
  const engine = created.value;
  let finished = false;
  let released = false;
  const read = (items: readonly EngineStreamItem[]): IterableIterator<StreamItem<O>> => {
    for (const item of items) {
      if (
        "ok" in item &&
        !item.ok &&
        (item.failure.kind === "engine-protocol-failed" ||
          item.failure.kind === "stream-closed" ||
          item.failure.kind === "limit-reached")
      )
        finished = true;
    }
    return items.values() as IterableIterator<StreamItem<O>>;
  };
  const close = (): Result<undefined, never> => {
    if (!released) engine.close();
    released = true;
    finished = true;
    return { ok: true, value: undefined };
  };
  const parser: StreamParser<O> = {
    feed: (input) => (finished ? oneClosed<O>(wantsReport(options)) : read(engine.feed(input))),
    end: () => {
      if (finished) return oneClosed<O>(wantsReport(options));
      finished = true;
      return read(engine.end());
    },
    close,
    ...(engine.snapshot === undefined ? {} : { snapshot: engine.snapshot }),
  } as StreamParser<O>;
  return {
    ok: true,
    value: {
      parser,
      feedSlice: (input, sourceOffset, finalSlice) =>
        finished
          ? oneClosed<O>(wantsReport(options))
          : read(engine.feedSlice(input, sourceOffset, finalSlice)),
      summary: options?.summary === true,
      summarise: () => (engine.summary?.() ?? protocolFailure()) as StreamItem<O>,
      failed: (failure: StreamFailure) => shaped(bareFailure(failure, wantsReport(options))),
      closed: () => finished,
    },
  };
};

const oneClosed = <O extends StreamParserOptions>(
  reported: boolean,
): IterableIterator<StreamItem<O>> =>
  [shaped<StreamItem<O>>(bareFailure({ kind: "stream-closed" }, reported))].values();

const protocolFailure = (): Extract<EngineStreamItem, { ok: false }> => ({
  ok: false,
  failure: { kind: "engine-protocol-failed", reason: "malformed-response" },
});
