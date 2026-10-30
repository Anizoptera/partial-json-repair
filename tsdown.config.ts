import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

import { defineConfig } from "tsdown";

/**
 * One line on every built file, because each is installed and read on its own: a scanner that
 * sees the file and nothing around it needs the licence declared in it. SPDX short-form is the
 * standard for exactly that. REUSE 3.3 terminates a tag value at a newline, so this is a line
 * comment — a block comment's closing delimiter would sit inside the value.
 *
 * Every value is read from the manifest, so an artifact cannot claim a licence or version the
 * package does not. Nothing volatile goes in — no date, no machine, no git hash — because the
 * published tarball must stay byte-identical across runs.
 */
const manifest = JSON.parse(
  readFileSync(new URL("package.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const field = (key: string): string => {
  const value = manifest[key];
  // Fails the build rather than emitting `undefined` into every consumer's copy, where no later
  // check looks and no test would notice.
  if (typeof value !== "string" || value === "")
    throw new Error(`package.json "${key}" must be a non-empty string for the dist banner.`);
  return value;
};
const stamp = [
  `// SPDX-License-Identifier: ${field("license")}`,
  `// ${field("name")} ${field("version")}`,
].join("\n");

/**
 * The declarations name `Symbol.dispose`, so a consumer compiling with `lib: ["es2022"]` and no
 * `@types/node` would fail inside our `.d.ts`. A reference directive in the declarations pulls the lib
 * in for them. It is stamped here because the declaration bundler drops directives written in source.
 * Every supported TypeScript ships this lib. `artifact:check` compiles exactly that consumer.
 */
const DISPOSABLE_LIB = '/// <reference lib="esnext.disposable" />';

export default defineConfig({
  entry: {
    index: "src/index.ts",
    async: "src/async.ts",
    "async-worker": "src/async-worker.ts",
    // URL loading has no static import edge for the producer to discover.
    "worker-executor": "src/worker-executor.ts",
  },
  format: ["esm"],
  outExtensions: () => ({ js: ".js" }),
  // `package.json#types` points at the emitted declarations, so they ship and are read alone
  // exactly as the JavaScript is.
  banner: { js: stamp, dts: `${stamp}\n${DISPOSABLE_LIB}` },
  dts: true,
  // The package ships the referenced sources; embedding them again in maps duplicates installation I/O.
  outputOptions: { sourcemapExcludeSources: true },
  clean: true,
  outDir: "dist",
  /**
   * Node resolution keeps the async entry's guarded `node:worker_threads` import an explicit
   * builtin. The packed-artifact check rejects any `node:` import in the root entry's browser bundle
   * and requires the async entry, which keeps that guarded import, to bundle for browsers.
   */
  platform: "node",
  // Consumer checks identify features by module path. Producer bundling needs composed source
  // attribution before this layout can change without losing the unused-feature proof.
  unbundle: true,
  async onSuccess() {
    // The repo root's AGENTS.md steers contributors, and npm cannot rename a file while packing,
    // so the guide for consumers' coding agents ships under the conventional name in dist/.
    copyFileSync("CONSUMER-AGENTS.md", "dist/AGENTS.md");
    // Keep repair projection private to the worker without duplicating the recovery core.
    // Otherwise multi-entry consumers can hoist the worker's repair code into app startup.
    const output = await build({
      entryPoints: ["dist/async-worker.js"],
      outfile: "dist/async-worker.js",
      allowOverwrite: true,
      write: false,
      bundle: true,
      format: "esm",
      platform: "browser",
      sourcemap: true,
      sourcesContent: false,
      banner: { js: stamp },
      plugins: [
        {
          name: "worker-private-repair",
          setup(builder) {
            // esbuild evaluates filters in Go, which rejects JavaScript's Unicode flag.
            // eslint-disable-next-line require-unicode-regexp
            builder.onResolve({ filter: /^\.\// }, ({ path, kind }) => {
              if (kind === "entry-point") return undefined;
              if (path === "./repair-operation.js" || path === "./repair-splice.js")
                return undefined;
              return { path, external: true };
            });
          },
        },
      ],
    });
    for (const file of output.outputFiles) {
      if (file.path.endsWith(".map")) {
        // esbuild omits the optional file field; installed maps identify their emitted subject.
        const map = JSON.parse(file.text) as { file?: string };
        map.file = "async-worker.js";
        writeFileSync(file.path, JSON.stringify(map));
      } else writeFileSync(file.path, file.contents);
    }
  },
});
