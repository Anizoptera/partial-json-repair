import { releaseCommand } from "./package-artifacts";
import { releaseManifests } from "./package-artifacts";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  registryHistory,
  historicalVersion,
  downloadRegistryArchive,
  NPM_REGISTRY,
} from "./registry-integrity";

interface Version {
  readonly tag: string;
  readonly value: string;
  readonly major: bigint;
  readonly minor: bigint;
}

export const COMPARISON_ROLES = ["immediate", "releaseLine", "stable"] as const;
export type ReleaseComparisons = Partial<
  Readonly<Record<(typeof COMPARISON_ROLES)[number], string>>
>;

export interface ComparisonInput {
  readonly role: (typeof COMPARISON_ROLES)[number];
  readonly tag: string;
  readonly commit: string;
  readonly packages: readonly HistoricalPackage[];
}

export type HistoricalPackage = { readonly name: string; readonly version: string } & (
  | { readonly published: false }
  | { readonly published: true; readonly file: string; readonly integrity: string }
);

export async function prepareHistory(
  candidate: string,
  destination: string,
  registry = NPM_REGISTRY,
): Promise<ComparisonInput[]> {
  const manifests = await releaseManifests();
  const lookups = await Promise.allSettled(
    manifests.map((item) => registryHistory(item.name, registry)),
  );
  const histories = lookups.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  for (const [index, item] of manifests.entries())
    if (histories[index]?.has(item.version) === true)
      throw new Error(
        'This version is already on npm, so it must not be repacked. Use "Re-run failed jobs" on the original release run, which reuses its reviewed archives; if that run\'s artifacts expired, release the next patch version instead.',
      );
  await mkdir(destination, { recursive: true });
  // Empty published history is a supported branch. Private tags are not compatibility promises.
  if (histories.every((history) => history.size === 0)) return [];
  const selected = await releaseComparisons(candidate);
  if (selected.immediate === undefined)
    throw new Error(
      "npm has published history but Git has no prior release tags; fetch the matching released tags before preparation.",
    );
  const selections = COMPARISON_ROLES.flatMap((role) => {
    const tag = selected[role];
    return tag === undefined ? [] : [{ role, tag }];
  });
  const plans = await Promise.allSettled(
    selections.map(async ({ role, tag }): Promise<ComparisonInput> => {
      const commit = await releaseCommand(["git", "rev-parse", `refs/tags/${tag}^{commit}`]);
      const results = await Promise.allSettled(
        manifests.map(async (item, index) => {
          const history = histories[index];
          if (history === undefined) throw new Error("Missing package registry history.");
          const version = tag.slice(1);
          const archive = historicalVersion(history, version, item.name);
          if (archive === undefined) return { name: item.name, version, published: false } as const;
          const file = path.join(destination, role, `${index}.tgz`);
          await mkdir(path.dirname(file), { recursive: true });
          await downloadRegistryArchive(archive, file);
          return {
            name: item.name,
            version,
            published: true,
            file: path.relative(path.dirname(destination), file),
            integrity: archive.integrity,
          } as const;
        }),
      );
      const packages = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      return { role, tag, commit, packages };
    }),
  );
  return plans.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

function parseTag(tag: string): Version {
  const identifier = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
  const match = new RegExp(
    String.raw`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${identifier}(?:\.${identifier})*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
    "u",
  ).exec(tag);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new Error(`Release tag ${tag} is not strict SemVer vMAJOR.MINOR.PATCH.`);
  return { tag, value: tag.slice(1), major: BigInt(match[1]), minor: BigInt(match[2]) };
}

export function releaseVersion(tag: string): string {
  const version = parseTag(tag).value;
  if (version.split("+", 1)[0]?.split("-", 2)[1]?.split(".").includes("dev") === true)
    throw new Error(
      "Development versions cannot be published; prepare an authorized release version first.",
    );
  return version;
}

function descending(left: Version, right: Version): number {
  return -Bun.semver.order(left.value, right.value);
}

/** Select distinct historical releases; registries verify these choices but never replace them. */
export function selectReleaseComparisons(
  candidateTag: string,
  tags: readonly string[],
): ReleaseComparisons {
  const candidate = parseTag(candidateTag);
  const versions = tags.map((tag) => parseTag(tag));
  if (
    versions.some((version, index) =>
      versions.slice(index + 1).some((other) => Bun.semver.order(version.value, other.value) === 0),
    )
  )
    throw new Error("Release tags contain versions with duplicate SemVer precedence.");
  const previous = versions.filter(({ value }) => Bun.semver.order(value, candidate.value) < 0);
  // The filtered array is fresh; mutating sort keeps the release tool on the package's ES2022 floor.
  // oxlint-disable-next-line unicorn/no-array-sort
  previous.sort(descending);
  const immediate = previous[0];
  if (!immediate) return {};
  const line = previous.find((version) =>
    candidate.major === 0n
      ? version.major === 0n && version.minor < candidate.minor
      : version.major < candidate.major,
  );
  // A second patch/minor in the same line adds no older-line comparison.
  const releaseLine =
    line?.value === immediate.value
      ? previous.find((version) =>
          candidate.major === 0n
            ? version.major === 0n && version.minor < immediate.minor
            : version.major < immediate.major,
        )
      : line;
  // A prerelease can already contain a break that stable consumers have not received; comparing
  // only that newest tag would let the next stable patch hide the break from its old stable line.
  const stable = previous.find(({ value }) => value.split("+", 1)[0]?.includes("-") !== true);
  return {
    immediate: immediate.tag,
    ...(releaseLine ? { releaseLine: releaseLine.tag } : {}),
    ...(stable && stable.tag !== immediate.tag && stable.tag !== releaseLine?.tag
      ? { stable: stable.tag }
      : {}),
  };
}

/** Read release history from Git; publication separately requires new tags to be annotated. */
export async function releaseComparisons(candidateTag: string): Promise<ReleaseComparisons> {
  const output = await releaseCommand(["git", "tag", "--list"]);
  const tags: string[] = [];
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    if (!line.startsWith("v") || !/^v\d/u.test(line)) continue;
    parseTag(line);
    tags.push(line);
  }
  return selectReleaseComparisons(candidateTag, tags);
}
