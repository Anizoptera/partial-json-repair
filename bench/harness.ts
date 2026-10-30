// SPDX-License-Identifier: Apache-2.0

/**
 * The microbenchmark harness behind the `*.bench.ts` files here. Never gates.
 *
 * It exists because vitest 5 removed the `bench` API these files were written against. tinybench is
 * the engine `vitest bench` itself ran on, so keeping it keeps these files' ratios comparable with
 * the ones they printed before — a different sampling strategy would silently change every one of
 * them while still printing plausible numbers.
 *
 * `bench/throughput.ts` and `bench/prior-art/compare.ts` time through `bench/estimator.ts` instead,
 * and should: they price whole documents, where the minimum of calibrated batches across forked
 * processes is the estimator. The files here resolve differences as small as 1.09x on
 * per-character operations, below a naive loop's noise floor. Measurement scale picks the
 * instrument, not taste.
 *
 * Being a plain module rather than a test runner, these files also run under Bun and Node alike,
 * where a vitest bench could only ever produce the Node column.
 */
import { Bench } from "tinybench";

type Case = () => unknown;

interface Group {
  readonly name: string;
  readonly cases: { readonly name: string; readonly fn: Case }[];
}

const groups: Group[] = [];
let open: Group | undefined;

/** Groups the cases sharing one input and one question, so each question prints its own table. */
export const describe = (name: string, body: () => void): void => {
  // Nesting would file the inner cases under the outer group and compare inputs never meant to be
  // compared. That is a wrong table rather than a crash, so it is refused instead of handled.
  if (open !== undefined) throw new Error(`describe(${name}) nested inside ${open.name}`);
  const group: Group = { name, cases: [] };
  open = group;
  groups.push(group);
  body();
  open = undefined;
};

/** Registers one alternative within the open group. The callback may be async; tinybench awaits it. */
export const bench = (name: string, fn: Case): void => {
  if (open === undefined) throw new Error(`bench(${name}) outside a describe`);
  open.cases.push({ name, fn });
};

/**
 * Runs every registered group, in declaration order.
 *
 * Called explicitly at the end of each file rather than from an exit hook, so a throwing case keeps
 * its stack. The runtime is printed beside every table because a number without its environment is
 * a claim about nothing.
 *
 * A case that THREW fails the process. tinybench records the error as a table cell and otherwise
 * exits zero, which is how `stream.bench.ts` went on printing a table after the parser API it
 * called had changed shape: the two broken rows were blank, and nothing else said so.
 */
export const run = async (): Promise<void> => {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  const runtime = bun === undefined ? `node ${process.versions.node}` : `bun ${bun.version}`;
  for (const group of groups) {
    const suite = new Bench();
    for (const { name, fn } of group.cases) suite.add(name, fn);
    // Sequential by necessity: concurrent groups would contend for the same core and price the
    // contention rather than the code.
    // oxlint-disable-next-line no-await-in-loop
    const tasks = await suite.run();
    console.log(`\n${group.name} — ${runtime}`);
    console.table(suite.table());
    let failed = false;
    for (const task of tasks) {
      const result = task.result;
      if (result !== undefined && "error" in result) {
        console.error(`FAILED ${group.name} / ${task.name}:`, result.error);
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;
  }
};
