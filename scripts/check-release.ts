import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript-6";
import { PACKAGE_DIRECTORIES, archiveIntegrity, releaseManifests } from "./package-artifacts";
import type { PackageArchive } from "./package-artifacts";
import { typedEntries } from "./api-extraction";
import { prepareHistory, selectReleaseComparisons } from "./release-history";
import type { ComparisonInput } from "./release-history";
import { registryHistory, historicalVersion, downloadRegistryArchive } from "./registry-integrity";
import { analyzeHistory } from "./release-analysis";
import { satisfiesMinimum } from "./release-comparison";
import { verifyExtractedVisibility } from "../test/api-extraction-probe";

const root = process.cwd();
const work = await mkdtemp(path.join(tmpdir(), "pjr-release-contract-"));
let stopRegistry: (() => Promise<void>) | undefined;
try {
  // Extraction invokes one fixed Bun/compiler toolchain, independent of the unit-test parent.
  // Check it once here rather than repeating the same subprocess under both test runners.
  await verifyExtractedVisibility();
  assert.deepEqual(selectReleaseComparisons("v0.1.0", []), {});
  assert.deepEqual(selectReleaseComparisons("v0.1.1", ["v0.1.1-beta.1", "v0.1.0"]), {
    immediate: "v0.1.1-beta.1",
    stable: "v0.1.0",
  });
  assert.deepEqual(selectReleaseComparisons("v0.3.1", ["v0.3.0", "v0.2.2", "v0.1.9", "v0.4.0"]), {
    immediate: "v0.3.0",
    releaseLine: "v0.2.2",
  });
  assert.throws(() => selectReleaseComparisons("v0.3.1", ["v0.3.0", "v0.3.0+other"]), /duplicate/u);
  const manifests = await releaseManifests();
  const [main, alias] = manifests;
  // Real emitted modules carry reference directives and imports that a review rollup may omit.
  const declarations = await Promise.all(
    (await readdir(path.join(root, "dist"), { recursive: true }))
      .filter((file) => file.endsWith(".d.ts"))
      .map(async (file) => ({
        file: `./dist/${file}`,
        source: await readFile(path.join(root, "dist", file), "utf8"),
      })),
  );
  const mainEntry = typedEntries({ exports: main.exports }).find((entry) => entry.entry === ".");
  const index = declarations.find((entry) => entry.file === mainEntry?.file);
  assert.ok(index);
  const syntax = ts.createSourceFile("previous.d.ts", index.source, ts.ScriptTarget.Latest, true);
  const parse = syntax.statements.findLast(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "parse",
  );
  assert.ok(
    parse,
    "The real public parse contract must be reached before planting an old-caller break.",
  );
  const oldApi = `${index.source.slice(0, parse.end)}\nexport declare function parse(input: Input, legacy: "previous-call"): unknown;\n${index.source.slice(parse.end)}`;
  const packFixtures = async (
    version: string,
    mode: "candidate" | "previous" = "candidate",
  ): Promise<PackageArchive[]> => {
    const selected = mode === "previous" ? manifests.slice(0, 1) : manifests;
    const results = await Promise.allSettled(
      selected.map(async (manifest, position) => {
        const metadata = {
          ...manifest,
          version,
          ...(position === 0 ? {} : { dependencies: { [main.name]: version } }),
        };
        const files: Record<string, string> = { "package/package.json": JSON.stringify(metadata) };
        if (position === 0)
          for (const declaration of declarations)
            files[`package/${declaration.file.slice(2)}`] =
              mode === "previous" && declaration.file === index.file ? oldApi : declaration.source;
        else files["package/index.d.ts"] = `export * from ${JSON.stringify(main.name)};\n`;
        const file = path.join(work, `${mode}-${version}-${position}.tgz`);
        // Explicit serialization preserves the requested encoding; Bun.write(Archive) may emit raw tar.
        await Bun.write(file, await new Bun.Archive(files, { compress: "gzip" }).bytes());
        const directory = PACKAGE_DIRECTORIES[position];
        assert.ok(directory !== undefined);
        return {
          name: manifest.name,
          version,
          directory,
          file,
          integrity: await archiveIntegrity(file),
        };
      }),
    );
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  };
  console.log("release contracts: creating archive fixtures");
  const old = (await packFixtures("0.1.0", "previous"))[0];
  assert.ok(old);
  const bytes = await Bun.file(old.file).bytes();
  const corrupt = bytes.slice();
  corrupt[0] = (corrupt[0] ?? 0) ^ 1;
  const emptyLookups = new Set<string>();
  // Faults belong at the external registry boundary; archive parsing, hashes and compilers stay real.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/empty/")) {
        emptyLookups.add(url.pathname);
        return new Response("missing", { status: 404 });
      }
      if (url.pathname.startsWith("/outage/")) return new Response("unavailable", { status: 503 });
      if (url.pathname === "/previous.tgz") return new Response(bytes);
      if (url.pathname === "/corrupt.tgz") return new Response(corrupt);
      if (url.pathname === `/${encodeURIComponent(main.name)}`)
        return Response.json({
          versions: {
            "0.1.0": {
              name: main.name,
              version: "0.1.0",
              dist: { integrity: old.integrity, tarball: `${url.origin}/previous.tgz` },
            },
          },
        });
      return new Response("missing", { status: 404 });
    },
  });
  stopRegistry = () => server.stop(true);
  const registry = `http://127.0.0.1:${server.port}`;
  const first = path.join(work, "first");
  // The alias manifest derives from this one.
  await mkdir(first, { recursive: true });
  await writeFile(path.join(first, "package.json"), JSON.stringify(main));
  console.log("release contracts: checking empty registry history");
  process.chdir(first);
  const empty = await prepareHistory(
    "v0.1.0",
    path.join(work, "empty-history"),
    `${registry}/empty`,
  );
  assert.deepEqual(empty, []);
  assert.equal(emptyLookups.size, PACKAGE_DIRECTORIES.length);
  assert.deepEqual(await readdir(path.join(work, "empty-history")), []);
  process.chdir(root);
  await assert.rejects(registryHistory(main.name, `${registry}/outage`), /503/u);
  console.log("release contracts: checking downloaded archive identity");
  const history = await registryHistory(main.name, registry);
  const previous = historicalVersion(history, "0.1.0", main.name);
  assert.ok(previous);
  assert.throws(() => historicalVersion(history, "0.0.9", main.name), /never substitute/u);
  await mkdir(path.join(work, "history", "immediate"), { recursive: true });
  const retained = path.join(work, "history", "immediate", "0.tgz");
  await downloadRegistryArchive(previous, retained);
  assert.equal(await archiveIntegrity(retained), previous.integrity);
  const wrong = path.join(work, "corrupt.tgz");
  try {
    await assert.rejects(
      downloadRegistryArchive({ ...previous, tarball: `${registry}/corrupt.tgz` }, wrong),
      /differs from registry integrity/u,
    );
  } finally {
    await rm(wrong, { force: true });
  }
  const comparisons: ComparisonInput[] = [
    {
      role: "immediate",
      tag: "v0.1.0",
      commit: "fixture-source",
      packages: [
        {
          name: main.name,
          version: "0.1.0",
          published: true,
          file: "history/immediate/0.tgz",
          integrity: previous.integrity,
        },
        { name: alias.name, version: "0.1.0", published: false },
      ],
    },
  ];
  const prose = "### Breaking changes\n\nPass options instead of the previous-call argument.\n";
  console.log("release contracts: checking published API and version effects");
  const result = await analyzeHistory(
    await packFixtures("0.2.0"),
    comparisons,
    work,
    "0.2.0",
    prose,
  );
  const report = result.comparisons[0];
  assert.ok(report);
  assert.equal(report.minimum, "minor");
  assert.equal(satisfiesMinimum("0.1.0", "0.1.1", report.minimum), false);
  assert.equal(satisfiesMinimum("0.1.0", "0.2.0", report.minimum), true);
  assert.ok(result.notes.includes("Pass options instead of the previous-call argument."));
  assert.ok(result.notes.includes("parse"));
  assert.ok(
    report.packages.some(
      (item) => item.level === "major" && item.sections.breaking.includes("parse"),
    ),
    `Removing the published parse overload must be a breaking main-package change; got ${JSON.stringify(report.packages)}`,
  );
  assert.ok(
    !result.notes.includes("class Builder"),
    "Private implementation inventories must stay out of consumer notes.",
  );
  console.log(
    "release contracts: empty and populated history, registry faults, real API compilers and breaking 0.x version control passed",
  );
} finally {
  process.chdir(root);
  if (stopRegistry !== undefined) await stopRegistry();
  await rm(work, { recursive: true, force: true });
}
