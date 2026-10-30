import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * `PJR_TEST_PACKED=1` runs the public-interface tests against the built package instead of the
 * sources, so a build-time transform (minification, property renaming) is judged by the same tests
 * as the source. Only the two public entries are redirected; a test file that reaches any other
 * source module would mix two engine copies, so it carries a `PRIVATE_MARK` line and is left out, and
 * an unmarked one fails at resolution instead of silently testing the sources.
 */
const PACKED = process.env.PJR_TEST_PACKED === "1";
const PRIVATE_MARK = "// test-scope: private-modules";
const root = import.meta.dirname;
const ENTRIES: Readonly<Record<string, string>> = {
  [path.join(root, "src/index.ts")]: path.join(root, "dist/index.js"),
  [path.join(root, "src/async.ts")]: path.join(root, "dist/async.js"),
};
const packedEntries = {
  name: "pjr-packed-entries",
  enforce: "pre" as const,
  async resolveId(
    this: { resolve: (id: string, from?: string, o?: object) => Promise<{ id: string } | null> },
    id: string,
    importer: string | undefined,
  ) {
    if (
      importer === undefined ||
      importer.includes("/node_modules/") ||
      importer.startsWith(path.join(root, "dist"))
    )
      return null;
    const resolved = await this.resolve(id, importer, { skipSelf: true });
    if (resolved === null || !resolved.id.startsWith(path.join(root, "src"))) return null;
    const packed = ENTRIES[resolved.id];
    if (packed !== undefined) return packed;
    throw new Error(
      `${importer} imports private module ${resolved.id}, which the packed run cannot redirect. Import from src/index or src/async, or add the line "${PRIVATE_MARK}" to the test file to leave it out of PJR_TEST_PACKED runs.`,
    );
  },
};
// The mark lives in each file, so no list here can drift from what the files import.
const privateFiles = (): string[] =>
  readdirSync(path.join(root, "test"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => readFileSync(path.join(root, "test", file), "utf8").includes(PRIVATE_MARK))
    .map((file) => `test/${file}`);

export default defineConfig({
  ...(PACKED ? { plugins: [packedEntries] } : {}),
  test: {
    // More forks repeat module compilation and contend with the other gate steps; file isolation stays on.
    maxWorkers: Math.min(4, availableParallelism()),
    // Matches every pattern `bun test ./test/` picks up, so no file can be seen by ONE runner. Bun's
    // discovery is wider than the `.test.ts` convention here, and the two-runner gate is worth
    // nothing on a file only one of them runs — the second runner exists to catch global damage,
    // and it cannot catch it in a file it never loads. Widen both sides together or neither.
    include: ["test/**/*.{test,spec}.ts", "test/**/*_{test,spec}.ts"],
    ...(PACKED ? { exclude: ["**/node_modules/**", ...privateFiles()] } : {}),
    // A retention test measures the heap after a full collection; Bun forces one with `Bun.gc`.
    execArgv: ["--expose-gc"],
  },
});
