// SPDX-License-Identifier: Apache-2.0

/** Define each measured JavaScript engine crossing and the flags its host requires. */

export const ENGINE_MODES = ["bun-ffi", "deno-ffi", "napi", "node-ffi", "wasm"] as const;
export type EngineMode = (typeof ENGINE_MODES)[number];
export const ENGINE_HOSTS = ["bun", "deno", "node"] as const;
export type EngineHost = (typeof ENGINE_HOSTS)[number];

export interface EngineRoute {
  readonly flags?: readonly string[];
  readonly mode: EngineMode;
}

export const ENGINE_ROUTES: Readonly<Record<EngineHost, readonly EngineRoute[]>> = {
  bun: [{ mode: "bun-ffi" }, { mode: "napi" }, { mode: "wasm" }],
  deno: [
    { mode: "deno-ffi", flags: ["--allow-ffi"] },
    { mode: "napi", flags: ["--allow-ffi"] },
    { mode: "wasm" },
  ],
  node: [{ mode: "napi" }, { mode: "node-ffi", flags: ["--experimental-ffi"] }, { mode: "wasm" }],
};

export const engineHostOf = (label: string): EngineHost | undefined =>
  ENGINE_HOSTS.find((host) => label.startsWith(`${host} `));

export const engineModeOf = (value: string | undefined): EngineMode | undefined =>
  ENGINE_MODES.find((mode) => mode === value);
