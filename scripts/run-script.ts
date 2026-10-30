// SPDX-License-Identifier: Apache-2.0

/**
 * Runs one package script and captures exactly what a terminal would have shown.
 *
 * Both output streams go to ONE descriptor. A tool's diagnostics and bun's own `$ command` echoes
 * interleave, and that order is the one thing the reader of a failed gate cannot afford to lose;
 * two pipes read separately and concatenated afterwards would scramble it. Merging them needs a real
 * descriptor both can hold — `"pipe"` always makes a fresh one per stream — and a temporary file is
 * the simplest descriptor available to a script.
 *
 * Callers name a SCRIPT, never a command line: what `check` or `format` means stays in
 * `package.json` alone, so no caller can drift from the lane it runs.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The error ceiling for a complete lane: a lane that needs longer is a defect in itself. It is a real
 * deadline, not just a number in a document: a hung step otherwise blocks a commit forever, and
 * while a person can press Ctrl-C, a script, an agent or CI cannot — and killing THEM orphans the
 * children.
 */
export const LANE_DEADLINE_MS = 5 * 60 * 1000;

// Browser startup and one page operation must finish before the platform owner keeps waiting.
export const PLATFORM_OBSERVATION_MS = 20_000;

/**
 * What the commit hook allows itself, derived rather than chosen so the two cannot drift apart. It
 * must be WIDER, because the hook also formats before it runs the lane, and because the lane's own
 * deadline gives the better message — it names WHICH step was still running. Written here, beside
 * the bound it depends on, so the relation is code rather than a comment in another file.
 */
export const HOOK_DEADLINE_MS = LANE_DEADLINE_MS + 60 * 1000;

/**
 * What a commit is expected to COST, which is a different question from what stops a runaway.
 *
 * A breach is reported and never fatal. A slow hook is a defect in the hook, not in the commit, so
 * failing the commit for it punishes the wrong thing and teaches the author to reach for
 * `--no-verify` — which turns a performance problem into an ungated repository. Deliberately far
 * below `HOOK_DEADLINE_MS`: that number bounds a HANG and must be generous, while these describe a
 * hook that still works but has become too slow for anyone to keep running before every commit.
 * Without them nothing notices the difference between a two-second hook and a forty-second one.
 *
 * They are this repository's warning and error ceilings for a hook. The error threshold still
 * reports without rejecting work.
 */
export const HOOK_WARN_MS = 10_000;
export const HOOK_ERROR_MS = 20_000;

export interface ScriptRun {
  readonly script: string;
  /**
   * Why the run ended, tagged rather than a boolean because three outcomes are not two: a `stopped`
   * run reported nothing about the code, and calling that a failure tells a reader to go looking for
   * a defect that was never diagnosed.
   *
   * `failed` also covers a script that could never start, since the reason is in `output` either way
   * and no caller can act differently on it. `stopped` says only that the caller's own signal killed
   * the child — WHY that signal fired is the caller's knowledge, so the caller writes that sentence.
   */
  readonly kind: "passed" | "failed" | "stopped";
  /** stdout and stderr, merged in the order they were written. Empty when the script was quiet. */
  readonly output: string;
  readonly ms: number;
}

/**
 * Resolves rather than rejects on a failed script: a red gate is an ANSWER, not an exception, and a
 * caller running several must be able to collect every verdict instead of losing the rest to the
 * first throw. `signal` aborts by killing the child, so a cancelled run stops its work rather than
 * being abandoned to finish unwatched.
 */
export const runScript = (
  script: string,
  signal?: AbortSignal,
  args: readonly string[] = [],
  cwd?: string,
): Promise<ScriptRun> => {
  const started = Date.now();
  const dir = mkdtempSync(path.join(tmpdir(), "partial-json-repair-run-"));
  const file = path.join(dir, "output");
  const fd = openSync(file, "w+");

  return new Promise<ScriptRun>((resolve) => {
    let failure: { kind: "failed" | "stopped"; extra?: string } | undefined;
    const finish = (kind: ScriptRun["kind"], extra?: string) => {
      closeSync(fd);
      const captured = readFileSync(file, "utf8");
      rmSync(dir, { recursive: true, force: true });
      resolve({
        script,
        kind,
        output: extra === undefined ? captured : `${captured}${extra}\n`,
        ms: Date.now() - started,
      });
    };
    const child = spawn("bun", ["run", script, "--", ...args], {
      cwd,
      stdio: ["ignore", fd, fd],
      signal,
    });
    // Abort errors can precede child cleanup. Keep their verdict until close joins owned work and
    // completes its output; the signal distinguishes a requested stop from a startup failure.
    child.on("error", (error) => {
      failure =
        signal?.aborted === true
          ? { kind: "stopped" }
          : { kind: "failed", extra: `bun run ${script}: ${error.message}` };
    });
    // A recorded abort stays stopped even when cleanup exits zero. Otherwise a zero exit owns the
    // verdict: a later signal must not relabel a completed check as unfinished.
    child.on("close", (code) => {
      if (failure === undefined)
        finish(code === 0 ? "passed" : signal?.aborted === true ? "stopped" : "failed");
      else finish(failure.kind, failure.extra);
    });
  });
};
