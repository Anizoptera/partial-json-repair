#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Require Git's active pre-commit path to resolve to the executable gate script.
 *
 * Content checks can pass while Git runs another hook or ignores a non-executable file.
 * Verify the active path and execute permission separately.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/** `undefined` for a path that does not exist, so two missing files never compare equal. */
const realpath = (target: string): string | undefined => {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
};

/** Where `prepare` points Git, and the file Git must find there. */
const HOOKS_PATH = ".githooks";
const HOOK = `${HOOKS_PATH}/pre-commit`;

let broken = false;
const report = (problem: string, fix: string) => {
  broken = true;
  console.error(problem);
  console.error(`  Fix: ${fix}`);
};

// One hook implementation must serve Git and direct checks; guidance links belong to steering:check.
const target = "../scripts/pre-commit.ts";
const actual =
  lstatSync(HOOK, { throwIfNoEntry: false })?.isSymbolicLink() === true
    ? readlinkSync(HOOK)
    : undefined;
if (actual !== target) {
  report(
    `${HOOK} must be a symlink to ${target}, but is ${actual === undefined ? "a regular file or missing" : `a symlink to ${actual}`}.`,
    `ln -sfn ${target} ${HOOK}`,
  );
}

// Git ignores non-executable hooks. Following the link checks both target existence and permission;
// a correctly spelled dangling link must fail too.
try {
  accessSync(HOOK, constants.X_OK);
} catch {
  report(
    `${HOOK} is not executable, so Git skips it with a hint and commits anyway — ungating this repository.`,
    `chmod +x scripts/pre-commit.ts`,
  );
}

// A perfectly correct hook file that Git never calls is the same outcome as no hook. Ask Git which
// directory it will actually use and compare RESOLVED paths, rather than comparing `core.hooksPath`
// against the string we expect: that setting may be absolute, `./`-prefixed or trailing-slashed, all
// of which name the right directory and none of which matches as text. Query failure cannot prove
// an active gate; preserve the diagnostic instead of accepting an unobserved hooks path.
const ours = realpath(HOOK);
const gitHooks = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" });
if (gitHooks.status !== 0) {
  report(
    `Cannot determine Git's active hooks directory: ${gitHooks.error?.message ?? (gitHooks.stderr.trim() || `exit ${gitHooks.status}`)}`,
    "Run this check from the repository with a working Git executable.",
  );
} else if (ours !== undefined) {
  const dir = gitHooks.stdout.trim();
  if (realpath(path.join(dir, "pre-commit")) !== ours) {
    report(
      `Git runs hooks from ${dir}, so ${HOOK} never runs and commits are not gated.`,
      "bun install  (its `prepare` script sets core.hooksPath), or: git config core.hooksPath .githooks",
    );
  }
}

if (broken) process.exit(1);
