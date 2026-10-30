// SPDX-License-Identifier: Apache-2.0

/** Validate one native byte binding and expose the same input/outcome seam as other engines. */

import {
  decodeEngineManyResponse,
  decodeEngineRepairResponse,
  decodeEngineResponse,
  decodeEngineSnapshotResponse,
  decodeEngineSpanResponse,
  decodeEngineStreamResponse,
  DEFAULT_ENGINE_DECODE_CONTEXT,
} from "./engine-wire";
import type {
  EngineDecodeContext,
  EngineBoundaryFailure,
  EngineParseOutcome,
  EngineRepairOutcome,
  EngineSpanOutcome,
  EngineSnapshotOutcome,
  EngineStreamItem,
} from "./engine-wire";
import { encodeEngineChunk, encodeEngineRequest } from "./engine-request";
import { engineSnapshotView } from "./engine-snapshot";
import { encodeEngineConfiguration, encodeEngineStreamOptions } from "./engine-configuration";
import type { EngineStreamOptions } from "./engine-configuration";
import { resolveOptions } from "./options";
import type { ParserOptions, ResolvedOptions } from "./options";
import type { ConfigurationFailure, Input, Result } from "./types";
import type { StopSignal } from "./stop-signal";

type NativeParse = (request: Uint8Array) => Uint8Array;
type NativeStreamBinding = {
  feed(request: Uint8Array): Uint8Array;
  end(): Uint8Array;
  close(): void;
  snapshot(): Uint8Array;
  summary(): Uint8Array;
};
type NativeStreamConstructor = new () => NativeStreamBinding;
type NativeParserBinding = {
  execute(request: Uint8Array): Uint8Array;
  executeAsync?(request: Uint8Array, cancellation?: NativeCancellationBinding): Promise<Uint8Array>;
  createStream(mode: number): NativeStreamBinding;
  close?(): void;
};
type NativeCancellationBinding = { readonly opaque?: unknown; abort(): void; close?(): void };
type NativeCancellationConstructor = new () => NativeCancellationBinding;
type NativeParserConstructor = new (configuration: Uint8Array) => NativeParserBinding;

export type NativeFactories = {
  readonly parse: NativeParse;
  readonly createParser: (configuration: Uint8Array) => NativeParserBinding;
  readonly createStream: () => NativeStreamBinding;
  readonly createCancellation?: () => NativeCancellationBinding;
  readonly retain?: object;
  readonly release?: () => void;
};

type NativeLease = {
  references: number;
  readonly retain?: object;
  readonly release?: () => void;
};

export type NativeBinding = {
  readonly parse?: unknown;
  readonly NativeStream?: unknown;
  readonly NativeParser?: unknown;
  readonly NativeCancellation?: unknown;
};

export type NativeAsyncOperation = "parse" | "parseMany" | "repair" | "findJsonSpan";
export type NativeAsyncOutcome =
  | EngineParseOutcome
  | readonly EngineParseOutcome[]
  | EngineRepairOutcome
  | EngineSpanOutcome;

type HostProcess = {
  getBuiltinModule?(name: "module"): {
    createRequire(url: string): (specifier: string) => unknown;
  };
};

const hostProcess = (): HostProcess | undefined =>
  (globalThis as { process?: HostProcess }).process;

// A loaded binding passes startup checks once; each operation still owns its configured state.
const readyBindings = new WeakMap<object, boolean>();

const hostRequire = (): ((specifier: string) => unknown) | undefined => {
  const process = hostProcess();
  return process?.getBuiltinModule?.("module").createRequire(import.meta.url);
};

export type NativeEngineStream = {
  feed(input: Input): readonly EngineStreamItem[];
  feedSlice(input: Input, sourceOffset: number, finalSlice: boolean): readonly EngineStreamItem[];
  end(): readonly EngineStreamItem[];
  close(): void;
  snapshot?(): EngineSnapshotOutcome;
  summary?(): EngineStreamItem;
};

export type NativeEngineLoadFailure = {
  readonly kind: "native-engine-load-failed";
  readonly reason:
    | "target"
    | "permission"
    | "load"
    | "exports"
    | "abi"
    | "initialization"
    | "protocol"
    | "teardown";
  readonly cause?: unknown;
};

export class NativeEngine {
  private closed = false;
  private backgroundCapable = false;

  private constructor(
    private readonly call: NativeParse,
    private readonly createStreamBinding: () => NativeStreamBinding,
    private readonly createParser: (configuration: Uint8Array) => NativeParserBinding,
    private readonly createCancellation?: () => NativeCancellationBinding,
    private readonly configured?: NativeParserBinding,
    private readonly lease?: NativeLease,
    private readonly decodeContext: EngineDecodeContext = DEFAULT_ENGINE_DECODE_CONTEXT,
  ) {
    this.acquireLease();
  }

  private acquireLease(): void {
    if (this.lease !== undefined) this.lease.references++;
  }

  private releaseLease(): void {
    if (this.lease !== undefined && --this.lease.references === 0) this.lease.release?.();
  }

  static load(specifier: string): Result<NativeEngine, NativeEngineLoadFailure> {
    let loaded: NativeBinding;
    try {
      const require = hostRequire();
      if (require === undefined)
        return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load" } };
      loaded = require(specifier) as typeof loaded;
    } catch (cause) {
      return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load", cause } };
    }
    return NativeEngine.bind(loaded);
  }

  static bind(loaded: NativeBinding): Result<NativeEngine, NativeEngineLoadFailure> {
    if (
      typeof loaded.parse !== "function" ||
      typeof loaded.NativeStream !== "function" ||
      typeof loaded.NativeParser !== "function" ||
      typeof loaded.NativeCancellation !== "function"
    )
      return { ok: false, failure: { kind: "native-engine-load-failed", reason: "exports" } };
    const engine = new NativeEngine(
      loaded.parse as NativeParse,
      () => new (loaded.NativeStream as NativeStreamConstructor)(),
      (configuration) => new (loaded.NativeParser as NativeParserConstructor)(configuration),
      () => new (loaded.NativeCancellation as NativeCancellationConstructor)(),
    );
    const backgroundCapable = readyBindings.get(loaded);
    if (backgroundCapable !== undefined) {
      engine.backgroundCapable = backgroundCapable;
      return { ok: true, value: engine };
    }
    const ready = NativeEngine.ready(engine);
    if (ready.ok) readyBindings.set(loaded, engine.backgroundCapable);
    return ready;
  }

  static fromFactories(factories: NativeFactories): Result<NativeEngine, NativeEngineLoadFailure> {
    return NativeEngine.ready(
      new NativeEngine(
        factories.parse,
        factories.createStream,
        factories.createParser,
        factories.createCancellation,
        undefined,
        {
          references: 0,
          ...(factories.retain === undefined ? {} : { retain: factories.retain }),
          ...(factories.release === undefined ? {} : { release: factories.release }),
        },
      ),
    );
  }

  /** Reject a callable but incompatible library before it can consume caller input. */
  private static ready(engine: NativeEngine): Result<NativeEngine, NativeEngineLoadFailure> {
    const parsed = engine.startupParse('{"ready":true}');
    if (!parsed.ok) return rejectStartup(engine, parsed.failure);
    const options = resolveOptions();
    if ("kind" in options)
      return {
        ok: false,
        failure: { kind: "native-engine-load-failed", reason: "initialization" },
      };
    const configured = engine.configureResolved(options);
    engine.backgroundCapable = configured.ok && configured.value.supportsAsync();
    const configuredParsed = configured.ok
      ? configured.value.startupParse('{"ready":true}')
      : undefined;
    const stream = engine.createStream();
    const streamed = stream.ok ? stream.value.feed('{"ready":true} ') : [];
    if (stream.ok) stream.value.close();
    if (configured.ok) configured.value.close();
    const item = streamed[0];
    if (
      !parsed.value.ok ||
      !readyValue(parsed.value.value) ||
      !configured.ok ||
      configuredParsed?.ok !== true ||
      !configuredParsed.value.ok ||
      !readyValue(configuredParsed.value.value) ||
      !stream.ok ||
      streamed.length !== 1 ||
      item === undefined ||
      !("ok" in item) ||
      !item.ok ||
      !readyValue(item.value)
    ) {
      return rejectStartup(engine, {
        kind: "native-engine-load-failed",
        reason:
          configuredParsed?.ok === false && configuredParsed.failure.reason !== "initialization"
            ? configuredParsed.failure.reason
            : "initialization",
        ...(configuredParsed?.ok === false && configuredParsed.failure.cause !== undefined
          ? { cause: configuredParsed.failure.cause }
          : {}),
      });
    }
    return { ok: true, value: engine };
  }

  private startupParse(input: Input): Result<EngineParseOutcome, NativeEngineLoadFailure> {
    let response: Uint8Array;
    try {
      const value = this.call(encodeEngineRequest(input));
      if (!(value instanceof Uint8Array))
        return {
          ok: false,
          failure: { kind: "native-engine-load-failed", reason: "abi" },
        };
      response = value;
    } catch (cause) {
      return {
        ok: false,
        failure: { kind: "native-engine-load-failed", reason: "abi", cause },
      };
    }
    const outcome = decodeEngineResponse(response, this.decodeContext);
    return !outcome.ok && outcome.failure.kind === "engine-protocol-failed"
      ? {
          ok: false,
          failure: { kind: "native-engine-load-failed", reason: "protocol" },
        }
      : { ok: true, value: outcome };
  }

  configure(
    options?: ParserOptions,
  ): Result<NativeEngine, ConfigurationFailure | EngineBoundaryFailure> {
    const resolved = resolveOptions(options);
    if ("kind" in resolved) return { ok: false, failure: resolved };
    return this.configureResolved(resolved);
  }

  configureResolved(options: ResolvedOptions): Result<NativeEngine, EngineBoundaryFailure> {
    if (this.closed) return malformed();
    try {
      const parser = this.createParser(encodeEngineConfiguration(options));
      return {
        ok: true,
        value: new NativeEngine(
          (request) => parser.execute(request),
          this.createStreamBinding,
          this.createParser,
          this.createCancellation,
          parser,
          this.lease,
          { nullPrototype: options.nullPrototype, selected: options.select !== undefined },
        ),
      };
    } catch {
      return { ok: false, failure: malformed().failure };
    }
  }

  close(): boolean {
    if (this.closed) return true;
    this.closed = true;
    let closed = true;
    try {
      this.configured?.close?.();
    } catch {
      closed = false;
    }
    try {
      this.releaseLease();
    } catch {
      closed = false;
    }
    return closed;
  }

  /** Whether this configured route can execute away from the host event loop. */
  supportsAsync(): boolean {
    return (
      !this.closed &&
      typeof this.configured?.executeAsync === "function" &&
      this.createCancellation !== undefined
    );
  }

  /** Whether configuring this loaded route can produce a background executor. */
  supportsAsyncRoute(): boolean {
    return !this.closed && this.backgroundCapable;
  }

  async executeAsync(
    operation: "parseMany",
    input: Input,
    signal?: StopSignal,
  ): Promise<readonly EngineParseOutcome[]>;
  async executeAsync(
    operation: Exclude<NativeAsyncOperation, "parseMany">,
    input: Input,
    signal?: StopSignal,
  ): Promise<EngineParseOutcome | EngineRepairOutcome | EngineSpanOutcome>;
  async executeAsync(
    operation: NativeAsyncOperation,
    input: Input,
    signal?: StopSignal,
  ): Promise<NativeAsyncOutcome>;
  async executeAsync(
    operation: NativeAsyncOperation,
    input: Input,
    signal?: StopSignal,
  ): Promise<NativeAsyncOutcome> {
    const parser = this.configured;
    const createCancellation = this.createCancellation;
    if (this.closed || parser?.executeAsync === undefined || createCancellation === undefined)
      return malformed();
    if (signalAborted(signal)) return aborted(operation, signal?.reason);
    const cancellation = createCancellation();
    const stop = () => {
      cancellation.abort();
    };
    signal?.addEventListener?.("abort", stop, { once: true });
    if (signalAborted(signal)) stop();
    this.acquireLease();
    try {
      const response = await parser.executeAsync(
        encodeEngineRequest(input, operation),
        cancellation,
      );
      if (!(response instanceof Uint8Array)) return malformed();
      if (operation === "parseMany") return decodeEngineManyResponse(response, this.decodeContext);
      if (operation === "repair") return decodeEngineRepairResponse(response, this.decodeContext);
      if (operation === "findJsonSpan")
        return decodeEngineSpanResponse(response, this.decodeContext);
      return decodeEngineResponse(response, this.decodeContext);
    } catch {
      if (signalAborted(signal)) {
        return aborted(operation, signal?.reason);
      }
      return malformed();
    } finally {
      try {
        signal?.removeEventListener?.("abort", stop);
      } finally {
        try {
          cancellation.close?.();
        } finally {
          this.releaseLease();
        }
      }
    }
  }

  parse(input: Input): EngineParseOutcome {
    if (this.closed) return malformed();
    try {
      const response = this.call(encodeEngineRequest(input));
      return response instanceof Uint8Array
        ? decodeEngineResponse(response, this.decodeContext)
        : malformed();
    } catch {
      return malformed();
    }
  }

  parseMany(input: Input): readonly EngineParseOutcome[] {
    if (this.closed) return [malformed()];
    try {
      const response = this.call(encodeEngineRequest(input, "parseMany"));
      return response instanceof Uint8Array
        ? decodeEngineManyResponse(response, this.decodeContext)
        : [malformed()];
    } catch {
      return [malformed()];
    }
  }

  repair(input: Input): EngineRepairOutcome {
    if (this.closed) return malformed();
    try {
      const response = this.call(encodeEngineRequest(input, "repair"));
      return response instanceof Uint8Array
        ? decodeEngineRepairResponse(response, this.decodeContext)
        : malformed();
    } catch {
      return malformed();
    }
  }

  findJsonSpan(input: Input): EngineSpanOutcome {
    if (this.closed) return malformed();
    try {
      const response = this.call(encodeEngineRequest(input, "findJsonSpan"));
      return response instanceof Uint8Array
        ? decodeEngineSpanResponse(response, this.decodeContext)
        : malformed();
    } catch {
      return malformed();
    }
  }

  createStream(
    options?: EngineStreamOptions,
  ): Result<NativeEngineStream, ConfigurationFailure | EngineBoundaryFailure> {
    if (this.closed) return malformed();
    let binding: NativeStreamBinding;
    let owner: NativeParserBinding | undefined;
    if (this.configured === undefined && options?.fragments === true)
      return {
        ok: false,
        failure: { kind: "invalid-options", field: "fragments", reason: "requires-select" },
      };
    try {
      if (this.configured !== undefined)
        binding = this.configured.createStream(encodeEngineStreamOptions(options));
      else if (options === undefined) binding = this.createStreamBinding();
      else {
        const resolved = resolveOptions();
        if ("kind" in resolved) return { ok: false, failure: resolved };
        owner = this.createParser(encodeEngineConfiguration(resolved));
        binding = owner.createStream(encodeEngineStreamOptions(options));
      }
    } catch {
      owner?.close?.();
      return { ok: false, failure: malformed().failure };
    }
    this.acquireLease();
    const releaseLease = () => {
      this.releaseLease();
    };
    const decodeContext = this.decodeContext;
    let closed = false;
    const stream: NativeEngineStream = {
      feed(input) {
        try {
          return decodeEngineStreamResponse(binding.feed(encodeEngineChunk(input)), decodeContext);
        } catch {
          return [malformed()];
        }
      },
      feedSlice(input, _sourceOffset, finalSlice) {
        try {
          return decodeEngineStreamResponse(
            binding.feed(encodeEngineChunk(input, finalSlice)),
            decodeContext,
          );
        } catch {
          return [malformed()];
        }
      },
      end() {
        try {
          return decodeEngineStreamResponse(binding.end(), decodeContext);
        } catch {
          return [malformed()];
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          binding.close();
        } finally {
          try {
            owner?.close?.();
          } finally {
            releaseLease();
          }
        }
      },
    };
    if (options?.view !== undefined) {
      const snapshotView = engineSnapshotView(options.view);
      stream.snapshot = () => {
        try {
          return snapshotView(decodeEngineSnapshotResponse(binding.snapshot(), decodeContext));
        } catch {
          return malformed();
        }
      };
    }
    if (options?.summary === true) {
      stream.summary = () => decodeSummary(binding.summary());
    }
    return { ok: true, value: stream };
  }
}

const readyValue = (value: unknown): boolean =>
  typeof value === "object" && value !== null && Reflect.get(value, "ready") === true;

const rejectStartup = (
  engine: NativeEngine,
  failure: NativeEngineLoadFailure,
): Result<NativeEngine, NativeEngineLoadFailure> =>
  engine.close()
    ? { ok: false, failure }
    : {
        ok: false,
        failure: { kind: "native-engine-load-failed", reason: "teardown", cause: failure },
      };

const malformed = () => ({
  ok: false as const,
  failure: { kind: "engine-protocol-failed" as const, reason: "malformed-response" as const },
});

const aborted = (operation: NativeAsyncOperation, reason: unknown): NativeAsyncOutcome => {
  const outcome = { ok: false as const, failure: { kind: "aborted" as const, reason } };
  return operation === "parseMany" ? [outcome] : outcome;
};

const signalAborted = (signal?: StopSignal): boolean => signal?.aborted === true;

const decodeSummary = (bytes: Uint8Array): EngineStreamItem => {
  const items = decodeEngineStreamResponse(bytes);
  const item = items[0];
  return items.length === 1 && item !== undefined && "kind" in item && item.kind === "summary"
    ? item
    : malformed();
};
