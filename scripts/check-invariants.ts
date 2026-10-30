// SPDX-License-Identifier: Apache-2.0

/**
 * The design invariants no linter here can express, checked on the AST of everything in `src/`.
 *
 * The first two were defects in the package this was extracted from, already forbidden in prose
 * there; the third, no work at import, is what lets a bundler drop an unused feature (HLD D5). A
 * rule that lives only in a document is exactly the failure being removed, so each one lives in the
 * lane instead — and each message names the defect it prevents, so an out-of-context reader
 * who trips it learns why in a line rather than deleting the check.
 *
 * Bypasses are closed deliberately, because each would have failed SILENTLY — the check would
 * still pass, while covering less than its name claims:
 * - the walk must REACH something; a scan of zero files satisfies every rule vacuously;
 * - the whole tree is walked, not one directory, or a module added under `src/stream/` escapes it;
 * - every mention of `RegExp` counts, not just `new RegExp`, so `RegExp(s)` and passing the
 *   constructor along are caught too;
 * - the regex ban covers all of `src/`, not a named file, so splitting or renaming the scanner
 *   cannot quietly drop it. There is no legitimate regex in this package's runtime code; if one is
 *   ever needed, that is a decision to argue for, not a rule to erode.
 *
 * The AST, not a text scan: `export *` inside a string and a slash that begins a division are both
 * things a text scan gets wrong, in opposite directions. `typescript` is already a dependency for the
 * corpus tooling, so this costs nothing new.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The classic compiler API (`createSourceFile`) exists only up to TypeScript 6; the 7.x package
// exports no such API, so AST tools read source through the `typescript-6` alias.
import ts from "typescript-6";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Modules whose import IS their job: the worker entry starts listening for messages when loaded.
 * Everything else must do nothing at import (HLD D5), or a bundler keeps it in apps that never call it.
 */
const IMPORT_EFFECT_ENTRIES: ReadonlySet<string> = new Set(["async-worker.ts"]);

const IMPORT_WORK =
  "runs at import — a bundler must keep it, so this module ships in apps that never use it (HLD D5). " +
  "Build the value inside a function and call it once at top level as `/* @__PURE__ */ f(...)`, " +
  "with plain literals or names as arguments, or annotate a call that truly has no effect";

/** Whether a call or `new` carries a PURE annotation; an initialiser's leading trivia starts before its `=`. */
const annotated = (node: ts.Node, text: string): boolean =>
  /[@#]__PURE__/u.test(text.slice(node.pos, node.getStart()));

/**
 * Whether evaluating an argument certainly does nothing. A PURE annotation covers the call alone:
 * esbuild still evaluates its arguments and keeps the statement when one might act, as a property
 * read (`Number.POSITIVE_INFINITY`, which could be a getter) or a spread (`...defaults`) might.
 * Measured: both kept their module in import-only bundles while every call was annotated.
 */
const inert = (node: ts.Expression): boolean => {
  if (
    ts.isLiteralExpression(node) ||
    ts.isIdentifier(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return inert(node.expression);
  if (ts.isPrefixUnaryExpression(node)) return ts.isNumericLiteral(node.operand);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every((element) => !ts.isSpreadElement(element) && inert(element));
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (property) =>
        ts.isShorthandPropertyAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          inert(property.initializer)),
    );
  if (ts.isCallExpression(node) || ts.isNewExpression(node))
    return (
      annotated(node, node.getSourceFile().text) &&
      (node.arguments ?? []).every((argument) => inert(argument))
    );
  return false;
};

/** Reports every call or `new` evaluated at import, outside function and class bodies. */
const evaluatedCalls = (node: ts.Node, report: (node: ts.Node, message: string) => void): void => {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    if (!annotated(node, node.getSourceFile().text))
      report(node, `unannotated call ${IMPORT_WORK}`);
    else if (!(node.arguments ?? []).every((argument) => inert(argument)))
      report(
        node,
        `annotated call whose arguments may act (a property read, spread or unannotated call) ${IMPORT_WORK}`,
      );
  }
  ts.forEachChild(node, (child) => {
    evaluatedCalls(child, report);
  });
};

/**
 * Work a module does at import. A declaration does none; its initialisers and a class's static
 * members can, and any other statement (an assignment, a loop, a bare call, an `enum`, which compiles
 * to one) always does. `chars.ts` once filled its lookup tables with element writes here, which kept
 * it in import-only bundles while every call looked annotated.
 */
const importWork = (st: ts.Statement, report: (node: ts.Node, message: string) => void): void => {
  if (
    ts.isImportDeclaration(st) ||
    ts.isExportDeclaration(st) ||
    ts.isFunctionDeclaration(st) ||
    ts.isTypeAliasDeclaration(st) ||
    ts.isInterfaceDeclaration(st)
  )
    return;
  if (ts.isVariableStatement(st)) {
    for (const declaration of st.declarationList.declarations)
      if (declaration.initializer !== undefined) evaluatedCalls(declaration.initializer, report);
    return;
  }
  if (ts.isClassDeclaration(st)) {
    for (const member of st.members) {
      const modifiers = ts.getModifiers(member as ts.HasModifiers);
      // Type-only fields erase their computed keys too; only emitted members can run at import.
      if (
        ts.isPropertyDeclaration(member) &&
        modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true
      )
        continue;
      if (ts.isClassStaticBlockDeclaration(member)) report(member, `static block ${IMPORT_WORK}`);
      // Evaluating a computed key may call `toString`, so esbuild keeps the whole class.
      if (member.name !== undefined && ts.isComputedPropertyName(member.name))
        report(member, `computed member key ${IMPORT_WORK}`);
      const isStatic = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (isStatic === true && ts.isPropertyDeclaration(member) && member.initializer !== undefined)
        evaluatedCalls(member.initializer, report);
    }
    return;
  }
  report(st, `statement ${IMPORT_WORK}`);
};

/** Whether any UTF-16 unit lies outside ASCII; a surrogate half counts, as its pair would. */
const nonAscii = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return true;
  return false;
};

const problems: string[] = [];
let files = 0;

for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  files++;
  const path = join(entry.parentPath, entry.name);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const at = (node: ts.Node, message: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    problems.push(`${path.slice(SRC.length + 1)}:${line + 1}: ${message}`);
  };

  const visit = (node: ts.Node): void => {
    // `export *` re-exports whatever a module happens to hold, so what is public becomes a
    // consequence of a file's contents rather than a decision. The extracted package had eight of
    // them; its real entry was a curated list, and the barrel misled every reader who found it
    // first. An explicit list also makes a leaked mutable constant structurally impossible.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.exportClause) {
      at(node, "`export *` — name every export, or a file's contents decide the public surface");
    }
    // A regular expression cannot match balanced delimiters, and that is the whole cause of the
    // silent truncation this package was rewritten to remove: the extractor pulled candidate JSON
    // with a non-greedy `/(\{[\s\S]*?\}|\[[\s\S]*?\])/g`, so nested input came back as a DIFFERENT
    // object — root key gone, sibling gone, nothing in `repairs` to say so. Counting is the shape of
    // that answer; matching is not.
    if (ts.isRegularExpressionLiteral(node) || (ts.isIdentifier(node) && node.text === "RegExp")) {
      at(
        node,
        "regular expression — regex cannot match balanced delimiters, and structure here is nested",
      );
    }
    // A loader that decodes a bundle as Latin-1 turns one non-ASCII character into several, silently.
    // Bun reads any file starting with `// @bun` that way, and `Bun.build` writes that header unescaped
    // for a `#!/usr/bin/env bun` entry built for another target; a browser does it for a script served
    // with no charset. The default cut suffix then appended `â€¦`, and the UTF-8 decoder stopped
    // recognising U+FFFD, so malformed bytes went uncounted and the verdict changed. The VALUE is
    // judged, not the spelling: bundlers re-emit a `\u` escape as the raw character.
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      nonAscii(node.text)
    ) {
      at(
        node,
        "non-ASCII character in a literal — a bundle read as Latin-1 corrupts it; build it at use with `String.fromCharCode` (a `\\u` escape is re-emitted raw)",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!IMPORT_EFFECT_ENTRIES.has(entry.name))
    for (const st of source.statements) importWork(st, at);
}

// Every rule above is satisfied by an empty tree, so "found nothing forbidden" and "looked at
// nothing" print the same line and exit the same way. Measured: with `src/` emptied, this reported
// `over 0 files in src/` and passed. Renaming the directory, or moving the sources to an extension
// this walk does not name, leaves the lane green over code nobody checked -- and the build and the
// tests would still be passing, because they read the sources by their own paths.
if (files === 0) {
  problems.push(
    `no .ts files found under ${SRC} — this check scanned nothing, so it proves nothing`,
  );
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(
  `invariants: no \`export *\`, no regex, no import-time work, no non-ASCII literal, over ${files} files in src/`,
);
