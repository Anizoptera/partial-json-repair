// Generated from shipped declarations; review changes with bun run api:update.
declare type AbortedFailure = {
  readonly kind: "aborted";
  readonly reason: unknown;
  readonly recovered?: Recovery;
};
export declare const ANY: unique symbol;
export declare const ANY_DEPTH: unique symbol;
export declare type BigIntConversionFailure =
  | {
      kind: "not-integer";
    }
  | {
      kind: "digits-exceeded";
      digits: number;
      maxDigits: number;
    };
export declare type ChunkSource =
  | AsyncIterable<string | Uint8Array>
  | Iterable<string | Uint8Array>
  | {
      getReader(): {
        read(): Promise<{
          done: boolean;
          value?: string | Uint8Array | undefined;
        }>;
        cancel?(reason?: unknown): Promise<void>;
        releaseLock(): void;
        readonly closed?: Promise<unknown>;
      };
    };
export declare type CleanupFailure = {
  kind: "cleanup-failed";
  cause: unknown;
  recovered?: undefined;
};
export declare type CloseFailure = (
  | CleanupFailure
  | SignalFailure
  | {
      kind: "aborted";
      reason: unknown;
    }
) & {
  readonly cleanupFailure?: CleanupFailure;
};
export declare const COMPAT: Readonly<{
  readonly allowJavaScript: true;
  readonly recover: Readonly<{
    readonly "leading-zero-number": true;
    readonly "unquoted-root-string": true;
  }>;
}>;
export declare type Completed<R> = R extends {
  readonly ok: true;
}
  ? R & Completion
  : R;
export declare type Completion =
  | {
      readonly complete: true;
      readonly cut?: undefined;
    }
  | {
      readonly complete: false;
      readonly cut: Cut;
    };
export declare const confidenceOf: (repairs: readonly Repair[]) => number;
export declare type ConfigurationFailure = {
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
    | "execution"
    | "cut-suffix"
    | "selector"
    | "skip-tail"
    | "import-required"
    | "fragments-stream"
    | "root-filter"
    | "fragments-view"
    | "parse-option-on-stream"
    | "metrics-report"
    | "function"
    | "signal";
};
export declare function createMetrics<
  O extends Omit<ParserOptions, "diagnostics"> = Record<never, never>,
>(options: Exact<O, Omit<ParserOptions, "diagnostics">>): MetricsParser<O>;
export declare function createMetrics<O extends Omit<ParserOptions, "diagnostics"> | undefined>(
  options: Exact<O, Omit<ParserOptions, "diagnostics">>,
): MetricsParser<Given<O>>;
export declare function createMetrics<
  O extends Omit<ParserOptions, "diagnostics"> = Record<never, never>,
>(): MetricsParser<O>;
export declare function createMetrics<O extends Omit<ParserOptions, "diagnostics"> = never>(
  options?: Exact<NoInfer<O>, Omit<ParserOptions, "diagnostics">>,
): MetricsParser<O>;
export declare function createStreamParser<O extends ParserOptions, S extends StreamOnlyOptions>(
  parser: Parser<O>,
  options: Exact<S, StreamOnlyOptions>,
): StreamParser<O & S>;
export declare function createStreamParser<
  O extends ParserOptions,
  S extends StreamOnlyOptions | undefined,
>(parser: Parser<O>, options: Exact<S, StreamOnlyOptions>): StreamParser<O & Given<S>>;
export declare function createStreamParser<O extends ParserOptions>(
  parser: Parser<O>,
): StreamParser<O>;
export declare function createStreamParser<
  O extends ParserOptions,
  S extends StreamOnlyOptions = never,
>(parser: Parser<O>, options?: Exact<NoInfer<S>, StreamOnlyOptions>): StreamParser<O & S>;
export declare function createStreamParser<O extends StreamParserOptions>(
  options: Exact<O, StreamParserOptions>,
): StreamParser<O>;
export declare function createStreamParser<O extends StreamParserOptions | undefined>(
  options: Exact<O, StreamParserOptions>,
): StreamParser<Given<O>>;
export declare function createStreamParser<
  O extends StreamParserOptions = Record<never, never>,
>(): StreamParser<O>;
export declare function createStreamParser<O extends StreamParserOptions = never>(
  options?: Exact<NoInfer<O>, StreamParserOptions>,
): StreamParser<O>;
export declare type CustomParser = (text: string) => unknown;
export declare type Cut = {
  readonly path: SourcePath;
  readonly kind: CutKind;
  readonly text?: string;
};
export declare type CutKind = "string" | "number" | "missing" | "between";
export declare type DangerousKeyPolicy = "drop" | "keep" | "reject";
export declare const decodedFragments: DecodedFragmentsFeature;
export declare type DecodedFragmentsFeature = {
  readonly feature: "decoded-fragments";
};
export declare type Diagnostics = {
  repairs: readonly Repair[];
  errors: readonly ParseError[];
  counts: {
    repairs: number;
    errors: number;
  };
  entriesComplete: boolean;
  scanComplete: boolean;
  scope: "all" | "selected";
  confidence: number;
  laterValues: readonly Span[];
};
export declare const diagnostics: DiagnosticsFeature;
export declare type DiagnosticsFeature = {
  <Settings extends DiagnosticsSettings>(
    settings: Exact<Settings, DiagnosticsSettings>,
  ): DiagnosticsFeature;
  readonly feature: "diagnostics";
  readonly maxEntries: number;
  readonly scope: "all" | "selected" | undefined;
};
export declare type DiagnosticsSettings = {
  readonly maxEntries?: number;
  readonly scope?: "all" | "selected";
};
export declare type EncodingFailure =
  | NonJsonValueFailure
  | {
      kind: "cycle";
      path: SourcePath;
    }
  | {
      kind: "accessor";
      path: SourcePath;
    }
  | {
      kind: "invalid-value";
      path: SourcePath;
      cause: unknown;
    }
  | {
      kind: "limit-reached";
      resource: "output";
      limit: number;
    };
export declare type ErrorKind =
  | "depth-budget"
  | "dangerous-key"
  | "invalid-utf8"
  | "unparsable-span";
declare type Exact<O, A> = O &
  ([Exclude<OptionKeys<O>, keyof A>] extends [never]
    ? [MisspeltKinds<O>] extends [never]
      ? [FragmentView<O>] extends [never]
        ? O extends undefined
          ? O
          : O & A
        : {
            readonly view: never;
          }
      : {
          readonly recover: {
            readonly [K in MisspeltKinds<O>]: never;
          };
        }
    : Record<Exclude<OptionKeys<O>, keyof A>, never>);
declare class ExactNumber {
  readonly text: string;
  private readonly brand;
  constructor(text: string);
  toNumber<
    Options extends
      | {
          allowRounding?: boolean;
        }
      | undefined,
  >(
    options: Exact<
      Options,
      {
        allowRounding?: boolean;
      }
    >,
  ): Result<number, NumberConversionFailure>;
  toNumber<
    Options extends {
      allowRounding?: boolean;
    } = never,
  >(
    options?: Exact<
      NoInfer<Options>,
      {
        allowRounding?: boolean;
      }
    >,
  ): Result<number, NumberConversionFailure>;
  toBigInt<
    Options extends {
      maxDigits: number;
    },
  >(
    options: Exact<
      Options,
      {
        maxDigits: number;
      }
    >,
  ): Result<bigint, BigIntConversionFailure>;
  toJSON(): unknown;
  toString(): string;
}
declare type ExecutionUnavailableFailure = {
  readonly kind: "execution-unavailable";
  readonly execution: "worker";
  readonly reason: WorkerFailure | "unsupported";
  readonly message: string;
  readonly recovered?: Recovery;
  readonly cause?: RepairFailure | AbortedFailure | SignalFailure;
};
export declare type FailureKind = (
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
declare type FeatureKey = keyof PublicFeatureValue;
export declare function findJsonSpan<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): SpanOutcome<Overridden<O, C>, ParserClosedFailure>;
export declare function findJsonSpan<
  O extends ParserOptions,
  C extends ParserOptions | undefined = undefined,
>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): SpanOutcome<Overridden<O, C>, ParserClosedFailure>;
export declare function findJsonSpan(input: Input): SpanOutcome<Record<never, never>>;
export declare function findJsonSpan<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): SpanOutcome<Given<O>>;
declare type First<R> = R extends {
  readonly ok: true;
}
  ? R & {
      readonly more?: true;
    }
  : R;
export declare type Fragment =
  | {
      readonly kind: "start";
      readonly id: number;
      readonly valueIndex: number;
      readonly path: SourcePath;
      readonly selectors: readonly number[];
      readonly scalar: "string" | "number" | "literal";
    }
  | {
      readonly kind: "data";
      readonly id: number;
      readonly text: string;
    }
  | {
      readonly kind: "end";
      readonly id: number;
      readonly span: Span;
      readonly complete: boolean;
    };
declare type FragmentMode<Setting> = Setting extends undefined
  ? false
  : Setting extends DecodedFragmentsFeature
    ? true
    : Setting;
declare type FragmentResult<F, O extends StreamParserOptions> = F extends true
  ? Result<Fragment, StreamFailure>
  : F extends SourceFragmentsFeature
    ? Result<SourceFragment, StreamFailure>
    : Completed<Result<Selected<O, Value, Match>, StreamFailure>>;
declare type FragmentsOf<O> = SelectionFragments<OptionOf<O, "select">>;
declare type FragmentView<O> = O extends {
  select: SelectFeature<true | SourceFragmentsFeature>;
  view: ViewFeature;
}
  ? "view"
  : never;
declare type Given<O> = O extends undefined ? Record<never, never> : O;
export declare function initParser<Options extends ParserOptions>(
  options: Exact<Options, ParserOptions>,
): Parser<Options>;
export declare function initParser<Options extends ParserOptions | undefined>(
  options: Exact<Options, ParserOptions>,
): Parser<Given<Options>>;
export declare function initParser<
  Options extends ParserOptions = Record<never, never>,
>(): Parser<Options>;
export declare function initParser<Options extends ParserOptions = never>(
  options?: Exact<NoInfer<Options>, ParserOptions>,
): Parser<Options>;
export declare type Input = string | Uint8Array;
export declare const isExactNumber: (value: unknown) => value is ExactNumber;
export declare const LLM_BALANCED: Readonly<{}>;
export declare const LLM_FULL: Readonly<{
  readonly allowJavaScript: true;
  readonly onDangerousKey: "drop";
}>;
declare type Located<R, L> = R extends {
  ok: true;
}
  ? [L] extends [LocationsFeature]
    ? R & {
        readonly span: Span;
      }
    : [L] extends [false | undefined]
      ? R
      : R & {
          readonly span?: Span;
        }
  : R;
export declare const locations: LocationsFeature;
export declare type LocationsFeature = {
  readonly feature: "locations";
};
export declare type ManyOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  Completed<Result<Selected<O, Value, Match>, ParseFailure | F>>,
  O
>;
export declare type Match<T = Value> = {
  readonly value: T;
  readonly path: SourcePath;
  readonly valueIndex: number;
  readonly span: Span;
  readonly selectors: readonly number[];
};
export declare type MetricsParser<O extends ParserOptions = ParserOptions> = Parser<
  O & {
    diagnostics: DiagnosticsFeature;
  }
> & {
  read(reset?: boolean): ParseMetrics;
  reset(): void;
};
declare type MisspeltKinds<O> = O extends {
  readonly recover?: infer R;
}
  ? MisspeltRecovery<R>
  : never;
declare type MisspeltRecovery<R> = R extends undefined
  ? never
  : string extends keyof R
    ? never
    : Exclude<keyof R, SwitchableRepair>;
export declare type NonJsonValueFailure = {
  kind: "non-json-value";
  valueKind:
    | "undefined"
    | "nan"
    | "infinity"
    | "bigint"
    | "function"
    | "symbol"
    | "non-plain-object";
  path: SourcePath;
};
export declare type NumberConversionFailure =
  | {
      kind: "overflow";
    }
  | {
      kind: "underflow";
    }
  | {
      kind: "inexact";
    };
declare type OptionKeys<O> = O extends undefined ? never : keyof O;
declare type OptionOf<O, K extends string> = O extends O
  ? K extends keyof O
    ? O[K]
    : undefined
  : never;
declare type Overridden<O extends ParserOptions, C> = O extends unknown
  ? OverrideMember<O, C>
  : never;
declare type OverrideMember<O, C> = C extends object
  ? Omit<O, keyof C> & {
      [K in keyof C]: Record<never, never> extends Pick<C, K>
        ? Exclude<C[K] | (K extends keyof O ? O[K] : never), undefined>
        : C[K];
    }
  : O;
export declare const ownedView: ViewFeature<"owned">;
export declare function parse<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): ParseOutcome<Overridden<O, C>, ParserClosedFailure>;
export declare function parse<
  O extends ParserOptions,
  C extends ParserOptions | undefined = undefined,
>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): ParseOutcome<Overridden<O, C>, ParserClosedFailure>;
export declare function parse(input: Input): ParseOutcome<Record<never, never>>;
export declare function parse<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): ParseOutcome<Given<O>>;
export declare type ParsedStream<O extends StreamParserOptions = StreamParserOptions> =
  AsyncIterableIterator<StreamItem<O>> & {
    close<Options extends TransportOptions | undefined>(
      options: Exact<Options, TransportOptions>,
    ): Promise<Result<undefined, CloseFailure>>;
    close<Options extends TransportOptions = never>(
      options?: Exact<NoInfer<Options>, TransportOptions>,
    ): Promise<Result<undefined, CloseFailure>>;
  } & Viewed<OptionOf<O, "view">, O>;
export declare type ParseError = {
  kind: ErrorKind;
  valueIndex: number;
  path: SourcePath;
  at: Position;
  line: number;
  column: number;
  context: string;
  refused?: SwitchableRepair | undefined;
};
export declare type ParseFailure =
  | {
      kind: "invalid-input";
      received: string;
      recovered?: Recovery;
      cause?: Exclude<
        ParseFailure,
        {
          kind: "invalid-input";
        }
      >;
    }
  | {
      kind: "unsupported-encoding";
      encoding: "utf-16be" | "utf-16le" | "utf-32be" | "utf-32le";
      recovered?: undefined;
    }
  | {
      kind: "no-json-found";
      recovered?: undefined;
    }
  | {
      kind: "no-match";
      expected: "object";
      requiredKeys: readonly string[];
      recovered?: Recovery;
    }
  | {
      kind: "policy-refused";
      issue: ParseError;
      recovered?: Recovery;
    }
  | {
      kind: "limit-reached";
      resource: "buffer" | "depth" | "errors" | "scalar" | "retained" | "unread";
      limit: number;
      at?: Position;
      recovered?: Recovery;
    };
export declare function parseMany<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): IterableIterator<ManyOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function parseMany<
  O extends ParserOptions,
  C extends ParserOptions | undefined = undefined,
>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): IterableIterator<ManyOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function parseMany(
  input: Input,
): IterableIterator<ManyOutcome<Record<never, never>>>;
export declare function parseMany<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): IterableIterator<ManyOutcome<Given<O>>>;
export declare type ParseMetrics = {
  readonly parseAttempts: number;
  readonly parseSuccesses: number;
  readonly parseFailures: number;
  readonly parseDuration?: number;
  readonly repairs: Readonly<Record<RepairKind, number>>;
  readonly memory: Readonly<{
    bufferCleanups: number;
    bufferOverflows: number;
    maxBufferSize: number;
  }>;
  readonly security: Readonly<{
    blockedKeys: Readonly<Record<string, number>>;
    dangerousKeysBlocked: number;
  }>;
};
export declare type ParseOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  First<Completed<Result<Selected<O, Value, readonly Match[]>, ParseFailure | F>>>,
  O
>;
export declare type Parser<Options extends ParserOptions = ParserOptions> =
  ParserConfiguration<Options> & Disposable;
export declare type ParserClosedFailure = {
  kind: "parser-closed";
  recovered?: undefined;
};
declare class ParserConfiguration<Options extends ParserOptions = ParserOptions> {
  #private;
  private constructor();
  get options(): ParserSettings;
  readonly close: (this: void) => Result<undefined, never>;
}
export declare type ParserOptions = {
  allowComments?: boolean;
  allowSingleQuotes?: boolean;
  allowTrailingComma?: boolean;
  allowUnquotedKeys?: boolean;
  allowJavaScript?: boolean;
  repairBroken?: boolean;
  recover?: Readonly<Partial<Record<SwitchableRepair, boolean>>>;
  maxErrors?: number;
  diagnostics?: false | DiagnosticsFeature;
  locations?: false | LocationsFeature;
  exactNumbers?: boolean;
  builtinParsers?: boolean;
  cutSuffix?: boolean | string;
  maxBuffer?: number;
  maxDepth?: number;
  onDangerousKey?: DangerousKeyPolicy;
  nullPrototype?: boolean;
  customDangerousKeys?: readonly string[];
  maxScalar?: number;
  maxRetained?: number;
  select?: false | SelectFeature<false>;
  skip?: false | SkipFeature;
  objectOnly?: boolean;
  requiredKeys?: readonly string[];
};
export declare type ParserSettings = Readonly<
  Omit<Required<ParserOptions>, "recover" | "cutSuffix" | FeatureKey>
> & {
  readonly cutSuffix: string;
  readonly recover: Readonly<Record<SwitchableRepair, boolean>>;
  readonly diagnostics: false | DiagnosticsFeature;
  readonly locations: boolean;
  readonly occurrences: boolean;
  readonly fragments: boolean;
};
export declare function parseStream<O extends ParserOptions, S extends StreamCallOptions>(
  source: ChunkSource,
  parser: Parser<O>,
  options: Exact<S, StreamCallOptions>,
): ParsedStream<O & S>;
export declare function parseStream<
  O extends ParserOptions,
  S extends StreamCallOptions | undefined,
>(
  source: ChunkSource,
  parser: Parser<O>,
  options: Exact<S, StreamCallOptions>,
): ParsedStream<O & Given<S>>;
export declare function parseStream<O extends ParserOptions>(
  source: ChunkSource,
  parser: Parser<O>,
): ParsedStream<O>;
export declare function parseStream<O extends ParserOptions, S extends StreamCallOptions = never>(
  source: ChunkSource,
  parser: Parser<O>,
  options?: Exact<NoInfer<S>, StreamCallOptions>,
): ParsedStream<O & S>;
export declare function parseStream<O extends StreamOptions>(
  source: ChunkSource,
  options: Exact<O, StreamOptions>,
): ParsedStream<O>;
export declare function parseStream<O extends StreamOptions | undefined>(
  source: ChunkSource,
  options: Exact<O, StreamOptions>,
): ParsedStream<Given<O>>;
export declare function parseStream<O extends StreamOptions = Record<never, never>>(
  source: ChunkSource,
): ParsedStream<O>;
export declare function parseStream<O extends StreamOptions = never>(
  source: ChunkSource,
  options?: Exact<NoInfer<O>, StreamOptions>,
): ParsedStream<O>;
export declare type PathSegment = string | number | typeof ANY | typeof ANY_DEPTH;
export declare type Position = {
  offset: number;
  unit: "utf16" | "byte";
  chunk?: number;
};
declare type PublicFeatureValue = {
  diagnostics: DiagnosticsFeature;
  locations: LocationsFeature;
  select: SelectFeature;
  skip: SkipFeature;
};
export declare type Recovery = {
  readonly value: Value;
} & Completion;
export declare type Repair = {
  kind: RepairKind;
  at: Position;
  path: SourcePath;
  valueIndex: number;
};
export declare function repair<O extends ParserOptions, C extends ParserOptions | undefined>(
  input: Input,
  parser: Parser<O>,
  options: Exact<C, ParserOptions>,
): RepairOutcome<Overridden<O, C>, ParserClosedFailure>;
export declare function repair<
  O extends ParserOptions,
  C extends ParserOptions | undefined = undefined,
>(
  input: Input,
  parser: Parser<O>,
  options?: Exact<NoInfer<C>, ParserOptions>,
): RepairOutcome<Overridden<O, C>, ParserClosedFailure>;
export declare function repair(input: Input): RepairOutcome<Record<never, never>>;
export declare function repair<O extends ParserOptions | undefined>(
  input: Input,
  options: Exact<O, ParserOptions>,
): RepairOutcome<Given<O>>;
export declare const REPAIR_PENALTY: Readonly<Record<RepairKind, number>>;
export declare type RepairFailure = ParseFailure;
export declare type RepairKind =
  | "unclosed-string"
  | "missing-quote"
  | "guessed-string-end"
  | "unclosed-object"
  | "unclosed-array"
  | "trailing-comma"
  | "missing-comma"
  | "missing-colon"
  | "missing-brackets"
  | "escaped-delimiter"
  | "non-json-whitespace"
  | "single-quote"
  | "unquoted-key"
  | "quote-mismatch"
  | "bracket-mismatch"
  | "comment-removed"
  | "js-literal"
  | "literal-case"
  | "null-alias"
  | "invalid-escape"
  | "extra-colon"
  | "unquoted-string"
  | "unquoted-root-string"
  | "invalid-number"
  | "leading-dot-number"
  | "leading-plus-number"
  | "hex-number"
  | "binary-number"
  | "octal-number"
  | "numeric-separator"
  | "leading-zero-number"
  | "bom-removed"
  | "duplicate-key"
  | "dangerous-key"
  | "dropped-member";
export declare type RepairOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  First<Completed<Result<Selected<O, string, readonly Match<string>[]>, RepairFailure | F>>>,
  O
>;
export declare type Reportable<R, D> = [D] extends [DiagnosticsFeature]
  ? Reported<R>
  : [D] extends [false | undefined]
    ? R
    : R & {
        readonly diagnostics?: Diagnostics;
      };
export declare type Reported<R> = R & {
  readonly diagnostics: Diagnostics;
};
export declare type Result<T, F> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly failure: F;
    };
declare type SchedulingFailure = {
  readonly kind: "scheduling-failed";
  readonly cause: unknown;
  readonly cleanupFailure?: CleanupFailure;
  readonly recovered?: Recovery;
};
export declare function select<const S extends SelectSettings = Record<never, never>>(
  paths: readonly SelectorPath[],
  settings?: S | SelectSettings,
  ...invalid: [S] extends [never]
    ? []
    : [Exclude<OptionKeys<S>, keyof SelectSettings>] extends [never]
      ? []
      : [never]
): SelectFeature<SelectionFragments_2<S>>;
export declare type Selected<O, Whole, Matched> = [OptionOf<O, "select">] extends [
  false | undefined,
]
  ? Whole
  : [OptionOf<O, "select">] extends [SelectFeature]
    ? Matched
    : Whole | Matched;
export declare type SelectFeature<
  Fragments extends boolean | SourceFragmentsFeature = boolean | SourceFragmentsFeature,
> = {
  readonly feature: "select";
  readonly paths: readonly SelectorPath[];
  readonly occurrences: boolean;
  readonly fragments: Fragments;
};
declare type SelectionFragments<S> = S extends SelectFeature<infer F> ? F : false;
declare type SelectionFragments_2<S extends SelectSettings> = S extends SelectSettings
  ? "fragments" extends keyof S
    ? FragmentMode<S["fragments"]>
    : false
  : never;
export declare type SelectorPath = readonly PathSegment[];
export declare type SelectSettings = {
  readonly occurrences?: boolean;
  readonly fragments?: false | DecodedFragmentsFeature | SourceFragmentsFeature;
};
export declare type Shaped<
  R,
  O extends {
    diagnostics?: false | DiagnosticsFeature;
    locations?: false | LocationsFeature;
  },
> = Reportable<Located<R, OptionOf<O, "locations">>, OptionOf<O, "diagnostics">>;
export declare const sharedView: ViewFeature<"shared">;
export declare type SignalFailure = {
  readonly kind: "signal-failed";
  readonly cause: unknown;
  readonly recovered?: Recovery;
  readonly cleanupFailure?: CleanupFailure;
};
export declare const skip: (paths: readonly SelectorPath[]) => SkipFeature;
export declare type SkipFeature = {
  readonly feature: "skip";
  readonly paths: readonly SelectorPath[];
};
export declare type Snapshot<T = Value> = {
  readonly value: T;
  readonly valueIndex: number;
} & Completion;
export declare type SnapshotFailure = Extract<
  ParseFailure,
  {
    kind: "policy-refused" | "limit-reached";
  }
>;
export declare type SnapshotResult<O extends StreamParserOptions = StreamParserOptions> = Result<
  Snapshot<Selected<O, Value, readonly Match[]>> | undefined,
  SnapshotFailure
>;
export declare type SourceFragment =
  | Omit<
      Extract<
        Fragment,
        {
          kind: "start";
        }
      >,
      "scalar"
    >
  | Extract<
      Fragment,
      {
        kind: "data";
      }
    >
  | ({
      readonly kind: "end";
      readonly id: number;
      readonly span: Span;
    } & (
      | {
          readonly scalar: "string" | "number" | "literal";
          readonly complete: boolean;
        }
      | {
          readonly scalar: "missing";
          readonly complete: false;
        }
    ));
export declare const sourceFragments: SourceFragmentsFeature;
export declare type SourceFragmentsFeature = {
  readonly feature: "source-fragments";
};
export declare type SourcePath = readonly (string | number)[];
export declare type Span = {
  start: Position;
  end: Position;
};
export declare type SpanOutcome<O extends ParserOptions = ParserOptions, F = never> = Reportable<
  First<Result<Selected<O, Span, readonly Match<Span>[]>, ParseFailure | F>>,
  OptionOf<O, "diagnostics">
>;
export declare type StopSignal = {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(
    type: "abort",
    listener: () => void,
    options: {
      once: true;
    },
  ): void;
  removeEventListener?(type: "abort", listener: () => void): void;
};
declare type StreamCallOptions = StreamOnlyOptions & {
  signal?: StopSignal;
};
export declare type StreamFailure =
  | ParserClosedFailure
  | ParseFailure
  | SignalFailure
  | SchedulingFailure
  | {
      kind: "invalid-source";
      sourceKind: string;
      recovered?: Recovery;
      cleanupFailure?: CleanupFailure;
    }
  | {
      kind: "source-failed";
      cause: unknown;
      recovered?: Recovery;
      cleanupFailure?: CleanupFailure;
    }
  | (AbortedFailure & {
      cleanupFailure?: CleanupFailure;
    })
  | CleanupFailure
  | {
      kind: "stream-closed";
      recovered?: undefined;
    }
  | {
      kind: "non-scalar-selection";
      path: SourcePath;
      recovered?: undefined;
    };
export declare type StreamItem<O extends StreamParserOptions = StreamParserOptions> =
  | Shaped<StreamResult<O>, O>
  | Summarised<OptionOf<O, "summary">>;
export declare type StreamOnlyOptions = {
  view?: ViewFeature;
  summary?: boolean;
};
export declare type StreamOptions = StreamParserOptions & {
  signal?: StopSignal;
};
export declare type StreamParser<O extends StreamParserOptions = StreamParserOptions> = {
  feed(chunk: string | Uint8Array): IterableIterator<StreamItem<O>>;
  end(): IterableIterator<StreamItem<O>>;
  close(): Result<undefined, never>;
} & Viewed<OptionOf<O, "view">, O>;
export declare type StreamParserOptions = Omit<ParserOptions, "select"> &
  StreamOnlyOptions & {
    select?: false | SelectFeature;
  };
declare type StreamResult<O extends StreamParserOptions> = FragmentResult<FragmentsOf<O>, O>;
export declare type StreamSummary = {
  readonly kind: "summary";
  readonly complete: boolean;
  readonly roots: number;
  readonly matches: number;
  readonly unmatched: readonly number[];
};
export declare const STRICT: Readonly<{
  readonly allowComments: false;
  readonly allowSingleQuotes: false;
  readonly allowTrailingComma: false;
  readonly allowUnquotedKeys: false;
  readonly allowJavaScript: false;
  readonly repairBroken: false;
  readonly maxErrors: 1;
}>;
export declare function stringify<O extends StringifyOptions | undefined>(
  value: unknown,
  options: Exact<O, StringifyOptions>,
): Result<string, EncodingFailure>;
export declare function stringify<O extends StringifyOptions = never>(
  value: unknown,
  options?: Exact<NoInfer<O>, StringifyOptions>,
): Result<string, EncodingFailure>;
export declare type StringifyOptions = {
  readonly maxOutput?: number;
};
declare type Summarised<S> = [S] extends [false | undefined] ? never : StreamSummary;
export declare type SwitchableRepair = Exclude<RepairKind, "dangerous-key">;
declare type TransportOptions = {
  signal?: StopSignal;
};
export declare function tryParsers<
  const P extends readonly CustomParser[],
  Options extends TryParsersOptions<ReturnType<P[number]>> | undefined = TryParsersOptions<
    ReturnType<P[number]>
  >,
>(
  text: string,
  parsers: P,
  options: Exact<Options, TryParsersOptions<ReturnType<P[number]>>>,
): Result<Exclude<ReturnType<P[number]>, PromiseLike<unknown>>, TryParsersFailure>;
export declare function tryParsers<
  const P extends readonly CustomParser[],
  Options extends TryParsersOptions<ReturnType<P[number]>> = never,
>(
  text: string,
  parsers: P,
  options?: Exact<NoInfer<Options>, TryParsersOptions<ReturnType<P[number]>>>,
): Result<Exclude<ReturnType<P[number]>, PromiseLike<unknown>>, TryParsersFailure>;
export declare type TryParsersFailure =
  | {
      readonly kind: "async-parser";
      readonly parserIndex: number;
    }
  | {
      readonly kind: "result-inspection-failed";
      readonly parserIndex: number;
      readonly cause: unknown;
    }
  | {
      readonly kind: "acceptance-failed";
      readonly parserIndex: number;
      readonly cause: unknown;
    }
  | {
      readonly kind: "parsers-exhausted";
      readonly attempts: number;
    };
export declare type TryParsersOptions<T = unknown> = {
  isResult?: (value: T) => boolean;
};
export declare type Value = unknown;
declare type Viewed<V, O extends StreamParserOptions> = [V] extends [ViewFeature]
  ? {
      snapshot(): SnapshotResult<O>;
    }
  : [V] extends [undefined]
    ? Record<never, never>
    : {
        snapshot?(): SnapshotResult<O>;
      };
export declare type ViewFeature<Mode extends ViewMode = ViewMode> = {
  readonly feature: "view";
  readonly mode: Mode;
};
export declare type ViewMode = "shared" | "owned";
declare type WorkerFailure = "failed" | "unsupported";
export {};
export type { ExactNumber };
