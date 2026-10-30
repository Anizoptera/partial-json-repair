// SPDX-License-Identifier: Apache-2.0

/** Read test inputs from verified upstream revisions, never from an unversioned cache. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
const cache = join(import.meta.dirname, ".rival-tests");

/** Revisions identify the inputs studied; update them deliberately when widening coverage. */
export const JSON_SUITE = {
  repo: "nst/JSONTestSuite",
  revision: "1ef36fa01286573e846ac449e8683f8833c5b26a",
};
export const REPAIR_SUITES = [
  { repo: "josdejong/jsonrepair", revision: "4a80ed87fb1155db064945bc2aa4f6b4f4e89c27" },
  {
    repo: "promplate/partial-json-parser-js",
    revision: "86fd4bcbff1e32f80dd33e62318221702905a8f0",
  },
  {
    repo: "beenotung/best-effort-json-parser",
    revision: "e83e71e0ab8bc04bb456c0bd262f500ca5420b20",
  },
  { repo: "ahgsql/json-repair-js", revision: "3fdcfd22fc1a01046bc97c5045fe4cdc333b754c" },
] as const;

type Suite = { readonly repo: string; readonly revision: string };
export type AcquiredSuite = Suite & { readonly root: string; readonly files: readonly string[] };

const git = async (root: string, args: string[]): Promise<string> => {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${root}: git ${args[0]} failed (${code}): ${stderr || stdout}`);
  return stdout.trimEnd();
};

export const acquireSuite = async (suite: Suite): Promise<AcquiredSuite> => {
  await mkdir(cache, { recursive: true });
  const name = suite.repo.slice(suite.repo.indexOf("/") + 1);
  const root = join(cache, `${name}-${suite.revision}`);
  if (!existsSync(root)) {
    const temporary = await mkdtemp(join(cache, ".fetch-"));
    try {
      await git(temporary, ["init", "--quiet"]);
      await git(temporary, [
        "fetch",
        "--quiet",
        "--depth",
        "1",
        `https://github.com/${suite.repo}.git`,
        suite.revision,
      ]);
      await git(temporary, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
      await rename(temporary, root);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  // Git otherwise walks upward and reports THIS project's HEAD for an archive with no .git.
  if (
    !existsSync(join(root, ".git")) ||
    resolve(await git(root, ["rev-parse", "--show-toplevel"])) !== resolve(root)
  ) {
    throw new Error(
      `${root}: not an independent suite checkout; move the invalid cache aside and retry.`,
    );
  }
  if ((await git(root, ["rev-parse", "HEAD"])) !== suite.revision) {
    throw new Error(
      `${root}: revision differs from the pinned source; move the invalid cache aside and retry.`,
    );
  }
  await git(root, ["diff", "--exit-code", "HEAD", "--"]);
  const files = (await git(root, ["ls-files"])).split("\n");
  if (files.length === 0 || files[0] === "")
    throw new Error(`${suite.repo}: acquired no tracked files.`);
  return { ...suite, root, files };
};
