// SPDX-License-Identifier: Apache-2.0

import { startupWaiterMemoryProbe } from "../test/worker-startup-memory-probe";
import {
  betweenRootsMemoryProbe,
  closedParserMemoryProbe,
  deliveredMetadataMemoryProbe,
  interruptedWorkerMemoryProbe,
  terminalInputMemoryProbe,
  wholeSignalMemoryProbe,
  syncWholeInputMemoryProbe,
  workerIteratorMemoryProbe,
} from "../test/worker-iterator-memory-probe";
import { wholeTextMemoryProbe } from "../test/whole-text-memory-probe";
import { assertInputRetention, pendingTokenMemoryProbe } from "../test/pending-token-memory-probe";
import { stoppedViewMemoryProbe } from "../test/resource-recovery-probe";
import { textCopySafetyProbe } from "../test/text-copy-safety-probe";
import { metricsMemoryProbe } from "../test/metrics-memory-probe";
import { closedReaderMemoryProbe } from "../test/whole-reader-memory-probe";

export type MemoryProbe = {
  start(width: number, retain: boolean): Promise<void>;
  advance(): Promise<void>;
  validate(): Promise<void>;
  clear(): Promise<void>;
  heap(): Promise<number>;
};

// Native WebKit batches the same cohorts because its inspector lives outside Bun's bridge.
export const INPUT_MEMORY_COHORTS = {
  warm: { width: 100, retain: false },
  small: { width: 100, retain: false },
  control: { width: 100_000, retain: true },
  large: { width: 100_000, retain: false },
} as const;

export const checkTerminalMemory = async (
  probe: MemoryProbe,
  owner = "terminal iterator",
): Promise<void> => {
  const sample = async ({ width, retain }: { width: number; retain: boolean }) => {
    // Collect completed controls before allocating another caller-sized cohort.
    await probe.heap();
    await using cleanup = { [Symbol.asyncDispose]: () => probe.clear() };
    await probe.start(width, retain);
    const suspended = await probe.heap();
    await probe.advance();
    const ended = await probe.heap();
    await probe.validate();
    return { suspended, ended };
  };
  await sample(INPUT_MEMORY_COHORTS.warm);
  const small = await sample(INPUT_MEMORY_COHORTS.small);
  const control = await sample(INPUT_MEMORY_COHORTS.control);
  const large = await sample(INPUT_MEMORY_COHORTS.large);
  assertInputRetention(small, control, large, owner);
};

export const checkConsumerMemory = (
  run: (command: string, args: string[], cwd: string) => void,
  extracted: string,
): void => {
  // Force collection through installed imports; workspace code cannot prove shipped ownership.
  run("bun", ["--eval", startupWaiterMemoryProbe("partial-json-repair/async")], extracted);
  run(
    "node",
    ["--expose-gc", "--input-type=module", "--eval", closedReaderMemoryProbe("./dist", "node")],
    extracted,
  );
  run("bun", ["--eval", closedReaderMemoryProbe("./dist", "bun")], extracted);
  run(
    "deno",
    ["eval", "--v8-flags=--expose-gc", closedReaderMemoryProbe("./dist", "deno")],
    extracted,
  );
  // Exercise every spelling in one real parent; verify raw argv so normalization cannot erase a case.
  const execArgv = [
    "--expose_gc",
    "--expose-gc-as=collect",
    "--expose_gc_as=collect",
    "--input-type=module",
    "--input_type=module",
    "--input_type",
    "module",
  ];
  run(
    "node",
    [
      ...execArgv,
      "--eval",
      `import { parseAsync, worker } from "partial-json-repair/async"; const expected = ${JSON.stringify(execArgv)}; if (expected.some((argument, index) => process.execArgv[index] !== argument)) throw new Error("Node changed the requested parent flags; every spelling must reach worker startup"); const result = await parseAsync("{safe:1}", { execution: worker }); if (!result.ok || !result.complete || result.value.safe !== 1) throw new Error("worker startup must filter parent input modes and GC exposure flags");`,
    ],
    extracted,
  );
  const iteratorProgram = workerIteratorMemoryProbe("partial-json-repair/async");
  const deliveredMetadata = deliveredMetadataMemoryProbe(
    "partial-json-repair",
    "partial-json-repair/async",
    ["sync", "cooperative", "worker"],
  );
  run("node", ["--expose-gc", "--input-type=module", "--eval", deliveredMetadata], extracted);
  run("bun", ["--eval", deliveredMetadata], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", deliveredMetadata], extracted);
  const closedParser = closedParserMemoryProbe("partial-json-repair/async");
  const betweenRoots = betweenRootsMemoryProbe("partial-json-repair");
  run("node", ["--expose-gc", "--input-type=module", "--eval", betweenRoots], extracted);
  run("bun", ["--eval", betweenRoots], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", betweenRoots], extracted);
  const metrics = metricsMemoryProbe("partial-json-repair");
  run("node", ["--expose-gc", "--input-type=module", "--eval", metrics], extracted);
  run("bun", ["--eval", metrics], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", metrics], extracted);
  const pendingTokens = pendingTokenMemoryProbe("partial-json-repair");
  const syncWholeInput = syncWholeInputMemoryProbe("partial-json-repair");
  run("node", ["--expose-gc", "--input-type=module", "--eval", syncWholeInput], extracted);
  run("bun", ["--eval", syncWholeInput], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", syncWholeInput], extracted);
  run("node", ["--expose-gc", "--input-type=module", "--eval", pendingTokens], extracted);
  run("bun", ["--eval", pendingTokens], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", pendingTokens], extracted);
  const stoppedViews = stoppedViewMemoryProbe("partial-json-repair");
  run("node", ["--expose-gc", "--input-type=module", "--eval", stoppedViews], extracted);
  run("bun", ["--eval", stoppedViews], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", stoppedViews], extracted);
  run("node", ["--expose-gc", "--input-type=module", "--eval", closedParser], extracted);
  run("bun", ["--eval", closedParser], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", closedParser], extracted);
  run("node", ["--expose-gc", "--input-type=module", "--eval", iteratorProgram], extracted);
  run("bun", ["--eval", iteratorProgram], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", iteratorProgram], extracted);
  const interrupted = interruptedWorkerMemoryProbe("partial-json-repair/async");
  run("node", ["--expose-gc", "--input-type=module", "--eval", interrupted], extracted);
  run("bun", ["--eval", interrupted], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", interrupted], extracted);
  const terminal = terminalInputMemoryProbe("partial-json-repair/async");
  run("node", ["--expose-gc", "--input-type=module", "--eval", terminal], extracted);
  run("bun", ["--eval", terminal], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", terminal], extracted);
  const signals = wholeSignalMemoryProbe("partial-json-repair/async");
  run("node", ["--expose-gc", "--input-type=module", "--eval", signals], extracted);
  run("bun", ["--eval", signals], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", signals], extracted);
  // Each host must detect its held-string control before its returned-text bound can count.
  const textProgram = wholeTextMemoryProbe(
    "partial-json-repair",
    "partial-json-repair/async",
    "parse",
  );
  const textSafety = textCopySafetyProbe("partial-json-repair", "partial-json-repair/async");
  run("node", ["--input-type=module", "--eval", textSafety], extracted);
  run("bun", ["--eval", textSafety], extracted);
  run("deno", ["eval", textSafety], extracted);
  run("node", ["--expose-gc", "--input-type=module", "--eval", textProgram], extracted);
  run("bun", ["--eval", textProgram], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", textProgram], extracted);
  const repairProgram = wholeTextMemoryProbe(
    "partial-json-repair",
    "partial-json-repair/async",
    "repair",
  );
  run("node", ["--expose-gc", "--input-type=module", "--eval", repairProgram], extracted);
  run("bun", ["--eval", repairProgram], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", repairProgram], extracted);
  // Spans carry no text, but their completed scanner must release its input as well.
  const spanProgram = wholeTextMemoryProbe(
    "partial-json-repair",
    "partial-json-repair/async",
    "findJsonSpan",
  );
  run("node", ["--expose-gc", "--input-type=module", "--eval", spanProgram], extracted);
  run("bun", ["--eval", spanProgram], extracted);
  run("deno", ["eval", "--v8-flags=--expose-gc", spanProgram], extracted);
};
