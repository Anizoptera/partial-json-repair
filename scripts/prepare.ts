// SPDX-License-Identifier: Apache-2.0

/**
 * Runs after `bun install` in a checkout of this repository, never in a consumer's install of the
 * published package (a registry install runs no `prepare`, and the tarball has no `scripts/`).
 *
 * 1. Points Git at `.githooks`, so the pre-commit gate runs without a manual step. Skipped outside a
 *    Git checkout (a source tarball), where there is nothing to configure.
 * 2. Installs `bench/prior-art/`, the rival libraries the prior-art harness measures. They have their
 *    own lockfile so the package's lockfile never depends on them, but `bun run check` type-checks
 *    the harness, so a fresh clone without them fails its first check — and CI, which runs exactly
 *    `bun install` then `bun run check`, failed the same way. `--frozen-lockfile` keeps the rivals at
 *    the versions the published figures were measured on.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const run = (command: string, args: readonly string[], cwd?: string): number =>
  spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1;

if (run("git", ["rev-parse", "--git-dir"]) === 0)
  run("git", ["config", "core.hooksPath", ".githooks"]);

if (existsSync("bench/prior-art/package.json")) {
  const status = run(process.execPath, ["install", "--frozen-lockfile"], "bench/prior-art");
  if (status !== 0) process.exit(status);
}
