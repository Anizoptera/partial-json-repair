import { fromMarkdown } from "mdast-util-from-markdown";
import type { CompileContext } from "mdast-util-from-markdown";

export const NOT_COMPILED = "<!-- not-compiled -->";
/** Documents whose TypeScript blocks a reader copies; each must compile against the packed package. */
export const DOCUMENTED: readonly string[] = ["README.md", "docs/API.md"];
type MarkdownNode = Parameters<CompileContext["enter"]>[0];
type DocumentExample = {
  readonly line: number;
  readonly source: string;
  readonly compile: boolean;
};

export function readArtifactDocument(markdown: string): {
  links: readonly string[];
  examples: readonly DocumentExample[];
} {
  // Rendered syntax owns both checks: fences and inline code cannot create links, and references
  // can precede their definitions. The parser's node union avoids a second syntax model.
  const links: string[] = [];
  const references: string[] = [];
  const definitions = new Map<string, string>();
  const examples: DocumentExample[] = [];
  const lines = markdown.split("\n");
  const visit = (node: MarkdownNode): void => {
    if (node.type === "link" || node.type === "image") links.push(node.url);
    if (node.type === "linkReference" || node.type === "imageReference")
      references.push(node.identifier);
    // CommonMark resolves duplicate definitions to their first occurrence.
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if (node.type === "code" && (node.lang === "ts" || node.lang === "typescript")) {
      const line = node.position?.start.line;
      if (line === undefined) throw new Error("Markdown code block has no source position");
      examples.push({
        line: line + 1,
        source: node.value,
        compile: lines[line - 2] !== NOT_COMPILED,
      });
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromMarkdown(markdown));
  for (const reference of references) {
    const target = definitions.get(reference);
    if (target !== undefined) links.push(target);
  }
  return { links, examples };
}

/**
 * Repository files the build ships under another name. The consumer agent guide cannot ship as a
 * root AGENTS.md (that name steers contributors here), so the build copies it to dist/AGENTS.md;
 * a README link to the source name is satisfied by the shipped copy.
 */
const SHIPPED_AS: ReadonlyMap<string, string> = new Map([["CONSUMER-AGENTS.md", "dist/AGENTS.md"]]);

export function assertReadmeLinksResolve(
  files: readonly string[],
  document: ReturnType<typeof readArtifactDocument>,
): void {
  // Relative documentation must remain usable from the unpacked package; derive its dependencies
  // from the rendered README instead of maintaining another list beside the publication allowlist.
  for (const target of document.links) {
    // A link leaving the repository root (`../../actions/...`) is a GitHub site route: the GitHub
    // README is the primary page and resolves it against `/<owner>/<repo>/blob/<branch>/`.
    if (
      target.startsWith("#") ||
      target.startsWith("//") ||
      target.startsWith("../") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(target)
    )
      continue;
    const file = target.replace(/#.*$/u, "").replace(/^\.\//u, "");
    if (file.length > 0 && !files.includes(SHIPPED_AS.get(file) ?? file))
      throw new Error(
        `README.md links ${target}, which the package does not ship. Ship it, use an absolute link, or remove the link.`,
      );
  }
}
