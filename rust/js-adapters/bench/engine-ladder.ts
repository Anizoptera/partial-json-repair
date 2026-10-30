// Times the engine JSON parsers on the SAME bytes `rust/bench` measures.
//
// Scoping a comparison to Rust crates measures the crate ecosystem, not the state of the art.
// `JSON.parse` in JavaScriptCore and V8 is heavily optimised C++ with far more engineering behind it
// than any crate, so it is the closest available thing to a practical ceiling for reading JSON into
// a language-native tree — and it is this package's real competition on clean input, because the
// TypeScript half delegates straight to it. If an engine beats the Rust scanner on clean input, the
// Rust port's clean path is not earning its crossing, and that is a fact about the architecture
// rather than about micro-optimisation.
//
// The documents come from `rust/bench/… dump:<dir>` rather than from a generator here: a second
// generator would compare generators as much as parsers, and the difference would be invisible
// because both would emit plausible JSON.
//
// Run it under BOTH runtimes on the same file — node 24 executes TypeScript directly, so neither
// gets a transpile step the other does not pay:
//
//   bun run build && bun scripts/rust/cargo.ts run --release --manifest-path rust/bench/Cargo.toml -- dump:/tmp/ladder
//   for i in 1 2 3 4 5; do bun  bench/engine-ladder.ts /tmp/ladder; done
//   for i in 1 2 3 4 5; do node bench/engine-ladder.ts /tmp/ladder; done
//
// The estimator matches `rust/bench/src/main.rs`: minimum WITHIN a process, because everything else
// on the machine can only ADD time while a mean tracks how busy it was; the error bar comes from
// separate PROCESSES, which is why the loops above exist. Warm-up is floored in INVOCATIONS rather
// than milliseconds because a tiering JIT counts calls, and a duration-based warm-up leaves a slow
// subject timed after two invocations and reading slow for ever.

import { readdirSync, readFileSync } from "node:fs";

const BUDGET_MS = 400;
const PATIENCE = 24;
const WARMUP_CALLS = 64;
const CALIBRATION_NS = 500_000n;

const directory = process.argv[2] ?? "/tmp/ladder";
// `Bun` is a global only under bun, so its absence is what names the runtime. The tag goes into
// every row because a number without the engine that produced it cannot be compared to anything.
const bun = (globalThis as { Bun?: { version: string } }).Bun;
const runtime = bun === undefined ? `node-${process.versions.node}` : `bun-${bun.version}`;

/** Nanoseconds per call, stopping once the minimum has stopped improving rather than after a fixed
 * batch count: a fixed count never gives a fast subject the chance to find an uncontended run, and
 * biases its first moment upward. The wall-clock budget is what bounds the patience. */
function measure<T>(fn: (input: T) => void, input: T): number {
  for (let i = 0; i < WARMUP_CALLS; i++) fn(input);

  // A batch long enough that the clock's own resolution is not part of the reading.
  let batch = 1;
  for (;;) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < batch; i++) fn(input);
    if (process.hrtime.bigint() - started >= CALIBRATION_NS || batch >= 1 << 22) break;
    batch *= 2;
  }

  let best = Number.POSITIVE_INFINITY;
  let sinceImprovement = 0;
  const deadline = Date.now() + BUDGET_MS;
  while (sinceImprovement < PATIENCE && Date.now() < deadline) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < batch; i++) fn(input);
    // Annotated because the difference of two `bigint`s is one, and the conversion to `number` is
    // load-bearing: `bigint / number` is a TypeError, not a division.
    const elapsedNanoseconds: bigint = process.hrtime.bigint() - started;
    const perOperation = Number(elapsedNanoseconds) / batch;
    if (perOperation < best) {
      best = perOperation;
      sinceImprovement = 0;
    } else sinceImprovement++;
  }
  return best;
}

// A sink the engine cannot prove unused, so the parse cannot be optimised away.
let sink = 0;
const parseText = (text: string): void => {
  sink += typeof JSON.parse(text) === "object" ? 1 : 0;
};
const decoder = new TextDecoder();
const parseBytes = (bytes: Uint8Array): void => {
  sink += typeof JSON.parse(decoder.decode(bytes)) === "object" ? 1 : 0;
};

for (const file of readdirSync(directory).toSorted()) {
  if (!file.endsWith(".json")) continue;
  const name = file.replace(/\.json$/u, "").replace("-", "/");
  const text = readFileSync(`${directory}/${file}`, "utf8");
  const bytes = new Uint8Array(readFileSync(`${directory}/${file}`));

  // Two rows, because they answer different questions. A consumer holding a decoded string pays
  // only the parse; one holding bytes off a socket or a file pays the decode too, which is the
  // comparison the Rust subjects make, since they take `&[u8]`.
  const rows: [string, number][] = [
    [`${runtime}/JSON.parse`, measure(parseText, text)],
    [`${runtime}/decode+parse`, measure(parseBytes, bytes)],
  ];
  for (const [subject, ns] of rows) {
    process.stdout.write(
      `${JSON.stringify({ case: name, bytes: bytes.length, subject, ns, ok: true })}\n`,
    );
  }
}
// Reading the sink keeps every parse above observable; the branch is never taken.
if (sink === -1) process.exit(9);
