import { stat } from "node:fs/promises";
import path from "node:path";
import type { ComparisonInput } from "./release-history";

/** One KB is 1024 bytes, as npm and GitHub display package sizes. */
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Estimated compressed bytes by role. Most of the tarball is source maps and TypeScript sources
 * that no bundle includes, so the total alone overstates what a consumer ships. A `.tgz` is one
 * gzip stream, so no file has its own compressed size; gzipping each role alone estimates its share.
 */
async function contents(file: string): Promise<string> {
  const roles = {
    js: [] as Uint8Array[],
    maps: [] as Uint8Array[],
    types: [] as Uint8Array[],
    sources: [] as Uint8Array[],
  };
  const files = [...(await new Bun.Archive(await Bun.file(file).bytes()).files())];
  const bytes = await Promise.all(files.map(([, blob]) => blob.bytes()));
  for (const [index, [name]] of files.entries()) {
    const role = name.endsWith(".map")
      ? roles.maps
      : name.endsWith(".d.ts")
        ? roles.types
        : name.endsWith(".js")
          ? roles.js
          : name.endsWith(".ts")
            ? roles.sources
            : undefined;
    const content = bytes[index];
    if (content !== undefined) role?.push(content);
  }
  const size = (parts: Uint8Array[]) =>
    parts.length > 0 ? Bun.gzipSync(Buffer.concat(parts)).length : 0;
  const parts = [
    `${kb(size(roles.js))} JS`,
    `${kb(size(roles.maps))} source maps`,
    `${kb(size(roles.types))} types`,
    ...(roles.sources.length > 0 ? [`${kb(size(roles.sources))} TS sources`] : []),
  ];
  return parts.join(", ");
}

/**
 * The notes' closing lines: each package's compressed size, its role breakdown and its change
 * from the immediate predecessor, then the npm and commit-history links. GitHub renders each line
 * break in a release body, so every entry is one line.
 */
export async function releaseFooter(
  packages: readonly { readonly name: string; readonly file: string }[],
  immediate: ComparisonInput | undefined,
  historyRoot: string,
  version: string,
  repository: string,
): Promise<string> {
  const lines = await Promise.all(
    packages.map(async ({ name, file }) => {
      const now = (await stat(file)).size;
      const old = immediate?.packages.find((item) => item.name === name);
      let change = "";
      if (immediate !== undefined && old?.published === true) {
        const before = (await stat(path.join(historyRoot, old.file))).size;
        const delta = now - before;
        change =
          delta === 0
            ? `, unchanged from ${immediate.tag}`
            : `, ${delta > 0 ? "up" : "down"} ${kb(Math.abs(delta))} (${delta > 0 ? "+" : "-"}${((Math.abs(delta) / before) * 100).toFixed(1)}%) from ${immediate.tag}`;
      }
      return `**[${name}](https://www.npmjs.com/package/${name}/v/${version})**: ${kb(now)} compressed _(${await contents(file)})_${change}`;
    }),
  );
  const history =
    immediate === undefined
      ? `https://github.com/${repository}/commits/v${version}`
      : `https://github.com/${repository}/compare/${immediate.tag}...v${version}`;
  return [...lines, `**Full commit history**: ${history}`].join("\n");
}
