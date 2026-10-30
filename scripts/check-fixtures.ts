// SPDX-License-Identifier: Apache-2.0

/** Reject real contact domains before fixtures or examples enter public Git history. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureEmails } from "./fixture-identities";

const root = fileURLToPath(new URL("..", import.meta.url));
// The commit hook names its changed paths: each file is judged alone, so unchanged files cannot
// change the verdict, and rescanning the large recorded corpus would dominate a prose commit.
const named = process.argv.slice(2);
const files = new Set(
  named.length > 0
    ? named
    : execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean),
);
if (named.length === 0 && !files.has("corpus/seeds.jsonl"))
  throw new Error("fixtures: input enumeration missed corpus/seeds.jsonl");

const seeds = readFileSync(join(root, "corpus/seeds.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as { license?: string; source?: string });
for (const [index, seed] of seeds.entries()) {
  if (Boolean(seed.source) !== Boolean(seed.license))
    throw new Error(
      `corpus/seeds.jsonl:${index + 1}: borrowed seeds require both source and license`,
    );
  if (
    seed.license !== undefined &&
    seed.license.includes("see NOTICE") &&
    !existsSync(join(root, "NOTICE"))
  )
    throw new Error(`corpus/seeds.jsonl:${index + 1}: license requires the missing NOTICE file`);
}

for (const file of files) {
  // Attribution belongs to its original author; fixture identities do not.
  if (/(?:^|\/)(?:LICENSE|NOTICE)(?:[.-]|$)/u.test(file)) continue;
  const target = join(root, file);
  const status = lstatSync(target, { throwIfNoEntry: false });
  if (status === undefined || !status.isFile()) continue;
  const lines = fixtureEmails(readFileSync(target, "utf8"));
  if (lines.length === 0) continue;
  process.exitCode = 1;
  console.error(
    `${file}:${lines.join(",")}: use a synthetic email at example.com, example.net or example.org; preserve the syntax under test. Fix source fixtures, then run bun run corpus:record for generated observations.`,
  );
}
if (process.exitCode !== 1)
  console.log(
    "fixtures: contact addresses use reserved example domains; this check does not certify anonymization",
  );
