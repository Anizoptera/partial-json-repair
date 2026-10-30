// SPDX-License-Identifier: Apache-2.0

/** Load the bundled WASM artifact from an installed Node package without network access. */

import { readFile } from "node:fs/promises";

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
    const bytes = await readFile(new URL("./partial_json_repair_wasm.wasm", import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });
}
