import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extractApi, apiSnapshot } from "./api-extraction";
import type { ExtractedApiEntry } from "./api-extraction";

// The artifact hook calls this on cleaned bytes, so the gate need not repeat extraction on dist/.
export async function verifyApi(
  packageDirectory: string,
  mode: "check" | "update" = "check",
): Promise<readonly ExtractedApiEntry[]> {
  const entries = await extractApi(packageDirectory);
  await mkdir("api", { recursive: true });
  const expected = new Set(entries.map(({ entry }) => apiSnapshot(entry).slice(4)));
  for (const file of await readdir("api"))
    if (file.endsWith(".api.d.ts") && !expected.has(file))
      throw new Error(
        `api/${file} has no public export; review its removal instead of retaining a stale snapshot.`,
      );
  const changed: string[] = [];
  await Promise.all(
    entries.map(async ({ entry, declarations }) => {
      const file = apiSnapshot(entry);
      const output = declarations;
      let baseline = "";
      try {
        baseline = await readFile(file, "utf8");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      if (baseline === output) return;
      changed.push(file);
      if (mode === "update") await writeFile(file, output);
    }),
  );
  if (mode === "check" && changed.length > 0)
    throw new Error(
      `Public API differs: ${changed.join(", ")}. If intended, run bun run api:update and review the declaration diff.`,
    );
  console.log(
    `api: ${entries.length} public entries ${mode === "update" ? "updated" : "match reviewed declarations"}`,
  );
  return entries;
}

if (import.meta.main) {
  const [mode, ...extra] = process.argv.slice(2);
  if ((mode !== "check" && mode !== "update") || extra.length > 0)
    throw new Error("Usage: bun scripts/api.ts check|update (build first).");
  await verifyApi(".", mode);
}
