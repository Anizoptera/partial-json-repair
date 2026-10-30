#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Compiles every optional feature alone. The contract with all features together is `rust:check:commit`
 * (`cargo test --all-features`), which `rust:check` runs first, so it is not repeated here.
 *
 * The feature list comes from `cargo metadata`, so adding a product feature extends the matrix with
 * no edit here. A hardcoded list would rot silently.
 *
 * Isolated checks prove no feature secretly needs a neighbour.
 *
 * Runs sequentially on purpose. Cargo takes an exclusive lock on `target/`, so concurrent
 * invocations queue anyway, and they would race to compile the same dependencies twice.
 */
import { spawnSync } from "node:child_process";

const MANIFEST = "rust/Cargo.toml";
const PACKAGE = "partial-json-repair";
const CARGO = ["scripts/rust/cargo.ts"] as const;

interface Package {
  readonly name: string;
  readonly features: Readonly<Record<string, readonly string[]>>;
}

const metadata = spawnSync(
  "bun",
  [...CARGO, "metadata", "--manifest-path", MANIFEST, "--format-version", "1", "--no-deps"],
  { encoding: "utf8" },
);
if (metadata.status !== 0) {
  console.error(metadata.stderr.trimEnd());
  throw new Error("rust:features: cargo metadata failed; the matrix is unknown, not empty.");
}
const { packages } = JSON.parse(metadata.stdout) as { packages: readonly Package[] };

/**
 * `default` is not a combination of its own — it is whatever `--no-default-features` removes, and
 * every real feature it lists is checked in its own right below.
 */
const optional = (pkg: Package): readonly string[] =>
  Object.keys(pkg.features).filter((name) => name !== "default");

const product = packages.find(({ name }) => name === PACKAGE);
if (product === undefined)
  throw new Error(`rust:features: ${PACKAGE} is absent from cargo metadata.`);
const features = optional(product);
const failures: string[] = [];
for (const enabled of [[], ...features.map((feature) => [feature])] as readonly string[][]) {
  const label =
    enabled.length === 0
      ? `${PACKAGE} (no features)`
      : `${PACKAGE} --features ${enabled.join(",")}`;
  const run = spawnSync(
    "bun",
    [
      ...CARGO,
      "check",
      "--manifest-path",
      MANIFEST,
      "-p",
      PACKAGE,
      "--lib",
      "--no-default-features",
      ...(enabled.length === 0 ? [] : ["--features", enabled.join(",")]),
    ],
    { encoding: "utf8" },
  );
  // Every isolated row is reported, never just the first: one broken feature must not hide the
  // next, or fixing them costs a full lane each.
  if (run.status !== 0) {
    failures.push(label);
    console.error(`--- ${label}`);
    console.error(run.stderr.trimEnd());
  }
}

if (failures.length > 0) {
  console.error(`rust:features: FAILED — ${failures.join(", ")}`);
  process.exitCode = 1;
}
