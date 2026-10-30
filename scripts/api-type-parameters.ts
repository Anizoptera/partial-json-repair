import ts from "typescript-6";

interface TypeWitness {
  parameters: string;
  arguments: string;
}

export function concreteCallAliases(
  type: ts.Type,
  checker: ts.TypeChecker,
  prefix: string,
): {
  name: string;
  declaration: string;
}[] {
  // A new generic function can satisfy assignment while rejecting an old concrete call.
  // Keep each signature in the old module so its private parameter and return types still bind.
  const printer = ts.createPrinter({ removeComments: true });
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call).flatMap((signature, index) => {
    const original = signature.declaration;
    if (
      (signature.typeParameters?.length ?? 0) > 0 ||
      !original ||
      !ts.isFunctionDeclaration(original) ||
      !ts.isSourceFile(original.parent)
    )
      return [];
    const name = `${prefix}_${index}`;
    const alias = ts.factory.createFunctionDeclaration(
      [
        ts.factory.createModifier(ts.SyntaxKind.ExportKeyword),
        ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword),
      ],
      undefined,
      name,
      undefined,
      original.parameters,
      original.type,
      undefined,
    );
    return [
      {
        name,
        declaration: printer.printNode(ts.EmitHint.Unspecified, alias, original.getSourceFile()),
      },
    ];
  });
}

// A universal old-caller witness keeps constraints and dependencies; instantiating with `any`
// would erase precisely the conditional/default/constraint changes this check must detect.
export function oldTypeParameters(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): TypeWitness & {
  omissions: readonly TypeWitness[];
  dependencies: readonly string[];
} {
  const declaration = symbol.declarations?.find(
    (node) =>
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isClassDeclaration(node),
  );
  const parameters =
    declaration &&
    (ts.isTypeAliasDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isClassDeclaration(declaration))
      ? (declaration.typeParameters ?? [])
      : [];
  if (parameters.length === 0)
    return { parameters: "", arguments: "", omissions: [], dependencies: [] };
  const file = parameters[0]?.getSourceFile();
  if (!file) throw new Error("Generic declaration has no source file.");
  const printer = ts.createPrinter();
  const dependencies = new Set<string>();
  const qualify = (name: ts.EntityName): ts.EntityName => {
    if (ts.isQualifiedName(name))
      return ts.factory.updateQualifiedName(name, qualify(name.left), name.right);
    const target = checker.getSymbolAtLocation(name);
    if (
      target &&
      !(target.flags & ts.SymbolFlags.TypeParameter) &&
      target.declarations?.some((node) => node.getSourceFile() === file) === true
    ) {
      dependencies.add(name.text);
      return ts.factory.createQualifiedName(ts.factory.createIdentifier("O"), name);
    }
    return name;
  };
  const witness = (count: number): TypeWitness => {
    const omitted = new Map<ts.Symbol, ts.TypeNode>();
    for (const parameter of parameters.slice(count)) {
      const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
      if (parameterSymbol !== undefined && parameter.default !== undefined)
        omitted.set(parameterSymbol, parameter.default);
    }
    const transform: ts.TransformerFactory<ts.TypeParameterDeclaration> = (context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isTypeReferenceNode(node)) {
          const referenceSymbol = checker.getSymbolAtLocation(node.typeName);
          const fallback = referenceSymbol === undefined ? undefined : omitted.get(referenceSymbol);
          // Constraints may name a later defaulted parameter; substitute its old default in a
          // partially supplied call, rather than creating a witness with an unbound identifier.
          if (fallback !== undefined)
            return ts.visitNode(fallback, visit, ts.isTypeNode) ?? fallback;
          return ts.factory.updateTypeReferenceNode(
            node,
            qualify(node.typeName),
            ts.visitNodes(node.typeArguments, visit, ts.isTypeNode),
          );
        }
        if (ts.isTypeQueryNode(node))
          return ts.factory.updateTypeQueryNode(node, qualify(node.exprName), node.typeArguments);
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit, ts.isTypeParameterDeclaration) ?? node;
    };
    const printed: string[] = [];
    for (const parameter of parameters.slice(0, count)) {
      const transformed = ts.transform(parameter, [transform]);
      try {
        const node = transformed.transformed[0];
        if (!node) throw new Error("Generic parameter transformation yielded no declaration.");
        // Defaults are tested separately at the omitted-argument call site; the witness is universal.
        printed.push(
          printer.printNode(
            ts.EmitHint.Unspecified,
            ts.factory.updateTypeParameterDeclaration(
              node,
              undefined,
              node.name,
              node.constraint,
              undefined,
            ),
            file,
          ),
        );
      } finally {
        transformed.dispose();
      }
    }
    return {
      parameters: count === 0 ? "" : `<${printed.join(", ")}>`,
      arguments:
        count === 0
          ? ""
          : `<${parameters
              .slice(0, count)
              .map((node) => node.name.text)
              .join(", ")}>`,
    };
  };
  const full = witness(parameters.length);
  const omissions = parameters.flatMap((_, count) =>
    parameters.slice(count).every((node) => node.default !== undefined) ? [witness(count)] : [],
  );
  return {
    ...full,
    omissions,
    dependencies: [...dependencies],
  };
}

export function comparableClasses(source: string, symbols: Set<string>): string {
  // Private storage is nominal within one installed package. Separate old/new test modules must
  // share that identity, while their public members and constructor signatures remain distinct.
  const file = ts.createSourceFile("api.d.ts", source, ts.ScriptTarget.Latest, true);
  const transform: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (!ts.isClassDeclaration(node)) return ts.visitEachChild(node, visit, context);
      const privateMember = (member: ts.ClassElement) =>
        (member.name !== undefined && ts.isPrivateIdentifier(member.name)) ||
        (ts.canHaveModifiers(member) &&
          ts
            .getModifiers(member)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) === true);
      if (!node.name || !node.members.some(privateMember)) return node;
      const brand = `__pjr_nominal_${node.name.text}`;
      symbols.add(brand);
      const property = ts.factory.createPropertyDeclaration(
        [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
        ts.factory.createComputedPropertyName(ts.factory.createIdentifier(brand)),
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
        undefined,
      );
      return ts.factory.updateClassDeclaration(
        node,
        node.modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        [...node.members.filter((member) => !privateMember(member)), property],
      );
    };
    return (node) => ts.visitNode(node, visit, ts.isSourceFile) ?? node;
  };
  const transformed = ts.transform(file, [transform]);
  try {
    const result = transformed.transformed[0];
    if (!result) throw new Error("Class identity transformation yielded no source.");
    return ts.createPrinter().printFile(result);
  } finally {
    transformed.dispose();
  }
}
