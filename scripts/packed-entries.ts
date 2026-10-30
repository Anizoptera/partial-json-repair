// SPDX-License-Identifier: Apache-2.0

/**
 * Preload for Bun scripts (`bun --preload ./scripts/packed-entries.ts <script>`): resolves the two
 * public entries, `src/index` and `src/async`, to the built `dist/` files, so a script that records or
 * replays behaviour through them judges the package a consumer installs, including any build-time
 * transform. Other source imports are left alone on purpose: the corpus tools read vocabulary and
 * profile metadata from them (repair kinds, resolved defaults), which describe the contract rather
 * than produce its outcomes. `vitest.config.ts` does the same for test files under PJR_TEST_PACKED.
 */

import { plugin } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";

const dist = path.join(import.meta.dirname, "..", "dist");
if (!existsSync(path.join(dist, "index.js")))
  throw new Error(`packed-entries: ${dist}/index.js is missing; run bun run build first.`);

// Bun's runtime `onResolve` never fires for relative imports of source files, so the entry's CONTENT
// is replaced instead: a module re-exporting the built entry has the same runtime surface.
plugin({
  name: "pjr-packed-entries",
  setup(build) {
    build.onLoad({ filter: /\/src\/(index|async)\.ts$/u }, (args) => ({
      contents: `export * from ${JSON.stringify(path.join(dist, `${path.basename(args.path, ".ts")}.js`))};`,
      loader: "js",
    }));
  },
});
