#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/** Build the current TypeScript package target around exactly one native library file. */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NATIVE_TARGETS, nativeTargetsForHost } from "../../src/native-targets";

type Manifest = {
  readonly license: string;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly version: string;
};

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
const report = process.report.getReport() as {
  readonly header?: { readonly glibcVersionRuntime?: string };
};
const glibc = report.header?.glibcVersionRuntime;
const host = nativeTargetsForHost(
  process.platform,
  process.arch,
  process.platform === "linux" ? glibc !== undefined && glibc !== "" : undefined,
)[0];
const selected =
  process.argv[3] === undefined
    ? host
    : NATIVE_TARGETS.find((candidate) => candidate.id === process.argv[3]);
if (selected === undefined)
  throw new Error(`unsupported native target: ${process.argv[3] ?? "host"}`);
const explicitTarget = process.argv[3] !== undefined;
const declared = Object.keys(manifest.optionalDependencies).filter((name) =>
  name.startsWith("partial-json-repair-native-"),
);
if (declared.length !== NATIVE_TARGETS.length)
  throw new Error("optionalDependencies must contain exactly the defined native targets");
for (const candidate of NATIVE_TARGETS) {
  if (manifest.optionalDependencies[candidate.package] === manifest.version) continue;
  throw new Error(
    `${candidate.package} must be declared at version ${manifest.version} in optionalDependencies`,
  );
}

const stem = "partial_json_repair_native";
const source = resolve(
  process.env.CARGO_TARGET_DIR ?? "rust/target",
  explicitTarget || selected !== host ? selected.rust : "",
  "release",
  selected.library === "dll" ? `${stem}.dll` : `lib${stem}.${selected.library}`,
);
const destination = resolve(process.argv[2] ?? "rust/target/native-package");
const packageRoot = resolve(destination, selected.package);
const library = "partial-json-repair.node";
rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });
copyFileSync(source, resolve(packageRoot, library));
copyFileSync("LICENSE", resolve(packageRoot, "LICENSE"));

const targetManifest = {
  name: selected.package,
  version: manifest.version,
  license: manifest.license,
  os: [selected.os],
  cpu: [selected.cpu],
  ...(selected.libc === undefined ? {} : { libc: [selected.libc] }),
  files: [library, "LICENSE"],
  exports: `./${library}`,
};
writeFileSync(resolve(packageRoot, "package.json"), `${JSON.stringify(targetManifest, null, 2)}\n`);

const packed = Bun.spawnSync({
  cmd: [
    process.execPath,
    "pm",
    "pack",
    "--destination",
    destination,
    "--ignore-scripts",
    "--quiet",
  ],
  cwd: packageRoot,
  stdout: "pipe",
  stderr: "pipe",
});
if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
console.log(resolve(destination, `${selected.package}-${manifest.version}.tgz`));
