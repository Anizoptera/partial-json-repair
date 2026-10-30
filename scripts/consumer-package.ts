// SPDX-License-Identifier: Apache-2.0

/** Pack an isolated consumer without loading or running any bundler. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const PKG = "partial-json-repair";

export type Consumer = {
  /** Directory holding `package.json`, `node_modules/partial-json-repair` and `fixtures/`. */
  readonly dir: string;
  readonly installed: string;
};
export type Packed = {
  readonly work: string;
  // Resolve the archive here so callers cannot read its filename from an unrelated cwd.
  readonly tarballPath: string;
  readonly tarballBytes: number;
  readonly consumer: Consumer;
};

/**
 * The README's recipe for bundlers that do not emit new Worker(new URL(...)) targets. The receiver
 * joins the app's build because the app imports it lazily and shares its modules. The worker is a
 * build of its own: threads share no module instances, and as an entry of the app's build its
 * engine landed in a chunk shared with the app's startup (esbuild: 105 KB at startup, 20 KB apart).
 */
export type WorkerRecipe = { readonly receiver: string; readonly worker: string };
export const workerRecipe = (consumer: Consumer): WorkerRecipe => ({
  receiver: path.join(consumer.installed, "dist", "worker-executor.js"),
  worker: path.join(consumer.installed, "dist", "async-worker.js"),
});

/**
 * Installs the retained release archive when supplied, otherwise packs the current build for
 * development. Both use `node_modules`, never source aliases (docs/CONSUMER-GRAPH.md).
 */
export const packConsumer = (root: string, prefix = "pjr-consumer-"): Packed => {
  const supplied = process.env.PJR_CONSUMER_ARCHIVE;
  // Only development packing reads the workspace; retained archives already own their build.
  if (supplied === undefined && !existsSync(path.join(root, "dist", "index.js")))
    throw new Error(
      `Packed consumer checks require build output in ${root}. Run bun run build first; check and platform:check build it automatically.`,
    );
  // A fixed path, not `mkdtemp`: bundlers hash chunk names from module paths, and a random directory
  // gave identical code different names and compressed sizes on every run, enough to cross the 2%
  // regression bound by chance. A fixed path admits one run at a time, so a live owner's pid refuses
  // a second run instead of letting it delete the first one's files mid-build.
  const work = path.join(tmpdir(), prefix.replace(/-$/u, ""));
  const owner = path.join(work, ".pid");
  if (existsSync(owner)) {
    const pid = Number(readFileSync(owner, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // No such process: the previous run ended without cleaning up (`--keep` or a crash).
    }
    if (alive) throw new Error(`${work} is in use by pid ${pid}; wait for that run to finish`);
  }
  rmSync(work, { recursive: true, force: true });
  // Until a caller receives the path, only this helper can clean a failed pack or extraction.
  try {
    mkdirSync(work, { recursive: true });
    writeFileSync(owner, String(process.pid));
    // Read supplied bytes directly: repacking here would prove a different artifact than publication.
    let tarballPath: string;
    if (supplied === undefined) {
      // `--ignore-scripts`: packing runs `prepare`, which reinstalls `bench/prior-art` and resets the
      // Git hook path mid-gate; neither changes what the tarball holds.
      const pack = spawnSync(
        process.execPath,
        ["pm", "pack", "--destination", work, "--quiet", "--ignore-scripts"],
        { cwd: root, encoding: "utf8" },
      );
      if (pack.status !== 0) throw new Error(`bun pm pack failed: ${pack.stderr}`);
      const tarballName = readdirSync(work).find((f) => f.endsWith(".tgz"));
      if (tarballName === undefined)
        throw new Error(`bun pm pack wrote no .tgz into ${work}: ${pack.stdout}`);
      tarballPath = path.resolve(work, tarballName);
    } else {
      tarballPath = path.resolve(supplied);
      if (!existsSync(tarballPath))
        throw new Error(
          `PJR_CONSUMER_ARCHIVE names ${tarballPath}, which does not exist. Point it at the retained cleaned archive, or unset it to pack the current build; a missing archive is never replaced by repacking.`,
        );
    }
    const dir = path.join(work, "consumer");
    const installed = path.join(dir, "node_modules", PKG);
    mkdirSync(installed, { recursive: true });
    const untar = spawnSync("tar", ["-xzf", tarballPath, "-C", installed, "--strip-components=1"], {
      encoding: "utf8",
    });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "consumer", private: true, type: "module" }),
    );
    mkdirSync(path.join(dir, "fixtures"), { recursive: true });
    return {
      work,
      tarballPath,
      tarballBytes: readFileSync(tarballPath).byteLength,
      consumer: { dir, installed },
    };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
};
