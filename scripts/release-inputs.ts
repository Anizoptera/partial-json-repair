import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveIntegrity,
  PACKAGE_DIRECTORIES,
  releaseCommand,
  releaseManifests,
} from "./package-artifacts";
import type { PackageArchive } from "./package-artifacts";
import { releaseVersion, COMPARISON_ROLES } from "./release-history";
import type { ComparisonInput, HistoricalPackage } from "./release-history";

export const RELEASE_DIRECTORY = path.resolve("release-artifacts/npm-release");
export const RELEASE_REPOSITORY = "Anizoptera/partial-json-repair";
export type ReleaseInputs = {
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  readonly preview: boolean;
  readonly packages: readonly PackageArchive[];
  readonly notesIntegrity: string;
  readonly comparisons: readonly ComparisonInput[];
  readonly reportIntegrity: string;
};

export async function releaseSource(tag: string, preview: boolean): Promise<string> {
  // A version string does not bind verification to source; annotated tags retain that identity.
  if (await releaseCommand(["git", "status", "--porcelain"]))
    throw new Error("Release preparation requires a clean working tree.");
  const commit = await releaseCommand(["git", "rev-parse", "HEAD"]);
  if (!preview) {
    if ((await releaseCommand(["git", "cat-file", "-t", `refs/tags/${tag}`])) !== "tag")
      throw new Error(
        "Release requires an annotated tag; creating one needs explicit authorization.",
      );
    if ((await releaseCommand(["git", "rev-parse", `refs/tags/${tag}^{commit}`])) !== commit)
      throw new Error("Release tag does not identify the checked-out commit.");
  }
  return commit;
}

function object(value: unknown): Record<string, unknown> {
  // Downloaded workflow evidence is an untyped boundary, not a trusted TypeScript value.
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Retained release inputs must be an object.");
  return value as Record<string, unknown>;
}

export function releaseInputs(value: unknown): ReleaseInputs {
  const input = object(value);
  if (
    typeof input.tag !== "string" ||
    typeof input.version !== "string" ||
    typeof input.commit !== "string" ||
    typeof input.preview !== "boolean" ||
    typeof input.notesIntegrity !== "string" ||
    typeof input.reportIntegrity !== "string" ||
    !Array.isArray(input.comparisons) ||
    !Array.isArray(input.packages)
  )
    throw new Error(
      "Retained release inputs are incomplete; restore the original workflow evidence.",
    );
  if (input.packages.length !== PACKAGE_DIRECTORIES.length)
    throw new Error(
      "Both original npm packages must remain selected, including after a partial upload.",
    );
  const packages = input.packages.map((entry: unknown, index: number): PackageArchive => {
    const item = object(entry);
    if (
      typeof item.name !== "string" ||
      typeof item.version !== "string" ||
      typeof item.directory !== "string" ||
      typeof item.file !== "string" ||
      typeof item.integrity !== "string"
    )
      throw new Error("Retained package identity is incomplete.");
    if (item.directory !== PACKAGE_DIRECTORIES[index])
      throw new Error("Retained package order changed.");
    const file = path.resolve(RELEASE_DIRECTORY, item.file);
    if (!file.startsWith(`${RELEASE_DIRECTORY}${path.sep}`) || !file.endsWith(".tgz"))
      throw new Error("Retained archive must stay inside the release evidence directory.");
    return {
      name: item.name,
      version: item.version,
      directory: item.directory,
      file: item.file,
      integrity: item.integrity,
    };
  });
  return {
    tag: input.tag,
    version: input.version,
    commit: input.commit,
    preview: input.preview,
    packages,
    notesIntegrity: input.notesIntegrity,
    comparisons: comparisonInputs(input.comparisons, packages),
    reportIntegrity: input.reportIntegrity,
  };
}

function comparisonInputs(
  values: readonly unknown[],
  current: readonly PackageArchive[],
): ComparisonInput[] {
  const seenRoles = new Set<string>();
  const seenTags = new Set<string>();
  return values.map((value) => {
    const input = object(value);
    const role = COMPARISON_ROLES.find((candidate) => candidate === input.role);
    if (
      role === undefined ||
      typeof input.tag !== "string" ||
      typeof input.commit !== "string" ||
      !Array.isArray(input.packages) ||
      input.packages.length !== current.length
    )
      throw new Error(
        "Retained comparison must preserve both package states, including a package's first publication.",
      );
    if (seenRoles.has(role) || seenTags.has(input.tag))
      throw new Error("Historical comparison was duplicated.");
    seenRoles.add(role);
    seenTags.add(input.tag);
    const tag = input.tag;
    const version = releaseVersion(tag);
    const packages = input.packages.map((entry: unknown, index: number): HistoricalPackage => {
      const item = object(entry);
      const name = current[index]?.name;
      if (typeof item.name !== "string" || item.name !== name || item.version !== version)
        throw new Error("Historical package name, version or order changed.");
      if (item.published === false && !("file" in item) && !("integrity" in item))
        return { name: item.name, version, published: false };
      if (
        item.published !== true ||
        typeof item.file !== "string" ||
        typeof item.integrity !== "string"
      )
        throw new Error("Historical archive identity is incomplete.");
      const file = path.resolve(RELEASE_DIRECTORY, item.file);
      if (
        !file.startsWith(`${RELEASE_DIRECTORY}${path.sep}history${path.sep}`) ||
        !file.endsWith(".tgz")
      )
        throw new Error("Historical archive must stay inside retained history.");
      return {
        name: item.name,
        version,
        published: true,
        file: item.file,
        integrity: item.integrity,
      };
    });
    if (packages[0]?.published !== true)
      throw new Error("A historical comparison requires a published main package.");
    return { role, tag, commit: input.commit, packages };
  });
}

export async function readReleaseInputs(
  tag: string,
  version: string,
  preview = false,
): Promise<ReleaseInputs> {
  const [raw, commit] = await Promise.all([
    readFile(path.join(RELEASE_DIRECTORY, "inputs.json"), "utf8"),
    releaseSource(tag, preview),
  ]);
  const inputs = releaseInputs(JSON.parse(raw));
  if (
    inputs.tag !== tag ||
    inputs.version !== version ||
    inputs.commit !== commit ||
    inputs.preview !== preview
  )
    throw new Error(
      "Retained evidence belongs to a different source, tag or preparation mode; restore the original inputs.",
    );
  const manifests = await releaseManifests();
  await Promise.all(
    inputs.packages.map(async (item, index) => {
      const current = manifests[index];
      if (current === undefined || item.directory !== PACKAGE_DIRECTORIES[index])
        throw new Error("Retained package order changed.");
      if (item.name !== current.name || item.version !== version || current.version !== version)
        throw new Error("Retained package name or version differs from the checked manifests.");
      if ((await archiveIntegrity(path.join(RELEASE_DIRECTORY, item.file))) !== item.integrity)
        throw new Error(`Retained archive changed: ${item.name}. Restore the reviewed bytes.`);
    }),
  );
  if ((await archiveIntegrity(path.join(RELEASE_DIRECTORY, "notes.md"))) !== inputs.notesIntegrity)
    throw new Error("Retained release notes changed.");
  if (
    (await archiveIntegrity(path.join(RELEASE_DIRECTORY, "comparison.json"))) !==
    inputs.reportIntegrity
  )
    throw new Error("Retained compatibility report changed.");
  await Promise.all(
    inputs.comparisons.map(async (comparison) => {
      if (
        (await releaseCommand(["git", "rev-parse", `refs/tags/${comparison.tag}^{commit}`])) !==
        comparison.commit
      )
        throw new Error(
          "A retained historical tag changed; restore the original comparison source.",
        );
      await Promise.all(
        comparison.packages.map(async (item) => {
          if (
            item.published &&
            (await archiveIntegrity(path.join(RELEASE_DIRECTORY, item.file))) !== item.integrity
          )
            throw new Error(`Retained historical archive changed: ${item.name}@${item.version}.`);
        }),
      );
    }),
  );
  return inputs;
}
