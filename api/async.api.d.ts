// Generated from shipped declarations; review changes with bun run api:update.
export declare type AbortedFailure = {
  readonly kind: "aborted";
  readonly reason: unknown;
  readonly recovered?: Recovery;
};
declare const ANY: unique symbol;
declare const ANY_DEPTH: unique symbol;
declare class AsyncConfiguration<Options extends AsyncOverrides = AsyncOverrides> {
  #private;
  readonly close: (this: void) => Result<undefined, never>;
  private constructor();
  get options(): ParserSettings;
}
export declare type AsyncExecution = AutoExecution | CooperativeExecution | WorkerExecution;
export declare type AsyncFailure = WithCleanupFailure<
  ParseFailure | AbortedFailure | SchedulingFailure | SignalFailure | ExecutionUnavailableFailure
>;
export declare type AsyncOptions = ParserOptions & {
  readonly execution: AsyncExecution;
  readonly signal?: StopSignal;
};
export declare type AsyncOverrides = ParserOptions & {
  readonly execution?: AsyncExecution;
  readonly signal?: StopSignal;
};
declare type AsyncParseOutcome<O extends AsyncOverrides, F = never> = ParseOutcome<
  O,
  AsyncFailure | F | CompletedCleanupFailure<ParseOutcome<O>>
>;
export declare type AsyncParser<Options extends AsyncOverrides = AsyncOverrides> =
  AsyncConfiguration<Options> & Disposable;
export declare type AsyncRepairFailure = WithCleanupFailure<
  RepairFailure | AbortedFailure | SchedulingFailure | SignalFailure | ExecutionUnavailableFailure
>;
declare type AsyncRepairOutcome<O extends AsyncOverrides, F = never> = RepairOutcome<
  O,
  AsyncRepairFailure | F | CompletedCleanupFailure<RepairOutcome<O>>
>;
declare type AsyncSpanOutcome<O extends AsyncOverrides, F = never> = SpanOutcome<
  O,
  AsyncFailure | F | CompletedCleanupFailure<SpanOutcome<O>>
>;
export declare const auto: AutoExecution;
export declare type AutoExecution = {
  readonly feature: "execution";
  readonly kind: "auto";
};
declare type CleanupFailure = {
  kind: "cleanup-failed";
  cause: unknown;
  recovered?: undefined;
};
declare type Completed<R> = R extends {
  readonly ok: true;
}
  ? R & Completion
  : R;
declare type CompletedCleanupFailure<Outcome> = CleanupFailure & {
  readonly completed: Extract<
    Outcome,
    {
      readonly ok: true;
    }
  >;
};
declare type Completion =
  | {
      readonly complete: true;
      readonly cut?: undefined;
    }
  | {
      readonly complete: false;
      readonly cut: Cut;
    };
export declare const cooperative: CooperativeExecution;
export declare type CooperativeExecution = {
  readonly feature: "execution";
  readonly kind: "cooperative";
};
declare type Cut = {
  readonly path: SourcePath;
  readonly kind: CutKind;
  readonly text?: string;
};
declare type CutKind = "string" | "number" | "missing" | "between";
declare type DangerousKeyPolicy = "drop" | "keep" | "reject";
declare type Diagnostics = {
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
declare type DiagnosticsFeature = {
  <Settings extends DiagnosticsSettings>(
    settings: Exact<Settings, DiagnosticsSettings>,
  ): DiagnosticsFeature;
  readonly feature: "diagnostics";
  readonly maxEntries: number;
  readonly scope: "all" | "selected" | undefined;
};
declare type DiagnosticsSettings = {
  readonly maxEntries?: number;
  readonly scope?: "all" | "selected";
};
declare type ErrorKind = "depth-budget" | "dangerous-key" | "invalid-utf8" | "unparsable-span";
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
export declare type ExecutionUnavailableFailure = {
  readonly kind: "execution-unavailable";
  readonly execution: "worker";
  readonly reason: WorkerFailure | "unsupported";
  readonly message: string;
  readonly recovered?: Recovery;
  readonly cause?: RepairFailure | AbortedFailure | SignalFailure;
};
declare type FeatureKey = keyof PublicFeatureValue;
export declare function findJsonSpanAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): Promise<AsyncSpanOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function findJsonSpanAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): Promise<AsyncSpanOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function findJsonSpanAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): Promise<AsyncSpanOutcome<O>>;
declare type First<R> = R extends {
  readonly ok: true;
}
  ? R & {
      readonly more?: true;
    }
  : R;
declare type FragmentView<O> = O extends {
  select: SelectFeature<true | SourceFragmentsFeature>;
  view: ViewFeature;
}
  ? "view"
  : never;
export declare function initAsyncParser<O extends AsyncOptions>(
  options: Exact<O, AsyncOptions>,
): AsyncParser<O>;
declare type Input = string | Uint8Array;
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
declare type LocationsFeature = {
  readonly feature: "locations";
};
declare type ManyOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  Completed<Result<Selected<O, Value, Match>, ParseFailure | F>>,
  O
>;
declare type Match<T = Value> = {
  readonly value: T;
  readonly path: SourcePath;
  readonly valueIndex: number;
  readonly span: Span;
  readonly selectors: readonly number[];
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
export declare function parseAsync<O extends AsyncOverrides, C extends AsyncOverrides | undefined>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): Promise<AsyncParseOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function parseAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): Promise<AsyncParseOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function parseAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): Promise<AsyncParseOutcome<O>>;
declare type ParseError = {
  kind: ErrorKind;
  valueIndex: number;
  path: SourcePath;
  at: Position;
  line: number;
  column: number;
  context: string;
  refused?: SwitchableRepair | undefined;
};
declare type ParseFailure =
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
export declare function parseManyAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): AsyncGenerator<
  ManyOutcome<Overridden<O, C>, AsyncFailure | CleanupFailure | ParserClosedFailure>,
  void,
  undefined
>;
export declare function parseManyAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): AsyncGenerator<
  ManyOutcome<Overridden<O, C>, AsyncFailure | CleanupFailure | ParserClosedFailure>,
  void,
  undefined
>;
export declare function parseManyAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): AsyncGenerator<ManyOutcome<O, AsyncFailure | CleanupFailure>, void, undefined>;
declare type ParseOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  First<Completed<Result<Selected<O, Value, readonly Match[]>, ParseFailure | F>>>,
  O
>;
declare type ParserClosedFailure = {
  kind: "parser-closed";
  recovered?: undefined;
};
declare type ParserOptions = {
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
declare type ParserSettings = Readonly<
  Omit<Required<ParserOptions>, "recover" | "cutSuffix" | FeatureKey>
> & {
  readonly cutSuffix: string;
  readonly recover: Readonly<Record<SwitchableRepair, boolean>>;
  readonly diagnostics: false | DiagnosticsFeature;
  readonly locations: boolean;
  readonly occurrences: boolean;
  readonly fragments: boolean;
};
declare type PathSegment = string | number | typeof ANY | typeof ANY_DEPTH;
declare type Position = {
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
declare type Recovery = {
  readonly value: Value;
} & Completion;
declare type Repair = {
  kind: RepairKind;
  at: Position;
  path: SourcePath;
  valueIndex: number;
};
export declare function repairAsync<O extends AsyncOverrides, C extends AsyncOverrides | undefined>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): Promise<AsyncRepairOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function repairAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): Promise<AsyncRepairOutcome<Overridden<O, C>, ParserClosedFailure>>;
export declare function repairAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): Promise<AsyncRepairOutcome<O>>;
declare type RepairFailure = ParseFailure;
declare type RepairKind =
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
declare type RepairOutcome<O extends ParserOptions = ParserOptions, F = never> = Shaped<
  First<Completed<Result<Selected<O, string, readonly Match<string>[]>, RepairFailure | F>>>,
  O
>;
declare type Reportable<R, D> = [D] extends [DiagnosticsFeature]
  ? Reported<R>
  : [D] extends [false | undefined]
    ? R
    : R & {
        readonly diagnostics?: Diagnostics;
      };
declare type Reported<R> = R & {
  readonly diagnostics: Diagnostics;
};
declare type Result<T, F> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly failure: F;
    };
export declare type SchedulingFailure = {
  readonly kind: "scheduling-failed";
  readonly cause: unknown;
  readonly cleanupFailure?: CleanupFailure;
  readonly recovered?: Recovery;
};
declare type Selected<O, Whole, Matched> = [OptionOf<O, "select">] extends [false | undefined]
  ? Whole
  : [OptionOf<O, "select">] extends [SelectFeature]
    ? Matched
    : Whole | Matched;
declare type SelectFeature<
  Fragments extends boolean | SourceFragmentsFeature = boolean | SourceFragmentsFeature,
> = {
  readonly feature: "select";
  readonly paths: readonly SelectorPath[];
  readonly occurrences: boolean;
  readonly fragments: Fragments;
};
declare type SelectorPath = readonly PathSegment[];
declare type Shaped<
  R,
  O extends {
    diagnostics?: false | DiagnosticsFeature;
    locations?: false | LocationsFeature;
  },
> = Reportable<Located<R, OptionOf<O, "locations">>, OptionOf<O, "diagnostics">>;
export declare type SignalFailure = {
  readonly kind: "signal-failed";
  readonly cause: unknown;
  readonly recovered?: Recovery;
  readonly cleanupFailure?: CleanupFailure;
};
declare type SkipFeature = {
  readonly feature: "skip";
  readonly paths: readonly SelectorPath[];
};
declare type SourceFragmentsFeature = {
  readonly feature: "source-fragments";
};
declare type SourcePath = readonly (string | number)[];
declare type Span = {
  start: Position;
  end: Position;
};
declare type SpanOutcome<O extends ParserOptions = ParserOptions, F = never> = Reportable<
  First<Result<Selected<O, Span, readonly Match<Span>[]>, ParseFailure | F>>,
  OptionOf<O, "diagnostics">
>;
declare type StopSignal = {
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
declare type SwitchableRepair = Exclude<RepairKind, "dangerous-key">;
declare type Value = unknown;
declare type ViewFeature<Mode extends ViewMode = ViewMode> = {
  readonly feature: "view";
  readonly mode: Mode;
};
declare type ViewMode = "shared" | "owned";
declare type WithCleanupFailure<Failure> = Failure & {
  readonly cleanupFailure?: CleanupFailure;
};
export declare const worker: WorkerExecution;
export declare type WorkerExecution = {
  readonly feature: "execution";
  readonly kind: "worker";
};
declare type WorkerFailure = "failed" | "unsupported";
export {};
