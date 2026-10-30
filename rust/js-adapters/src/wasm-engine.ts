// SPDX-License-Identifier: Apache-2.0

/** Own one validated portable WASM instance and every request buffer crossing into it. */

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

type Unary = (value: number) => number;
type Binary = (left: number, right: number) => number;
type WasmExports = {
  readonly memory: WebAssembly.Memory;
  readonly allocate: Unary;
  readonly pointer: Unary;
  readonly length: Unary;
  readonly parse: Unary;
  readonly parserCreate: Unary;
  readonly parserExecute: Binary;
  readonly parserStreamCreate: Binary;
  readonly parserRelease: Unary;
  readonly release: Unary;
  readonly streamCreate: () => number;
  readonly streamFeed: Binary;
  readonly streamEnd: Binary;
  readonly streamSnapshot: Binary;
  readonly streamSummary: Binary;
  readonly streamRelease: Unary;
};

export type WasmEngineLoadFailure = {
  readonly kind: "wasm-engine-load-failed";
  readonly reason: "compile" | "imports" | "exports" | "instantiate";
  readonly cause?: unknown;
};

export type WasmEngineStream = {
  feed(input: Input): readonly EngineStreamItem[];
  feedSlice(input: Input, sourceOffset: number, finalSlice: boolean): readonly EngineStreamItem[];
  end(): readonly EngineStreamItem[];
  close(): boolean;
  snapshot?(): EngineSnapshotOutcome;
  summary?(): EngineStreamItem;
};

export class WasmEngine {
  private constructor(
    private readonly exports: WasmExports,
    private readonly parser?: number,
    private readonly decodeContext: EngineDecodeContext = DEFAULT_ENGINE_DECODE_CONTEXT,
  ) {}

  static async load(
    source: WebAssembly.Module | ArrayBuffer | ArrayBufferView<ArrayBuffer>,
  ): Promise<Result<WasmEngine, WasmEngineLoadFailure>> {
    let module: WebAssembly.Module;
    try {
      const bytes =
        source instanceof WebAssembly.Module
          ? undefined
          : ArrayBuffer.isView(source)
            ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
            : source;
      module = bytes === undefined ? source : await WebAssembly.compile(bytes);
    } catch (cause) {
      return { ok: false, failure: { kind: "wasm-engine-load-failed", reason: "compile", cause } };
    }
    if (WebAssembly.Module.imports(module).length > 0)
      return { ok: false, failure: { kind: "wasm-engine-load-failed", reason: "imports" } };
    let instance: WebAssembly.Instance;
    try {
      instance = await WebAssembly.instantiate(module);
    } catch (cause) {
      return {
        ok: false,
        failure: { kind: "wasm-engine-load-failed", reason: "instantiate", cause },
      };
    }
    const exports = readExports(instance.exports);
    return exports === undefined
      ? { ok: false, failure: { kind: "wasm-engine-load-failed", reason: "exports" } }
      : { ok: true, value: new WasmEngine(exports) };
  }

  configure(
    options?: ParserOptions,
  ): Result<WasmEngine, ConfigurationFailure | EngineBoundaryFailure> {
    const resolved = resolveOptions(options);
    if ("kind" in resolved) return { ok: false, failure: resolved };
    return this.configureResolved(resolved);
  }

  configureResolved(options: ResolvedOptions): Result<WasmEngine, EngineBoundaryFailure> {
    const handle = this.withRequest(encodeEngineConfiguration(options), (buffer) =>
      this.exports.parserCreate(buffer),
    );
    return handle === 0
      ? { ok: false, failure: malformed().failure }
      : {
          ok: true,
          value: new WasmEngine(this.exports, handle, {
            nullPrototype: options.nullPrototype,
            selected: options.select !== undefined,
          }),
        };
  }

  close(): boolean {
    if (this.parser === undefined) return true;
    try {
      return this.exports.parserRelease(this.parser) === 1;
    } catch {
      return false;
    }
  }

  parse(input: Input): EngineParseOutcome {
    return this.call<EngineParseOutcome>(
      encodeEngineRequest(input),
      (bytes) => decodeEngineResponse(bytes, this.decodeContext),
      malformed(),
    );
  }

  parseMany(input: Input): readonly EngineParseOutcome[] {
    return this.call<readonly EngineParseOutcome[]>(
      encodeEngineRequest(input, "parseMany"),
      (bytes) => decodeEngineManyResponse(bytes, this.decodeContext),
      [malformed()],
    );
  }

  repair(input: Input): EngineRepairOutcome {
    return this.call<EngineRepairOutcome>(
      encodeEngineRequest(input, "repair"),
      (bytes) => decodeEngineRepairResponse(bytes, this.decodeContext),
      malformed(),
    );
  }

  findJsonSpan(input: Input): EngineSpanOutcome {
    return this.call<EngineSpanOutcome>(
      encodeEngineRequest(input, "findJsonSpan"),
      (bytes) => decodeEngineSpanResponse(bytes, this.decodeContext),
      malformed(),
    );
  }

  createStream(
    options?: EngineStreamOptions,
  ): Result<WasmEngineStream, ConfigurationFailure | EngineBoundaryFailure> {
    if (this.parser === undefined && options?.fragments === true)
      return {
        ok: false,
        failure: { kind: "invalid-options", field: "fragments", reason: "requires-select" },
      };
    if (this.parser === undefined && options !== undefined) {
      const configured = this.configure();
      if (!configured.ok) return configured;
      const stream = configured.value.createStream(options);
      configured.value.close();
      return stream;
    }
    try {
      const handle =
        this.parser === undefined
          ? this.exports.streamCreate()
          : this.exports.parserStreamCreate(this.parser, encodeEngineStreamOptions(options));
      return handle === 0
        ? { ok: false, failure: malformed().failure }
        : { ok: true, value: this.wrapStream(handle, options) };
    } catch {
      return { ok: false, failure: malformed().failure };
    }
  }

  streamFeed(handle: number, input: Input, finalSlice = true): readonly EngineStreamItem[] {
    return this.streamCall(handle, encodeEngineChunk(input, finalSlice), this.exports.streamFeed);
  }

  streamEnd(handle: number): readonly EngineStreamItem[] {
    return this.streamCall(handle, new Uint8Array(), this.exports.streamEnd);
  }

  streamRelease(handle: number): boolean {
    try {
      return this.exports.streamRelease(handle) === 1;
    } catch {
      return false;
    }
  }

  streamSnapshot(handle: number): EngineSnapshotOutcome {
    return this.call(
      new Uint8Array(),
      (bytes) => decodeEngineSnapshotResponse(bytes, this.decodeContext),
      malformed(),
      (buffer) => this.exports.streamSnapshot(handle, buffer),
    );
  }

  streamSummary(handle: number): EngineStreamItem {
    const items = this.streamCall(handle, new Uint8Array(), this.exports.streamSummary);
    const item = items[0];
    return items.length === 1 && item !== undefined && "kind" in item && item.kind === "summary"
      ? item
      : malformed();
  }

  private call<T>(
    request: Uint8Array,
    decode: (bytes: Uint8Array) => T,
    failed: T,
    operation?: Unary,
  ): T {
    const parser = this.parser;
    const execute =
      operation ??
      (parser === undefined
        ? this.exports.parse
        : (buffer: number) => this.exports.parserExecute(parser, buffer));
    let handle = 0;
    try {
      handle = this.exports.allocate(request.byteLength);
    } catch {
      return failed;
    }
    if (handle === 0) return failed;
    let outcome = failed;
    try {
      outcome = this.execute(handle, request, decode, failed, execute);
    } catch {
      // Host traps are engine failures; the request handle still reaches the release below.
    }
    try {
      return this.exports.release(handle) === 1 ? outcome : failed;
    } catch {
      return failed;
    }
  }

  private withRequest(request: Uint8Array, use: (handle: number) => number): number {
    let buffer = 0;
    let outcome = 0;
    try {
      buffer = this.exports.allocate(request.byteLength);
      const target = this.view(buffer);
      if (target !== undefined && target.byteLength === request.byteLength) {
        target.set(request);
        outcome = use(buffer);
      }
    } catch {
      return 0;
    }
    try {
      return this.exports.release(buffer) === 1 ? outcome : 0;
    } catch {
      return 0;
    }
  }

  private execute<T>(
    handle: number,
    request: Uint8Array,
    decode: (bytes: Uint8Array) => T,
    failed: T,
    operation: Unary,
  ): T {
    const target = this.view(handle);
    if (target === undefined || target.byteLength !== request.byteLength) return failed;
    target.set(request);
    if (operation(handle) !== 1) return failed;
    const response = this.view(handle);
    return response === undefined ? failed : decode(response);
  }

  private streamCall(
    stream: number,
    request: Uint8Array,
    operation: Binary,
  ): readonly EngineStreamItem[] {
    return this.call(
      request,
      (bytes) => decodeEngineStreamResponse(bytes, this.decodeContext),
      [malformed()],
      (buffer) => operation(stream, buffer),
    );
  }

  private wrapStream(handle: number, options?: EngineStreamOptions): WasmEngineStream {
    let open = true;
    const stream: WasmEngineStream = {
      feed: (input) => (open ? this.streamFeed(handle, input) : [malformed()]),
      feedSlice: (input, _sourceOffset, finalSlice) =>
        open ? this.streamFeed(handle, input, finalSlice) : [malformed()],
      end: () => (open ? this.streamEnd(handle) : [malformed()]),
      close: () => {
        if (!open) return false;
        open = false;
        return this.streamRelease(handle);
      },
    };
    if (options?.view !== undefined) {
      const snapshotView = engineSnapshotView(options.view);
      stream.snapshot = () => snapshotView(this.streamSnapshot(handle));
    }
    if (options?.summary === true) stream.summary = () => this.streamSummary(handle);
    return stream;
  }

  private view(handle: number): Uint8Array | undefined {
    const pointer = this.exports.pointer(handle);
    const length = this.exports.length(handle);
    const end = pointer + length;
    if (!Number.isSafeInteger(end) || pointer === 0 || end > this.exports.memory.buffer.byteLength)
      return undefined;
    return new Uint8Array(this.exports.memory.buffer, pointer, length);
  }
}

const readExports = (values: WebAssembly.Instance["exports"]): WasmExports | undefined => {
  const memory = values["memory"];
  if (!(memory instanceof WebAssembly.Memory)) return undefined;
  const names = [
    "pjr_allocate",
    "pjr_pointer",
    "pjr_length",
    "pjr_parse",
    "pjr_parser_create",
    "pjr_parser_execute",
    "pjr_parser_stream_create",
    "pjr_parser_release",
    "pjr_release",
    "pjr_stream_create",
    "pjr_stream_feed",
    "pjr_stream_end",
    "pjr_stream_snapshot",
    "pjr_stream_summary",
    "pjr_stream_release",
  ] as const;
  const functions = names.map((name) => values[name]);
  if (functions.some((value) => typeof value !== "function")) return undefined;
  return {
    memory,
    allocate: functions[0] as Unary,
    pointer: functions[1] as Unary,
    length: functions[2] as Unary,
    parse: functions[3] as Unary,
    parserCreate: functions[4] as Unary,
    parserExecute: functions[5] as Binary,
    parserStreamCreate: functions[6] as Binary,
    parserRelease: functions[7] as Unary,
    release: functions[8] as Unary,
    streamCreate: functions[9] as () => number,
    streamFeed: functions[10] as Binary,
    streamEnd: functions[11] as Binary,
    streamSnapshot: functions[12] as Binary,
    streamSummary: functions[13] as Binary,
    streamRelease: functions[14] as Unary,
  };
};

const malformed = () => ({
  ok: false as const,
  failure: { kind: "engine-protocol-failed" as const, reason: "malformed-response" as const },
});
