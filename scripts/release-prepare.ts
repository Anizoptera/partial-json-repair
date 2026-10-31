import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { archiveIntegrity, preparePackages } from "./package-artifacts";
import { prepareHistory } from "./release-history";
import { analyzeHistory } from "./release-analysis";
import { releaseFooter } from "./release-footer";
import { changelogNotes } from "./release-notes";
import {
  RELEASE_DIRECTORY,
  RELEASE_REPOSITORY,
  releaseSource,
  readReleaseInputs,
} from "./release-inputs";
import type { ReleaseInputs } from "./release-inputs";

export async function prepareRelease(
  tag: string,
  version: string,
  preview: boolean,
): Promise<void> {
  const commit = await releaseSource(tag, preview);
  const inputFile = Bun.file(path.join(RELEASE_DIRECTORY, "inputs.json"));
  if (await inputFile.exists()) {
    await readReleaseInputs(tag, version, preview);
    return; // Same-source retries reuse the original archives rather than repacking.
  }
  await mkdir(RELEASE_DIRECTORY, { recursive: true });
  if ((await readdir(RELEASE_DIRECTORY)).length > 0)
    throw new Error(
      "Incomplete release evidence exists; recover it before preparing replacement archives.",
    );
  const staging = path.join(RELEASE_DIRECTORY, "staging");
  try {
    const comparisons = await prepareHistory(tag, path.join(staging, "history"));
    const packages = await preparePackages(path.join(staging, "packages"));
    const prose = changelogNotes(await readFile("CHANGELOG.md", "utf8"), version);
    const analysis = await analyzeHistory(packages, comparisons, staging, version, prose);
    await writeFile(
      path.join(staging, "comparison.json"),
      `${JSON.stringify(analysis.comparisons, null, 2)}\n`,
    );
    const footer = await releaseFooter(
      packages,
      comparisons.find((item) => item.role === "immediate"),
      staging,
      version,
      RELEASE_REPOSITORY,
    );
    const notes = `${analysis.notes}\n\n${footer}\n`;
    await writeFile(path.join(staging, "notes.md"), notes);
    const inputs: ReleaseInputs = {
      tag,
      version,
      commit,
      preview,
      packages: packages.map((item) =>
        Object.assign({}, item, { file: path.relative(staging, item.file) }),
      ),
      notesIntegrity: await archiveIntegrity(path.join(staging, "notes.md")),
      comparisons,
      reportIntegrity: await archiveIntegrity(path.join(staging, "comparison.json")),
    };
    if ((await releaseSource(tag, preview)) !== commit)
      throw new Error("Source changed during release preparation.");
    await writeFile(path.join(staging, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
    await rename(path.join(staging, "packages"), path.join(RELEASE_DIRECTORY, "packages"));
    await rename(path.join(staging, "notes.md"), path.join(RELEASE_DIRECTORY, "notes.md"));
    await rename(path.join(staging, "history"), path.join(RELEASE_DIRECTORY, "history"));
    await rename(
      path.join(staging, "comparison.json"),
      path.join(RELEASE_DIRECTORY, "comparison.json"),
    );
    // The inputs file is the completion marker; incomplete moves cannot look like verified evidence.
    await rename(path.join(staging, "inputs.json"), path.join(RELEASE_DIRECTORY, "inputs.json"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
