// SPDX-License-Identifier: Apache-2.0

/**
 * The six supported consumer bundlers (HLD D5) and the packed-package consumer, shared by size-check.ts and
 * platform-check.ts. Each adapter builds one entry into a directory and reports chunks with the
 * package modules each one ships, from the bundler's own report, never from a text search.
 */

import { rspack } from "@rspack/core";
import * as esbuild from "esbuild";
import { rolldown } from "rolldown";
import type { RolldownOutput } from "rolldown";
import TerserPlugin from "terser-webpack-plugin";
import { build as vite } from "vite";
import type { Stats } from "webpack";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PKG } from "./consumer-package";
import type { Consumer } from "./consumer-package";
export { PKG, packConsumer, workerRecipe } from "./consumer-package";
export type { Consumer, Packed, WorkerRecipe } from "./consumer-package";
import type { WorkerRecipe } from "./consumer-package";

// Loaded through `require`: Bun's ESM import of a CommonJS module reads every export, and four of
// webpack's are deprecation getters that print a warning into every size and platform log.
const webpack = createRequire(import.meta.url)("webpack") as typeof import("webpack");

export type Mode = "optimised" | "conservative";
export type Chunk = {
  readonly file: string;
  readonly entry: boolean;
  readonly staticImports: readonly string[];
  readonly dynamicImports: readonly string[];
  /** Package dist module → bytes it contributes to this chunk (bundler's own attribution). */
  readonly modules: Readonly<Record<string, number>>;
};
export type Built = {
  readonly dir: string;
  // Filesystem path for loading emitted code; a page URL needs its basename relative to dir.
  readonly entryFile: string;
  readonly chunks: readonly Chunk[];
  readonly emitted: readonly string[];
};
export type Bundler = {
  readonly name: string;
  readonly version: string;
  /** `recipe` applies the README's worker recipe (`WorkerRecipe`) for bundlers that need it. */
  build(entry: string, dir: string, mode: Mode, recipe?: WorkerRecipe): Promise<Built>;
  /** Whether `recipe` is honoured; the worker-aware bundlers need no recipe. */
  readonly takesExtraEntries: boolean;
};

/** `…/node_modules/partial-json-repair/dist/scan.js` → `scan`; anything else outside the package → undefined. */
export const distModule = (id: string): string | undefined => {
  const match = /node_modules[\\/]partial-json-repair[\\/]dist[\\/](.+)\.js$/u.exec(
    id.replace(/\?.*$/u, ""),
  );
  return match?.[1];
};

const addModule = (
  into: Record<string, number>,
  id: string,
  bytes: number,
  mapped = false,
): void => {
  const name = distModule(id);
  // From a bundler's own report, 0 bytes means tree-shaken away. From a source map, a source with
  // mappings still ships at 0 bytes: the minifier inlined its code into a caller (Rspack inlines the
  // one-function `stream.js` into the fixture).
  if (name !== undefined && (bytes > 0 || mapped)) into[name] = (into[name] ?? 0) + bytes;
};

export const esbuildBundler: Bundler = {
  name: "esbuild",
  version: esbuild.version,
  takesExtraEntries: true,
  async build(entry, dir, mode, recipe) {
    const run = async (entryPoints: Record<string, string>) =>
      (
        await esbuild.build({
          entryPoints,
          bundle: true,
          splitting: true,
          format: "esm",
          platform: "browser",
          minify: true,
          metafile: true,
          outdir: dir,
          write: true,
          logLevel: "silent",
          ignoreAnnotations: mode === "conservative",
        })
      ).metafile;
    const app = await run({ main: entry, ...(recipe && { "worker-executor": recipe.receiver }) });
    const worker = recipe && (await run({ "async-worker": recipe.worker }));
    return fromMetafile(dir, entry, app, worker);
  },
};

export const bunBundler: Bundler = {
  name: "bun",
  version: Bun.version,
  takesExtraEntries: true,
  async build(entry, dir, mode, recipe) {
    const run = async (entrypoints: string[]): Promise<Metafile> => {
      const result = await Bun.build({
        // Bun names an entry after its file, so a recipe entry keeps its basename.
        entrypoints,
        outdir: dir,
        target: "browser",
        format: "esm",
        splitting: true,
        minify: true,
        metafile: true,
        naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
        ignoreDCEAnnotations: mode === "conservative",
      });
      if (!result.success) throw new AggregateError(result.logs, "Bun.build failed");
      return typeof result.metafile === "string"
        ? (JSON.parse(result.metafile) as Metafile)
        : (result.metafile as Metafile);
    };
    const app = await run(recipe ? [entry, recipe.receiver] : [entry]);
    const worker = recipe && (await run([recipe.worker]));
    return fromMetafile(dir, entry, app, worker);
  },
};

type Metafile = {
  readonly outputs: Record<
    string,
    {
      readonly entryPoint?: string;
      readonly imports: readonly { readonly path: string; readonly kind: string }[];
      readonly inputs: Record<string, { readonly bytesInOutput: number }>;
    }
  >;
};

/** esbuild and Bun share the metafile shape; paths are relative to cwd for esbuild, absolute or relative for Bun. */
const name = (p: string): string => path.basename(p);

/** `worker` is the recipe's separate worker build into the same directory; its outputs join the app's. */
const fromMetafile = (dir: string, entry: string, meta: Metafile, worker?: Metafile): Built => {
  const chunks: Chunk[] = [];
  for (const [file, output] of Object.entries({ ...meta.outputs, ...worker?.outputs })) {
    if (!file.endsWith(".js")) continue;
    const modules: Record<string, number> = {};
    for (const [id, input] of Object.entries(output.inputs))
      addModule(modules, id, input.bytesInOutput);
    chunks.push({
      file: name(file),
      // Both tools also mark a dynamic-import target as an entry point; only the fixture's own is the entry.
      entry:
        output.entryPoint !== undefined &&
        path.basename(output.entryPoint) === path.basename(entry),
      staticImports: output.imports
        .filter((i) => i.kind === "import-statement")
        .map((i) => name(i.path)),
      dynamicImports: output.imports
        .filter((i) => i.kind === "dynamic-import")
        .map((i) => name(i.path)),
      modules,
    });
  }
  return finish(dir, chunks);
};

export const rolldownBundler: Bundler = {
  name: "rolldown",
  version: (await import("rolldown/package.json", { with: { type: "json" } })).default.version,
  takesExtraEntries: true,
  async build(entry, dir, mode, recipe) {
    const run = async (input: Record<string, string>) => {
      const bundle = await rolldown({
        input,
        platform: "browser",
        logLevel: "silent",
        treeshake: mode === "conservative" ? { annotations: false, moduleSideEffects: true } : true,
      });
      const { output } = await bundle.write({
        dir,
        format: "esm",
        minify: true,
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      });
      await bundle.close();
      return output;
    };
    const app = await run({ main: entry, ...(recipe && { "worker-executor": recipe.receiver }) });
    const worker = recipe ? await run({ "async-worker": recipe.worker }) : [];
    const chunks: Chunk[] = [];
    for (const item of [...app, ...worker]) {
      if (item.type !== "chunk") continue;
      const modules: Record<string, number> = {};
      for (const [id, info] of Object.entries(item.modules))
        addModule(modules, id, info.renderedLength);
      chunks.push({
        file: item.fileName,
        entry: item.isEntry && item.name === "main",
        staticImports: item.imports.filter((i) => !i.startsWith("node:")),
        dynamicImports: item.dynamicImports.filter((i) => !i.startsWith("node:")),
        modules,
      });
    }
    return finish(dir, chunks);
  },
};

export const rspackBundler: Bundler = {
  name: "rspack",
  takesExtraEntries: false,
  version:
    rspack.rspackVersion ??
    (await import("@rspack/core/package.json", { with: { type: "json" } })).default.version,
  async build(entry, dir, mode) {
    const conservative = mode === "conservative";
    const compiler = rspack({
      mode: "production",
      target: "web",
      context: path.dirname(entry),
      entry: { main: entry },
      // Hidden maps attribute minified bytes to source modules; they are read, never shipped.
      devtool: "hidden-source-map",
      performance: false,
      output: {
        path: dir,
        filename: "[name].js",
        chunkFilename: "[name]-[contenthash:8].js",
        module: true,
        chunkFormat: "module",
        chunkLoading: "import",
        library: { type: "module" },
        clean: true,
      },
      optimization: conservative
        ? {
            sideEffects: false,
            innerGraph: false,
            minimizer: [
              new rspack.SwcJsMinimizerRspackPlugin({
                minimizerOptions: { compress: { side_effects: false } },
              }),
            ],
          }
        : {},
    });
    const stats = await new Promise<import("@rspack/core").Stats>((resolve, reject) => {
      compiler.run((error, result) => {
        if (result === undefined || error !== null) reject(error ?? new Error("rspack: no stats"));
        else resolve(result);
      });
    });
    await new Promise<void>((resolve) => {
      compiler.close(() => {
        resolve();
      });
    });
    if (stats.hasErrors())
      throw new Error(`rspack: ${stats.toString({ all: false, errors: true })}`);
    return fromWebpackStats(dir, "rspack", stats.toJson(STATS_OPTIONS));
  },
};

/** The stats fields both webpack-family compilers are asked for; `ids` makes every chunk carry its id. */
const STATS_OPTIONS = {
  all: false,
  modules: true,
  nestedModules: true,
  chunks: true,
  chunkRelations: true,
  ids: true,
  modulesSpace: Infinity,
  nestedModulesSpace: Infinity,
  orphanModules: true,
} as const;

/** The part of a webpack-family stats chunk this harness reads; Rspack and webpack both emit it. */
type StatsChunk = {
  readonly id?: string | number | null;
  readonly files?: readonly string[];
  readonly initial: boolean;
  readonly names?: readonly string[];
  readonly siblings?: readonly (string | number)[];
  readonly children?: readonly (string | number)[];
};

const fromWebpackStats = (
  dir: string,
  tool: string,
  json: { readonly chunks?: readonly StatsChunk[] },
): Built => {
  const statsChunks = (json.chunks ?? []).map((chunk) => {
    if (chunk.id === undefined || chunk.id === null)
      throw new Error(`${tool}: a chunk in the stats has no id`);
    const file = (chunk.files ?? []).find((f) => f.endsWith(".js")) ?? String(chunk.id);
    return {
      id: chunk.id,
      file,
      initial: chunk.initial,
      names: chunk.names ?? [],
      siblings: chunk.siblings ?? [],
      children: chunk.children ?? [],
    };
  });
  const files = new Map(statsChunks.map((chunk) => [chunk.id, chunk.file]));
  // The stats report SOURCE size of every module in the chunk graph, and a module in the graph
  // can still minify to nothing (measured: an import-only build listed 30 modules in a 10.8 kB
  // output). So bytes are attributed from the emitted source map, the same post-minification
  // measure esbuild, Bun and Rolldown report natively.
  const perChunk = new Map<string | number, Record<string, number>>();
  for (const chunk of statsChunks) {
    const into: Record<string, number> = {};
    const map = path.join(dir, `${chunk.file}.map`);
    // Missing attribution cannot prove that emitted code contains no package modules.
    const sourceMap = JSON.parse(readFileSync(map, "utf8")) as SourceMap;
    const code = readFileSync(path.join(dir, chunk.file), "utf8");
    for (const [source, bytes] of Object.entries(attributeBySourceMap(code, sourceMap)))
      addModule(into, source, bytes, true);
    perChunk.set(chunk.id, into);
  }
  const chunks: Chunk[] = statsChunks.map((chunk) => ({
    file: chunk.file,
    entry: chunk.initial && chunk.names.includes("main"),
    // Initial chunks load together with the entry; async chunks are loaded on demand.
    staticImports: chunk.siblings.flatMap((id) => files.get(id) ?? []),
    dynamicImports: chunk.children.flatMap((id) => files.get(id) ?? []),
    modules: perChunk.get(chunk.id) ?? {},
  }));
  return finish(dir, chunks);
};

export const webpackBundler: Bundler = {
  name: "webpack",
  takesExtraEntries: false,
  version: webpack.version,
  async build(entry, dir, mode) {
    const conservative = mode === "conservative";
    const compiler = webpack({
      mode: "production",
      target: "web",
      context: path.dirname(entry),
      entry: { main: entry },
      devtool: "hidden-source-map",
      performance: false,
      experiments: { outputModule: true },
      output: {
        path: dir,
        filename: "[name].js",
        chunkFilename: "[name]-[contenthash:8].js",
        module: true,
        chunkFormat: "module",
        chunkLoading: "import",
        library: { type: "module" },
        clean: true,
      },
      optimization: conservative
        ? {
            sideEffects: false,
            innerGraph: false,
            // `parallel: false` changes scheduling, never output: the size check already runs one build
            // per thread, and terser's own worker pool per build only oversubscribes the cores.
            // The optimised branch keeps webpack's default minimizer, which a consumer actually gets.
            minimizer: [
              new TerserPlugin({
                parallel: false,
                terserOptions: { compress: { side_effects: false } },
              }),
            ],
          }
        : {},
    });
    const stats = await new Promise<Stats>((resolve, reject) => {
      compiler.run((error, result) => {
        if (result === undefined || error !== null) reject(error ?? new Error("webpack: no stats"));
        else resolve(result);
      });
    });
    await new Promise<void>((resolve) => {
      compiler.close(() => {
        resolve();
      });
    });
    if (stats.hasErrors())
      throw new Error(`webpack: ${stats.toString({ all: false, errors: true })}`);
    return fromWebpackStats(dir, "webpack", stats.toJson(STATS_OPTIONS));
  },
};

/**
 * Vite bundles a recognised worker in a SEPARATE build and emits it as an asset, so the worker's
 * modules appear in no output chunk. Each emitted `.js` asset is therefore attributed through its
 * hidden source map and reported as a chunk that nothing imports statically, which is what makes it
 * lazy.
 */
export const viteBundler: Bundler = {
  name: "vite",
  takesExtraEntries: false,
  version: (await import("vite/package.json", { with: { type: "json" } })).default.version,
  async build(entry, dir, mode) {
    const result = await vite({
      configFile: false,
      root: path.dirname(entry),
      // A relative base resolves emitted files from `import.meta.url`, so the bundle also runs from
      // disk in the size check; the default `/` assumes a web server root.
      base: "./",
      logLevel: "silent",
      build: {
        outDir: dir,
        emptyOutDir: true,
        sourcemap: "hidden",
        minify: true,
        // The preload helper reads `document`, which the size check's Bun run lacks. It only speeds
        // up chunk loading, never changes results; platform-check runs Vite's default in browsers.
        modulePreload: false,
        rolldownOptions: {
          input: { main: entry },
          // An app build drops the entry's exports; the fixture's `run` must survive to be called.
          preserveEntrySignatures: "exports-only",
          output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
          treeshake:
            mode === "conservative" ? { annotations: false, moduleSideEffects: true } : true,
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as readonly RolldownOutput[];
    const chunks: Chunk[] = [];
    for (const item of outputs.flatMap((o) => o.output)) {
      const modules: Record<string, number> = {};
      if (item.type === "chunk") {
        for (const [id, info] of Object.entries(item.modules))
          addModule(modules, id, info.renderedLength);
        chunks.push({
          file: item.fileName,
          entry: item.isEntry,
          staticImports: item.imports,
          dynamicImports: item.dynamicImports,
          modules,
        });
      } else if (item.fileName.endsWith(".js")) {
        const map = path.join(dir, `${item.fileName}.map`);
        if (!existsSync(map))
          throw new Error(
            `Vite JavaScript asset ${item.fileName} has no source map: preserve attribution before judging unused code.`,
          );
        const code = readFileSync(path.join(dir, item.fileName), "utf8");
        const sourceMap = JSON.parse(readFileSync(map, "utf8")) as SourceMap;
        for (const [source, bytes] of Object.entries(attributeBySourceMap(code, sourceMap)))
          addModule(modules, path.resolve(path.dirname(map), source), bytes, true);
        chunks.push({
          file: item.fileName,
          entry: false,
          staticImports: [],
          dynamicImports: [],
          modules,
        });
      }
    }
    return finish(dir, chunks);
  },
};

export const finish = (dir: string, chunks: readonly Chunk[]): Built => {
  const entry = chunks.find((c) => c.entry);
  if (entry === undefined) throw new Error(`no entry chunk in ${dir}`);
  const emitted = readdirSync(dir, { recursive: true }).map(String);
  // An asset outside the reported graph still costs deployment bytes and may hide package code.
  const reported = new Set(chunks.map((chunk) => chunk.file));
  const missing = emitted.find((file) => file.endsWith(".js") && !reported.has(file));
  if (missing !== undefined)
    throw new Error(
      `Unattributed JavaScript asset ${missing}: include its bytes and source modules before judging this consumer.`,
    );
  return {
    dir,
    entryFile: path.join(dir, entry.file),
    chunks,
    emitted,
  };
};

export const BUNDLERS: readonly Bundler[] = [
  viteBundler,
  webpackBundler,
  rspackBundler,
  esbuildBundler,
  rolldownBundler,
  bunBundler,
];

/**
 * A second consumer whose copy of the package has NO `sideEffects` field, so a module can be dropped
 * only when its own top level does no work. Fixtures are copied alongside so relative paths match.
 */
export const withoutSideEffectsField = (from: Consumer, into: string): Consumer => {
  cpSync(from.dir, into, { recursive: true });
  const installed = path.join(into, "node_modules", PKG);
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  delete manifest.sideEffects;
  writeFileSync(path.join(installed, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: into, installed };
};

/**
 * The top-level code a bundler keeps from ONE dist module when nothing imports any of its bindings and
 * no `sideEffects` field vouches for it: bundles a bare `import` of the file with its own imports left
 * external and minification off, so the output is exactly the statements that bundler judged
 * effectful. The bundler is the instrument, never a hand-written purity heuristic.
 */
export const retainedTopLevel = async (
  bundler: "esbuild" | "rolldown",
  file: string,
  scratch: string,
): Promise<string> => {
  mkdirSync(scratch, { recursive: true });
  const entry = path.join(scratch, "entry.mjs");
  writeFileSync(entry, `import ${JSON.stringify(file)};\n`);
  let code: string;
  if (bundler === "esbuild") {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "silent",
      external: ["node:*"],
      plugins: [
        {
          name: "siblings-external",
          setup(build) {
            // esbuild compiles `filter` as a Go regular expression and rejects the `u` flag.
            // oxlint-disable-next-line eslint/require-unicode-regexp
            build.onResolve({ filter: /^\.\.?\// }, (args) =>
              args.importer === entry ? undefined : { path: args.path, external: true },
            );
          },
        },
      ],
    });
    code = result.outputFiles.map((o) => o.text).join("\n");
  } else {
    const bundle = await rolldown({
      input: entry,
      platform: "browser",
      logLevel: "silent",
      external: (id, importer) =>
        id.startsWith("node:") ||
        (importer !== undefined && importer !== entry && /^\.\.?\//u.test(id)),
    });
    const { output } = await bundle.generate({ format: "esm" });
    await bundle.close();
    code = output.map((o) => (o.type === "chunk" ? o.code : "")).join("\n");
  }
  return code
    .replaceAll(/\/\*\*[\s\S]*?\*\//gu, () => "")
    .split("\n")
    .filter((line) => !/^\s*(import\b|export\s*\{|\/\/)/u.test(line) && line.trim() !== "")
    .join("\n");
};

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Generated characters per original source, from a v3 source map: each mapping segment owns the
 * generated columns up to the next segment on its line. Unmapped runtime glue is attributed to no one.
 */
export type SourceMap = { readonly sources: readonly string[]; readonly mappings: string };

export const attributeBySourceMap = (code: string, map: SourceMap): Record<string, number> => {
  const lines = code.split("\n");
  const out: Record<string, number> = {};
  let source = 0;
  for (const [line, group] of map.mappings.split(";").entries()) {
    const segments: { col: number; src: number | undefined }[] = [];
    let col = 0;
    for (const segment of group.split(",")) {
      if (segment === "") continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = BASE64.indexOf(ch);
        value += (digit & 31) << shift;
        if ((digit & 32) === 0) {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        } else {
          shift += 5;
        }
      }
      // A non-empty segment always decodes its first field; the source delta exists from four on.
      const [colDelta = 0, sourceDelta = 0] = fields;
      col += colDelta;
      if (fields.length >= 4) source += sourceDelta;
      segments.push({ col, src: fields.length >= 4 ? source : undefined });
      // Fields 2 and 3 (original line/column) and 4 (name) are relative too but unused here; only
      // the source index accumulates across segments, so it is the one state carried.
    }
    const width = lines[line]?.length ?? 0;
    for (const [i, { col: from, src }] of segments.entries()) {
      const original = src === undefined ? undefined : map.sources[src];
      if (original === undefined) continue;
      const to = segments[i + 1]?.col ?? width;
      out[original] = (out[original] ?? 0) + Math.max(0, to - from);
    }
  }
  return out;
};
