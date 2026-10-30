// SPDX-License-Identifier: Apache-2.0

/** Build complete native/WASM routes once and add them to each eligible JavaScript runtime row. */

import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Runner } from "./baseline.ts";
import { ENGINE_ROUTES, engineHostOf } from "./engine-routes";
import type { EngineRoute } from "./engine-routes";

const cargo = (...args: string[]): void => {
  const result = spawnSync(process.execPath, ["scripts/rust/cargo.ts", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr.slice(-800));
};

export interface EngineArtifacts {
  readonly native: string;
  readonly wasm: string;
}

export const buildEngineArtifacts = (): EngineArtifacts => {
  const packageBuild = spawnSync(process.execPath, ["run", "build"], { encoding: "utf8" });
  if (packageBuild.status !== 0) throw new Error(packageBuild.stderr.slice(-800));
  cargo(
    "build",
    "--release",
    "--manifest-path",
    "rust/Cargo.toml",
    "-p",
    "partial-json-repair-native",
  );
  const target = resolve("rust/target/release");
  const stem = "partial_json_repair_native";
  const library =
    process.platform === "win32"
      ? resolve(target, `${stem}.dll`)
      : resolve(target, `lib${stem}.${process.platform === "darwin" ? "dylib" : "so"}`);
  const native = resolve(target, "partial-json-repair-native.node");
  copyFileSync(library, native);
  const wasm = resolve("rust/target/wasm32-unknown-unknown/release/partial_json_repair_wasm.wasm");

  return { native, wasm };
};

const buildRunner = async (): Promise<string> => {
  const target = resolve("rust/target/release");
  const runner = resolve(target, "engine-runner.js");
  const built = await Bun.build({
    entrypoints: ["bench/prior-art/engine-runner.ts"],
    target: "node",
    format: "esm",
    outdir: target,
    naming: "engine-runner.js",
  });
  if (!built.success) throw new Error("engine benchmark runner bundle failed");

  return runner;
};

export const availableEngineRoutes = (runtime: Runner): readonly EngineRoute[] => {
  const host = engineHostOf(runtime.expect);
  if (host === undefined) return [];
  if (host !== "node") return ENGINE_ROUTES[host];
  const prefix = runtime.argv.slice(0, -1);
  const supported = spawnSync(prefix[0] ?? "", [
    ...prefix.slice(1),
    "--experimental-ffi",
    "-e",
    'process.exit(process.getBuiltinModule?.("node:ffi") ? 0 : 1)',
  ]);
  return ENGINE_ROUTES.node.filter((route) => route.mode !== "node-ffi" || supported.status === 0);
};

export const engineCommand = (
  runtime: Runner,
  route: EngineRoute,
  runner: string,
  artifacts: EngineArtifacts,
  ...args: readonly string[]
): readonly string[] => [
  ...runtime.argv.slice(0, -1),
  ...(route.flags ?? []),
  runner,
  ...args,
  route.mode,
  route.mode === "wasm" ? artifacts.wasm : artifacts.native,
];

export const engineRunners = async (
  runtimes: readonly Runner[],
  input: string,
): Promise<Runner[]> => {
  const { native, wasm } = buildEngineArtifacts();
  const runner = await buildRunner();

  const added: Runner[] = [];
  for (const runtime of runtimes) {
    const host = engineHostOf(runtime.expect);
    if (host === undefined) continue;
    for (const route of availableEngineRoutes(runtime)) {
      added.push({
        argv: engineCommand(runtime, route, runner, { native, wasm }),
        expect: `${runtime.expect} ${route.mode}`,
        reference: "JSON.parse",
        required: `partial-json-repair/${route.mode}`,
        input,
      });
    }
  }
  return added;
};
