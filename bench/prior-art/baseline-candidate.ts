// SPDX-License-Identifier: Apache-2.0

/** Bind measurements and requested review files to their exact tracked tree. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Baseline = Record<string, Record<string, Record<string, string>>>;
type Candidate = { readonly state: string; readonly value: unknown };

const stateOfTree = (): string => {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const diff = spawnSync("git", ["diff", "--binary", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  });
  if (head.status !== 0 || diff.status !== 0 || status.status !== 0)
    throw new Error("could not identify benchmarked tree");
  if (status.stdout.split("\n").some((line) => line.startsWith("?? ")))
    throw new Error("commit or remove untracked files before measuring a reusable candidate");
  return createHash("sha256")
    .update(head.stdout)
    .update(status.stdout)
    .update(diff.stdout)
    .digest("hex");
};

export const prepareCandidate = (file?: string): ((value: unknown) => void) => {
  // Capture before the build, so later edits cannot be stamped onto earlier measurements.
  const state = stateOfTree();
  return (value) => {
    if (stateOfTree() !== state)
      throw new Error("the tree changed during measurement; rerun before using these results");
    // Ordinary measurements still bind their source, but own no persistent review artifact.
    if (file === undefined) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ state, value } satisfies Candidate)}\n`);
  };
};

export const acceptCandidate = (candidateFile: string, outputFile: string): unknown => {
  const candidate = JSON.parse(readFileSync(candidateFile, "utf8")) as Candidate;
  if (candidate.state !== stateOfTree())
    throw new Error("the measured tree changed; rerun the measurement before accepting it");
  writeFileSync(outputFile, `${JSON.stringify(candidate.value, undefined, 2)}\n`);
  return candidate.value;
};
