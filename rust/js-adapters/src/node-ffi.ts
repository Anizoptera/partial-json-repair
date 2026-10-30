// SPDX-License-Identifier: Apache-2.0

/** Load the shared native protocol through flag-enabled Node FFI. */

import { encodeEngineConfiguration } from "./engine-configuration";
import { createFfiBinding } from "./ffi-binding";
import type { FfiSymbols } from "./ffi-binding";
import { FFI_SIGNATURES } from "./ffi-signatures";
import { NativeEngine } from "./native-engine";
import type { NativeEngineLoadFailure } from "./native-engine";
import { DEFAULT_OPTIONS } from "./options";
import type { Result } from "./types";

type NodeLibrary = { readonly functions: FfiSymbols<bigint, bigint>; readonly lib: object };
type NodeFfi = {
  dlopen(path: string, definitions: Readonly<Record<string, NodeForeignFunction>>): NodeLibrary;
  toArrayBuffer(pointer: bigint, length: number, copy?: boolean): ArrayBuffer;
};
type NodeForeignFunction = {
  readonly arguments: readonly ("buffer" | "pointer" | "u8" | "u64")[];
  readonly return: "pointer" | "u8" | "u64" | "void";
};

const definitions = Object.fromEntries(
  Object.entries(FFI_SIGNATURES).map(([name, signature]) => [
    name,
    {
      arguments: signature.parameters.map((parameter) =>
        parameter === "usize" ? "u64" : parameter,
      ),
      return: nodeType(signature.result),
    },
  ]),
);

function nodeType(type: "pointer" | "u8" | "usize" | "void"): "pointer" | "u8" | "u64" | "void" {
  return type === "usize" ? "u64" : type;
}

const nodeFfi = (): NodeFfi | undefined =>
  (
    globalThis as {
      process?: { getBuiltinModule?(name: "node:ffi"): NodeFfi | undefined };
    }
  ).process?.getBuiltinModule?.("node:ffi");

export const loadNodeFfi = (path: string): Result<NativeEngine, NativeEngineLoadFailure> => {
  const ffi = nodeFfi();
  if (ffi === undefined)
    return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load" } };
  try {
    const library = ffi.dlopen(path, definitions);
    return NativeEngine.fromFactories(
      createFfiBinding(
        library.functions,
        { copy: (pointer, length) => new Uint8Array(ffi.toArrayBuffer(pointer, length)) },
        BigInt,
        encodeEngineConfiguration(DEFAULT_OPTIONS),
        library.lib,
      ),
    );
  } catch (cause) {
    return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load", cause } };
  }
};
