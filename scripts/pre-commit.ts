#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * The ordinary commit-path gate: it PREPARES what Git is about to commit, then validates the working
 * tree, naming any path where the tree and the commit differ.
 * Hooks prevent accidents, not deliberate bypasses. `--no-verify` still works, and that is
 * sufficient: an accident is what this stops, while a bypass is a decision someone made and can be
 * seen making.
 *
 * Running the commit checks used to be a rule to remember, and
 * remembering failed once: a pipeline's exit status is its LAST stage's, so
 * `bun run check | tail -4 && git commit` reads `tail`'s zero and commits over a red lane.
 *
 * THE HOOK IS NOT THE GATE. It runs the fast checks that judge what this commit carries, and only
 * those: `scripts/check.ts --changed` picks each step by the paths it reads and limits it to them,
 * and leaves out the steps marked `hook: "skip"` (packing, the second test runtime, the async
 * replay), whose wait would not earn its value on every commit. `bun run check` and CI run
 * everything. A hook people wait on gets bypassed, and then none of its checks protect anything, so
 * it aims at well under the 10 s warning. Rust is in neither: `bun run rust:check` runs by hand when
 * `rust/` changes.
 *
 * PREPARE, DO NOT REJECT. An automatic fix has exactly one right answer, so rejecting a commit that
 * needs one only hands the author a round trip to run a command the hook could have run itself.
 * That covers every fix the tooling can make by itself: `lint:fix` as well as `format`. Both write
 * only the committed paths whose worktree bytes ARE the staged bytes, and their checkers judge the
 * same committed paths, so no file outside the commit is ever rewritten or judged. `git add` on a
 * path that also carries unstaged edits would sweep in work the author deliberately left out of this
 * commit; those paths are formatted in the index alone, below.
 *
 * SILENCE ON SUCCESS. A green run used to print 4692 bytes, 48 of them tsdown's `dist/` listing, on
 * every commit. This repository is worked by AI agents, for whom that is context window spent to
 * learn that nothing happened. Output is replayed only on failure, where all of it is wanted and
 * where truncating it is the very defect described above.
 *
 * TypeScript rather than shell, because the shell version was wrong and not merely clumsy.
 * `git diff --name-only` quotes and octal-escapes any path outside ASCII, so a staged `план.md`
 * arrives as `"\320\277\320\273\320\260\320\275.md"`, names no file when passed back to `git add`,
 * and blocks every commit. `-z` and a `split` fix it; shell needs a `read -d ''` bashism. Two more
 * shell traps are structurally absent here: `set -e` ends the hook silently when `grep` matches
 * nothing, which is the ordinary case for a set difference, and `set -u` aborts on the very
 * variable the HLD branch exists to test for.
 *
 * `.githooks/pre-commit` is a SYMLINK to this file, so the gate exists once. It was two files for a
 * while — Git needs that exact filename, and a one-line shell shim was the obvious way to give it
 * one. The cost only showed up later: a commit replaced this file and left the other one holding a
 * whole rival copy of the gate, which is what Git actually ran, for four commits, silently. The
 * shim's premise was also untrue. It said a symlink would rest on Bun resolving the link to find
 * the TypeScript loader; Bun 1.4 runs TypeScript from an extension-less path either way, measured.
 * `wiring:check` fails the lane if the link is ever broken or replaced, or if `core.hooksPath` stops
 * pointing at `.githooks`, because nothing else reveals which file Git runs — or whether it runs one
 * at all. The shebang is what lets Git exec the link directly.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import type { ScriptRun } from "./run-script";
import { HOOK_DEADLINE_MS, HOOK_ERROR_MS, HOOK_WARN_MS, runScript } from "./run-script";

const started = performance.now();
/** Every script this hook ran, kept only so a slow run can name WHICH part was slow. */
const runs: ScriptRun[] = [];

const seconds = (value: number): string => `${(value / 1000).toFixed(1)}s`;

/**
 * Reports how long the hook took, but only once that stops being uninteresting.
 *
 * Nothing else measures this. A hook that has drifted from two seconds to forty still passes every
 * check, so the cost lands on whoever commits next and no signal ever says why. Naming the slowest
 * script is most of the diagnosis.
 *
 * NEVER changes the exit status: the commit is not at fault for the hook being slow, and a hook that
 * rejects work over its own latency is one people disable. Printed FIRST on the failure path,
 * because a red gate's output can run to hundreds of lines and anything after it is not read — the
 * failure itself must stay at the bottom, which is where a reader looks for what to do next.
 */
const reportDuration = (): void => {
  const ms = performance.now() - started;
  if (ms < HOOK_WARN_MS) return;
  const slowest = runs.reduce<ScriptRun | undefined>(
    (worst, run) => (worst === undefined || run.ms > worst.ms ? run : worst),
    undefined,
  );
  const detail = slowest?.output.trimEnd().split("\n").at(-1);
  console.error(
    `pre-commit: ${ms >= HOOK_ERROR_MS ? "ERROR" : "warning"}: the hook took ${seconds(ms)}, over its ${seconds(HOOK_WARN_MS)} budget` +
      (slowest === undefined
        ? ""
        : `, slowest \`bun run ${slowest.script}\` at ${seconds(slowest.ms)}`) +
      (detail === undefined || detail === "" ? "" : ` (${detail})`) +
      `. Your commit is unaffected — this is the hook to fix, not the change.`,
  );
};

/** Ends the commit. Lines are written in order, so guidance goes LAST — where a reader scrolled to
 *  the bottom of a long gate dump actually looks. */
const fail = (...lines: readonly string[]): never => {
  reportDuration();
  for (const line of lines) console.error(line);
  process.exit(1);
};

/**
 * Every Git call this hook makes takes paths literally. Git otherwise reads `*`, `?` and `[` in a
 * pathspec as a pattern, so `git add -- "a*.ts"` for a committed file literally named that would also
 * stage `ab.ts`, another author's unstaged work. Set per call, not on `process.env`: the checks the
 * hook runs are ordinary commands whose own Git calls must keep Git's normal pathspecs.
 */
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };

/** `undefined` when git exits non-zero, for the callers that treat that as an answer rather than a
 *  breakage. */
const tryGit = (...args: readonly string[]): string | undefined => {
  const result = spawnSync("git", args, { encoding: "utf8", env: GIT_ENV });
  return result.status === 0 ? result.stdout : undefined;
};

/** A git call whose failure means this hook is broken, not that the commit is bad. Nothing is
 *  reported as an author-fixable defect on this path, because none of it is. */
const git = (...args: readonly string[]): string =>
  tryGit(...args) ??
  fail(`pre-commit: \`git ${args.join(" ")}\` failed, so nothing was committed.`);

/** Raw bytes, for content that has to survive a round trip through this process unchanged. */
const gitBytes = (...args: readonly string[]): Buffer => {
  const result = spawnSync("git", args, { env: GIT_ENV });
  return result.status === 0
    ? result.stdout
    : fail(`pre-commit: \`git ${args.join(" ")}\` failed, so nothing was committed.`);
};

/** Paths from a `-z` git command. NUL-separated deliberately — see the quoting note in the header;
 *  the trailing NUL yields one empty field, which is dropped rather than becoming a path. */
const gitPaths = (...args: readonly string[]): string[] =>
  git(...args, "-z")
    .split("\0")
    .filter((entry) => entry.length > 0);

/*
 * HLD.md changes only with the maintainer's approval of the exact delta. A hook cannot verify that —
 * it has no idea who ran it — so this asks the author to name the staged bytes instead. Everything a
 * blocked author needs is in the failure message, not here: that is the copy they actually read.
 *
 * A hash, not a flag, because approval is of BYTES. An edit after approval moves it, which is the
 * case a boolean waves through.
 *
 * The message says outright that it is a confirmation. Worded as "maintainer-owned; not approved" it
 * read as a permission wall, and an agent holding an approval sat on finished work rather than
 * re-running one command. Any check that sounds like authorization but only asks "are you sure" has
 * to say so where it fires.
 */
if (gitPaths("diff", "--cached", "--name-only", "--", "HLD.md").length > 0) {
  const approved = tryGit("rev-parse", "--verify", ":HLD.md")?.trim();
  if (approved === undefined) fail("HLD.md is maintainer-owned and may not be deleted.");
  if (process.env["HLD_APPROVED_BLOB"] !== approved) {
    fail(
      "HLD.md is staged and HLD_APPROVED_BLOB does not name its bytes.",
      `  Approved this exact delta? Re-run with HLD_APPROVED_BLOB=${approved}`,
      "  Edited HLD.md after approval? The hash moved — the maintainer must see the new bytes.",
      "  Did not mean to touch HLD.md? `git restore --staged HLD.md`.",
      "",
      "  CONFIRMATION, NOT PERMISSION: nothing here knows whether approval happened, and the first",
      "  line above hands you the value that clears it. Do not stall waiting to be let through.",
    );
  }
}

// The selected change: what the candidate (the index Git handed this hook) holds that HEAD does not.
// It alone decides which checks run and what they read, because the commit carries nothing else; an
// unstaged or untracked file belongs to someone's next commit, and judging it here would block this
// one over work it does not contain. Added and deleted paths select steps like any other (a deletion
// can break an import), so nothing widens the run to the whole tree. On an initial commit
// `git diff --cached` compares with the empty tree, so the whole candidate is selected.
const changed = gitPaths("diff", "--cached", "--name-only", "--no-renames");
// Nothing selected means nothing to prepare or judge (`git commit --allow-empty`, or a merge that
// only records parents).
if (changed.length === 0) process.exit(0);

// Paths staged with no unstaged edit on top: their worktree bytes ARE the candidate, so a fixer may
// rewrite them and the result may be staged with nothing of the author's at risk. Read before any
// fixer runs, because it is the fixers that make them differ.
const unstaged = new Set(gitPaths("diff", "--name-only"));
const staged = gitPaths("diff", "--cached", "--name-only", "--diff-filter=ACMR");
const restageable = staged.filter((candidate) => !unstaged.has(candidate));
// The fixers write only these, so nothing outside the commit is rewritten and nothing the author
// left unstaged is touched. oxlint refuses a path list holding no file it lints; oxfmt skips the
// file types it ignores (Markdown) only under its unmatched-pattern flag.
const lintable = restageable.filter((path) => /\.[cm]?[jt]sx?$/u.test(path));

/** Staged `mode` and `blob` of each path in `index` (the candidate when omitted), in one Git call. */
const stageOf = (
  paths: readonly string[],
  index?: string,
): Map<string, { readonly mode: string; readonly blob: string }> => {
  if (paths.length === 0) return new Map();
  const result = spawnSync("git", ["ls-files", "--stage", "-z", "--", ...paths], {
    encoding: "utf8",
    env: index === undefined ? GIT_ENV : { ...GIT_ENV, GIT_INDEX_FILE: index },
  });
  if (result.status !== 0)
    fail("pre-commit: `git ls-files --stage` failed, so nothing was committed.");
  return new Map(
    result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        const [mode = "", blob = ""] = entry.slice(0, tab).split(" ");
        return [entry.slice(tab + 1), { mode, blob }] as const;
      }),
  );
};
// What preparation starts from, so settling the repository index below can tell its own stale
// entry from one someone else wrote while the hook ran.
const preparedFrom = stageOf(restageable);

// ONE budget for both runs below, so a hook wedged anywhere still ends. Without it `git commit`
// hangs with no output and nothing to act on — no hint what to kill. It only ever fires on a hang;
// the whole hook takes seconds.
const deadline = AbortSignal.timeout(HOOK_DEADLINE_MS);

/** The one place a script is run, so nothing this hook does can escape the duration report. */
const run = async (script: string, args: readonly string[] = []): Promise<ScriptRun> => {
  const result = await runScript(script, deadline, args);
  runs.push(result);
  return result;
};

/**
 * Runs a script under that budget and ends the commit unless it passed. `whenFailed` says what a RED
 * run means for this commit, which differs per script; a run the deadline killed judged nothing at
 * all, so it gets its own sentence instead — naming the bound the committer has just waited out,
 * which is the one fact `The operation was aborted` never tells them.
 */
const runOrFail = async (
  script: string,
  args: readonly string[],
  whenFailed: () => readonly string[],
): Promise<void> => {
  const outcome = await run(script, args);
  if (outcome.kind === "passed") return;
  if (outcome.kind === "stopped") {
    fail(
      outcome.output,
      // Seconds, in the same shape `scripts/check.ts` reports its own deadline, so the two
      // messages a committer may see read alike whichever bound fired.
      `pre-commit: \`bun run ${script}\` was still running after ${String(HOOK_DEADLINE_MS / 1000)}s and was killed, so nothing was committed.`,
    );
  }
  fail(outcome.output, ...whenFailed());
};

// Auto-fixes are APPLIED, never judged, and the result is not checked here: `oxlint --fix` exits
// non-zero whenever unfixed issues remain, which is the ordinary case and is exactly what the gate
// below reports, with full output and a message that names the gate. Rejecting here would end the
// commit before the formatter had run, and preparation never rejects.
//
// Safe fixes only — `--fix-suggestions` and `--fix-dangerously` can change behaviour and are not in
// the script. Before the formatter, because a lint fix writes code the formatter still has to lay
// out, and the formatter must have the last word on layout.
if (lintable.length > 0) await run("lint:fix", lintable);
if (restageable.length > 0) {
  await runOrFail("format", ["--no-error-on-unmatched-pattern", ...restageable], () => [
    "pre-commit: `bun run format` failed, so nothing was prepared and nothing was committed.",
  ]);
}

// Neither fixer reports what it rewrote, so the change set is read back from git: a restageable path
// that now differs from the index is one a fixer has just changed. Asking git rather than the tools
// is also what keeps this one block correct as fixers are added — it measures the effect, not the
// cause.
const nowUnstaged = new Set(gitPaths("diff", "--name-only"));
const fixed = restageable.filter((candidate) => nowUnstaged.has(candidate));
/**
 * Whether the index this hook stages into is thrown away after the commit.
 *
 * A path-limited commit (`git commit --only`, or any `git commit -- <paths>`) is handed a disposable
 * `next-index-<pid>.lock`. It becomes the COMMIT and is then discarded, while Git holds the
 * repository index, pre-format blobs included, in `.git/index.lock` and renames that over
 * `.git/index` once the commit lands. Left alone, the path reads `MM` afterwards, and the next plain
 * `git commit` stages the pre-format bytes again: a silent revert of the formatting.
 *
 * So the hook writes its prepared blobs into `.git/index.lock` too (measured, git 2.56: index and
 * commit then agree and status is clean). `update-index` with that file as `GIT_INDEX_FILE` takes
 * `index.lock.lock`, so it is an ordinary staging operation under Git's own lock, and a refused
 * commit deletes the lock and the write with it. Aiming at `.git/index` instead fails with
 * `Unable to create '.git/index.lock'`, and `git rev-parse --git-path index` names the candidate
 * here, because `GIT_INDEX_FILE` is set. This relies on Git renaming its lock rather than rewriting
 * it after the hook, which Git does not document.
 *
 * A plain commit gets `index`, which IS the repository index, and `-a`/`--include` get
 * `index.lock`, which Git renames onto it; neither needs settling. Settling is gated on the one name
 * that does AND on Git's lock existing: `update-index` on a missing `.git/index.lock` would create a
 * lone index there and every later Git command would refuse to run (a dry run or a test hands the
 * hook a private candidate with no commit in flight).
 */
const repositoryLock = `${git("rev-parse", "--git-dir").trim()}/index.lock`;
const indexIsDiscarded =
  basename(process.env["GIT_INDEX_FILE"] ?? "index").startsWith("next-index-") &&
  existsSync(repositoryLock);

if (fixed.length > 0) {
  // `git` and not `tryGit`, so the report below is unreachable unless the staging happened. A
  // failed `git add` announced as success would hide the worst outcome available here: the gate
  // passes, because it reads the formatted worktree, while the commit keeps the unformatted bytes.
  git("add", "--", ...fixed);
  // Silent on the ordinary path. Applying formatting and staging it IS this hook's job, so saying so
  // reports that the thing worked — and the commit's own diff already holds the result, for a reader
  // who cares. This repository is worked by AI agents, and a line per commit is context spent to
  // learn that nothing surprising happened.
  if (indexIsDiscarded) {
    // Only an entry still holding the blob preparation started from is the hook's stale copy; any
    // other value was written by someone while the hook ran, is user work, and is left alone.
    const prepared = stageOf(fixed);
    const held = stageOf(fixed, repositoryLock);
    const settle = fixed.filter((path) => held.get(path)?.blob === preparedFrom.get(path)?.blob);
    const records = settle.flatMap((path) => {
      const entry = prepared.get(path);
      return entry === undefined ? [] : [`${entry.mode} ${entry.blob}\t${path}\0`];
    });
    if (records.length > 0) {
      const result = spawnSync("git", ["update-index", "-z", "--index-info"], {
        input: records.join(""),
        env: { ...GIT_ENV, GIT_INDEX_FILE: repositoryLock },
      });
      if (result.status !== 0)
        fail(
          "pre-commit: `git update-index` on the repository index failed, so nothing was committed.",
        );
    }
    const left = fixed.filter((path) => !settle.includes(path));
    if (left.length > 0) {
      // Every line carries the prefix: a reader filtering hook output by it keeps the action too.
      console.error(
        `pre-commit: reformatted in the commit, but the repository index changed meanwhile, so it was left alone: ${left.join(" ")}` +
          `\npre-commit: review those paths with \`git diff --cached\` before your next commit.`,
      );
    }
  }
}

// A path staged and then edited again is committed from its staged bytes, not the worktree's.
// The formatter above must not reach it, because writing that file would destroy the edit
// the author deliberately left unstaged. Left alone, its staged bytes stay unformatted and the
// commit fails `format:check` for anyone who checks it out — while this hook stays green, because
// the gate reads the worktree, which IS formatted. Measured before this existed.
//
// So the formatter is fed the staged content and the result goes back into the index alone. Never
// touching the file on disk is what makes that safe, and it is why `git stash` is not used here:
// the usual answer to this problem parks the author's only copy of unstaged work in a tool's
// private state.
const formattedInIndex: string[] = [];
for (const candidate of staged) {
  if (!unstaged.has(candidate)) continue;
  // Ordinary files only. A symlink's staged content is its target path, so formatting it would
  // repoint the link, and a submodule entry is not file content at all.
  const entry = gitBytes("ls-files", "--stage", "--", candidate).toString("utf8");
  const mode = entry.slice(0, entry.indexOf(" "));
  if (mode !== "100644" && mode !== "100755") continue;

  const current = gitBytes("show", `:${candidate}`);
  // Through `bun run`, so the choice of formatter stays in `package.json` and this hook does not
  // become a second place that names one. A non-zero status means the formatter does not handle
  // this file type — it says so and changes nothing, which is why skipping on it is safe.
  const reformatted = spawnSync("bun", ["run", "--silent", "format:stdin", candidate], {
    input: current,
  });
  if (reformatted.status !== 0 || reformatted.stdout.equals(current)) continue;

  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    input: reformatted.stdout,
    encoding: "utf8",
  });
  if (blob.status !== 0) fail("pre-commit: `git hash-object` failed, so nothing was committed.");
  git("update-index", "--cacheinfo", `${mode},${blob.stdout.trim()},${candidate}`);
  formattedInIndex.push(candidate);
}
if (formattedInIndex.length > 0) {
  // Reported even though the commit succeeds: for these paths the committed bytes and the file on
  // disk now differ, and nothing else about the commit says so.
  console.error(
    `pre-commit: formatted in the commit only, your unstaged edits on disk untouched: ${formattedInIndex.join(" ")}`,
  );
}

// The checks read the working tree, and the commit is the index this hook was handed. Wherever they
// differ, a failure may come from bytes the commit does not hold: an unstaged edit or an untracked
// file that typecheck and test discovery read, often another agent's. Validating the commit's own tree
// would mean materialising it with every `node_modules` on every commit; naming the difference costs
// two Git calls, and only a failure needs it, so a passing commit stays silent and skips them.
await runOrFail("check:commit", ["--changed", ...changed], () => {
  const outsideCommit = [
    ...gitPaths("diff", "--name-only"),
    ...gitPaths("ls-files", "--others", "--exclude-standard"),
  ];
  return [
    "pre-commit: the commit checks failed, so nothing was committed.",
    ...(outsideCommit.length === 0
      ? []
      : [
          `pre-commit: the checks read the working tree, which differs from this commit in: ${outsideCommit.join(" ")}`,
          "pre-commit: if the failure is in one of those files, it is not this commit's defect.",
        ]),
    `Fix what is reported above; reproduce it with \`bun scripts/check.ts --commit --changed ${changed.join(" ")}\`.`,
  ];
});

// Last, so it measures everything the commit waited for. Silent unless the hook is over budget.
reportDuration();
