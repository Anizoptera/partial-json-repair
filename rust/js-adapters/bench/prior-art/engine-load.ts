// SPDX-License-Identifier: Apache-2.0

/** Load one measured engine route through the adapter named by the shared route table. */

import { readFileSync } from "node:fs";
import { loadBunFfi } from "../../src/bun-ffi";
import { loadDenoFfi } from "../../src/deno-ffi";
import { NativeEngine } from "../../src/native-engine";
import { loadNodeFfi } from "../../src/node-ffi";
import { WasmEngine } from "../../src/wasm-engine";
import type { EngineParseOutcome } from "../../src/engine-wire";
import type { ParserOptions } from "../../src/options";
import type { EngineMode } from "./engine-routes";

export interface MeasuredEngine {
  parse(input: string): EngineParseOutcome;
  parseMany(input: string): readonly EngineParseOutcome[];
  configure(options?: ParserOptions): unknown;
  createStream(): unknown;
}

type Loaded =
  | { readonly ok: false; readonly failure: { readonly reason: string } }
  | { readonly ok: true; readonly value: MeasuredEngine };

const LOADERS = {
  "bun-ffi": loadBunFfi,
  "deno-ffi": loadDenoFfi,
  napi: (artifact: string) => NativeEngine.load(artifact),
  "node-ffi": loadNodeFfi,
  wasm: (artifact: string) => WasmEngine.load(Uint8Array.from(readFileSync(artifact))),
} satisfies Record<EngineMode, (artifact: string) => Loaded | Promise<Loaded>>;

export const loadEngine = (mode: EngineMode, artifact: string): Loaded | Promise<Loaded> =>
  LOADERS[mode](artifact);
