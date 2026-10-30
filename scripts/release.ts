#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Publishes the version a pushed `v<version>` tag names: the main package first, then the alias that
 * depends on it, each with npm provenance. `.github/workflows/release.yml` runs it after the complete
 * gate passed on the tagged commit. `bun scripts/release.ts check <tag>` runs only the preflight, so a
 * release can be checked locally before the tag is pushed.
 *
 * Why CI: provenance (npm's signed link from a tarball to the commit and workflow that built it) is
 * minted only inside a supported CI and can never be added to a version once published.
 *
 * Preparation retains both publish-clean archives before credentials are available. A retry reuses
 * those source-bound inputs; every upload or existing registry version must match their bytes.
 * `preview` prepares local review bytes without creating a tag and can never authorize publication.
 *
 * First publish of a new name: npm attaches trusted publishers only to an existing package, so that
 * run authenticates with a short-lived token in the `NPM_TOKEN` secret. Then configure the trusted
 * publisher for `release.yml` on npmjs.com, delete the secret and revoke the token.
 */
import { readFileSync } from "node:fs";
import { readReleaseInputs } from "./release-inputs";
import { prepareRelease } from "./release-prepare";
import { changelogNotes } from "./release-notes";
import { publishRelease } from "./release-publish";
import { finalizeRelease } from "./release-finalize";
import { releaseVersion } from "./release-history";

const MAIN = "partial-json-repair";

if (import.meta.main) {
  const [mode, tag = process.env.GITHUB_REF_NAME, ...extra] = process.argv.slice(2);
  if (
    !["check", "preview", "prepare", "verify", "publish", "finalize"].includes(mode ?? "") ||
    tag === undefined ||
    extra.length > 0
  )
    throw new Error(
      "usage: bun scripts/release.ts check|preview|prepare|verify|publish|finalize <tag>",
    );
  releaseVersion(tag);
  // The alias manifest is derived from this one, so the tag is the only thing that can disagree.
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  if (tag !== `v${version}`)
    throw new Error(
      `release preflight: tag ${tag} does not name ${MAIN} ${version}; tag v${version}`,
    );
  changelogNotes(readFileSync("CHANGELOG.md", "utf8"), version);
  if (mode === "prepare" || mode === "preview")
    await prepareRelease(tag, version, mode === "preview");
  if (mode === "verify") await readReleaseInputs(tag, version);
  if (mode === "publish") await publishRelease(tag, version);
  if (mode === "finalize") await finalizeRelease(tag, version);
}
