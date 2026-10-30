// SPDX-License-Identifier: Apache-2.0

/** Bind one explicit WASM source to one validated parser configuration. */

import { resolveOptions } from "./options";
import type { ParserOptions } from "./options";
import { buildParser } from "./parser";
import type { Parser } from "./parser";
import { buildEngineBackend } from "./engine-backend";
import type { EngineBoundaryFailure } from "./types";
import type { ConfigurationFailure, Result } from "./types";
import { WasmEngine } from "./wasm-engine";
import type { WasmEngineLoadFailure } from "./wasm-engine";

export type WasmSource =
  | WebAssembly.Module
  | ArrayBuffer
  | ArrayBufferView<ArrayBuffer>
  | "bundled";

export type WasmParserFailure =
  | WasmEngineLoadFailure
  | ConfigurationFailure
  | EngineBoundaryFailure;

export async function initialize<O extends ParserOptions = Record<never, never>>(
  source: WasmSource,
  options: O | undefined,
  bundled: () => Promise<ArrayBuffer>,
): Promise<Result<Parser<O, EngineBoundaryFailure>, WasmParserFailure>> {
  let input: Exclude<WasmSource, "bundled">;
  if (source === "bundled") {
    try {
      input = await bundled();
    } catch (cause) {
      return {
        ok: false,
        failure: { kind: "wasm-engine-load-failed", reason: "compile", cause },
      };
    }
  } else input = source;
  const loaded = await WasmEngine.load(input);
  if (!loaded.ok) return loaded;
  let settings: ParserOptions = {};
  const resolved = resolveOptions(options, undefined, (captured) => {
    settings = captured;
  });
  if ("kind" in resolved) return { ok: false, failure: resolved };
  const configured = loaded.value.configureResolved(resolved);
  if (!configured.ok) return configured;
  return {
    ok: true,
    value: buildParser(resolved, settings, buildEngineBackend<O>(configured.value, resolved)),
  };
}
