import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanPackage, releaseCommand } from "./package-artifacts";
import { readReleaseInputs, RELEASE_DIRECTORY, RELEASE_REPOSITORY } from "./release-inputs";
import {
  awaitRegistryArchive,
  registryArchive,
  verifyPublishedPackage,
} from "./registry-integrity";
import { releaseVersion } from "./release-history";

export function requirePublicationContext(env: NodeJS.ProcessEnv, tag: string): void {
  // Credentials on a laptop or private mirror are not permission to publish unsigned/wrong-source bytes.
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY ||
    env.GITHUB_REF_TYPE !== "tag" ||
    env.GITHUB_REF_NAME !== tag
  )
    throw new Error(
      "Publication requires the authorized public repository's tagged GitHub Actions workflow.",
    );
}

export async function publishRelease(tag: string, version: string): Promise<void> {
  requirePublicationContext(process.env, tag);
  const inputs = await readReleaseInputs(tag, version);
  // Validate the whole retained pair before the first upload; a retry must not narrow its selection.
  const main = inputs.packages[0];
  if (main === undefined) throw new Error("Reviewed main archive is missing.");
  // Restore the verified build instead of compiling again in the credential-bearing job.
  await releaseCommand([
    "tar",
    "-xzf",
    path.join(RELEASE_DIRECTORY, main.file),
    "--strip-components=1",
    "-C",
    process.cwd(),
    "package/dist",
  ]);
  for (const item of inputs.packages) {
    const reviewed = path.join(RELEASE_DIRECTORY, item.file);
    // oxlint-disable-next-line no-await-in-loop -- main must be observable before its exact-version alias
    const existing = await registryArchive(item.name, version);
    if (existing !== undefined && existing.integrity !== item.integrity)
      throw new Error(
        `npm already holds different bytes for ${item.name}@${version}; never overwrite or move its tag.`,
      );
    if (existing === undefined) {
      // Scratch exists only around the credentialed repack; retained evidence is never its output directory.
      // oxlint-disable-next-line no-await-in-loop -- retain publication order
      const work = await mkdtemp(path.join(tmpdir(), "pjr-publish-"));
      try {
        // oxlint-disable-next-line no-await-in-loop -- the cleaner must prove identity before this upload
        await cleanPackage(item.directory, work, "publish", { PJR_EXPECTED_ARCHIVE: reviewed });
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- release the current upload's scratch before advancing
        await rm(work, { recursive: true, force: true });
      }
      // oxlint-disable-next-line no-await-in-loop -- the alias must not upload before main is served
      await awaitRegistryArchive(item.name, version);
    }
    // oxlint-disable-next-line no-await-in-loop -- first prove main publication, then permit alias publication
    await verifyPublishedPackage(item, reviewed);
    console.log(`${item.name}@${version} matches its reviewed archive`);
  }
}

if (import.meta.main) {
  const [tag = process.env.GITHUB_REF_NAME, ...extra] = process.argv.slice(2);
  if (tag === undefined || extra.length > 0)
    throw new Error("Usage: bun scripts/release-publish.ts <tag>");
  await publishRelease(tag, releaseVersion(tag));
}
