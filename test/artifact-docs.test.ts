import { expect, it } from "vitest";
import { assertReadmeLinksResolve, readArtifactDocument } from "../scripts/artifact-docs";

it("checks rendered destinations through nesting, titles and reference definitions", () => {
  for (const markdown of [
    '[guide](docs/API(v2).md "API guide")',
    "[guide][API]\n\n  [api]: docs/API(v2).md\n",
    "![guide][api]\n\n[api]: docs/API(v2).md\n",
  ]) {
    const document = readArtifactDocument(markdown);
    expect(() => {
      assertReadmeLinksResolve(["docs/API(v2).md"], document);
    }).not.toThrow();
    expect(() => {
      assertReadmeLinksResolve([], document);
    }).toThrow("docs/API(v2).md");
  }
});

it("ignores example text and unused definitions without ignoring a real link", () => {
  const document = readArtifactDocument(
    "```md\n[example](missing.md)\n```\n\n`[example](missing.md)`\n\n" +
      "[unused]: missing.md\n\n[guide](./README.md#usage)\n\n" +
      "[site](https://example.com/docs) [anchor](#usage) [cdn](//example.com/guide)",
  );
  expect(() => {
    assertReadmeLinksResolve(["README.md"], document);
  }).not.toThrow();
  expect(() => {
    assertReadmeLinksResolve([], document);
  }).toThrow("README.md#usage");
});

it("resolves duplicate reference definitions to the first destination", () => {
  for (const [first, second, allowed] of [
    ["README.md", "missing.md", true],
    ["missing.md", "README.md", false],
  ] as const) {
    const document = readArtifactDocument(`[guide][api]\n\n[api]: ${first}\n[api]: ${second}`);
    if (allowed)
      expect(() => {
        assertReadmeLinksResolve(["README.md"], document);
      }).not.toThrow();
    else
      expect(() => {
        assertReadmeLinksResolve(["README.md"], document);
      }).toThrow("missing.md");
  }
});

it("extracts actual TypeScript blocks with source lines and explicit compilation exclusions", () => {
  const markdown = [
    "````md",
    "```ts",
    "not an example",
    "```",
    "````",
    "",
    "~~~ts",
    "const first: number = 1;",
    "~~~",
    "",
    "<!-- not-compiled -->",
    "```typescript",
    "type Sketch =",
    "```",
    "",
    "> ```ts",
    "> const nested: number = 2;",
    "> ```",
  ].join("\n");
  expect(readArtifactDocument(markdown).examples).toEqual([
    { line: 8, source: "const first: number = 1;", compile: true },
    { line: 13, source: "type Sketch =", compile: false },
    { line: 17, source: "const nested: number = 2;", compile: true },
  ]);
});
