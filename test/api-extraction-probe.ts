import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript-6";
import assert from "node:assert/strict";
import { extractApi } from "../scripts/api-extraction";

export async function verifyExtractedVisibility(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "pjr-api-visibility-"));
  try {
    await Promise.all([
      writeFile(
        path.join(work, "package.json"),
        JSON.stringify({
          name: "visibility-contract",
          version: "0.1.0",
          type: "module",
          exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        }),
      ),
      writeFile(
        path.join(work, "model.d.ts"),
        "export declare class Value { read(): string; } export declare function effect(): void;",
      ),
      writeFile(
        path.join(work, "index.d.ts"),
        'export type { Value, Value as Alias, effect as TypeOnlyFunction } from "./model"; export { Value as Constructor } from "./model";',
      ),
    ]);
    const [api] = await extractApi(work);
    if (!api) throw new Error("The public declaration entry was not extracted.");
    await writeFile(path.join(work, "snapshot.d.ts"), api.declarations);
    const callers = ["index", "snapshot"].map((module) => path.join(work, `${module}-caller.ts`));
    await Promise.all(
      callers.map((file, index) =>
        writeFile(
          file,
          `import { Alias, Constructor, TypeOnlyFunction, type Value } from "./${index === 0 ? "index" : "snapshot"}";
const value: Value = new Constructor();
value.read();
new Alias();
TypeOnlyFunction();
`,
        ),
      ),
    );
    // Run the same allowed and forbidden calls against native declarations and the review rollup.
    // A missing module or damaged instance type must fail separately from type-only value access.
    const program = ts.createProgram(callers, {
      strict: true,
      noEmit: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
        code: diagnostic.code,
        file: path.basename(diagnostic.file?.fileName ?? ""),
        expression: diagnostic.file?.text.slice(
          diagnostic.start,
          (diagnostic.start ?? 0) + (diagnostic.length ?? 0),
        ),
      })),
      callers.flatMap((file) =>
        ["Alias", "TypeOnlyFunction"].map((expression) => ({
          code: 1362,
          file: path.basename(file),
          expression,
        })),
      ),
    );
  } finally {
    await rm(work, { recursive: true });
  }
}
