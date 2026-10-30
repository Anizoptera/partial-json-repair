#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports an optimization opportunity when a scanner function approaches the size above which JavaScriptCore's
 * optimising JIT inlines nothing into it.
 *
 * The limit is `maximumInliningCallerBytecodeCost` (10 000 in Bun 1.4). Past it every call inside
 * the function stays a real call, so a hot loop that crosses it by a few units gets far slower with
 * no change in behaviour: `runWindow` crossing it made `scan` 1.3-1.9x slower on Bun, and nothing
 * that judges behaviour could see it. Timing could, but not reliably on a loaded machine.
 *
 * So this asks the JIT itself. It runs a workload twice, with the limit lowered to {@link LIMIT} and
 * with it lifted, logging every inlining decision and every optimised compile. A function large
 * enough to matter that inlines calls with the limit lifted, and inlined nothing under the lowered
 * limit, costs more than {@link LIMIT}. The margin below the real limit makes this warn BEFORE a
 * function reaches the cliff. A function not compiled in the lowered run is not judged, and the run
 * must compile `runWindow`, so an instrument that reached nothing cannot pass.
 */
import { resolveOptions } from "../src/options";
import { createStreamParser, diagnostics, parse } from "../src/index";
import { scan } from "../src/scan-collect";

/** 10% under JavaScriptCore's default limit: warn before the cliff without blocking other work. */
const LIMIT = 9000;
/** The scanner's main loop: the run must compile it, or it measured nothing. */
const REQUIRED = "runWindow";

if (process.argv.includes("--workload")) {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ["a"] }));
  const clean = JSON.stringify(rows);
  const damaged = clean.replaceAll('"name"', "name").replaceAll("],", "],,");
  const scanner = resolveOptions({ builtinParsers: false });
  for (let i = 0; i < 1500; i++) {
    scan(clean, scanner);
    scan(damaged, scanner);
    parse(damaged, { diagnostics });
    if (i % 10 === 0) {
      const stream = createStreamParser();
      for (let at = 0; at < damaged.length; at += 64) stream.feed(damaged.slice(at, at + 64));
      stream.end();
    }
  }
  process.exit(0);
}

/** Per optimised function, the instruction size its compile report prints; see {@link candidates}. */
const run = (limit: number): { size: Map<string, number>; inlining: Set<string> } => {
  const child = Bun.spawnSync([process.execPath, import.meta.path, "--workload"], {
    env: {
      ...process.env,
      BUN_JSC_maximumInliningCallerBytecodeCost: String(limit),
      BUN_JSC_printEachDFGFTLInlineCall: "1",
      BUN_JSC_reportDFGCompileTimes: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
  if (child.exitCode !== 0) throw new Error(`jit: the workload failed:\n${output.slice(-2000)}`);
  const size = new Map<string, number>();
  const inlining = new Set<string>();
  for (const line of output.split("\n")) {
    // A native private method's name starts with `#`; the following `#` starts its JIT identity.
    const optimised = /^Optimized (#?[^#\s]+)#\S+ \w+, (\d+)/u.exec(line);
    if (optimised?.[1] !== undefined) size.set(optimised[1], Number(optimised[2]));
    const inlined = /^\[InlineCall\]\[(?:DFG|FTL)\] Callee: \S+ -> Caller: (#?[^#\s]+)#/u.exec(
      line,
    );
    if (inlined?.[1] !== undefined) inlining.add(inlined[1]);
  }
  return { size, inlining };
};

const [lowered, lifted] = [run(LIMIT), run(1_000_000)];
if (!lowered.size.has(REQUIRED) || !lifted.inlining.has(REQUIRED)) {
  throw new Error(`jit: the workload never optimised ${REQUIRED}, so this check measured nothing.`);
}
/**
 * Only functions whose printed size exceeds the limit are judged. That size bounded the inlining
 * cost from above in every function measured (`runWindow` 10 021 against 7 934, `readString`
 * 5 172 against 4 441, `numberToken` 2 336 against 2 332), so a smaller one is under the limit. A
 * small function is also misjudged by its inlining log: it can compile alone and inline nothing
 * while its inlining happens nested in a large caller, which named `continuingString` (size 67).
 */
const candidates = [...lowered.size].filter(([, size]) => size > LIMIT).map(([name]) => name);
const over = candidates.filter((name) => lifted.inlining.has(name) && !lowered.inlining.has(name));
if (over.length > 0) {
  console.warn(
    `jit: optimization warning: bytecode cost over ${LIMIT} in: ${over.join(", ")}.\n` +
      "JavaScriptCore inlines nothing into a function above 10000, which makes a hot loop far slower. " +
      "Record this for later optimization; it does not block commits or release. " +
      "Consider moving a branch that runs at most once per token or window into its own function.",
  );
} else {
  console.log(
    `jit: ${candidates.length} optimised function(s) larger than ${LIMIT} by size, ` +
      `each still inlining at that limit (${candidates.join(", ") || "none"})`,
  );
}
