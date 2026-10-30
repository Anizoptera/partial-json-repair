// SPDX-License-Identifier: Apache-2.0
import ts from "typescript-6";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Empty option objects must offer option names, even when generic inference defaults to {}. */
export const checkEditor = (consumer: string): void => {
  const file = join(consumer, "editor.ts");
  const text = [
    'import { parse, initParser, createStreamParser, stringify, tryParsers, diagnostics, select } from "partial-json-repair";',
    'import type { Parser, ParserOptions } from "partial-json-repair";',
    'import { auto, parseAsync, initAsyncParser } from "partial-json-repair/async";',
    'import type { AsyncParser, AsyncOptions } from "partial-json-repair/async";',
    'parse("{}", {});',
    'parseAsync("{}", { execution: auto });',
    "createStreamParser({});",
    "stringify(null, {});",
    'tryParsers("{}", [JSON.parse], {});',
    "initAsyncParser({ execution: auto });",
    "initParser({});",
    'const parser = initParser(); parse("{}", parser, {});',
    "diagnostics({}); select([], {});",
    'const configured = initParser({ diagnostics, select: select([["a"]]) }); parse("{}", configured, {});',
    'const configuredAsync = initAsyncParser({ execution: auto, diagnostics }); parseAsync("{}", configuredAsync, {});',
    "declare const configurationShape: Parser; declare const optionShape: ParserOptions;",
    "declare const asyncConfigurationShape: AsyncParser; declare const asyncOptionShape: AsyncOptions;",
  ].join("\n");
  writeFileSync(file, text);
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
    lib: ["lib.es2022.d.ts"],
  };
  const service = ts.createLanguageService({
    getCompilationSettings: () => options,
    getScriptFileNames: () => [file],
    getScriptVersion: () => "0",
    getScriptSnapshot: (name) => {
      const content = ts.sys.readFile(name);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => consumer,
    getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
    fileExists: (name) => ts.sys.fileExists(name),
    readFile: (name) => ts.sys.readFile(name),
    readDirectory: (...args) => ts.sys.readDirectory(...args),
  });
  try {
    const diagnostics = service.getSemanticDiagnostics(file);
    if (diagnostics.length > 0)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => consumer,
          getNewLine: () => "\n",
        }),
      );
    const source = service.getProgram()?.getSourceFile(file);
    if (source === undefined)
      throw new Error("editor fixture was not loaded from the packed consumer");
    const checker = service.getProgram()?.getTypeChecker();
    if (checker === undefined) throw new Error("editor fixture has no type checker");
    const fields = (name: string): ReadonlySet<string> => {
      const declaration = source.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => statement.declarationList.declarations)
        .find((node) => ts.isIdentifier(node.name) && node.name.text === name);
      if (declaration === undefined) throw new Error(`editor fixture has no ${name}`);
      return new Set(
        checker
          .getPropertiesOfType(checker.getTypeAtLocation(declaration.name))
          .map((symbol) => symbol.name),
      );
    };
    const shapes = new Map([
      ["parse", { configuration: fields("configurationShape"), options: fields("optionShape") }],
      [
        "parseAsync",
        { configuration: fields("asyncConfigurationShape"), options: fields("asyncOptionShape") },
      ],
    ]);
    const wanted: Readonly<Record<string, readonly string[]>> = {
      parse: ["requiredKeys", "diagnostics"],
      parseAsync: ["signal", "diagnostics"],
      createStreamParser: ["view", "summary"],
      stringify: ["maxOutput"],
      tryParsers: ["isResult"],
      initAsyncParser: ["signal", "diagnostics"],
      "parse(parser)": ["requiredKeys", "diagnostics"],
      diagnostics: ["maxEntries", "scope"],
      select: ["occurrences", "fragments"],
      initParser: ["requiredKeys", "diagnostics"],
      "parse(configured)": ["select", "diagnostics"],
      "parseAsync(configuredAsync)": ["execution", "signal", "diagnostics"],
    };
    const checked = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isObjectLiteralExpression(node) &&
        // Async options must name a strategy to type-check, so a literal holding only it counts as empty.
        node.properties.every((property) => property.name?.getText(source) === "execution") &&
        ts.isCallExpression(node.parent)
      ) {
        const entries = service.getCompletionsAtPosition(file, node.getStart(source) + 1, {});
        const expression = node.parent.expression.getText(source);
        const configuration = node.parent.arguments[1];
        const call =
          (expression === "parse" || expression === "parseAsync") &&
          configuration !== undefined &&
          ts.isIdentifier(configuration)
            ? `${expression}(${configuration.text})`
            : expression;
        const names = new Set(entries?.entries.map((entry) => entry.name));
        const shape = shapes.get(expression);
        if (shape !== undefined)
          for (const name of names)
            if (shape.configuration.has(name) && !shape.options.has(name))
              throw new Error(
                `${call}({}): editor offers configuration member ${name} as an option`,
              );
        for (const name of wanted[call] ?? [])
          if (!names.has(name))
            throw new Error(
              `${call}({}): editor offers no ${name}; expose the option constraint without weakening Exact`,
            );
        checked.add(call);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const call of Object.keys(wanted))
      if (!checked.has(call)) throw new Error(`editor fixture did not query ${call}`);
  } finally {
    service.dispose();
  }
};
