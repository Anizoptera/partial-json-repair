// SPDX-License-Identifier: Apache-2.0

/** Load the shared native protocol through Bun's synchronous FFI boundary. */

import { encodeEngineConfiguration } from "./engine-configuration";
import { createFfiBinding } from "./ffi-binding";
import type { FfiSymbols } from "./ffi-binding";
import { FFI_SIGNATURES } from "./ffi-signatures";
import { NativeEngine } from "./native-engine";
import type { NativeEngineLoadFailure } from "./native-engine";
import { DEFAULT_OPTIONS } from "./options";
import type { Result } from "./types";

type BunPointer = bigint | number | null;
type BunLibrary = { readonly symbols: FfiSymbols<BunPointer>; close(): void };
type BunFfi = {
  dlopen(path: string | URL, definitions: Readonly<Record<string, BunForeignFunction>>): BunLibrary;
  toArrayBuffer(pointer: BunPointer, offset: number, length: number): ArrayBuffer;
};
type BunForeignFunction = {
  readonly args: readonly ("buffer" | "pointer" | "u8" | "usize")[];
  readonly returns: "pointer" | "u8" | "usize" | "void";
};

const definitions = Object.fromEntries(
  Object.entries(FFI_SIGNATURES).map(([name, signature]) => [
    name,
    { args: signature.parameters, returns: signature.result },
  ]),
);

const bunFfi = (): BunFfi | undefined =>
  (
    globalThis as {
      process?: { getBuiltinModule?(name: "bun:ffi"): BunFfi | undefined };
    }
  ).process?.getBuiltinModule?.("bun:ffi");

export const loadBunFfi = (path: string | URL): Result<NativeEngine, NativeEngineLoadFailure> => {
  const ffi = bunFfi();
  if (ffi === undefined)
    return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load" } };
  try {
    const library = ffi.dlopen(path, definitions);
    const memory = {
      copy(pointer: BunPointer, length: number): Uint8Array {
        return length === 0
          ? new Uint8Array()
          : new Uint8Array(ffi.toArrayBuffer(pointer, 0, length)).slice();
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
      ),
    );
  } catch (cause) {
    return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load", cause } };
  }
};
