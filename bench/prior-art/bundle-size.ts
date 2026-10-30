// SPDX-License-Identifier: Apache-2.0

/**
 * What each library costs a browser bundle: minified and gzipped bytes of exactly the import a
 * caller needs, bundled by `Bun.build` from this directory's pinned rivals.
 *
 *     bun bench/prior-art/bundle-size.ts
 *
 * One entry per library, re-exporting only the symbol the comparison calls, so tree shaking
 * removes what a caller would not ship. Size is deterministic, so bytes are exact and carry no error
 * bar (bench/AGENTS.md: size and memory are separate instruments). Gzip is level 9 via
 * `Bun.gzipSync`; a CDN's compressor may differ by a few percent, which is why the minified bytes
 * are printed beside it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;

/** The import each row needs; ours is the built artefact a consumer installs. */
const ENTRIES: readonly { readonly name: string; readonly source: string }[] = [
  {
    name: "partial-json-repair (parse)",
    source: `export { parse } from ${JSON.stringify(join(here, "..", "..", "dist", "index.js"))};`,
  },
  {
    name: "partial-json-repair (createStreamParser)",
    source: `export { createStreamParser } from ${JSON.stringify(join(here, "..", "..", "dist", "index.js"))};`,
  },
  { name: "jsonrepair", source: `export { jsonrepair } from "jsonrepair";` },
  { name: "partial-json", source: `export { parse, ALL } from "partial-json";` },
  { name: "best-effort-json-parser", source: `export { parse } from "best-effort-json-parser";` },
  { name: "json-repair-js", source: `export { loads } from "json-repair-js";` },
  { name: "repair-json-stream", source: `export { repairJson } from "repair-json-stream";` },
  { name: "untruncate-json", source: `export { default } from "untruncate-json";` },
  { name: "jsonriver", source: `export { parse } from "jsonriver";` },
  { name: "@streamparser/json", source: `export { JSONParser } from "@streamparser/json";` },
  { name: "ai parsePartialJson", source: `export { parsePartialJson } from "ai";` },
  {
    name: "openai partialParse",
    source: `export { partialParse } from "openai/_vendor/partial-json-parser/parser";`,
  },
  {
    name: "anthropic partialParse",
    source: `export { partialParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser";`,
  },
  { name: "json5", source: `export { parse } from "json5";` },
  { name: "jsonc-parser", source: `export { parse } from "jsonc-parser";` },
];

// Inside this directory, so the entry files resolve the rivals from its node_modules.
const scratch = mkdtempSync(join(here, ".bundle-"));
try {
  const rows: string[] = [];
  for (const [i, entry] of ENTRIES.entries()) {
    const file = join(scratch, `entry-${i}.ts`);
    writeFileSync(file, entry.source);
    // Sequential: each build's failure must be attributed to its own row.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const out = await Bun.build({ entrypoints: [file], minify: true, target: "browser" });
    const artifact = out.outputs[0];
    if (!out.success || artifact === undefined) {
      rows.push(`| ${entry.name} | build failed: ${out.logs.map(String).join("; ")} | |`);
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    const bytes = new Uint8Array(await artifact.arrayBuffer());
    rows.push(`| ${entry.name} | ${bytes.length} | ${Bun.gzipSync(bytes, { level: 9 }).length} |`);
  }
  console.log(
    ["| Import | minified bytes | gzip bytes |", "| --- | --- | --- |", ...rows].join("\n"),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
