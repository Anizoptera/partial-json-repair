// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end throughput, and the only bench here that is a SCRIPT rather than a `vitest bench`.
 *
 * The reason is the question: every number below is a ratio against the runtime's own
 * `JSON.parse`, and V8 and JavaScriptCore do not implement that the same way — so a single-runtime
 * measurement would report a property of the runtime as a property of this package. Vitest runs on
 * Node, so a vitest bench cannot produce the Bun column at all. This file is plain enough for both
 * to execute directly:
 *
 *     node bench/throughput.ts   &&   bun bench/throughput.ts
 *
 * Never gates. Informs the README's Limitations section and the prior-art comparison, both of which
 * must print the machine and runtime beside any number, because a number without its environment is
 * a claim about nothing.
 */

// The BUILT artefact, not `src/`. Two reasons, and the second is why the path is not a convenience:
// Node cannot resolve an extensionless TypeScript import, so `src/` would make this Node-only and
// there would be no second column; and what a consumer installs is `dist/`, so a number measured on
// source is a claim about a file nobody runs. Requires `bun run build` first.
import { spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";

import { parse, parseMany, repair } from "../dist/index.js";
// Extension required: node's type stripping does not resolve extensionless TS specifiers.
import { estimate } from "./estimator.ts";

/**
 * One timed row, through the SHARED estimator rather than a loop of its own.
 *
 * This file used to time 51 single invocations and keep the fastest. On a damaged document under
 * bun that read 26 MB/s where the estimator reads 78 — a 3x error, in the direction that makes this
 * package look slow, and the README table was built on it. The cause is in `estimator.ts`: a fixed
 * count of single-shot samples never catches an uncontended run of a slow, allocation-heavy
 * operation, so it measures GC rather than code. Convergence with patience does, and node/V8 barely
 * shows the difference — which is why the fault survived: the runtime most people check was fine.
 *
 * A second timer is a second answer to the same question. There is one estimator here now.
 *
 * `bytes` is the size of THIS row's input, and it is a parameter rather than a constant because the
 * rows do not all parse the same document. A raw millisecond comparison across documents of
 * different sizes reports the generator's choices; per-byte throughput is the only figure that
 * survives the difference, so the ratio column is computed from that and not from `ms`.
 */
const time = (
  label: string,
  bytes: number,
  run: () => void,
): { label: string; ms: number; mbs: number } => {
  const ms = estimate(run) / 1e6;
  return { label, ms, mbs: bytes / 1024 / 1024 / (ms / 1000) };
};

/**
 * Deterministic and generated, never pasted: the size is a knob, and content that was hand-picked
 * could be tuned — knowingly or not — to favour the implementation being measured.
 */
const rows400 = (score: (i: number) => number): string =>
  JSON.stringify(
    Array.from({ length: 400 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      note: i % 7 === 0 ? 'has "quotes" and \\ escapes' : "plain text value",
      score: score(i),
      tags: [`a${i}`, `b${i}`],
      nested: { deep: { deeper: i % 2 === 0 } },
    })),
  );

const records = rows400((i) => Math.round((i / 3) * 100) / 100);

/**
 * The same document with full-precision floats — `i / 3` spells `0.3333333333333333`, sixteen
 * digits. Its own row because it is the shape that silently cost the fast path before the precision
 * screen learned to confirm a suspect instead of convicting on the digit count, and a regression
 * there would otherwise show up only as "everything got slower" with no case naming the cause.
 */
const fullPrecision = rows400((i) => i / 3);

/**
 * Integers past 2^53, written as text because `JSON.stringify` of a JS number can no longer produce
 * one — which is the whole point: these cannot round-trip, so the fast path MUST decline and the
 * scanner must hand each back as an `ExactNumber`.
 */
const losing = `[${Array.from({ length: 400 }, (_, i) => `123456789012345678${i % 10}`).join(",")}]`;

/** The input this package actually exists for: what a model emits when it is cut off or sloppy. */
const messy = records
  .replaceAll('"name"', "name")
  .replaceAll('"note":', "'note':")
  .replace(/.{200}$/u, "");

const jsonl = Array.from({ length: 400 }, (_, i) => JSON.stringify({ id: i, v: `row-${i}` })).join(
  "\n",
);

/**
 * Each row is measured in its OWN process, and that is the whole reason this file re-executes
 * itself.
 *
 * Measured, bun 1.4.1: the damaged document reads 80 MB/s in a process that parses only it, and
 * 26 MB/s in a process that parsed the four other documents first — a 3x difference in the row this
 * package exists for. Controls separate the cause: the same prior work through `JSON.parse`, or
 * through our own parser on the SAME document, costs nothing (83 and 83), so it is neither heap
 * state nor warm-up. It is the inline caches in the shared builder seeing several document shapes.
 * A consumer's process parses THEIR shapes, not our five, so the isolated figure is the one that
 * answers "what should I expect" — and the mixed one silently made this table a claim about the
 * harness. It also made two builds incomparable: an option one of them rejects turns that row into
 * a no-op and leaves the rest of its run less polluted.
 */
const cases: Record<string, { bytes: number; run: () => void }> = {
  "JSON.parse (baseline)": { bytes: records.length, run: () => void JSON.parse(records) },
  "parse, clean": { bytes: records.length, run: () => void parse(records) },
  // The fast path off is the SCANNER's own number: the ratio between these two is what the native
  // attempt actually buys, and it is the only honest way to state it.
  "parse, clean, scanner only": {
    bytes: records.length,
    run: () => void parse(records, { builtinParsers: false }),
  },
  // Full-precision floats: 16-digit runs everywhere, none of which loses anything. Should sit beside
  // "parse, clean" — if it sits beside "scanner only" instead, the precision screen has gone back to
  // convicting on the digit count.
  "parse, 16-digit floats": { bytes: fullPrecision.length, run: () => void parse(fullPrecision) },
  // The decline path, exercised on purpose: an integer past 2^53 genuinely cannot round-trip, so the
  // fast path must refuse it and the scanner must return an `ExactNumber`. Its cost is the price of
  // not losing digits silently, and it belongs in the table rather than in a footnote.
  "parse, losing integers": { bytes: losing.length, run: () => void parse(losing) },
  "parse, malformed": { bytes: messy.length, run: () => void parse(messy) },
  "repair, malformed": { bytes: messy.length, run: () => void repair(messy) },
  "parseMany, 400 JSONL rows": {
    bytes: jsonl.length,
    run: () => {
      for (const v of parseMany(jsonl)) void v;
    },
  },
};

const runtime =
  (globalThis as { Bun?: unknown }).Bun === undefined
    ? `node ${process.versions.node}`
    : `bun ${(globalThis as { Bun?: { version: string } }).Bun?.version ?? "?"}`;

/** A child asked for one row prints just that row's numbers, and the parent collects them. */
const only = process.argv[2] ?? "";
if (only === "") {
  // `process.execPath` rather than a name: the child must be the runtime the parent is, or the table
  // would mix engines under one heading.
  const rows = Object.keys(cases).map((label) => {
    const child = spawnSync(process.execPath, [import.meta.filename, label], { encoding: "utf8" });
    if (child.status !== 0) throw new Error(`${label}: ${child.stderr}`);
    const { ms, mbs } = JSON.parse(child.stdout) as { ms: number; mbs: number };
    return { label, ms, mbs };
  });

  const base = rows[0]?.mbs ?? 1;
  // The load average is printed rather than left to the reader to check, because a busy machine and
  // slow code are indistinguishable in the table below. Anything near `cpus().length` means another
  // process is competing and every row is suspect, however plausible it looks.
  const load = loadavg()[0]?.toFixed(1) ?? "?";
  console.log(
    `\n${runtime} — one process per row, ratio is per byte against JSON.parse` +
      `\nload ${load} of ${cpus().length} cores\n`,
  );
  for (const { label, ms, mbs } of rows) {
    const cost = `${(base / mbs).toFixed(1)}x`;
    console.log(
      `  ${label.padEnd(28)} ${ms.toFixed(2).padStart(7)} ms  ${mbs.toFixed(0).padStart(5)} MB/s  ${cost.padStart(6)}`,
    );
  }
} else {
  const one = cases[only];
  if (one === undefined) throw new Error(`no such row: ${only}`);
  const { ms, mbs } = time(only, one.bytes, one.run);
  console.log(JSON.stringify({ ms, mbs }));
}
