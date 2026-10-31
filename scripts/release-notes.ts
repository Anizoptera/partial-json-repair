import { fromMarkdown } from "mdast-util-from-markdown";

interface TextNode {
  type: string;
  value?: string;
  children?: readonly TextNode[];
}

const text = (node: TextNode): string => node.value ?? node.children?.map(text).join("") ?? "";

export function changelogNotes(changelog: string, version: string): string {
  return unwrapParagraphs(releaseNotes(changelog, version).trim());
}

interface PositionedNode extends TextNode {
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: readonly PositionedNode[];
}

/**
 * Joins the line breaks the changelog wraps its paragraphs and list items at. GitHub renders every
 * line break in a release body as a visible break, so wrapped notes would show ragged lines. Code
 * blocks and explicit hard breaks keep theirs.
 */
function unwrapParagraphs(markdown: string): string {
  const ranges: [number, number][] = [];
  const walk = (node: PositionedNode): void => {
    if (node.type === "paragraph") {
      const { start, end } = node.position ?? { start: {}, end: {} };
      if (
        start.offset !== undefined &&
        end.offset !== undefined &&
        node.children?.some((child) => child.type === "break") !== true
      )
        ranges.push([start.offset, end.offset]);
      return;
    }
    if (node.type !== "code") for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(markdown) as PositionedNode);
  let out = markdown;
  for (const [start, end] of ranges.toReversed())
    out =
      out.slice(0, start) +
      out.slice(start, end).replaceAll(/\n[ \t]*(?:>[ \t]*)*/gu, " ") +
      out.slice(end);
  return out;
}

/** Select a real top-level release section and preserve its body bytes, including fences. */
function releaseNotes(markdown: string, version: string): string {
  const nodes = fromMarkdown(markdown).children;
  const matches = nodes.flatMap((node, index) => {
    if (node.type !== "heading" || node.depth !== 2) return [];
    const label = text(node).split(/\s/u, 1)[0];
    return label === version || label === `[${version}]` ? [index] : [];
  });
  const index = matches[0];
  if (matches.length !== 1 || index === undefined)
    throw new Error(
      `CHANGELOG.md must have exactly one ## [${version}] section. Draft, edit and commit it before releasing.`,
    );
  const heading = nodes[index];
  if (heading === undefined || !text(heading).startsWith(`${version} — `))
    throw new Error(`CHANGELOG.md has no "## ${version} — <date>" heading; date the release.`);
  // The same syntax tree must judge all headings: code examples are not pending releases.
  for (const [pending, node] of nodes.entries()) {
    if (node.type !== "heading" || node.depth !== 2 || text(node) !== "Unreleased") continue;
    const remaining = nodes.slice(pending + 1);
    const next = remaining.findIndex((item) => item.type === "heading" && item.depth <= 2);
    if ((next < 0 ? remaining : remaining.slice(0, next)).length > 0)
      throw new Error(
        `CHANGELOG.md still has notes under "## Unreleased"; move them into ${version}`,
      );
  }
  const start = heading?.position?.end.offset;
  if (start === undefined) throw new Error("Release heading has no source position.");
  const following = nodes.slice(index + 1);
  const boundary = following.findIndex((node) => node.type === "heading" && node.depth <= 2);
  const body = boundary < 0 ? following : following.slice(0, boundary);
  if (
    !body.some(
      (node) =>
        node.type !== "definition" &&
        node.type !== "html" &&
        node.type !== "heading" &&
        node.type !== "thematicBreak",
    )
  )
    throw new Error(`CHANGELOG.md section ${version} has no release notes.`);
  const end = boundary < 0 ? markdown.length : following[boundary]?.position?.start.offset;
  if (end === undefined) throw new Error("Release boundary has no source position.");
  return markdown.slice(start, end);
}

/**
 * Renames the notes declare as `` `old` → `new` ``, or as lists of the same length
 * (`` `A`, `B` and `C` → `X`, `Y` and `Z` ``), by leading identifier: `` `parse(input)` ``
 * names `parse`. The release diff pairs exactly these declarations; it never guesses renames.
 * A code span that does not start with an identifier, such as `` `codec.migration` ``, pairs nothing.
 */
export function declaredRenames(markdown: string): Map<string, string> {
  const renames = new Map<string, string>();
  const walk = (node: TextNode): void => {
    // `run` collects adjacent code spans; after an arrow, `left` waits for a run as long as itself.
    let run: (string | undefined)[] = [];
    let left: (string | undefined)[] | undefined;
    for (const child of node.children ?? []) {
      if (child.type === "inlineCode") {
        run.push(/^([A-Za-z_$][\w$]*)(?:$|[(<])/u.exec(child.value ?? "")?.[1]);
        if (left?.length !== run.length) continue;
        for (const [index, from] of left.entries()) {
          const to = run[index];
          if (from !== undefined && to !== undefined) renames.set(from, to);
        }
        left = undefined;
        run = [];
      } else if (child.type === "text" && child.value?.trim() === "→" && run.length > 0) {
        left = run;
        run = [];
      } else if (child.type !== "text" || !/^\s*(,|,? and)?\s*$/u.test(child.value ?? "")) {
        run = [];
        left = undefined;
        walk(child);
      }
    }
  };
  walk(fromMarkdown(markdown));
  return renames;
}
