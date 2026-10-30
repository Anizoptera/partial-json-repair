#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/** Run the repository-pinned rustup toolchain with reproducible artifact source paths. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const executable = process.platform === "win32" ? "rustup.exe" : "rustup";
const standardCargoHome = join(homedir(), ".cargo");
const standardRustup = join(standardCargoHome, "bin", executable);
const cargoHome = existsSync(standardRustup)
  ? standardCargoHome
  : (process.env.CARGO_HOME ?? standardCargoHome);
const rustupHome = existsSync(standardRustup)
  ? join(homedir(), ".rustup")
  : process.env.RUSTUP_HOME;
const rustup = existsSync(standardRustup) ? standardRustup : join(cargoHome, "bin", executable);
const environment: NodeJS.ProcessEnv = { ...process.env, CARGO_HOME: cargoHome };
if (rustupHome === undefined) delete environment.RUSTUP_HOME;
else environment.RUSTUP_HOME = rustupHome;
environment.PATH = [join(cargoHome, "bin"), process.env.PATH].filter(Boolean).join(delimiter);
delete environment.RUSTUP_TOOLCHAIN;

const active = spawnSync(rustup, ["show", "active-toolchain"], {
  encoding: "utf8",
  env: environment,
});
const toolchain = active.stdout.trim().split(/\s/u, 1)[0];
if (active.status !== 0 || toolchain === undefined || toolchain === "")
  throw new Error(active.stderr.trim() || "rustup could not resolve the repository toolchain");
environment.RUSTUP_TOOLCHAIN = toolchain;

const which = (tool: "cargo" | "rustc"): string => {
  const result = spawnSync(rustup, ["which", "--toolchain", toolchain, tool], {
    encoding: "utf8",
    env: environment,
  });
  const resolved = result.stdout.trim();
  if (result.status !== 0 || resolved === "")
    throw new Error(result.stderr.trim() || `rustup could not resolve ${tool}`);
  return resolved;
};

const cargo = which("cargo");
const rustc = which("rustc");

const inherited = process.env.RUSTFLAGS?.trim();
const remaps = [
  `--remap-path-prefix=${homedir()}=/build`,
  `--remap-path-prefix=${process.cwd()}=/source`,
];
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex < 0 ? undefined : process.argv[targetIndex + 1];
if (target?.endsWith("-musl") === true) remaps.push("-C", "target-feature=-crt-static");
const result = spawnSync(cargo, process.argv.slice(2), {
  env: {
    ...environment,
    RUSTC: rustc,
    RUSTFLAGS: inherited === undefined ? remaps.join(" ") : `${inherited} ${remaps.join(" ")}`,
  },
  stdio: "inherit",
});

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
