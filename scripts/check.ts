#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * The repository's gate: every check, run for real, in as few seconds as the work allows.
 *
 * Why this is a script and not a `&&` chain in `package.json`. A chain is serial, and almost nothing
 * here depends on anything else, so a chain spends more time waiting than working. It also stops at
 * the first red, so it returns ONE defect per run when it could return all of them, and each extra
 * round trip costs a full lane.
 *
 * Artifact, size and release checks read build output. The typecheck and lint edges follow from
 * a single fact: `bench/throughput.ts` imports
 * `../dist/index.js`, because the benchmark measures the shipped bundle rather than the source. So
 * `typecheck` follows that import, and `lint` follows it too — `--type-aware` RESOLVES the file even though
 * `dist/` is git-ignored and therefore never LINTED. Being ignored as a target and being unread are
 * different things, and `.gitignore` only answers the second: planting a malformed file in `dist/`
 * leaves both tools green, which is why this edge is easy to miss. A missing edge shows as an
 * intermittent `Failed to open file .../dist/index.js` while tsdown rewrites it.
 *
 * The two fail differently: `typecheck` refuses a MISSING `dist/` outright (TS2307), so run before
 * `build` on a fresh checkout it fails every time, while `lint` is happy without it and breaks only
 * when the file vanishes mid-read.
 *
 * Every other step reads only the source tree and is safe beside a build.
 *
 * At most one step per core (`slots` below); apart from the explicit build edges the steps are
 * independent. On a machine with few cores the heavy steps queue, which costs time and never
 * correctness.
 *
 * Each step is named, never spelled out: what `test` or `typecheck` means stays in `package.json`,
 * so this file cannot drift from the commands a developer runs by hand.
 *
 * `bun run --parallel` is the way to avoid owning any of this, and it was measured rather than waved
 * off. The closest equivalent, `bun run build && bun run --parallel <the rest>`, is slower here,
 * because everything then waits on `build` — including `test`, which does not need it. It also
 * prints every step's output on success, kills the surviving steps when one fails, and
 * `--no-exit-on-error` returns the failing child's own code rather than a verdict. None of that is
 * wrong for a task runner; it just is not a gate. Revisit if Bun grows per-step dependencies.
 */
import { existsSync } from "node:fs";

import { DOCUMENTED } from "./artifact-docs";
import { LANE_DEADLINE_MS, runScript, type ScriptRun } from "./run-script";

interface Step {
  readonly script: string;
  /**
   * Script whose OUTPUT this one reads. Must appear earlier in the list. Each consumer currently
   * has one immediate producer; add a list only when a consumer really needs independent outputs.
   */
  readonly needs?: string;
  /**
   * Under `--changed`, the producer is needed only when a changed path matches. `lint` and
   * `typecheck` read `dist/` only when they judge `bench/` files, so other commits skip the build.
   */
  readonly needsFor?: (path: string) => boolean;
  /**
   * Starts a worker per core itself, so it holds every slot: one slot under it put twice as many
   * busy processes as cores, and timed cases passed their timeouts on contention alone.
   */
  readonly allCores?: true;
  /** Runs in the complete profile only, so CI can run the CPU-heavy half on its own runner. */
  readonly completeOnly?: true;
  /**
   * Membership in the commit hook's run (`--changed`), which is NOT a gate pass: it runs the fast
   * checks on what the commit carries, and the full lane plus CI run everything. A hook people wait on
   * gets bypassed, and then none of its checks protect anything. `skip`: its value at commit
   * time does not earn its wait, so it runs only in full runs. `only`: the hook's narrow stand-in for
   * a `skip` step, which a full run would merely repeat. Absent: both.
   */
  readonly hook?: "skip" | "only";
  /**
   * Paths whose content this step never reads, so `--changed` skips it when only they changed.
   * Absent means it reads every path. Under-declaring only costs time; over-declaring is a false
   * green, so list a path only after reading the step's code. Complete runs ignore this field.
   */
  readonly ignores?: (path: string) => boolean;
  /**
   * Under `--changed`, the arguments that limit the step to the changed paths it reads: every
   * reliable option a tool has to limit its work to the commit is used. `undefined` means none of
   * those paths is a target the tool accepts, so the step has nothing to judge and does not run.
   */
  readonly scope?: (paths: readonly string[]) => readonly string[] | undefined;
}

const PROFILES = ["--commit", "--complete-only"] as const;
const args = process.argv.slice(2);
const profile = args[0] as (typeof PROFILES)[number] | undefined;
// `--changed <path>...` comes from the commit hook, which owns change detection; without it every
// step runs, which is what a developer running the edit gate by hand wants.
const changed =
  profile === "--commit" && args[1] === "--changed" && args.length > 2 ? args.slice(2) : undefined;
if (
  (changed === undefined && args.length > 1) ||
  (profile !== undefined && !PROFILES.includes(profile))
) {
  throw new Error(
    `check: expected no arguments, --complete-only, or --commit [--changed <path>...]; got ${args.join(" ")}.`,
  );
}

// Markdown no step compiles or tests. README.md and docs/API.md carry compiled examples and
// README.md is read by tests; oxfmt ignores Markdown; every other `.md` is read only by
// `fixtures:check` (all tracked files) and, for AGENTS.md/CLAUDE.md, `steering:check`.
const prose = (path: string): boolean => path.endsWith(".md") && !DOCUMENTED.includes(path);
// Read at runtime by `size:check` alone; `format:check` and `fixtures:check` read it as a file.
const sizeReference = (path: string): boolean => path === "bench/size-baseline.json";
const unread = (path: string): boolean => prose(path) || sizeReference(path);
const steering = (path: string): boolean => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(path);
const bench = (path: string): boolean => path.startsWith("bench/");
// The recorder imports `src/` and `scripts/corpus/` and reads `corpus/`; nothing else moves a row.
const contractInput = (path: string): boolean => /^(?:src|corpus|scripts\/corpus)\//u.test(path);
// A deleted path selects steps (it can break an import) but cannot be handed to a tool as a target.
const present = (paths: readonly string[]): string[] => paths.filter((path) => existsSync(path));
const nonEmpty = (paths: readonly string[]): readonly string[] | undefined =>
  paths.length === 0 ? undefined : paths;
// oxlint refuses a run whose paths hold no file it lints, so non-code paths never reach it.
const code = (path: string): boolean => /\.[cm]?[jt]sx?$/u.test(path);
// A change to what decides a tool's verdict (its config, or the pinned tool in `package.json`)
// moves the verdict on files the commit never touched, so the tool then judges the whole tree.
const lintPolicy = (path: string): boolean =>
  /^(?:\.oxlintrc\.json|package\.json|bun\.lock|tsconfig[^/]*\.json)$/u.test(path);
const formatPolicy = (path: string): boolean =>
  /^(?:\.oxfmtrc\.json|\.editorconfig|\.prettierignore|\.gitignore|package\.json|bun\.lock)$/u.test(
    path,
  );

const ALL_STEPS: readonly Step[] = [
  // Rust is outside this gate: the npm package ships TypeScript only, and `bun run rust:check`
  // replays the corpus Rust last met (see `scripts/rust/conform.ts`).
  { script: "build", ignores: unread },
  // The flag keeps a commit of files oxfmt ignores (Markdown) from failing on an empty target set.
  {
    script: "format:check",
    ignores: prose,
    scope: (paths) => {
      if (paths.some((path) => formatPolicy(path))) return [];
      const files = present(paths);
      return files.length === 0 ? undefined : ["--no-error-on-unmatched-pattern", ...files];
    },
  },
  {
    script: "lint",
    needs: "build",
    // A config change lints the whole tree, `bench/` included.
    needsFor: (path) => bench(path) || lintPolicy(path),
    ignores: unread,
    scope: (paths) =>
      paths.some((path) => lintPolicy(path))
        ? []
        : nonEmpty(present(paths).filter((path) => code(path))),
  },
  { script: "invariants:check", ignores: unread },
  // Run performance diagnostics separately: an optimization miss cannot reject a correct change.
  // Without paths it scans every tracked file, so an all-deleted change must not reach it empty.
  { script: "fixtures:check", scope: (paths) => nonEmpty(present(paths)) },
  { script: "steering:check", ignores: (path) => !steering(path) },
  { script: "wiring:check", ignores: unread },
  // One step runs the SAME suite concurrently under both runtimes. The reason is not coverage —
  // vitest isolates each file in its own environment while `bun test` runs them all in ONE process,
  // so a test that damages a global is invisible to the first and breaks an unrelated file under the
  // second: a prototype-pollution defect can pass every vitest file. JavaScriptCore instead of V8 is
  // a second, smaller benefit. It also compares their test COUNTS — a silent divergence means one of
  // them stopped seeing a file, and a runner that quietly runs fewer tests is a false green.
  { script: "test:check", ignores: unread, hook: "skip", allCores: true },
  // The hook's stand-in: one runtime, and only the test files whose import graph reaches a change.
  // Bun diffs the worktree against HEAD itself, so unstaged edits count too: more tests, never
  // fewer. It follows imports only, so it cannot see a test that READS a changed file
  // (`readme.test.ts` reads README.md, others read `corpus/`): any changed non-code path runs the
  // whole suite.
  {
    script: "test:bun",
    ignores: unread,
    hook: "only",
    allCores: true,
    scope: (paths) => (paths.every((path) => code(path)) ? ["--changed=HEAD"] : []),
  },
  { script: "corpus:conform", ignores: (path) => !contractInput(path) },
  // Every recorded whole-input row follows the cooperative continuation one pull at a time and
  // compares all four public outcomes with the synchronous oracle. Seconds of replay for a route
  // that `test/async.test.ts` already exercises when `src/` changes, so the full lane owns it.
  {
    script: "async:conform",
    ignores: (path) => !contractInput(path) && path !== "scripts/check-async.ts",
    hook: "skip",
  },
  // Only `bench/` projects read `dist/`; the root project covers every other TypeScript path.
  {
    script: "typecheck",
    needs: "build",
    needsFor: bench,
    // TypeScript sources, JSON (configs, manifests, JSON imports) and the lockfile behind `@types`.
    ignores: (path) => sizeReference(path) || !/\.(?:[cm]?ts|json)$|^bun\.lock$/u.test(path),
    scope: (paths) => [
      "--bun",
      ...(paths.some((path) => !bench(path)) ? ["tsconfig.typecheck.json"] : []),
      ...(paths.some((path) => bench(path))
        ? ["tsconfig.bench.json", "bench/prior-art/tsconfig.json"]
        : []),
    ],
  },
  // Packs both archives and compiles consumers against them: release-shaped work whose output no
  // commit carries. A source defect it could catch reaches it through the full lane and CI.
  { script: "artifact:check", needs: "build", ignores: unread, hook: "skip" },
  // HLD D5, which `sideEffects: false` declares and cannot enforce: what a bundler may drop is
  // decided by the SHAPE of the code. It bundles `src/` per entry point, so it runs in the commit
  // hook without a build; `size:check` judges the packed artefact the same way.
  { script: "treeshake:check", ignores: unread },
  // What each of the six supported bundlers keeps, loads and emits for every consumer fixture
  // (HLD D5). Its builds take most of the complete lane's time, so the commit hook skips it.
  { script: "size:check", needs: "build", completeOnly: true },
  // Exercise registry failures and populated release history locally without publishing fixtures.
  { script: "release:check", needs: "build", completeOnly: true },
];
// The edit profile (the commit hook) leaves out `completeOnly` steps; `--complete-only` runs just
// those and the steps they read. The two partition the complete profile, so CI runs them as parallel
// jobs and still runs every step. On a 2-vCPU runner one job would put the bundlers of `size:check`,
// most of the gate's CPU, on the same cores as timed test cases, slowing them past their timeouts.
const completeOnly = ALL_STEPS.filter((step) => step.completeOnly === true);
const read = new Set(completeOnly.flatMap((step) => [step.script, step.needs ?? []].flat()));
const PROFILE_STEPS = (
  profile === "--commit"
    ? ALL_STEPS.filter((step) => step.completeOnly !== true)
    : profile === "--complete-only"
      ? ALL_STEPS.filter((step) => read.has(step.script))
      : ALL_STEPS
).filter((step) => step.hook !== (changed === undefined ? "only" : "skip"));

// Each step that runs, with the arguments it runs with. Under `--changed` a step runs only when a
// changed path is one it reads and its scope leaves it something to judge, and a producer such as
// `build` runs only on a consumer's demand: its output is git-ignored, so building for its own sake
// spends the commit's wait on bytes the commit does not carry.
const producers = new Set(PROFILE_STEPS.flatMap((step) => step.needs ?? []));
const plan = new Map<string, readonly string[]>();
for (const step of PROFILE_STEPS) {
  if (changed === undefined) {
    plan.set(step.script, []);
    continue;
  }
  if (producers.has(step.script)) continue;
  const reads = changed.filter((path) => step.ignores?.(path) !== true);
  if (reads.length === 0) continue;
  const scoped = step.scope === undefined ? [] : step.scope(reads);
  if (scoped === undefined) continue;
  plan.set(step.script, scoped);
  if (
    step.needs !== undefined &&
    (step.needsFor === undefined || reads.some((path) => step.needsFor?.(path) === true))
  )
    plan.set(step.needs, []);
}
const STEPS = PROFILE_STEPS.filter((step) => plan.has(step.script));
const unaffected = PROFILE_STEPS.length - STEPS.length;

/**
 * One step's verdict. `skipped` adds the outcome the LANE owns to the three a run can have: a step
 * whose predecessor failed never spawns, so it has no output and no duration to report.
 *
 * Flat, not a run wrapped in an outcome. Every reader then switches on ONE `kind` and reaches
 * `script` the same way whatever happened, and a new outcome is still a compile error everywhere.
 */
type Result =
  | ScriptRun
  | { readonly kind: "skipped"; readonly script: string; readonly because: string };

// Ctrl-C kills the children instead of orphaning a `tsc` or a `vitest` to finish unwatched. The flag
// separates "you stopped it" from "it failed": every killed child reports failure, and dumping nine
// of those would bury the one fact the reader needs, which is that nothing was judged.
const cancel = new AbortController();
let cancelled = false;
const stop = () => {
  cancelled = true;
  cancel.abort();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Held HERE and not inside a step, because the step that hung is exactly the one that would never
// get round to checking its own clock. The whole lane finishes far inside it, so it only ever fires
// on a hang.
const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(LANE_DEADLINE_MS)]);

// Progress belongs to a human watching a terminal. Captured — by the commit hook, or by an agent —
// it is context spent to learn that nothing happened, so only the final line survives.
const live = process.stdout.isTTY;

// At most one step per core, as `make -j$(nproc)` does. Every step at once is free on a laptop but on
// a 2-vCPU CI runner it put a dozen processes on two cores, and the test cases running in that
// burst passed their timeouts on contention alone. A step takes its slot only once its producer
// settled, so a step that waits never holds one.
const cores = Math.max(1, navigator.hardwareConcurrency);
let free = cores;
// First come, first served: a step needing every slot would otherwise wait forever behind a stream
// of single-slot steps.
const queue: { readonly need: number; readonly resolve: () => void }[] = [];
const acquire = async (need: number): Promise<void> => {
  if (queue.length === 0 && free >= need) {
    free -= need;
    return;
  }
  await new Promise<void>((resolve) => {
    queue.push({ need, resolve });
  });
};
const release = (held: number): void => {
  free += held;
  for (let next = queue[0]; next !== undefined && free >= next.need; next = queue[0]) {
    queue.shift();
    free -= next.need;
    next.resolve();
  }
};

const started = Date.now();
// Keyed by script name, which is also how `needs` refers to a step. A Map keeps insertion order, so
// reading the values back yields declaration order without zipping two arrays by index.
const running = new Map<string, Promise<Result>>();

for (const step of STEPS) {
  const { needs } = step;
  // An unplanned producer is one this run does not need (`needsFor` said so), not a missing one.
  const gate = needs === undefined ? undefined : running.get(needs);
  if (needs !== undefined && plan.has(needs) && gate === undefined) {
    throw new Error(`check: "${step.script}" needs "${needs}", which is not an earlier step.`);
  }
  // A repeated name would overwrite the earlier entry and drop that step from the lane silently,
  // which is the one failure a gate must never have.
  if (running.has(step.script)) throw new Error(`check: "${step.script}" is listed twice.`);

  running.set(
    step.script,
    (async () => {
      if (gate !== undefined) {
        const upstream = await gate;
        // Running it anyway would report a missing or stale artefact, which reads as a second,
        // unrelated defect and sends the reader after the wrong thing.
        if (upstream.kind !== "passed") {
          return {
            kind: "skipped",
            script: step.script,
            because: `${upstream.script} did not pass`,
          } as const;
        }
      }
      const held = step.allCores === true ? cores : 1;
      await acquire(held);
      // A step that reaches its slot after the lane stopped never spawns: started with the aborted
      // signal it would come back `stopped` and be named as still running.
      if (signal.aborted) {
        release(held);
        return { kind: "skipped", script: step.script, because: "the lane stopped first" } as const;
      }
      let run: ScriptRun;
      try {
        run = await runScript(step.script, signal, plan.get(step.script) ?? []);
      } finally {
        release(held);
      }
      if (live) {
        const note = run.kind === "passed" ? "" : `  ${run.kind.toUpperCase()}`;
        console.log(`  ${String(run.ms).padStart(5)} ms  ${run.script}${note}`);
      }
      return run;
    })(),
  );
}

const settled = await Promise.all(running.values());
// Declaration order throughout, because `running` is a Map: a report that reshuffles between runs
// cannot be diffed.
// `flatMap` rather than `filter`, which does not narrow the union — the members carry different
// fields, and the report reads `output` from one and `because` from the other.
const failed = settled.flatMap((result) => (result.kind === "failed" ? [result] : []));
const skipped = settled.flatMap((result) => (result.kind === "skipped" ? [result] : []));
const elapsed = Date.now() - started;
const slowest = settled.reduce<ScriptRun | undefined>(
  (worst, result) =>
    result.kind === "skipped" || (worst !== undefined && worst.ms >= result.ms) ? worst : result,
  undefined,
);

for (const run of failed) {
  console.error(`--- ${run.script}`);
  console.error(run.output.trimEnd());
}

if (signal.aborted) {
  // `exitCode` and not `process.exit`, which can drop a pending write to a pipe — losing exactly the
  // line that explains why the run ended. 130 is the shell's convention for death by SIGINT; a
  // deadline is an ordinary failure, because the lane did not judge every step and the commit must
  // not proceed.
  // A killed child is exactly a step that was still running, so the answer to "what was stuck" is
  // read off the results rather than tracked alongside them. A step still queued for a slot or
  // behind `build` never spawned, reports `skipped`, and listing it would bury the one that matters.
  // Steps that failed before the stop WERE judged, so their output is printed above as on a normal run.
  const stuck = settled.flatMap((result) => (result.kind === "stopped" ? [result.script] : []));
  const why = cancelled ? "cancelled" : `gave up after ${String(LANE_DEADLINE_MS / 1000)}s`;
  console.error(
    `check: ${why}` +
      (failed.length === 0
        ? ""
        : `; failed before that: ${failed.map((r) => r.script).join(", ")}`) +
      (stuck.length === 0 ? "." : `; still running: ${stuck.join(", ")}.`),
  );
  process.exitCode = cancelled ? 130 : 1;
} else {
  for (const step of skipped) {
    console.error(`check: ${step.script} did not run — ${step.because}.`);
  }

  if (failed.length === 0 && skipped.length === 0) {
    // The hook keeps this final line; preserve the child's own bottleneck instead of hiding it.
    const detail = slowest?.output.trimEnd().split("\n").at(-1);
    console.log(
      `check: ${String(STEPS.length)} steps passed in ${String(elapsed)} ms` +
        (unaffected === 0 ? "" : `; ${String(unaffected)} not reading the changed files skipped`) +
        (slowest === undefined ? "" : `; slowest ${slowest.script} at ${String(slowest.ms)} ms`) +
        (detail === undefined || detail === "" ? "" : ` (${detail})`),
    );
  } else {
    // Last, because that is where a reader who scrolled through the dumps above ends up.
    console.error(
      `check: FAILED in ${String(elapsed)} ms — ${failed.map((run) => run.script).join(", ")}`,
    );
    process.exitCode = 1;
  }
}
