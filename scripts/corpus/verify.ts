// SPDX-License-Identifier: Apache-2.0

/**
 * Fails when any recorded answer moved: records the contract from this package in memory and
 * compares its hash with the accepted one in `corpus/contract.sha256`.
 *
 * The recorded strings are what holds this package and a later Rust port to the same answers; they
 * are compared as canonical STRINGS so a second implementation needs no shared type system.
 *
 * **A mismatch is a CHANGE, not a defect.** The contract records what this package does, wrong
 * behaviour included. Decide which side is right, then fix the code or accept with
 * `bun run corpus:record` and say what moved in the changelog.
 *
 * Git keeps only the hash, so on a mismatch the accepted contract is re-recorded from the commit
 * that accepted it (a `git archive` copy, never a worktree) and the two are diffed row by row.
 * `--verbose` prints every moved observation; the default prints a bounded sample, because one
 * shared code path moves hundreds of rows at once and a full dump buries the first one.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { contract, CONTRACT_HASH, contractHash } from "./record";

const SAMPLE = 10;
const rowsOf = (text: string): Map<string, Record<string, string>> =>
  new Map(
    text
      .split("\n")
      .slice(1)
      .filter((line) => line !== "")
      .map((line) => {
        const row = JSON.parse(line) as { id: string; observed: Record<string, string> };
        return [row.id, row.observed];
      }),
  );

const accepted = readFileSync(CONTRACT_HASH, "utf8").trim();
if (contractHash(contract) === accepted) {
  // Rows are the lines after the header; parsing them would cost more than the check itself.
  console.log(`contract: ${contract.split("\n").length - 2} rows match the accepted recording`);
  process.exit(0);
}
const current = rowsOf(contract);

const root = path.resolve(import.meta.dir, "../..");
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("log", "-1", "--format=%h", "--", "corpus/contract.sha256");
const work = mkdtempSync(path.join(tmpdir(), "pjr-accepted-contract-"));
let reference: Map<string, Record<string, string>>;
try {
  execFileSync("sh", ["-c", 'git archive "$1" | tar -x -C "$2"', "sh", commit, work], {
    cwd: root,
  });
  // The copy brings `.tool-versions`, so asdf resolves the same runtimes there.
  symlinkSync(path.join(root, "node_modules"), path.join(work, "node_modules"));
  const file = path.join(work, "accepted.jsonl");
  execFileSync("bun", ["scripts/corpus/record.ts", "--out", file], { cwd: work, stdio: "ignore" });
  const text = readFileSync(file, "utf8");
  if (contractHash(text) !== accepted)
    throw new Error(
      `${commit} does not reproduce its own corpus/contract.sha256; the hash was accepted without its code. Re-accept with bun run corpus:record.`,
    );
  reference = rowsOf(text);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const verbose = process.argv.includes("--verbose");
let moved = 0;
const report = (line: string): void => {
  moved++;
  if (verbose || moved <= SAMPLE) console.log(line);
};
for (const [id, observed] of current) {
  const before = reference.get(id);
  if (before === undefined) {
    report(`${id}: new row`);
    continue;
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(observed)]))
    if (before[key] !== observed[key])
      report(`${id} ${key}\n  accepted: ${before[key]}\n  actual:   ${observed[key]}`);
}
for (const id of reference.keys()) if (!current.has(id)) report(`${id}: row no longer recorded`);
console.log(
  `contract: ${moved} changes against the recording accepted in ${commit}` +
    (verbose || moved <= SAMPLE ? "" : ` (showing ${SAMPLE}; pass --verbose for all)`) +
    (moved === 0 ? "; only the header moved (profiles or coverage witnesses)" : ""),
);
process.exit(1);
