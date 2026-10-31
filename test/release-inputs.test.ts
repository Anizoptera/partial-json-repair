import { expect, it } from "vitest";
import { releaseInputs } from "../scripts/release-inputs";
import { changelogNotes } from "../scripts/release-notes";
import { PACKAGE_DIRECTORIES } from "../scripts/package-artifacts";
import { requirePublicationContext } from "../scripts/release-publish";

it("rejects narrowing, reordering or escaping the original release pair", () => {
  // Restored JSON, unlike a TypeScript caller, can omit the unpublished alias after a main upload.
  const input = {
    tag: "v0.1.0",
    version: "0.1.0",
    commit: "source",
    preview: false,
    notesIntegrity: "sha512-notes",
    comparisons: [],
    reportIntegrity: "sha512-report",
    packages: PACKAGE_DIRECTORIES.map((directory, index) => ({
      directory,
      name: String(index),
      version: "0.1.0",
      file: `packages/${index}/package.tgz`,
      integrity: "sha512-archive",
    })),
  };
  expect(releaseInputs(input).packages).toHaveLength(PACKAGE_DIRECTORIES.length);
  expect(() => releaseInputs({ ...input, packages: input.packages.slice(0, 1) })).toThrow(
    "Both original npm packages",
  );
  expect(() => releaseInputs({ ...input, packages: input.packages.toReversed() })).toThrow(
    "order changed",
  );
  expect(() =>
    releaseInputs({
      ...input,
      packages: input.packages.map((item) => Object.assign({}, item, { file: "../outside.tgz" })),
    }),
  ).toThrow("inside the release evidence");
});

it("refuses laptop, private-mirror and branch publication before registry work", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "Anizoptera/partial-json-repair",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v0.1.0",
  };
  expect(() => {
    requirePublicationContext(env, "v0.1.0");
  }).not.toThrow();
  for (const changed of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "someone/partial-json-repair-fork" },
    { GITHUB_REF_TYPE: "branch" },
    { GITHUB_REF_NAME: "v0.2.0" },
  ])
    expect(() => {
      requirePublicationContext({ ...env, ...changed }, "v0.1.0");
    }).toThrow("tagged GitHub Actions");
});

it("does not borrow another release's prose when its own section is missing or empty", () => {
  const text = "## 0.2.0 — date\n\n## 0.1.0 — date\n\nPreserve source digits.\n";
  expect(changelogNotes(text, "0.1.0")).toBe("Preserve source digits.");
  expect(() => changelogNotes(text, "0.2.0")).toThrow("has no release notes");
  expect(() => changelogNotes(text, "0.3.0")).toThrow("exactly one");
});

it("ignores fenced release headings and refuses duplicate real sections", () => {
  const fenced =
    "```md\n## Unreleased\n## 0.2.0 — date\nFake notes\n```\n\n## 0.1.0 — date\nReal notes\n";
  expect(() => changelogNotes(fenced, "0.2.0")).toThrow();
  expect(changelogNotes(fenced, "0.1.0")).toBe("Real notes");
  expect(() => changelogNotes("## 0.1.0\nFirst\n## 0.1.0\nSecond\n", "0.1.0")).toThrow();
  expect(() => changelogNotes("## 0.1.0\nUndated notes", "0.1.0")).toThrow("date the release");
  expect(() => changelogNotes(`## Unreleased\nPending notes\n${fenced}`, "0.1.0")).toThrow(
    "still has notes",
  );
  expect(changelogNotes(`${fenced}\n## Unreleased\n`, "0.1.0")).toBe("Real notes");
});

// GitHub shows every line break in a release body, so wrapped prose must arrive joined.
it("joins wrapped prose but keeps code blocks, hard breaks and list structure", () => {
  const section =
    "## 0.1.0 — date\n\nOne\nparagraph.\n\n- **Item** wraps\n  here.\n- Next\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nHard\\\nbreak\n";
  expect(changelogNotes(section, "0.1.0")).toBe(
    "One paragraph.\n\n- **Item** wraps here.\n- Next\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nHard\\\nbreak",
  );
});

it("retains both historical package states and refuses narrowing or changing their identity", () => {
  const packages = PACKAGE_DIRECTORIES.map((directory, index) => ({
    directory,
    name: String(index),
    version: "0.2.0",
    file: `packages/${index}/package.tgz`,
    integrity: "sha512-current",
  }));
  const historical = packages.map((item, index) =>
    index === 0
      ? {
          name: item.name,
          version: "0.1.0",
          published: true,
          file: "history/immediate/0.tgz",
          integrity: "sha512-previous",
        }
      : { name: item.name, version: "0.1.0", published: false },
  );
  const comparison = {
    role: "immediate",
    tag: "v0.1.0",
    commit: "old-source",
    packages: historical,
  };
  const input = {
    tag: "v0.2.0",
    version: "0.2.0",
    commit: "source",
    preview: false,
    notesIntegrity: "sha512-notes",
    reportIntegrity: "sha512-report",
    packages,
    comparisons: [comparison],
  };
  expect(releaseInputs(input).comparisons[0]?.packages[1]?.published).toBe(false);
  expect(() =>
    releaseInputs({ ...input, comparisons: [{ ...comparison, packages: historical.slice(0, 1) }] }),
  ).toThrow("both package states");
  expect(() =>
    releaseInputs({ ...input, comparisons: [comparison, { ...comparison, role: "stable" }] }),
  ).toThrow("duplicated");
  expect(() =>
    releaseInputs({
      ...input,
      comparisons: [
        {
          ...comparison,
          packages: historical.map((item) =>
            item.published ? { ...item, file: "../outside.tgz" } : item,
          ),
        },
      ],
    }),
  ).toThrow("inside retained history");
  expect(() =>
    releaseInputs({
      ...input,
      comparisons: [
        {
          ...comparison,
          packages: historical.map((item) => Object.assign({}, item, { published: false })),
        },
      ],
    }),
  ).toThrow("identity is incomplete");
});
