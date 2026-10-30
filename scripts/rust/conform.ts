#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Replays the corpus the Rust crate last met against it, not the corpus the TypeScript package
 * records today.
 *
 * The npm release ships TypeScript only (HLD "Native and WASM (deferred)"), and TypeScript efficiency
 * comes before Rust portability, so the TypeScript corpus is free to move ahead. A Rust check that
 * read the live contract would turn every TypeScript behaviour change into a red Rust
 * lane, which forces either a Rust rewrite inside unrelated work or deleting the lane. Pinning keeps
 * the lane meaningful: it proves Rust still meets the contract it last met, and the live corpus is
 * the contract a later Rust catch-up must meet.
 *
 * The pinned corpus is a file, not a commit to `git show`: the public repository is published as one
 * squashed commit, so no older commit exists there to read it from. Replace the file (gzip -9 -n of the
 * output of `bun scripts/corpus/record.ts --out <file>`) only in the commit where Rust catches up to the live corpus; that commit's
 * diff of this file is the record of the catch-up.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** The last contract the Rust crate fully met. */
const PINNED = "rust/crates/conformance/pinned-contract.jsonl.gz";

const dir = mkdtempSync(join(tmpdir(), "pjr-rust-conform-"));
try {
  const path = join(dir, "contract.jsonl");
  writeFileSync(path, gunzipSync(readFileSync(PINNED)));
  const run = spawnSync(
    "bun",
    [
      "scripts/rust/cargo.ts",
      "run",
      "--release",
      "--manifest-path",
      "rust/Cargo.toml",
      "-p",
      "conformance",
      "--",
      path,
    ],
    { stdio: "inherit" },
  );
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
