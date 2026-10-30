// SPDX-License-Identifier: Apache-2.0

/** Load one portable WASM engine explicitly and bind its parser options once. */

import type { ParserOptions } from "./options";
import type { Parser } from "./parser";
import type { EngineBoundaryFailure } from "./types";
import type { Result } from "./types";
import { initialize } from "./wasm-init";
import type { WasmParserFailure, WasmSource } from "./wasm-init";

export type { WasmParserFailure, WasmSource } from "./wasm-init";

export function initParser<O extends ParserOptions = Record<never, never>>(
  source: WasmSource,
  options?: O,
): Promise<Result<Parser<O, EngineBoundaryFailure>, WasmParserFailure>> {
  return initialize(source, options, async () => {
    const response = await fetch(new URL("./partial_json_repair_wasm.wasm", import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    return response.arrayBuffer();
  });
}
