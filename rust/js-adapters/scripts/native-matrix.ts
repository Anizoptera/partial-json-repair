#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/** Run one native target on its host or reconcile the records from the complete target matrix. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NATIVE_TARGETS } from "../../src/native-targets";

type MatrixRecord = {
  readonly routes: readonly string[];
  readonly schema: 1;
  readonly target: string;
};

const fail = (message: string): never => {
  throw new Error(message);
};

const hostLibc = (): "glibc" | "musl" | undefined => {
  if (process.platform !== "linux") return undefined;
  const report = process.report.getReport() as {
    readonly header?: { readonly glibcVersionRuntime?: string };
  };
  if (report.header?.glibcVersionRuntime !== undefined) return "glibc";
  const result = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  if (/musl/iu.test(output)) return "musl";
  if (/glibc|GNU C Library/iu.test(output)) return "glibc";
  return fail("could not identify the Linux host libc");
};

const run = (cmd: readonly string[], env: NodeJS.ProcessEnv = process.env): void => {
  const result = Bun.spawnSync([...cmd], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) fail(`${cmd[0] ?? "command"} exited ${String(result.exitCode)}`);
};

const mode = process.argv[2];
if (mode === "host") {
  const targetId = process.argv[3] ?? fail("host requires a target id");
  const record = process.argv[4] ?? fail("host requires a record path");
  const target =
    NATIVE_TARGETS.find((candidate) => candidate.id === targetId) ??
    fail(`unsupported native target: ${targetId}`);
  if (
    target.os !== process.platform ||
    target.cpu !== process.arch ||
    (target.libc !== undefined && target.libc !== hostLibc())
  )
    fail(`${target.id} does not match this ${process.platform}/${process.arch} host`);
  const environment = {
    ...process.env,
    CARGO_TARGET_DIR: resolve("rust/target/native-matrix", target.id),
  };
  run(
    [
      process.execPath,
      "scripts/rust/cargo.ts",
      "build",
      "--release",
      "--manifest-path",
      "rust/Cargo.toml",
      "-p",
      "partial-json-repair-native",
      "--target",
      target.rust,
    ],
    environment,
  );
  run(
    [process.execPath, "scripts/rust/check-native.ts", "--target", target.id, "--record", record],
    environment,
  );
} else if (mode === "reconcile") {
  const records = process.argv
    .slice(3)
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as MatrixRecord);
  const byTarget = new Map<string, MatrixRecord>();
  for (const record of records) {
    if (
      record.schema !== 1 ||
      !Array.isArray(record.routes) ||
      record.routes.length === 0 ||
      record.routes.some((route) => typeof route !== "string" || route === "") ||
      new Set(record.routes).size !== record.routes.length
    )
      fail(`invalid native matrix record for ${record.target}`);
    if (!NATIVE_TARGETS.some((target) => target.id === record.target))
      fail(`unexpected native matrix target: ${record.target}`);
    if (byTarget.has(record.target)) fail(`duplicate native matrix target: ${record.target}`);
    byTarget.set(record.target, record);
  }
  const missing = NATIVE_TARGETS.filter((target) => !byTarget.has(target.id));
  if (missing.length > 0)
    fail(`missing native matrix targets: ${missing.map((target) => target.id).join(", ")}`);
  console.log(`native matrix: reconciled ${String(byTarget.size)} target records`);
} else {
  fail("usage: native-matrix.ts host <target> <record> | reconcile <records...>");
}
