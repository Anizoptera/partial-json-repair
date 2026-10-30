import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { extractApi, apiSnapshot, typedEntries } from "./api-extraction";
import type { ApiEntry } from "./api-extraction";
import { normalizeDeclarations } from "./api-declarations";
import { incompatibleExports } from "./api-compatibility";
import {
  combineReleaseLevels,
  minimumRelease,
  satisfiesMinimum,
  sectionsLevel,
  typeScriptApiSections,
} from "./release-comparison";
import type { ApiSections, ReleaseLevel } from "./release-comparison";
import { npmReleaseSurface, npmSurfaceDifference } from "./release-surface";
import { unpackDeclarations } from "./registry-integrity";
import { declaredRenames } from "./release-notes";
import type { PackageArchive } from "./package-artifacts";
import type { ComparisonInput } from "./release-history";

interface PackageManifest extends Record<string, unknown> {
  name: string;
  version: string;
  exports?: unknown;
}

function manifest(source: string, name: string, version: string): PackageManifest {
  const value: unknown = JSON.parse(source);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("name" in value) ||
    !("version" in value) ||
    value.name !== name ||
    value.version !== version
  )
    throw new Error(`Archive manifest does not identify ${name}@${version}.`);
  return value as PackageManifest;
}

// Generated diffs must land beside the prose a caller reads, without rewriting that prose.
export function appendApiSection(notes: string, heading: string, block: string): string {
  const nodes = fromMarkdown(notes).children;
  const headings = nodes.filter((node) => node.type === "heading" && node.depth <= 3);
  const matches = headings.flatMap((node, index) =>
    node.type === "heading" &&
    node.depth === 3 &&
    node.children.map((child) => (child.type === "text" ? child.value : "")).join("") === heading
      ? [index]
      : [],
  );
  if (matches.length > 1) throw new Error(`Release notes contain duplicate ${heading} sections.`);
  const index = matches[0];
  if (index === undefined) {
    if (heading === "Breaking changes")
      throw new Error(
        'Explain the caller migration under "### Breaking changes" before releasing this incompatible API.',
      );
    return `${notes.trimEnd()}\n\n### ${heading}\n\n${block}`;
  }
  const end = headings[index + 1]?.position?.start.offset ?? notes.length;
  const start = headings[index]?.position?.end.offset;
  if (
    heading === "Breaking changes" &&
    !nodes.some(
      (node) =>
        (node.type === "paragraph" || node.type === "list") &&
        start !== undefined &&
        (node.position?.start.offset ?? -1) >= start &&
        (node.position?.end.offset ?? notes.length + 1) <= end,
    )
  )
    throw new Error(
      'Explain the caller migration under "### Breaking changes" before releasing this incompatible API.',
    );
  return `${notes.slice(0, end).trimEnd()}\n\n${block}${end < notes.length ? `\n\n${notes.slice(end)}` : ""}`;
}

async function compareEntries(
  previous: readonly ApiEntry[],
  current: readonly ApiEntry[],
  prose: string,
): Promise<ApiSections> {
  const results = await Promise.allSettled(
    previous.map(async (old) => {
      const fresh = current.find((entry) => entry.entry === old.entry);
      // Removed entry points are reported by the export-map comparison, without a duplicate API dump.
      if (fresh === undefined) return { breaking: "", added: "", changed: "" };
      const incompatible = await incompatibleExports(old.declarations, fresh.declarations);
      const sections = typeScriptApiSections(
        normalizeDeclarations(old.declarations),
        normalizeDeclarations(fresh.declarations),
        incompatible,
        declaredRenames(prose),
      );
      const labeled = (body: string) => (body === "" ? "" : `**${old.entry}**\n\n${body}`);
      return {
        breaking: labeled(sections.breaking),
        added: labeled(sections.added),
        changed: labeled(sections.changed),
      };
    }),
  );
  const sections = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  return {
    breaking: sections
      .map((section) => section.breaking)
      .filter(Boolean)
      .join("\n\n"),
    added: sections
      .map((section) => section.added)
      .filter(Boolean)
      .join("\n\n"),
    changed: sections
      .map((section) => section.changed)
      .filter(Boolean)
      .join("\n\n"),
  };
}

export interface ComparisonReport {
  readonly role: ComparisonInput["role"];
  readonly tag: string;
  readonly minimum: ReleaseLevel;
  readonly packages: readonly { name: string; level: ReleaseLevel; sections: ApiSections }[];
}

export async function analyzeHistory(
  packages: readonly PackageArchive[],
  comparisons: readonly ComparisonInput[],
  staging: string,
  version: string,
  prose: string,
): Promise<{ notes: string; comparisons: ComparisonReport[] }> {
  // No invented predecessor and no compatibility work on the first publication. The populated
  // branch remains the same release path for later versions, including deliberate breaking 0.x.
  if (comparisons.length === 0) return { notes: prose, comparisons: [] };
  const work = await mkdtemp(path.join(tmpdir(), "pjr-release-analysis-"));
  try {
    const loaded = await Promise.allSettled(
      packages.map(async (item, index) => {
        const directory = await unpackDeclarations(
          item.file,
          path.join(work, "current", String(index)),
        );
        return manifest(
          await readFile(path.join(directory, "package.json"), "utf8"),
          item.name,
          version,
        );
      }),
    );
    const current = loaded.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const main = current[0];
    if (main === undefined) throw new Error("Candidate has no main package.");
    // The cleaned-archive callback already proved these snapshots equal the candidate's declarations.
    // Reuse that result instead of extracting the same current API again for every predecessor.
    const declarations = await Promise.all(
      typedEntries(main).map(async ({ entry }) => ({
        entry,
        declarations: await readFile(apiSnapshot(entry), "utf8"),
      })),
    );
    const reports: ComparisonReport[] = [];
    for (const comparison of comparisons) {
      // Bound simultaneous full declaration programs by comparing releases in order; entries and
      // supported compilers within each release still run concurrently.
      // eslint-disable-next-line no-await-in-loop -- bound owned extraction and compiler processes across predecessors
      const observations = await Promise.allSettled(
        comparison.packages.map(async (item, index) => {
          if (!item.published) return [];
          const target = current[index];
          if (target === undefined || target.name !== item.name)
            throw new Error("Historical package order changed.");
          const directory = await unpackDeclarations(
            path.join(staging, item.file),
            path.join(work, comparison.role, String(index)),
          );
          const old = manifest(
            await readFile(path.join(directory, "package.json"), "utf8"),
            item.name,
            item.version,
          );
          const before = npmReleaseSurface(old);
          const after = npmReleaseSurface(target);
          const metadata = npmSurfaceDifference(before, after);
          // The alias re-exports the canonical API; its own metadata and exact dependency are separate.
          const api =
            index === 0
              ? await compareEntries(await extractApi(directory), declarations, prose)
              : { breaking: "", added: "", changed: "" };
          const level = combineReleaseLevels(sectionsLevel(api), metadata.level);
          const key = metadata.level === "major" ? "breaking" : "changed";
          const sections = metadata.changed
            ? { ...api, [key]: [metadata.report, api[key]].filter(Boolean).join("\n\n") }
            : api;
          return [{ name: item.name, level, sections }];
        }),
      );
      const changes = observations.flatMap((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      const minimum = minimumRelease(
        version,
        prose,
        changes.map((change) => change.level),
      );
      if (!satisfiesMinimum(comparison.tag.slice(1), version, minimum))
        throw new Error(
          `${version} needs a ${minimum} increase over ${comparison.tag}; update the version and caller-facing notes before release.`,
        );
      reports.push({ role: comparison.role, tag: comparison.tag, minimum, packages: changes });
    }
    let notes = prose;
    const immediate = reports.find((report) => report.role === "immediate");
    // Stable consumers upgrade from stable versions; an intervening prerelease must not hide
    // their migration in notes that show only the small change since that prerelease.
    const stable = reports
      .filter((report) => report.tag.split("+", 1)[0]?.includes("-") !== true)
      .toSorted((left, right) => -Bun.semver.order(left.tag.slice(1), right.tag.slice(1)))[0];
    const basis =
      version.split("+", 1)[0]?.includes("-") === true ? immediate : (stable ?? immediate);
    for (const [key, heading] of [
      ["breaking", "Breaking changes"],
      ["added", "Added"],
      ["changed", "Changed"],
    ] as const) {
      const blocks =
        basis?.packages.flatMap((item) =>
          item.sections[key] === "" ? [] : [`**${item.name}**\n\n${item.sections[key]}`],
        ) ?? [];
      if (blocks.length > 0) notes = appendApiSection(notes, heading, blocks.join("\n\n"));
    }
    return { notes, comparisons: reports };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
