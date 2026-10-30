import { fromMarkdown } from "mdast-util-from-markdown";
import { records, reachable } from "./api-declarations";
import type { DeclarationRecord } from "./api-declarations";

export type ReleaseLevel = "prerelease" | "patch" | "minor" | "major";

export type ApiDifference =
  | { readonly changed: false; readonly level: "patch" }
  | { readonly changed: true; readonly report: string; readonly level: ReleaseLevel };

/** Consumer-facing API changes, each a Markdown fragment or empty, placed under the matching notes heading. */
export interface ApiSections {
  readonly breaking: string;
  readonly changed: string;
  readonly added: string;
}

export function combineReleaseLevels(...levels: readonly ReleaseLevel[]): ReleaseLevel {
  return levels.includes("major") ? "major" : levels.includes("minor") ? "minor" : "patch";
}

function fencedDiff(lines: readonly string[]): string {
  const body = lines.join("\n");
  const fence = "`".repeat(
    Math.max(3, ...[...body.matchAll(/`+/gu)].map(([run]) => run.length + 1)),
  );
  return `${fence}diff\n${body}\n${fence}`;
}

// A wholly added or removed declaration shows its own row on one line, not each member.
function headerRows(rows: readonly DeclarationRecord[], root: string): string[] {
  return rows
    .filter((row) => row.family === root)
    .map(({ text }) =>
      text.startsWith(`${root}: `)
        ? text.slice(root.length + 2).replace(/\{\n\}$/u, "{ … }")
        : text,
    );
}

// Rows of `list` that `other` also has, in `list`'s order and count, comparable as one string.
function shared(list: readonly string[], other: readonly string[]): string {
  return JSON.stringify(list.filter((text) => other.includes(text)));
}

// `export {}` only marks the file as a module; it is no API.
function isApiRow({ text }: DeclarationRecord): boolean {
  return text !== "export {};";
}

/**
 * One declaration's change, or a rename's: `roots` are its old and new top-level names. Rows keep
 * each member's old form directly above its new one.
 */
interface DiffGroup {
  roots: string[];
  // "  " marks an unchanged export whose unexported dependency changed.
  rows: (readonly ["- " | "+ " | "  ", string])[];
}

const removedRows = (texts: readonly string[]) => texts.map((text) => ["- ", text] as const);

const addedRows = (texts: readonly string[]) => texts.map((text) => ["+ ", text] as const);

/**
 * A reader upgrading code looks up one declaration and needs its old and new forms side by side,
 * so each group prints its removed rows directly above its added ones. GitHub colours only whole
 * diff lines; the `@@ old → new @@` hunk header names what changed in words. A group of one row
 * needs no header: the row names itself. Under a header, member rows drop their `Owner: ` prefix
 * and declarations drop the `export declare` every exported row shares.
 */
function sectionDiff(groups: readonly DiffGroup[]): string {
  if (groups.length === 0) return "";
  const rendered = groups.map(({ roots, rows }) => {
    // A nameless statement such as `export { a as b }` is keyed by its syntax kind, which no
    // reader knows; its rows describe themselves, so only a name the rows declare gets a header.
    const named = new RegExp(
      `(?<![\\p{ID_Continue}$])${RegExp.escape(roots[0] ?? "")}(?![\\p{ID_Continue}$])`,
      "u",
    );
    const header =
      roots.length > 1 ||
      rows.some(([prefix]) => prefix === "  ") ||
      (rows.length > 1 && rows.some(([, text]) => named.test(text)));
    const name =
      roots.length > 1
        ? `${roots.slice(0, -1).join(", ")} → ${roots.at(-1)}`
        : rows.some(([prefix]) => prefix === "  ")
          ? `${roots.join("")} (uses a changed private type)`
          : roots.join("");
    return {
      header,
      lines: [
        ...(header ? [`@@ ${name} @@`] : []),
        ...rows.flatMap(([prefix, text]) => {
          const owner = header ? roots.find((root) => text.startsWith(`${root}: `)) : undefined;
          // `export default …` and `export { … }` keep `export`: without it they say nothing.
          // A container's own row holds no members (they are rows of their own): `{ … }` says so.
          const shown = (owner === undefined ? text : text.slice(owner.length + 2))
            .replace(
              /^export (?:declare )?(?=(?:abstract )?(?:class|const|enum|function|interface|let|namespace|type|var)\b)/u,
              "",
            )
            .replace(/\{\n\}$/u, "{ … }");
          // Not declarationLines: a stripped member such as `"a-b": string;` is not a JSON row.
          return shown.split("\n").map((line) => prefix + line);
        }),
      ],
    };
  });
  // A row below a header reads as part of that group, so rows without a header come first.
  return fencedDiff(
    [
      ...rendered.filter(({ header }) => !header),
      ...rendered.filter(({ header }) => header),
    ].flatMap(({ lines }) => lines),
  );
}

/**
 * Sorts changed public declarations into the notes sections a caller acts on. Callers cannot
 * import an unexported type, so its rows never appear; when one changes, the unchanged exports
 * that use it appear instead, as context lines in that change's section, which keeps both the
 * reader and the release level informed. The prose says what changed inside.
 * A wholly removed or added declaration shows only its own rows, not every member. `renames` maps
 * old top-level names to new ones as the changelog prose declares them; renames are never guessed,
 * because similar names and signatures pair the wrong declarations too often to publish.
 */
export function typeScriptApiSections(
  before: string,
  after: string,
  incompatible: ReadonlySet<string>,
  renames: ReadonlyMap<string, string> = new Map(),
): ApiSections {
  const previous = records(before);
  const current = records(after);
  const publicRoots = (rows: readonly DeclarationRecord[]) =>
    reachable(
      rows,
      rows.filter(({ visible }) => visible).map(({ root }) => root),
    );
  const shown = new Set([...publicRoots(previous), ...publicRoots(current)]);
  // Breaking: an incompatible export, the types it uses, or a row naming it (`export { a as b }`).
  const breakingRoots = new Set([
    ...reachable(previous, incompatible),
    ...reachable(current, incompatible),
    ...[...previous, ...current]
      .filter(({ refs }) => refs.some((name) => incompatible.has(name)))
      .map(({ root }) => root),
  ]);
  // Public: exported directly, or named by an export statement (`export { a as b }`, `export default a`).
  const exportedRoots = new Set<string>();
  for (const { root, refs, text, visible } of [...previous, ...current]) {
    if (!visible) continue;
    exportedRoots.add(root);
    if (/^export (?:\{|default\b)/u.test(text)) for (const name of refs) exportedRoots.add(name);
  }
  const sections = {
    breaking: [] as DiffGroup[],
    changed: [] as DiffGroup[],
    added: [] as DiffGroup[],
  };
  const hidden: { root: string; target: DiffGroup[] }[] = [];
  for (const root of new Set([...previous, ...current].map((row) => row.root))) {
    if (!shown.has(root)) continue;
    // A new or removed unexported type is never named by callers; the exports using it show the change.
    const exportedRoot = exportedRoots.has(root);
    const visibleRoot = [...previous, ...current].some((row) => row.root === root && row.visible);
    // An export shows only rows callers can reach: private brand members stay hidden.
    const rowsOf = (rows: readonly DeclarationRecord[]) =>
      rows.filter((row) => row.root === root && isApiRow(row) && (row.visible || !visibleRoot));
    const old = rowsOf(previous).map(({ text }) => text);
    const now = rowsOf(current).map(({ text }) => text);
    if (JSON.stringify(old) === JSON.stringify(now)) continue;
    if (old.length === 0) {
      if (exportedRoot)
        sections.added.push({ roots: [root], rows: addedRows(headerRows(current, root)) });
      continue;
    }
    if (now.length === 0) {
      if (exportedRoot)
        sections.breaking.push({ roots: [root], rows: removedRows(headerRows(previous, root)) });
      continue;
    }
    const family = (rows: readonly DeclarationRecord[], name: string) =>
      rowsOf(rows)
        .filter((row) => row.family === name)
        .map(({ text }) => text);
    const rows: DiffGroup["rows"] = [];
    let reordered = false;
    for (const name of new Set(
      [...rowsOf(previous), ...rowsOf(current)].map((row) => row.family),
    )) {
      const was = family(previous, name);
      const is = family(current, name);
      if (JSON.stringify(was) === JSON.stringify(is)) continue;
      // Kept overloads in another order or count change overload resolution; only the whole
      // family before and after shows that, since a row-by-row diff of identical text is empty.
      if (shared(was, is) === shared(is, was)) {
        rows.push(
          ...removedRows(was.filter((text) => !is.includes(text))),
          ...addedRows(is.filter((text) => !was.includes(text))),
        );
      } else {
        reordered = true;
        rows.push(...removedRows(was), ...addedRows(is));
      }
    }
    const target =
      reordered || breakingRoots.has(root)
        ? sections.breaking
        : rows.some(([prefix]) => prefix === "- ")
          ? sections.changed
          : sections.added;
    if (exportedRoots.has(root)) target.push({ roots: [root], rows });
    else hidden.push({ root, target });
  }
  // An unchanged export lands in the most severe section among the hidden changes it uses.
  const listed = new Set(
    Object.values(sections).flatMap((groups) => groups.map(({ roots }) => roots[0])),
  );
  if (hidden.length > 0)
    for (const user of exportedRoots) {
      if (listed.has(user)) continue;
      const uses = reachable(current, [user]);
      const target = [sections.breaking, sections.changed, sections.added].find((section) =>
        hidden.some((change) => change.target === section && uses.has(change.root)),
      );
      target?.push({
        roots: [user],
        rows: headerRows(current, user).map((text) => ["  ", text] as const),
      });
    }
  // A declared rename joins the old declaration's removal and the new one's addition into one
  // breaking group; several old names may merge into one new name.
  for (const [from, to] of renames) {
    const removal = sections.breaking.find(
      ({ roots, rows }) => roots[0] === from && rows.every(([prefix]) => prefix === "- "),
    );
    if (!removal) continue;
    const merged = sections.breaking.find(({ roots }) => roots.length > 1 && roots.at(-1) === to);
    if (merged) {
      merged.roots.splice(-1, 0, from);
      merged.rows.splice(
        merged.rows.findIndex(([prefix]) => prefix === "+ "),
        0,
        ...removal.rows,
      );
      sections.breaking.splice(sections.breaking.indexOf(removal), 1);
      continue;
    }
    const index = sections.added.findIndex(({ roots }) => roots[0] === to);
    const addition = sections.added[index];
    if (!addition || addition.rows.some(([prefix]) => prefix === "- ")) continue;
    sections.added.splice(index, 1);
    removal.roots.push(to);
    removal.rows.push(...addition.rows);
  }
  return {
    breaking: sectionDiff(sections.breaking),
    changed: sectionDiff(sections.changed),
    added: sectionDiff(sections.added),
  };
}

export function minimumRelease(
  version: string,
  notes: string,
  languages: readonly ReleaseLevel[],
): ReleaseLevel {
  if (version.split("+", 1)[0]?.includes("-") === true) return "prerelease";
  const headings = new Set(
    fromMarkdown(notes).children.flatMap((node) => {
      if (node.type !== "heading" || node.depth !== 3) return [];
      return [node.children.map((child) => (child.type === "text" ? child.value : "")).join("")];
    }),
  );
  const declared = headings.has("Breaking changes")
    ? "major"
    : headings.has("Added")
      ? "minor"
      : "patch";
  const strongest = combineReleaseLevels(declared, ...languages);
  return version.startsWith("0.") && strongest === "major" ? "minor" : strongest;
}

export function satisfiesMinimum(
  previous: string,
  current: string,
  minimum: ReleaseLevel,
): boolean {
  if (minimum === "prerelease" || previous.split("+", 1)[0]?.includes("-") === true) return true;
  const [oldMajorText, oldMinorText] = previous.split(".");
  const [newMajorText, newMinorText] = current.split(".");
  if (
    oldMajorText === undefined ||
    oldMinorText === undefined ||
    newMajorText === undefined ||
    newMinorText === undefined ||
    ![oldMajorText, oldMinorText, newMajorText, newMinorText].every((part) => /^\d+$/u.test(part))
  )
    return false;
  const oldMajor = BigInt(oldMajorText);
  const oldMinor = BigInt(oldMinorText);
  const newMajor = BigInt(newMajorText);
  const newMinor = BigInt(newMinorText);
  if (minimum === "major") return newMajor > oldMajor;
  if (minimum === "minor")
    return newMajor > oldMajor || (newMajor === oldMajor && newMinor > oldMinor);
  return Bun.semver.order(current, previous) > 0;
}

/** Release level an API change needs: any breaking change is major, any other change minor. */
export function sectionsLevel({ breaking, changed, added }: ApiSections): ReleaseLevel {
  return breaking ? "major" : changed || added ? "minor" : "patch";
}
