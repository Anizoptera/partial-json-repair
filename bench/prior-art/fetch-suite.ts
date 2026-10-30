// SPDX-License-Identifier: Apache-2.0

/**
 * Fetch the pinned JSONTestSuite and expose its parsing inputs to `compare.ts`.
 * Keep the upstream checkout and license in the ignored cache; copy no expectations into our corpus.
 *
 *     bun bench/prior-art/fetch-suite.ts
 *
 */

import { existsSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireSuite, JSON_SUITE } from "./suites";

const dir = fileURLToPath(new URL(".jsontestsuite", import.meta.url));

const suite = await acquireSuite(JSON_SUITE);
if (!suite.files.some((file) => file.startsWith("test_parsing/") && file.endsWith(".json"))) {
  throw new Error(`${suite.repo}@${suite.revision}: no parsing inputs; comparison cannot run.`);
}
const target = relative(import.meta.dirname, join(suite.root, "test_parsing"));
const existing = lstatSync(dir, { throwIfNoEntry: false });
if (existing?.isSymbolicLink()) {
  if (readlinkSync(dir) !== target) unlinkSync(dir);
} else if (existing) {
  // Preserve the old unversioned inputs for comparison; they cannot prove the pinned revision.
  renameSync(dir, `${dir}.unversioned`);
}
if (!existsSync(dir)) symlinkSync(target, dir, "dir");
console.log(`suite: ${suite.repo}@${suite.revision}, inputs in ${dir}`);
