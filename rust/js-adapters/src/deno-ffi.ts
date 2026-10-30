// SPDX-License-Identifier: Apache-2.0

/** Load the native byte protocol through latest Deno's permissioned FFI API. */

import { encodeEngineConfiguration } from "./engine-configuration";
import { createFfiBinding } from "./ffi-binding";
import { FFI_SIGNATURES } from "./ffi-signatures";
import { NativeEngine } from "./native-engine";
import type { NativeEngineLoadFailure } from "./native-engine";
import { DEFAULT_OPTIONS } from "./options";
import type { Result } from "./types";

type DenoPointer = object | null;
type DenoSymbols = {
  readonly pjr_ffi_parse: (bytes: Uint8Array, length: number) => DenoPointer;
  readonly pjr_ffi_parser_create: (bytes: Uint8Array, length: number) => DenoPointer;
  readonly pjr_ffi_parser_execute: (
    parser: DenoPointer,
    bytes: Uint8Array,
    length: number,
  ) => DenoPointer;
  readonly pjr_ffi_parser_execute_controlled: (
    parser: DenoPointer,
    bytes: Uint8Array,
    length: number,
    cancellation: DenoPointer,
  ) => Promise<DenoPointer>;
  readonly pjr_ffi_parser_execute_async: (
    parser: DenoPointer,
    bytes: Uint8Array,
    length: number,
    cancellation: DenoPointer,
    completion: DenoPointer,
  ) => number;
  readonly pjr_ffi_parser_release: (parser: DenoPointer) => void;
  readonly pjr_ffi_cancellation_create: () => DenoPointer;
  readonly pjr_ffi_cancellation_abort: (cancellation: DenoPointer) => void;
  readonly pjr_ffi_cancellation_release: (cancellation: DenoPointer) => void;
  readonly pjr_ffi_stream_create: (parser: DenoPointer, mode: number) => DenoPointer;
  readonly pjr_ffi_stream_feed: (
    stream: DenoPointer,
    bytes: Uint8Array,
    length: number,
  ) => DenoPointer;
  readonly pjr_ffi_stream_end: (stream: DenoPointer) => DenoPointer;
  readonly pjr_ffi_stream_snapshot: (stream: DenoPointer) => DenoPointer;
  readonly pjr_ffi_stream_summary: (stream: DenoPointer) => DenoPointer;
  readonly pjr_ffi_stream_release: (stream: DenoPointer) => void;
  readonly pjr_ffi_response_pointer: (response: DenoPointer) => DenoPointer;
  readonly pjr_ffi_response_length: (response: DenoPointer) => bigint;
  readonly pjr_ffi_response_release: (response: DenoPointer) => void;
};

type DenoFfi = {
  readonly permissions: {
    querySync(descriptor: { readonly name: "ffi"; readonly path: string | URL }): {
      readonly state: string;
    };
  };
  dlopen(path: string | URL, definitions: typeof FFI_SIGNATURES): DenoLibrary;
  readonly UnsafePointerView: new (pointer: object) => {
    copyInto(destination: Uint8Array): void;
  };
};

type DenoLibrary = {
  readonly symbols: DenoSymbols;
  close(): void;
};

const definitions = {
  ...FFI_SIGNATURES,
  pjr_ffi_parser_execute_controlled: {
    ...FFI_SIGNATURES.pjr_ffi_parser_execute_controlled,
    nonblocking: true,
  },
} as const;

const denoFfi = (): DenoFfi | undefined => (globalThis as { readonly Deno?: DenoFfi }).Deno;

export const loadDenoFfi = (path: string | URL): Result<NativeEngine, NativeEngineLoadFailure> => {
  const deno = denoFfi();
  if (deno === undefined)
    return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load" } };
  if (deno.permissions.querySync({ name: "ffi", path }).state !== "granted")
    return { ok: false, failure: { kind: "native-engine-load-failed", reason: "permission" } };
  try {
    const library = deno.dlopen(path, definitions);
    const memory = {
      copy(pointer: DenoPointer, length: number): Uint8Array {
        if (length === 0) return new Uint8Array();
        if (typeof pointer !== "object" || pointer === null)
          throw new Error("Deno FFI returned an invalid pointer");
        const bytes = new Uint8Array(length);
        new deno.UnsafePointerView(pointer).copyInto(bytes);
        return bytes;
      },
    };
    return NativeEngine.fromFactories(
      createFfiBinding(
        library.symbols,
        memory,
        (length) => length,
        encodeEngineConfiguration(DEFAULT_OPTIONS),
        library,
        () => {
          library.close();
        },
        (parser, bytes, length, cancellation) =>
          library.symbols.pjr_ffi_parser_execute_controlled(parser, bytes, length, cancellation),
      ),
    );
  } catch (cause) {
    return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load", cause } };
  }
};
