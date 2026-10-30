import ts from "typescript-6";

export function valueExports(checker: ts.TypeChecker, file: ts.SourceFile): Set<string> {
  const module = checker.getSymbolAtLocation(file);
  if (!module) throw new Error(`API declarations are not a module: ${file.fileName}`);
  // Alias targets retain their class/value flags even behind `export type`; the namespace type
  // contains only values a caller can actually import from this module.
  return new Set(
    checker
      .getPropertiesOfType(checker.getTypeOfSymbolAtLocation(module, file))
      .map(({ name }) => name),
  );
}

export interface DeclarationRecord {
  readonly text: string;
  readonly family: string;
  readonly visible: boolean;
  /** Top-level declaration that owns the row; release notes group changes by it. */
  readonly root: string;
  /** Bound top-level references let notes follow an export into the unexported types it uses. */
  readonly refs: readonly string[];
}

function declarationName(node: ts.Node, file: ts.SourceFile): string {
  if (ts.isVariableStatement(node))
    return node.declarationList.declarations.map(({ name }) => name.getText(file)).join(", ");
  // Emitted declarations may be unnamed signatures; NamedDeclaration's optional name covers both.
  const name = (node as ts.NamedDeclaration).name;
  return name?.getText(file) ?? ts.SyntaxKind[node.kind];
}

export function exported(node: ts.Node): boolean {
  return (
    ts.isExportDeclaration(node) ||
    ts.isExportAssignment(node) ||
    (ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true)
  );
}

type DeclarationContainer =
  | ts.ClassDeclaration
  | ts.EnumDeclaration
  | ts.InterfaceDeclaration
  | ts.ModuleDeclaration;

function isDeclarationContainer(node: ts.Node): node is DeclarationContainer {
  return (
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

export function normalizeDeclarations(source: string): string {
  // Keep compiler names and visibility with the printed text: reparsing names loses valid API changes.
  const file = ts.createSourceFile("public.d.ts", source, ts.ScriptTarget.Latest, true);
  // Binding distinguishes real type/value references from member names and locally shadowed names.
  // This rolled-up module needs no libraries or resolution: only declarations in this file count.
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const program = ts.createProgram([file.fileName], options, {
    ...ts.createCompilerHost(options),
    getSourceFile: (name) => (name === file.fileName ? file : undefined),
  });
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  const entries: DeclarationRecord[] = [];
  const namedExports = new Set(
    file.statements.flatMap((node) =>
      ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((entry) => (entry.propertyName ?? entry.name).text)
        : ts.isExportAssignment(node) && ts.isIdentifier(node.expression)
          ? [node.expression.text]
          : [],
    ),
  );
  const privateSymbols = new Set(
    file.statements.flatMap((node) =>
      ts.isVariableStatement(node) && !exported(node)
        ? node.declarationList.declarations
            .filter(
              ({ name, type }) =>
                !namedExports.has(name.getText(file)) &&
                type &&
                ts.isTypeOperatorNode(type) &&
                type.operator === ts.SyntaxKind.UniqueKeyword,
            )
            .map(({ name }) => name.getText(file))
        : [],
    ),
  );
  const print = (node: ts.Node): string =>
    printer.printNode(ts.EmitHint.Unspecified, node, file).trim();
  const emit = (node: ts.Node, text: string, owners: readonly string[], visible: boolean) => {
    const name = (node as ts.NamedDeclaration).name;
    const hidden =
      (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.PrivateKeyword) ===
          true) ||
      (name !== undefined && ts.isPrivateIdentifier(name)) ||
      (name !== undefined &&
        ts.isComputedPropertyName(name) &&
        ts.isIdentifier(name.expression) &&
        privateSymbols.has(name.expression.text));
    const refs = new Set<string>();
    const collect = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) {
        const symbol = checker.getSymbolAtLocation(child);
        const bound =
          symbol &&
          (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
        for (const declaration of bound?.declarations ?? []) {
          let root: ts.Node = declaration;
          while (root.parent !== undefined && !ts.isSourceFile(root.parent)) root = root.parent;
          if (root.parent !== file) continue;
          refs.add(
            ts.isVariableDeclaration(declaration)
              ? declaration.name.getText(file)
              : declarationName(root, file),
          );
        }
      }
      ts.forEachChild(child, collect);
    };
    ts.forEachChild(node, collect);
    entries.push({
      text,
      family: [...owners, declarationName(node, file)].join("."),
      visible: visible && !hidden,
      root: owners[0] ?? declarationName(node, file),
      refs: [...refs],
    });
  };
  const visit = (node: ts.Node, owners: readonly string[], parentVisible = false): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length > 1) {
      for (const declaration of node.declarationList.declarations)
        visit(
          ts.factory.updateVariableStatement(
            node,
            node.modifiers,
            ts.factory.updateVariableDeclarationList(node.declarationList, [declaration]),
          ),
          owners,
          parentVisible,
        );
      return;
    }
    const visible =
      owners.length > 0
        ? parentVisible
        : exported(node) || namedExports.has(declarationName(node, file));
    if (isDeclarationContainer(node) && node.name) {
      const name = node.name.getText(file);
      const path = [...owners, name];
      const shell = ts.isClassDeclaration(node)
        ? ts.factory.updateClassDeclaration(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            [],
          )
        : ts.isInterfaceDeclaration(node)
          ? ts.factory.updateInterfaceDeclaration(
              node,
              node.modifiers,
              node.name,
              node.typeParameters,
              node.heritageClauses,
              [],
            )
          : ts.isEnumDeclaration(node)
            ? ts.factory.updateEnumDeclaration(node, node.modifiers, node.name, [])
            : ts.factory.updateModuleDeclaration(node, node.modifiers, node.name, undefined);
      emit(node, `${path.join(".")}: ${print(shell)}`, owners, visible);
      if (ts.isModuleDeclaration(node)) {
        if (node.body && ts.isModuleDeclaration(node.body)) visit(node.body, path, visible);
        else if (node.body && ts.isModuleBlock(node.body))
          for (const statement of node.body.statements) visit(statement, path, visible);
      } else {
        for (const member of node.members)
          emit(member, `${path.join(".")}: ${print(member)}`, path, visible);
      }
      return;
    }
    emit(
      node,
      owners.length > 0 ? `${owners.join(".")}: ${print(node)}` : print(node),
      owners,
      visible,
    );
  };
  for (const statement of file.statements) visit(statement, []);
  // One record per owned declaration preserves overload order while making additive members additive.
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

export function records(source: string): DeclarationRecord[] {
  return source
    .split("\n")
    .filter((row) => row.startsWith("{"))
    .map((row) => JSON.parse(row) as DeclarationRecord);
}

/** Roots reachable from `from` through each row's bound declaration references. */
export function reachable(rows: readonly DeclarationRecord[], from: Iterable<string>): Set<string> {
  const refs = new Map<string, string[]>();
  for (const row of rows) refs.set(row.root, [...(refs.get(row.root) ?? []), ...row.refs]);
  const seen = new Set<string>();
  const queue = [...from];
  for (let root = queue.pop(); root !== undefined; root = queue.pop()) {
    if (seen.has(root) || !refs.has(root)) continue;
    seen.add(root);
    queue.push(...(refs.get(root) ?? []));
  }
  return seen;
}
