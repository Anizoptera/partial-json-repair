// SPDX-License-Identifier: Apache-2.0

/**
 * The maintained speed baseline: every library, every case, every runtime on this machine, in one
 * committed file a release is checked against.
 *
 *     bun bench/prior-art/baseline.ts            # measure, and name the cells that moved
 *     bun bench/prior-art/baseline.ts --routes   # prove every registered command once
 *     bun bench/prior-art/baseline.ts --candidate <ignored-file>  # retain only for requested review
 *     bun bench/prior-art/baseline.ts --accept --candidate <same-file>
 *
 * **Every cell is a ratio against that runtime's own `JSON.parse`, never MB/s.** An absolute rate
 * encodes the machine, its load and the engine build, so a figure recorded on a quiet laptop reads
 * as a regression when re-measured on a busy one. Measured: one node process ran EVERY library low
 * together — the box moved, not the code. Ratios reduce common slowdown, but contention can affect
 * the numerator and denominator differently. They describe relative cost on the measured host;
 * neither a ratio nor an absolute rate predicts every consumer's machine.
 *
 * **Each runtime is measured in several separate PROCESSES, and their spread is the error bar.**
 * Batches inside one process share a JIT profile and a heap, so their agreement is no evidence that
 * a re-run reproduces — measured, an in-process error bar came out six times too small. This is the
 * fork level, and it is why JMH forks the JVM rather than adding iterations.
 *
 * **Stored figures are rounded magnitudes, not regression verdicts.** Sampling variation or machine
 * state can move an estimate across a rung boundary without a code change. Read the process spread
 * and remeasure before attributing a move.
 *
 * Nothing here reads the machine's load. A `loadavg` threshold was tried: it passed at load 6.8
 * while 22 cells moved. A proxy for "is the box quiet" cannot beat rounding coarsely, and it added a
 * `--force` flag inviting the abuse it was meant to stop.
 *
 * **What this file CANNOT do: decide a small regression.** Measured, two immediate re-runs agreed
 * with each other and disagreed with the first while machine load climbed throughout — a state every
 * fork inside one run shares, which no arrangement of samples within a run can see. Interleaving the
 * forks across the whole run was tried and did not reduce the churn. The floor is a few percent on a
 * fast operation and roughly ten on a slow one, against a historical drift of 2-5% per commit, so
 * comparing today's number with one stored last week measures the week. That job needs the old and
 * new build measured against each other in ONE run; this file is the published comparison a READER
 * uses, and it is honest at the resolution it states and no finer.
 *
 * Deliberately NOT a gate, and it never runs in one — it runs for many minutes and cannot resolve
 * what a gate would need to catch.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { combine, stable } from "../estimator.ts";
import { acceptCandidate, prepareCandidate } from "./baseline-candidate.ts";
import type { Baseline } from "./baseline-candidate.ts";
import { buildNative, NATIVE_LABEL } from "./native.ts";
import {
  supportedBunRuntimes,
  supportedDenoRuntime,
  supportedDenoVersion,
  supportedNodeRuntimes,
} from "./runtimes";
import type { InstalledRuntime } from "./runtimes";
// Type-only, so nothing in `compare.ts` runs here: it is a script with top-level output, and this
// file spawns it as a child. Importing the wire format rather than restating it is what stops the
// two from disagreeing about a shape only a runtime failure would reveal.
import type { Emitted } from "./speed-docs.ts";

const here = import.meta.dirname;
const FILE = join(here, "baseline.json");
const { values } = parseArgs({
  options: {
    routes: { type: "boolean" },
    accept: { type: "boolean" },
    candidate: { type: "string" },
  },
});
const COMPARE = join(here, "compare.ts");
const STREAM = join(here, "stream.ts");
const WEB = join(here, "web.ts");

/** Independent processes per runtime. Below about five the spread is itself a guess. */
const FORKS = 5;

/**
 * Denominator for every ratio in a JavaScript row, and the only row that is 1 by construction.
 *
 * A ratio reduces shared machine effects, though it does not cancel them all. That makes
 * the denominator per-RUNTIME rather than global — Rust has no `JSON.parse`, and its standard parser
 * is `serde_json`. Two rows therefore carry different denominators and their cells are NOT directly
 * comparable; what bridges them is this package itself, which appears in every JavaScript and Rust
 * row, so "how do we compare to the best in each language" is answered by reading our own cell in
 * each. The Python and native rows carry no such bridge: their cells compare rivals within one
 * language only.
 */
const REFERENCE = "JSON.parse";

/**
 * The case whose reference rate divides every cell, including the cells of other cases.
 *
 * ONE denominator across the row, not one per case, because `JSON.parse` has no rate on a damaged or
 * dialect document — there is nothing to divide by. So every number here reads as a fraction of what
 * the runtime's own parser does on undamaged JSON, which is also the comparison a reader wants.
 *
 * The only case this file names. Everything else follows whatever a runner emitted, so a case added
 * in `compare.ts` arrives here as new columns in the diff and needs no edit.
 */
const REFERENCE_CASE = "clean";

if (values.accept === true) {
  if (values.candidate === undefined)
    throw new Error("Pass --candidate <reviewed-file>; normal benchmark runs save no candidate.");
  const accepted = acceptCandidate(values.candidate, FILE) as Baseline;
  console.log(`written: ${Object.keys(accepted).join(", ")}`);
  process.exit(0);
}

export type Runner = {
  /** The command. It need not be JavaScript — anything printing {@link Emitted} belongs here. */
  readonly argv: readonly string[];
  /** The runtime string this runner must report. A pin that silently fell back is caught by it. */
  readonly expect: string;
  /** The library whose {@link REFERENCE_CASE} rate divides this runner's cells. */
  readonly reference: string;
  /** Subjects that must each produce at least one correct case when proving registered routes. */
  readonly required?: readonly string[];
  /** Every library this runner emits must produce at least one correct case in a route proof. */
  readonly requireEvery?: boolean;
  /**
   * The baseline row, when it differs from {@link expect}: two runners on one runtime (the shared
   * cases and the streaming workload) report the same runtime string but must not share a row,
   * because their `JSON.parse` reference samples would merge.
   */
  readonly row?: string;
  /** Fed to the runner's stdin. Non-JavaScript runners receive the case documents this way. */
  readonly input?: string;
};

/**
 * A registered member that cannot run on this machine, and the exact reason — a missing tool or a
 * runtime release outside the pinned set. Reported by `--routes` and refused by a measuring run,
 * never skipped: a member that silently vanished would read as one that was never registered.
 */
export type Unavailable = { readonly label: string; readonly unavailable: string };
export type Member = Runner | Unavailable;

const rowOf = (runner: Runner): string => runner.row ?? runner.expect;

/**
 * The pinned releases of one asdf-managed runtime, or why they cannot be resolved. The reason
 * becomes an unavailable member, so a missing pin costs only its own rows, as a missing Deno does,
 * instead of aborting the run before `--routes` can report the rest.
 */
const pinnedRuntimes = (
  resolve: () => readonly InstalledRuntime[],
): readonly InstalledRuntime[] | string => {
  try {
    return resolve();
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
};

/** One runner per pinned release, or one unavailable member named `label` for the family. */
const each = (
  runtimes: readonly InstalledRuntime[] | string,
  label: string,
  runner: (runtime: InstalledRuntime) => Runner,
): Member[] =>
  typeof runtimes === "string"
    ? [{ label, unavailable: runtimes }]
    : runtimes.map((runtime) => runner(runtime));

/** The exact Deno candidate; unlike Bun and Node it is not managed by asdf here. */
const denoRunners = (cases: string): Member[] => {
  let runtime;
  try {
    runtime = supportedDenoRuntime();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return [
      { label: `deno ${supportedDenoVersion}`, unavailable: reason },
      { label: `stream deno ${supportedDenoVersion}`, unavailable: reason },
    ];
  }
  const deno = [
    ...runtime.argv,
    "run",
    "--node-modules-dir=manual",
    "--allow-read",
    "--allow-env",
    "--allow-sys",
    "--no-config",
  ];
  return [
    { argv: [...deno, COMPARE], expect: runtime.label, reference: REFERENCE },
    streamRunner([...deno, STREAM], runtime.label, cases),
  ];
};

/**
 * The Rust subjects, as one more runner in the same matrix.
 *
 * Rust is measured HERE rather than by a report of its own. A second comparison system would need a
 * second estimator, a second rounding rule and a second set of documents, and the two would drift
 * with nothing to reveal it — the same failure this repository records for a CI step that cannot be
 * run locally. Making it a runner is also why {@link Runner.argv} was never JavaScript-only.
 *
 * The binary is built here rather than assumed present: a stale artifact would report an older
 * revision's speed under this revision's name, which is the quiet version of measuring nothing.
 * Rust stays outside the TypeScript release gate; this cross-language comparison explicitly needs
 * its toolchain.
 *
 * The case documents and their expected values are fetched once from `compare.ts` and fed on stdin,
 * so the five cases keep one owner and cannot diverge between languages. The expected values matter
 * on the damaged case: without them the Rust runner could only judge this crate by its own answer.
 */
const rustRunner = (cases: string): Runner => {
  const dir = join(here, "..", "..", "rust", "bench");
  const built = spawnSync(
    process.execPath,
    ["scripts/rust/cargo.ts", "build", "--release", "--manifest-path", join(dir, "Cargo.toml")],
    {
      encoding: "utf8",
    },
  );
  if (built.status !== 0) throw new Error(`rust bench build failed:\n${built.stderr.slice(-800)}`);
  // The emitted compiler identity catches a wrapper or environment that bypasses the repository pin.
  const pin = /channel\s*=\s*"([^"]+)"/u.exec(
    readFileSync(join(here, "..", "..", "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (pin === undefined) throw new Error("no channel pin in rust-toolchain.toml");
  return {
    argv: [join(dir, "target", "release", "rust-prior-art"), "baseline"],
    expect: `rust ${pin}`,
    reference: "serde_json",
    input: JSON.stringify({
      cases: JSON.parse(cases) as unknown,
      wants: JSON.parse(caseWants()) as unknown,
    }),
  };
};

/** The five case documents, from their one owner. */
const caseDocuments = (): string => {
  const r = spawnSync(process.execPath, [COMPARE], {
    encoding: "utf8",
    env: { ...process.env, EMIT: "cases" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`could not read case documents: ${r.stderr.slice(0, 500)}`);
  return r.stdout;
};

/** The expected value of every case, for runners in languages with no oracle of their own. */
const caseWants = (): string => {
  const r = spawnSync(process.execPath, [COMPARE], {
    encoding: "utf8",
    env: { ...process.env, EMIT: "wants" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`could not read case oracles: ${r.stderr.slice(0, 500)}`);
  return r.stdout;
};

/**
 * The streaming workload on one JavaScript runtime. Its own row, because its cells are a different
 * workload from the shared cases, and every streaming subject must produce a correct cell: a rival
 * whose final value never matches the oracle is a failed member, not a quiet empty row.
 */
const streamRunner = (argv: readonly string[], label: string, cases: string): Runner => ({
  argv,
  expect: label,
  row: `stream ${label}`,
  reference: REFERENCE,
  requireEvery: true,
  input: cases,
});

/**
 * Python's `json_repair`, run through `uv` with the interpreter minor and the package pinned, so the
 * resolved environment is the one the label names. Fed the cases AND their expected values, since
 * Python has no oracle for the damaged case. Unavailable — never provisioned — without `uv`.
 */
const PYTHON = "3.14";
const JSON_REPAIR_PY = "0.63.5";
const pythonRunner = (cases: string): Member => {
  const uv = Bun.which("uv");
  if (uv === null) return { label: `python ${PYTHON}`, unavailable: "uv is not on PATH" };
  return {
    argv: [
      uv,
      "run",
      "--no-project",
      "--python",
      PYTHON,
      "--with",
      `json_repair==${JSON_REPAIR_PY}`,
      "python",
      join(here, "python", "runner.py"),
    ],
    expect: `python ${PYTHON} json_repair ${JSON_REPAIR_PY}`,
    // The standard library's parser, the same role `JSON.parse` plays in a JavaScript row.
    reference: "json",
    required: ["json_repair"],
    input: JSON.stringify({
      cases: JSON.parse(cases) as unknown,
      wants: JSON.parse(caseWants()) as unknown,
    }),
  };
};

/**
 * yyjson, RapidJSON and simdjson as native C/C++ subjects built from pinned sources (`native.ts`).
 *
 * C++ has no standard JSON parser, so this row's denominator is a CHOICE: RapidJSON, the
 * longest-established of the three. Its cells therefore compare the three with each other and
 * bridge to no other row; a reader comparing languages must say so.
 */
const nativeRunner = async (cases: string): Promise<Member> => {
  const built = await buildNative();
  if ("unavailable" in built) return { label: NATIVE_LABEL, ...built };
  return {
    ...built,
    reference: "rapidjson",
    required: ["yyjson", "rapidjson", "simdjson"],
    input: cases,
  };
};

const runners = async (cases: string): Promise<Member[]> => {
  const bun = pinnedRuntimes(supportedBunRuntimes);
  const node = pinnedRuntimes(supportedNodeRuntimes);
  const shared = (runtime: InstalledRuntime): Runner => ({
    argv: [...runtime.argv, COMPARE],
    expect: runtime.label,
    reference: REFERENCE,
  });
  const stream = (runtime: InstalledRuntime): Runner =>
    streamRunner([...runtime.argv, STREAM], runtime.label, cases);
  const all: Member[] = [
    ...each(bun, "bun", shared),
    ...each(node, "node", shared),
    ...each(bun, "stream bun", stream),
    ...each(node, "stream node", stream),
    ...denoRunners(cases),
    // Browsers and workerd, which no command line reaches: `web.ts` runs the same documents there.
    // A host that cannot start fails its member, as in `platform:check`; the package ships to them.
    ...(["webkit", "chromium", "workerd"] as const).map((host) => ({
      argv: [process.execPath, WEB, host],
      expect: host,
      reference: REFERENCE,
    })),
    rustRunner(cases),
    pythonRunner(cases),
    await nativeRunner(cases),
  ];
  // Zero runners would write an empty baseline and call it a clean run, which is the one outcome
  // indistinguishable from every library having vanished.
  if (all.length === 0)
    throw new Error("no runtimes found; check `asdf list bun` and `asdf list nodejs`");
  return all;
};

const fork = (runner: Runner): Emitted => {
  const [cmd = "", ...args] = runner.argv;
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, EMIT: "json" },
    input: runner.input,
    // The Rust runner is handed five documents totalling ~150 KB; the default 1 MB pipe buffer is
    // ample, but a silent truncation here would read as a parser failure rather than as plumbing.
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`${runner.expect}: ${r.stderr.slice(0, 500)}`);
  const emitted = JSON.parse(r.stdout) as Emitted;
  // Version pinning through the environment can fall back to whatever is on PATH, which would file
  // one engine's numbers under another engine's name and make the whole row a quiet lie.
  if (emitted.runtime !== runner.expect)
    throw new Error(`asked for ${runner.expect}, ran ${emitted.runtime}`);
  return emitted;
};

/** Ratio samples, per runner, per library, per case. Cases are whatever the runner emitted. */
type Samples = Map<string, Map<string, Map<string, number[]>>>;

/**
 * One fork of every runner, appended to `into`.
 *
 * **Called once per ROUND, so a row's samples are spread across the whole run rather than taken
 * back to back.** Five consecutive forks of one runtime occupy about ten seconds and therefore share
 * whatever the machine was doing during them; their agreement then describes that window, not
 * whether a re-run reproduces — the same correlation trap as batches inside one process, one level
 * up. It is kept because it is the correct design, NOT because it bought anything: measured, churn
 * was 18, 21 and 22 cells across three runs with and without it. What the samples cannot reach is a
 * machine state lasting the whole run, and widening the bar to three deviations is what actually
 * brought those to 5 and 1. Interleaving costs nothing — the same forks in a different order — so it
 * stays rather than leaving a known bias in for no gain.
 *
 * The ratio is formed INSIDE each fork against the reference that fork measured. Combining rates
 * first and dividing afterwards would let a fork that ran slow overall shift the answer; that
 * pairing is the entire reason a ratio is stabler than a rate.
 */
const round = (targets: readonly Runner[], into: Samples, failed: Set<string>): void => {
  for (const runner of targets) {
    const row = rowOf(runner);
    if (failed.has(row)) continue;
    let rates;
    try {
      console.log(`measuring ${row}`);
      const emitted = fork(runner);
      // The same result proves the route and supplies rates; never time a second preflight fork.
      prove(runner, emitted);
      ({ rates } = emitted);
    } catch (cause) {
      // One unusable runtime must not cost the whole matrix: the run takes many minutes, and the
      // rows that DID measure are still worth reading. Writing is refused instead, below.
      failed.add(row);
      console.log(`! ${row}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    const reference = rates[runner.reference]?.[REFERENCE_CASE] ?? 1;
    const byLib = into.get(row) ?? new Map<string, Map<string, number[]>>();
    into.set(row, byLib);
    for (const [lib, cells] of Object.entries(rates)) {
      const byCase = byLib.get(lib) ?? new Map<string, number[]>();
      byLib.set(lib, byCase);
      for (const [c, rate] of Object.entries(cells)) {
        if (rate !== undefined) byCase.set(c, [...(byCase.get(c) ?? []), rate / reference]);
      }
    }
  }
};

const read = (): Baseline => {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Baseline;
  } catch {
    return {};
  }
};

const was = read();
const now: Baseline = {};
const moved: string[] = [];
const failed = new Set<string>();

// Every JavaScript runner, and the damaged case's expected value, import the BUILT package, so a
// `dist/` older than `src/` would report a previous revision's answers and speed under this one's
// name. Built here for the reason `rustRunner` builds its binary; a modification-time check would
// miss a changed build config or dependency, which a build cannot.
const retain = values.routes === true ? undefined : prepareCandidate(values.candidate);
const built = spawnSync(process.execPath, ["run", "build"], {
  cwd: join(here, "..", ".."),
  encoding: "utf8",
});
if (built.status !== 0) throw new Error(`package build failed:\n${built.stderr.slice(-800)}`);

const cases = caseDocuments();
const members = await runners(cases);

/**
 * One member's route proof: the reference cell exists and every required subject produced at least
 * one correct cell. Returns the per-subject lines, or throws with the reason the member failed.
 */
const prove = (runner: Runner, { rates }: Emitted = fork(runner)): string[] => {
  if (rates[runner.reference]?.[REFERENCE_CASE] === undefined)
    throw new Error(`no ${runner.reference} ${REFERENCE_CASE} rate`);
  const subjects = runner.requireEvery === true ? Object.keys(rates) : (runner.required ?? []);
  const lines: string[] = [];
  const empty: string[] = [];
  for (const subject of subjects) {
    const cells = Object.keys(rates[subject] ?? {});
    if (cells.length === 0) empty.push(subject);
    else lines.push(`  ${subject}: ${cells.length} correct cell(s)`);
  }
  if (empty.length > 0) throw new Error(`no correct cell from ${empty.join(", ")}`);
  return lines;
};

if (values.routes === true) {
  // Every member ends as exactly one of ok, fail or unavailable, and the counts are printed so an
  // empty or partial run cannot read as a pass.
  let passed = 0;
  let failures = 0;
  let unavailable = 0;
  for (const member of members) {
    if ("unavailable" in member) {
      unavailable++;
      console.log(`unavailable ${member.label}: ${member.unavailable}`);
      continue;
    }
    try {
      const lines = prove(member);
      passed++;
      console.log(`ok ${rowOf(member)}`);
      for (const line of lines) console.log(line);
    } catch (cause) {
      failures++;
      console.log(
        `fail ${rowOf(member)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  console.log(`routes: ${passed} passed, ${failures} failed, ${unavailable} unavailable`);
  process.exit(failures + unavailable === 0 && passed > 0 ? 0 : 1);
}

const all: Runner[] = [];
for (const member of members) {
  if ("unavailable" in member) {
    // A measuring run cannot leave a registered member out and still write a complete baseline.
    failed.add(member.label);
    console.log(`! ${member.label}: unavailable — ${member.unavailable}`);
  } else all.push(member);
}
const samples: Samples = new Map();
for (let r = 0; r < FORKS; r++) round(all, samples, failed);

for (const [rt, byLib] of samples) {
  if (failed.has(rt)) continue;
  const rows: Record<string, Record<string, string>> = {};
  for (const [lib, byCase] of byLib) {
    const row: Record<string, string> = {};
    for (const [c, ratios] of byCase) {
      // A cell correct in only SOME forks would still be combined, and its deviation over the few
      // samples it has would be reported as if the whole run stood behind it. The bar is the entire
      // product of this file, so a cell that cannot supply one is not recorded at all.
      if (ratios.length < FORKS) {
        moved.push(`! ${rt} ${lib} ${c}: correct in ${ratios.length}/${FORKS} runs — not recorded`);
        continue;
      }
      const estimate = combine(ratios);
      const before = was[rt]?.[lib]?.[c];
      // What THIS run measured — not a blend of every run since the file was created.
      //
      // Hysteresis (keep the old figure while the new one sits inside its bar) used to live here and
      // must not return: the noisier a cell, the wider its bar, the more permanently its number
      // sticks. Measured — a 2.9x speed-up left one cell reading 0.032 against a true 0.11.
      const value = stable(estimate.value);
      row[c] = value;
      const spread = `±${Math.round((100 * estimate.error) / Math.max(estimate.value, 1e-12))}%`;
      if (before === undefined) moved.push(`+ ${rt} ${lib} ${c}: ${value} ${spread}`);
      else if (before !== value) moved.push(`  ${rt} ${lib} ${c}: ${before} -> ${value} ${spread}`);
    }
    rows[lib] = row;
  }
  // A library that stopped producing the correct answer is a behaviour change; dropping its row in
  // silence would present that as a speed result nobody recorded.
  for (const [lib, row] of Object.entries(was[rt] ?? {}))
    for (const c of Object.keys(row))
      if (rows[lib]?.[c] === undefined)
        moved.push(`- ${rt} ${lib} ${c}: was ${row[c]}, now no correct answer`);
  now[rt] = rows;
}

// A runtime that vanished is usually an uninstall rather than a finding, but saying so beats a row
// disappearing from a committed file with no line anywhere explaining it.
for (const rt of Object.keys(was))
  if (now[rt] === undefined && !failed.has(rt)) moved.push(`- ${rt}: not installed`);

for (const line of moved) console.log(line);
if (failed.size > 0) {
  // Writing now would delete the failed runtimes' recorded rows and present the remainder as a
  // complete baseline, which is the one error this file cannot afford to make quietly.
  console.log(`\n${failed.size} runtime(s) unmeasured — nothing written; fix them and re-run`);
  process.exitCode = 1;
} else {
  if (retain !== undefined) {
    retain(now);
    if (values.candidate !== undefined)
      console.log(
        "\ncandidate retained; inspect the movements, then use --accept with the same --candidate path",
      );
  }
  console.log(moved.length === 0 ? "\nunchanged" : `\n${moved.length} cell(s) moved`);
  process.exitCode = moved.length === 0 ? 0 : 1;
}
