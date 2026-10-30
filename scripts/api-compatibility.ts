// Compiler-backed API compatibility: writes old caller code against two declaration versions and
// asks every supported TypeScript checker whether it still compiles, which text cannot decide.
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import ts from "typescript-6";
import {
  exported,
  normalizeDeclarations,
  reachable,
  records,
  valueExports,
} from "./api-declarations";
import type { DeclarationRecord } from "./api-declarations";
import { typeScriptCheckers } from "./typescript-compilers";
import { comparableClasses, concreteCallAliases, oldTypeParameters } from "./api-type-parameters";

// One configuration for the in-process program and every checker command. Default libraries ship
// with each compiler and are not re-checked; checking them dominates every command's run time.
const compilerOptions = {
  strict: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "Bundler",
  // The API names web globals such as `AbortSignal`, which only the DOM library declares.
  lib: ["ESNext", "DOM"],
  types: [],
  skipDefaultLibCheck: true,
};

// Every compatibility check builds two programs over the same standard library; parsing `lib.dom`
// dominates their cost, and those files never change while the process runs.
const libraryFiles = new Map<string, ts.SourceFile | undefined>();

function compilerRun(
  command: string[],
  directory: string,
): Promise<{ command: string; output: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = command;
    if (executable === undefined || executable === "") {
      reject(new Error("Compiler command is empty."));
      return;
    }
    const child = spawn(executable, args, {
      cwd: directory,
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: string): void => {
      output += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ command: command.join(" "), output, code });
    });
  });
}
function libraryFile(
  disk: ts.CompilerHost,
  name: string,
  version: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile | undefined {
  if (!libraryFiles.has(name)) libraryFiles.set(name, disk.getSourceFile(name, version));
  return libraryFiles.get(name);
}

// Arguments a call may pass; a rest parameter takes any number.
function acceptedArguments(signature: ts.Signature): number {
  return signature.declaration?.parameters.some(
    (parameter) => ts.isParameter(parameter) && !!parameter.dotDotDotToken,
  ) === true
    ? Number.POSITIVE_INFINITY
    : signature.parameters.length;
}

// Ordered printed rows a top-level declaration owns, comparable as one string.
function rootTexts(rows: readonly DeclarationRecord[], root: string): string {
  return JSON.stringify(rows.filter((row) => row.root === root).map(({ text }) => text));
}

/**
 * Names exported by the old declarations that old callers can no longer use: removed, or failing
 * a compiler assignability check. Text comparison cannot decide this: `generate(options: Options)`
 * prints identically after the unexported `Options.at` becomes required, yet `generate({})` breaks.
 */
export async function incompatibleExports(before: string, after: string): Promise<Set<string>> {
  const directory = await mkdtemp(join(tmpdir(), "pjr-api-compatibility-"));
  try {
    return await checkDirectory(directory, before, after);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkDirectory(
  directory: string,
  before: string,
  after: string,
): Promise<Set<string>> {
  // Each file's `unique symbol` would be a distinct type, making every branded type look
  // unrelated across versions. A caller has one version installed, so a brand keeps its identity
  // by name: both versions import each such symbol from one shared module.
  const symbols = new Set<string>();
  const shareSymbols = (source: string) => {
    const file = ts.createSourceFile("api.d.ts", source, ts.ScriptTarget.Latest, true);
    let text = "";
    let copied = 0;
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const names = statement.declarationList.declarations
        .filter(
          ({ type }) =>
            type && ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.UniqueKeyword,
        )
        .map(({ name }) => name.getText(file));
      if (names.length !== statement.declarationList.declarations.length || names.length === 0)
        continue;
      for (const name of names) symbols.add(name);
      const list = names.join(", ");
      text += `${source.slice(copied, statement.getStart(file))}import { ${list} } from "./symbols";${exported(statement) ? ` export { ${list} };` : ""}`;
      copied = statement.end;
    }
    // A file without exports is a global script with no API; `export {}` keeps it importable.
    return `${text}${source.slice(copied)}\nexport {};\n`;
  };
  const oldFile = join(directory, "old.d.ts");
  const nominal = new Set<string>();
  const oldSource = comparableClasses(before, nominal);
  const newSource = comparableClasses(after, nominal);
  const withBrands = (source: string) =>
    `${[...nominal].map((name) => `declare const ${name}: unique symbol;`).join("\n")}\n${source}`;
  // Array elements evaluate in order: both versions fill `symbols` before its module is written.
  await Promise.all([
    writeFile(oldFile, shareSymbols(withBrands(oldSource))),
    writeFile(join(directory, "new.d.ts"), shareSymbols(withBrands(newSource))),
    writeFile(
      join(directory, "symbols.d.ts"),
      [...symbols].map((name) => `export declare const ${name}: unique symbol;`).join("\n"),
    ),
  ]);
  // The in-process program only finds exports and argument counts; checker commands give the verdict.
  const { options } = ts.convertCompilerOptionsFromJson(compilerOptions, directory);
  const disk = ts.createCompilerHost(options);
  const program = ts.createProgram([oldFile, join(directory, "new.d.ts")], options, {
    ...disk,
    getSourceFile: (name, version) =>
      name.startsWith(directory)
        ? disk.getSourceFile(name, version)
        : libraryFile(disk, name, version),
  });
  const checker = program.getTypeChecker();
  const exportsOf = (name: string) => {
    const file = program.getSourceFile(join(directory, name));
    const module = file && checker.getSymbolAtLocation(file);
    return new Map(
      (module ? checker.getExportsOfModule(module) : []).map((symbol) => [
        symbol.name,
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
      ]),
    );
  };
  // Assignability lets a function with fewer parameters replace one with more, yet a caller passing
  // the dropped argument stops compiling. Every old call or construct signature, including methods
  // and results reached from it, needs a new one accepting at least as many arguments.
  const arityKept = (oldType: ts.Type, newType: ts.Type, seen = new Set<string>()): boolean => {
    // Generic instantiations are new type objects on every visit; their printed form repeats.
    const key = checker.typeToString(oldType);
    if (seen.has(key)) return true;
    seen.add(key);
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      const fresh = checker.getSignaturesOfType(newType, kind);
      for (const signature of checker.getSignaturesOfType(oldType, kind)) {
        const match = fresh.find(
          (candidate) => acceptedArguments(candidate) >= acceptedArguments(signature),
        );
        if (
          !match ||
          !arityKept(
            checker.getReturnTypeOfSignature(signature),
            checker.getReturnTypeOfSignature(match),
            seen,
          )
        )
          return false;
      }
    }
    // Only package-declared members: built-in types such as `String` are the same in both versions.
    return checker.getPropertiesOfType(oldType).every((property) => {
      const counterpart = checker.getPropertyOfType(newType, property.name);
      return (
        !counterpart ||
        property.declarations?.some((node) => node.getSourceFile().fileName === oldFile) !== true ||
        arityKept(checker.getTypeOfSymbol(property), checker.getTypeOfSymbol(counterpart), seen)
      );
    });
  };
  const previous = exportsOf("old.d.ts");
  const current = exportsOf("new.d.ts");
  const oldSyntax = program.getSourceFile(oldFile);
  const newSyntax = program.getSourceFile(join(directory, "new.d.ts"));
  if (!oldSyntax || !newSyntax) throw new Error("Compatibility declarations were not loaded.");
  const previousValues = valueExports(checker, oldSyntax);
  const currentValues = valueExports(checker, newSyntax);
  // TypeScript never relates deferred conditional types declared in different files, so even an
  // identical export can fail the check. An export whose declarations and the types they use are
  // unchanged is compatible by definition; only exports reaching a changed declaration are
  // checked, so a false failure can only mark a changed export as breaking.
  const oldRows = records(normalizeDeclarations(before));
  const newRows = records(normalizeDeclarations(after));
  const changed = new Set(
    [...oldRows, ...newRows]
      .map(({ root }) => root)
      .filter((root) => rootTexts(oldRows, root) !== rootTexts(newRows, root)),
  );
  const touchesChange = (root: string) =>
    [...reachable(oldRows, [root]), ...reachable(newRows, [root])].some((name) =>
      changed.has(name),
    );
  const incompatible = new Set<string>();
  const checks: { name: string; line: string }[] = [];
  const dependencies = new Set<string>();
  const calls: string[] = [];
  for (const [name, old] of previous) {
    const now = current.get(name);
    const wasValue = previousValues.has(name);
    if (wasValue && !currentValues.has(name)) {
      incompatible.add(name);
      continue;
    }
    if (now && !touchesChange(old.name) && !touchesChange(now.name)) continue;
    // Quoted export names cannot be written as `O.name`; treat their changes as breaking.
    if (!now || !/^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(name)) {
      incompatible.add(name);
      continue;
    }
    if (wasValue && !arityKept(checker.getTypeOfSymbol(old), checker.getTypeOfSymbol(now))) {
      incompatible.add(name);
      continue;
    }
    // Values flow from the package to callers: the new value must fit wherever the old one was used.
    if (wasValue) {
      checks.push({
        name,
        line: `export function v${checks.length}(value: typeof N.${name}): typeof O.${name} { return value; }`,
      });
      for (const alias of concreteCallAliases(
        checker.getTypeOfSymbol(old),
        checker,
        `__pjr_call_${checks.length}`,
      )) {
        calls.push(alias.declaration);
        checks.push({
          name,
          line: `export function c${checks.length}(implementation: typeof N.${name}, ...args: Parameters<typeof O.${alias.name}>): ReturnType<typeof O.${alias.name}> { return implementation(...args); }`,
        });
      }
    }
    // Structural annotations serve readers and writers; test both directions over old type arguments.
    if (old.flags & ts.SymbolFlags.Type) {
      const generic = oldTypeParameters(old, checker);
      for (const dependency of generic.dependencies)
        if (!previous.has(dependency)) dependencies.add(dependency);
      // Nominal class instances come from constructors, unlike structural annotations callers fill.
      // Requiring old instances to contain newly added methods would reject compatible additions.
      const nominalClass =
        !!(old.flags & ts.SymbolFlags.Class) &&
        checker
          .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(old))
          .some(
            (property) =>
              property.declarations?.some(
                (node) =>
                  ts.isPropertyDeclaration(node) &&
                  ts.isComputedPropertyName(node.name) &&
                  ts.isIdentifier(node.name.expression) &&
                  nominal.has(node.name.expression.text),
              ) === true,
          );
      const [input, output] = nominalClass ? ["N", "O"] : ["O", "N"];
      checks.push({
        name,
        line: `export function t${checks.length}${generic.parameters}(value: ${input}.${name}${generic.arguments}): ${output}.${name}${generic.arguments} { return value; }${nominalClass ? "" : ` export function r${checks.length}${generic.parameters}(value: N.${name}${generic.arguments}): O.${name}${generic.arguments} { return value; }`}`,
      });
      for (const omitted of generic.omissions)
        checks.push({
          name,
          line: `export function d${checks.length}${omitted.parameters}(value: ${input}.${name}${omitted.arguments}): ${output}.${name}${omitted.arguments} { return value; }${nominalClass ? "" : ` export function e${checks.length}${omitted.parameters}(value: N.${name}${omitted.arguments}): O.${name}${omitted.arguments} { return value; }`}`,
        });
    }
  }
  const header = ['import type * as O from "./old";', 'import type * as N from "./new";'];
  // Every export not given a check line is already decided.
  if (checks.length === 0) return incompatible;
  // Only the fixture can see constraint dependencies; they never enter the public export census.
  if (dependencies.size > 0)
    await appendFile(oldFile, `\nexport { ${[...dependencies].join(", ")} };\n`);
  // Added only after the real export census; witness aliases must never become public API rows.
  if (calls.length > 0) await appendFile(oldFile, `\n${calls.join("\n")}\n`);
  await Promise.all([
    writeFile(
      join(directory, "check.ts"),
      [...header, ...checks.map(({ line }) => line)].join("\n"),
    ),
    writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions, files: ["check.ts"] }),
    ),
  ]);
  const completed = await Promise.allSettled(
    typeScriptCheckers.map((command) => compilerRun(command, directory)),
  );
  const runs = completed.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  for (const { command, output, code } of runs) {
    const errors = [...output.matchAll(/^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/gmu)];
    // A failed run without diagnostics crashed or could not start; its silence proves nothing.
    if (code !== 0 && errors.length === 0)
      throw new Error(`${command} failed without a diagnostic:\n${output}`);
    for (const [, file, line, message] of errors) {
      // Unresolved names in a declaration file become error types that accept anything, so a
      // version some supported compiler cannot check proves no export compatible under it.
      if (file !== "check.ts") {
        for (const { name } of checks) incompatible.add(name);
        continue;
      }
      const check = checks[Number(line) - 1 - header.length];
      if (!check)
        throw new Error(
          `Compatibility check failed outside an export under ${command}: ${message}`,
        );
      incompatible.add(check.name);
    }
  }
  return incompatible;
}
