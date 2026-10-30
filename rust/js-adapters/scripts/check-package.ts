#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/** Package the Rust crate and drive its shipped bytes from external consumers. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type CargoPackage = {
  readonly name: string;
  readonly version: string;
  readonly manifest_path: string;
};

const root = process.cwd();
const manifest = resolve("rust/crates/partial-json-repair/Cargo.toml");
const cargo = resolve("scripts/rust/cargo.ts");
const metadata = spawnSync(
  process.execPath,
  [cargo, "metadata", "--manifest-path", manifest, "--format-version", "1", "--no-deps"],
  { encoding: "utf8" },
);
if (metadata.status !== 0) throw new Error(metadata.stderr.trimEnd());
const packages = (JSON.parse(metadata.stdout) as { packages: readonly CargoPackage[] }).packages;
const product = packages.find((candidate) => candidate.manifest_path === manifest);
if (product === undefined)
  throw new Error("packed Rust check could not identify the product crate");

const packaged = spawnSync(
  process.execPath,
  [cargo, "package", "--manifest-path", manifest, "--allow-dirty", "--no-verify", "--offline"],
  { encoding: "utf8" },
);
if (packaged.status !== 0) throw new Error(packaged.stderr.trimEnd());

const crate = resolve("rust/target/package", `${product.name}-${product.version}.crate`);
if (!existsSync(crate)) throw new Error(`cargo package did not produce ${crate}`);
const temporary = mkdtempSync(join(tmpdir(), "partial-json-repair-rust-package-"));

const run = (args: readonly string[]): string | undefined => {
  const result = spawnSync(process.execPath, [cargo, ...args], {
    cwd: temporary,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: resolve(root, "rust/target/package-consumers") },
  });
  return result.status === 0 ? undefined : `${args.join(" ")}\n${result.stderr.trimEnd()}`;
};
const file = (relative: string, contents: string): void => {
  const target = join(temporary, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

try {
  const extracted = spawnSync("tar", ["-xzf", crate, "-C", temporary], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr.trimEnd());
  symlinkSync(resolve(root, "rust-toolchain.toml"), join(temporary, "rust-toolchain.toml"));
  const dependency = JSON.stringify(join(temporary, `${product.name}-${product.version}`));
  writeFileSync(
    join(temporary, "Cargo.toml"),
    `[workspace]\nresolver = "3"\nmembers = ["core", "nostd", "serde", "async"]\n`,
  );

  file(
    "core/Cargo.toml",
    `[package]\nname = "consumer-core"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\npartial-json-repair = { path = ${dependency} }\n`,
  );
  file(
    "core/src/lib.rs",
    String.raw`#[test]
fn recovers() {
    let value = partial_json_repair::parse("{a:1}").expect("recovered");
    assert_eq!(partial_json_repair::canonical_of(&value.value), "{\"a\":1}");
}
`,
  );

  file(
    "nostd/Cargo.toml",
    `[package]\nname = "consumer-nostd"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\npartial-json-repair = { path = ${dependency}, default-features = false }\n`,
  );
  file(
    "nostd/src/lib.rs",
    `#![no_std]\nextern crate alloc;\npub fn recovers() -> bool { partial_json_repair::parse("[]").is_ok() }\n`,
  );

  file(
    "serde/Cargo.toml",
    `[package]\nname = "consumer-serde"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\npartial-json-repair = { path = ${dependency}, features = ["serde"] }\nserde = { version = "1", features = ["derive"] }\n`,
  );
  file(
    "serde/src/lib.rs",
    `use serde::Deserialize;\n#[derive(Deserialize)]\nstruct Row { id: u64 }\n#[test]\nfn converts_exactly() {\n    let value = partial_json_repair::parse("{id:9007199254740993}").expect("recovered");\n    let row: Row = value.value.deserialize().expect("converted exactly");\n    assert_eq!(row.id, 9_007_199_254_740_993);\n}\n`,
  );

  file(
    "async/Cargo.toml",
    `[package]\nname = "consumer-async"\nversion = "0.0.0"\nedition = "2024"\n[dependencies]\npartial-json-repair = { path = ${dependency}, features = ["async"] }\nfutures-core = { version = "0.3", default-features = false }\n`,
  );
  file(
    "async/src/lib.rs",
    `use core::pin::Pin;\nuse core::task::{Context, Poll};\nuse futures_core::Stream;\nstruct Empty;\nimpl Stream for Empty {\n    type Item = Result<&'static str, ()>;\n    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> { Poll::Ready(None) }\n}\npub fn builds() { let _stream = partial_json_repair::parse_stream_async(Empty); }\n`,
  );

  const failures = [run(["test", "-q", "--workspace", "--offline"])].filter(
    (failure): failure is string => failure !== undefined,
  );
  if (failures.length > 0) throw new Error(failures.join("\n---\n"));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("packed Rust crate: core, no_std, Serde and async consumers passed");
