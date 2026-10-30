// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("refuses output deletion when tracked-file discovery fails", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pjr-cleanup-"));
  try {
    mkdirSync(join(scratch, "scripts"));
    mkdirSync(join(scratch, "dist"));
    const script = join(scratch, "scripts", "clean-generated.sh");
    cpSync(new URL("../scripts/clean-generated.sh", import.meta.url), script);
    const sentinel = join(scratch, "dist", "keep.txt");
    writeFileSync(sentinel, "ownership is unknown");
    // Fail the real Git query; an empty tracked-file list must not stand in for unavailable evidence.
    const child = spawnSync("bash", [script, "--build"], {
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: join(scratch, "missing-git"), GIT_WORK_TREE: scratch },
      timeout: 2000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).not.toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("ownership is unknown");
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

it("preserves every output when another cleanup target contains tracked files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pjr-cleanup-tracked-"));
  try {
    // Git's own inventory prevents an enclosing commit's temporary index from leaking into this repo.
    const localNames = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .trim()
      .split("\n");
    if (!localNames.includes("GIT_INDEX_FILE"))
      throw new Error("Git environment inventory is missing");
    const env = { ...process.env };
    for (const name of localNames) delete env[name];
    execFileSync("git", ["init", "--quiet", scratch], { env });
    for (const directory of ["scripts", "dist", "release-artifacts"])
      mkdirSync(join(scratch, directory));
    const script = join(scratch, "scripts", "clean-generated.sh");
    cpSync(new URL("../scripts/clean-generated.sh", import.meta.url), script);
    const generated = join(scratch, "dist", "pending.txt");
    const protectedFile = join(scratch, "release-artifacts", "source.txt");
    writeFileSync(generated, "keep until ownership is resolved");
    writeFileSync(protectedFile, "tracked source");
    execFileSync("git", ["-C", scratch, "add", "--", protectedFile], { env });
    const child = spawnSync("bash", [script, "--build"], { env, encoding: "utf8", timeout: 2000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).not.toBe(0);
    expect(existsSync(generated), "earlier output was deleted before preflight finished").toBe(
      true,
    );
    expect(readFileSync(protectedFile, "utf8")).toBe("tracked source");
  } finally {
    rmSync(scratch, { recursive: true });
  }
});
