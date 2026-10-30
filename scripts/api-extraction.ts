import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript-6";
import { releaseCommand } from "./package-artifacts";
import { exported, valueExports } from "./api-declarations";

export interface ApiEntry {
  readonly entry: string;
  readonly declarations: string;
}

export interface ExtractedApiEntry extends ApiEntry {
  readonly values: readonly string[];
  readonly runtime: string;
}

// Documentation edits must not look like API changes, but deprecation remains a caller contract.
function declarations(source: string, values: ReadonlySet<string>): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  let result = "";
  let copied = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const comment =
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia;
    if (comment && !scanner.getTokenText().includes("@deprecated")) {
      result += source.slice(copied, scanner.getTokenStart());
      result += source
        .slice(scanner.getTokenStart(), scanner.getTokenEnd())
        .replaceAll(/[^\r\n]/gu, " ");
      copied = scanner.getTokenEnd();
    }
  }
  result += source.slice(copied);
  const file = ts.createSourceFile("public.d.ts", result, ts.ScriptTarget.Latest, true);
  const statements: ts.Statement[] = [];
  const hiddenValues = new Set<string>();
  for (const statement of file.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      statements.push(
        ts.factory.updateExportDeclaration(
          statement,
          statement.modifiers,
          false,
          ts.factory.updateNamedExports(
            statement.exportClause,
            statement.exportClause.elements.map((specifier) =>
              ts.factory.updateExportSpecifier(
                specifier,
                !values.has(specifier.name.text),
                specifier.propertyName,
                specifier.name,
              ),
            ),
          ),
          statement.moduleSpecifier,
          statement.attributes,
        ),
      );
      continue;
    }
    // Extractor can promote a type-only class re-export to `export declare class`. Keep its
    // declaration intact for instance types and typeof queries, but hide its runtime binding.
    if (
      exported(statement) &&
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isVariableStatement(statement))
    ) {
      const names = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(({ name }) => name.getText(file))
        : statement.name
          ? [statement.name.text]
          : [];
      if (names.length > 0 && names.every((name) => !values.has(name))) {
        for (const name of names) hiddenValues.add(name);
        statements.push(
          ts.factory.replaceModifiers(
            statement,
            ts.getModifiers(statement)?.filter(({ kind }) => kind !== ts.SyntaxKind.ExportKeyword),
          ),
        );
        continue;
      }
    }
    statements.push(statement);
  }
  if (hiddenValues.size > 0)
    statements.push(
      ts.factory.createExportDeclaration(
        undefined,
        true,
        ts.factory.createNamedExports(
          [...hiddenValues].map((name) => ts.factory.createExportSpecifier(false, undefined, name)),
        ),
        undefined,
      ),
    );
  return `${ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(ts.factory.updateSourceFile(file, statements)).trim()}\n`;
}

export function typedEntries(manifest: {
  exports?: unknown;
}): { entry: string; file: string; runtime: string }[] {
  // Read the actual export map, never a second list that misses a newly exposed subpath.
  if (
    manifest.exports === null ||
    typeof manifest.exports !== "object" ||
    Array.isArray(manifest.exports)
  )
    throw new Error("The package must declare its public exports.");
  const entries = Object.entries(manifest.exports).flatMap(([entry, target]: [string, unknown]) => {
    if (typeof target === "string") return [];
    if (
      target === null ||
      typeof target !== "object" ||
      !("types" in target) ||
      typeof target.types !== "string" ||
      !("default" in target) ||
      typeof target.default !== "string"
    )
      throw new Error(
        `Export ${entry} needs explicit types and default conditions before API extraction.`,
      );
    if (
      !(entry === "." || entry.startsWith("./")) ||
      !target.types.startsWith("./") ||
      target.types.split("/").includes("..") ||
      !target.default.startsWith("./") ||
      target.default.split("/").includes("..")
    )
      throw new Error(`Export ${entry} leaves the package directory.`);
    return [{ entry, file: target.types, runtime: target.default }];
  });
  if (entries.length === 0) throw new Error("No typed public entries were found.");
  return entries;
}

export async function extractApi(packageDirectory: string): Promise<ExtractedApiEntry[]> {
  const root = path.resolve(packageDirectory);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    exports?: unknown;
  };
  const entries = typedEntries(manifest);
  const compilerOptions = {
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2022"],
    types: [],
    skipLibCheck: false,
  };
  const program = ts.createProgram(
    entries.map(({ file }) => path.resolve(root, file)),
    ts.convertCompilerOptionsFromJson(compilerOptions, root).options,
  );
  const checker = program.getTypeChecker();
  const work = await mkdtemp(path.join(tmpdir(), "pjr-api-extraction-"));
  try {
    // API Extractor resolves the package beside its config; link its owner instead of cloning it.
    await symlink(path.join(root, "package.json"), path.join(work, "package.json"));
    const results = await Promise.allSettled(
      entries.map(async ({ entry, file, runtime }, index) => {
        const syntax = program.getSourceFile(path.resolve(root, file));
        if (!syntax) throw new Error(`API entry declarations were not loaded: ${file}`);
        const values = valueExports(checker, syntax);
        const directory = path.join(work, String(index));
        await mkdir(directory);
        const output = path.join(directory, "api.d.ts");
        const config = path.join(directory, "api-extractor.json");
        // This instrument checks declarations, not TSDoc prose in private dependencies. Deprecation
        // comments survive the rollup; runtime examples and public docs have their own packed checks.
        await writeFile(
          config,
          JSON.stringify({
            extends: path.resolve("api-extractor.json"),
            projectFolder: root,
            mainEntryPointFilePath: path.resolve(root, file),
            compiler: {
              overrideTsconfig: {
                compilerOptions,
                files: [path.resolve(root, file)],
                include: [],
              },
            },
            dtsRollup: { enabled: true, untrimmedFilePath: output },
          }),
        );
        await releaseCommand([
          process.execPath,
          "--bun",
          path.resolve("node_modules/.bin/api-extractor"),
          "run",
          "--local",
          "--config",
          config,
        ]).catch((error: unknown) => {
          // API Extractor maps each of its messages through the .d.ts.map; a message landing on a
          // segment without a source crashes it with this text instead of the message itself. An
          // undocumented exported declaration is one known trigger.
          if (String(error).includes("Target is a folder, not a file: undefined"))
            throw new Error(
              `API Extractor crashed locating a message for ${entry}. Diff this entry's dist/*.d.ts against the last passing build; a public declaration that lost its doc comment is a known trigger.`,
              { cause: error },
            );
          throw error;
        });
        const source = `// Generated from shipped declarations; review changes with bun run api:update.\n${declarations(await readFile(output, "utf8"), values)}`;
        const formatted = await releaseCommand(
          [path.resolve("node_modules/.bin/oxfmt"), "--stdin-filepath", apiSnapshot(entry)],
          {},
          new TextEncoder().encode(source),
        );
        return { entry, declarations: `${formatted}\n`, values: [...values].toSorted(), runtime };
      }),
    );
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function apiSnapshot(entry: string): string {
  // Flat names keep snapshots inside their owner; refuse ambiguous or nested export spellings.
  if (entry !== "." && !/^\.\/[\w-]+$/u.test(entry))
    throw new Error(`Choose an unambiguous snapshot filename for ${entry}.`);
  return path.join("api", `${entry === "." ? "index" : entry.slice(2)}.api.d.ts`);
}
