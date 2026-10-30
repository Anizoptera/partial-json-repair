import { expect, it } from "vitest";
import { appendApiSection, analyzeHistory } from "../scripts/release-analysis";
import { releaseVersion } from "../scripts/release-history";
import { historicalVersion } from "../scripts/registry-integrity";
import { npmReleaseSurface, npmSurfaceDifference } from "../scripts/release-surface";

it("keeps first-publication notes without inventing a predecessor or reading history archives", async () => {
  const notes = "### Added\n\nRecover streamed JSON.\n";
  const result = await analyzeHistory([], [], "no-history-directory", "0.1.0", notes);
  expect(result).toEqual({ notes, comparisons: [] });
});

it("requires real migration prose headings instead of fenced examples or duplicate sections", () => {
  const fenced = "```md\n### Breaking changes\nExample only\n```";
  expect(() => appendApiSection(fenced, "Breaking changes", "- parse changed")).toThrow(
    "caller migration",
  );
  expect(() => appendApiSection("### Added\nA\n### Added\nB", "Added", "C")).toThrow("duplicate");
  expect(() =>
    appendApiSection(
      "### Breaking changes\n\n### Fixed\nKeep digits.",
      "Breaking changes",
      "- parse changed",
    ),
  ).toThrow("caller migration");
  const prose =
    "### Breaking changes\n\nPass options explicitly.\n\n### Fixed\n\nKeep exact digits.";
  const result = appendApiSection(prose, "Breaking changes", "- parse(input, options)");
  expect(result).toContain("Pass options explicitly.\n\n- parse(input, options)\n\n### Fixed");
  expect(result.endsWith("Keep exact digits.")).toBe(true);
});

it("distinguishes an unpublished package from a missing selected version in existing history", () => {
  const archive = {
    integrity: "sha512-fixture",
    tarball: "https://registry.npmjs.org/package.tgz",
  };
  expect(historicalVersion(new Map(), "0.1.0", "partial-json-repair")).toBeUndefined();
  const history = new Map([["0.2.0", archive]]);
  expect(() => historicalVersion(history, "0.1.0", "partial-json-repair")).toThrow(
    "never substitute",
  );
  expect(historicalVersion(history, "0.2.0", "partial-json-repair")).toBe(archive);
});

it("rejects malformed and development publication versions while accepting intentional 0.x releases", () => {
  expect(releaseVersion("v0.2.0")).toBe("0.2.0");
  for (const tag of ["0.2.0", "v00.2.0", "v0.2", "v0.2.0-dev", "v0.2.0-dev.1", "v0.2.0-dev+build"])
    expect(() => releaseVersion(tag)).toThrow();
});

it("distinguishes export-condition priority from independent subpath ordering", () => {
  const surface = (exports: unknown, node = ">=22") =>
    npmReleaseSurface({ exports, engines: { node } });
  const before = surface({
    ".": { types: "./index.d.ts", default: "./index.js" },
    "./async": { types: "./async.d.ts", default: "./async.js" },
  });
  const reorder = surface({
    "./async": { types: "./async.d.ts", default: "./async.js" },
    ".": { types: "./index.d.ts", default: "./index.js" },
  });
  expect(npmSurfaceDifference(before, reorder)).toEqual({ changed: false, level: "patch" });
  expect(
    npmSurfaceDifference(before, surface({ ".": { default: "./index.js", types: "./index.d.ts" } }))
      .level,
  ).toBe("major");
  expect(
    npmSurfaceDifference(before, surface({ ".": { types: "./index.d.ts", default: "./index.js" } }))
      .level,
  ).toBe("major");
  expect(
    npmSurfaceDifference(surface({ ".": "./index.js" }, ">=20"), surface({ ".": "./index.js" }))
      .level,
  ).toBe("major");
});
