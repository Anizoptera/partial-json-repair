import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { LANE_DEADLINE_MS } from "./run-script";

/**
 * `@anizoptera/recover-json` exists only so an npm search for "recover json" finds this package (the
 * bare `recover-json` belongs to someone else). Everything it ships follows from the main manifest, so
 * it is written at pack time into ignored output instead of kept as a second source of the version,
 * exact pin, licence and metadata. It re-exports the main package rather than copying it, so a project
 * that installs both loads one module instance (`isExactNumber` and friends agree across the two).
 */
const ALIAS_NAME = "@anizoptera/recover-json";
const ALIAS_DIRECTORY = "release-artifacts/recover-json";
// The alias's exact dependency requires this order in preparation, upload and recovery.
export const PACKAGE_DIRECTORIES = [".", ALIAS_DIRECTORY] as const;

type Manifest = Record<string, unknown> & { name: string; version: string };

/** Both release manifests, main first; the alias's is derived, so the two cannot disagree. */
export async function releaseManifests(): Promise<[Manifest, Manifest]> {
  const main = (await Bun.file("package.json").json()) as Manifest;
  const { name, version, description, license, author, contributors, repository } = main;
  const keywords = (main.keywords ?? []) as string[];
  return [
    main,
    {
      name: ALIAS_NAME,
      version,
      description,
      keywords: [...keywords, name, "recover-json"],
      license,
      author,
      contributors,
      repository,
      // npm always adds README and LICENSE.
      files: ["*.js", "*.d.ts"],
      type: "module",
      sideEffects: false,
      main: "./index.js",
      types: "./index.d.ts",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./async": { types: "./async.d.ts", default: "./async.js" },
      },
      dependencies: { [name]: version },
      // Publication must upload the reviewed bytes; see check-artifact.ts.
      "publish-clean": { validateArtifact: ["bun", "../../scripts/check-artifact.ts", "--alias"] },
    },
  ];
}

async function writeAlias(): Promise<void> {
  const [main, alias] = await releaseManifests();
  const reexport = (entry: string): string => `export * from ${JSON.stringify(entry)};\n`;
  await rm(ALIAS_DIRECTORY, { recursive: true, force: true });
  await mkdir(ALIAS_DIRECTORY, { recursive: true });
  // Every public entry of the main package, so either name is a complete install.
  const entries = { index: main.name, async: `${main.name}/async` };
  await Promise.all([
    Bun.write(path.join(ALIAS_DIRECTORY, "package.json"), `${JSON.stringify(alias, null, 2)}\n`),
    ...Object.entries(entries).flatMap(([file, entry]) => [
      Bun.write(path.join(ALIAS_DIRECTORY, `${file}.js`), reexport(entry)),
      Bun.write(path.join(ALIAS_DIRECTORY, `${file}.d.ts`), reexport(entry)),
    ]),
    // Apache-2.0 requires the licence in every redistribution.
    copyFile("LICENSE", path.join(ALIAS_DIRECTORY, "LICENSE")),
    // The alias's npm page carries the full README with the two names swapped, so its install line
    // and imports paste and run as written: under pnpm an alias-only app cannot import the main
    // name. Repository URLs and the worker recipe's node_modules paths name real locations and stay.
    Bun.write(
      path.join(ALIAS_DIRECTORY, "README.md"),
      (await Bun.file("README.md").text()).replaceAll(
        /(?<!(?:Anizoptera|node_modules)\/)(?:partial-json-repair|@anizoptera\/recover-json)/gu,
        (found) => (found === main.name ? alias.name : main.name),
      ),
    ),
  ]);
}
export type PackageArchive = {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly file: string;
  readonly integrity: string;
};

export async function releaseCommand(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: Uint8Array,
): Promise<string> {
  // Publish-clean needs pnpm; resolve the locked local executable before any global installation.
  const child = Bun.spawn(args, {
    env: {
      ...process.env,
      PATH: `${path.resolve("node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      ...env,
    },
    stdout: "pipe",
    stdin: input ?? "ignore",
    stderr: "pipe",
    timeout: LANE_DEADLINE_MS,
  });
  const stop = (): void => {
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let result: [number, string, string];
  try {
    result = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  const [status, stdout, stderr] = result;
  if (status !== 0) throw new Error(`${args.join(" ")} failed (${status}):\n${stdout}\n${stderr}`);
  return stdout.trim();
}

export async function archiveIntegrity(file: string): Promise<string> {
  // The same digest format is used by npm; streaming avoids a second archive-sized allocation.
  const hash = createHash("sha512");
  const chunks: AsyncIterable<Uint8Array> = createReadStream(file);
  for await (const chunk of chunks) hash.update(chunk);
  return `sha512-${hash.digest("base64")}`;
}

export async function requireArchiveIdentity(actual: string, expected: string): Promise<void> {
  if ((await archiveIntegrity(actual)) !== (await archiveIntegrity(expected)))
    throw new Error(
      "Cleaned archive differs from the reviewed bytes; stop publication and prepare a new reviewed candidate.",
    );
}

export async function cleanPackage(
  directory: string,
  destination: string,
  mode: "prepare" | "publish",
  env: NodeJS.ProcessEnv = {},
  git: "clean" | "working-tree" = "clean",
): Promise<PackageArchive> {
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length > 0)
    throw new Error(`${destination} must be empty before packing.`);
  if (directory === ALIAS_DIRECTORY) await writeAlias();
  const manifest = (await Bun.file(path.join(directory, "package.json")).json()) as {
    name: string;
    version: string;
  };
  const distTag = (manifest.version.split("+", 1)[0]?.includes("-") ?? false) ? "next" : "latest";
  await releaseCommand(
    [
      process.execPath,
      path.resolve("node_modules/.bin/publish-clean"),
      ...(mode === "prepare" ? ["verify"] : []),
      directory,
      "--tarball-out",
      path.resolve(destination),
      ...(git === "working-tree" ? ["--no-git-checks"] : []),
      "--",
      "--access",
      "public",
      "--tag",
      distTag,
      "--provenance",
    ],
    // Build is a prerequisite; pack hooks must not reinstall tools in a credentialed upload step.
    { ...env, npm_config_ignore_scripts: "true" },
  );
  const files = await readdir(destination);
  const [name] = files;
  if (files.length !== 1 || name === undefined || !name.endsWith(".tgz"))
    throw new Error(`${destination} must contain exactly one cleaned archive.`);
  const file = path.resolve(destination, name);
  // A type assertion cannot remove source-manifest fields from the retained release identity.
  return {
    name: manifest.name,
    version: manifest.version,
    directory,
    file,
    integrity: await archiveIntegrity(file),
  };
}

export function preparePackages(
  destination: string,
  git: "clean" | "working-tree" = "clean",
): Promise<PackageArchive[]> {
  return Promise.all(
    PACKAGE_DIRECTORIES.map((directory, index) =>
      cleanPackage(directory, path.join(destination, String(index)), "prepare", {}, git),
    ),
  );
}
