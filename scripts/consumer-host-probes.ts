import { spawnSync } from "node:child_process";

export const run = (command: string, args: string[], cwd = process.cwd()): string => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
};

export type HostProbe = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly expectedOutput: readonly string[];
};

const readProbeOutput = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const output = await new Response(stream).text();
  return output;
};

export const runHostProbes = async (probes: readonly HostProbe[]): Promise<void> => {
  if (probes.length === 0) throw new Error("No packed host probes were queued");
  let next = 0;
  const failures: Error[] = [];
  const active = new Set<ReturnType<typeof Bun.spawn>>();
  let interrupted = false;
  const stop = (): void => {
    if (interrupted) return;
    interrupted = true;
    for (const child of active) {
      try {
        child.kill("SIGKILL");
      } catch (cause) {
        failures.push(new Error("Unable to stop an owned packed probe", { cause }));
      }
    }
  };
  const lane = async (): Promise<void> => {
    while (next < probes.length) {
      if (interrupted) break;
      const { command, args, cwd, expectedOutput } = probes[next++] as HostProbe;
      try {
        const child = Bun.spawn([command, ...args], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
          // A probe can install signal handlers; its deadline must still end owned work.
          killSignal: "SIGKILL",
        });
        active.add(child);
        try {
          // Drain both pipes while waiting; a full pipe must not hold an otherwise finished child.
          // eslint-disable-next-line no-await-in-loop -- Each lane owns one child at a time.
          const [stdout, stderr, exit] = await Promise.allSettled([
            readProbeOutput(child.stdout),
            readProbeOutput(child.stderr),
            child.exited,
          ]);
          if (
            stdout.status === "rejected" ||
            stderr.status === "rejected" ||
            exit.status === "rejected"
          )
            throw new AggregateError(
              [stdout, stderr, exit]
                .filter((result) => result.status === "rejected")
                .map(
                  (result) =>
                    new Error("Packed probe observation failed", { cause: result.reason }),
                ),
              `Unable to observe ${command} probe completion`,
            );
          if (exit.value !== 0)
            throw new Error(
              `${command} ${args.join(" ")} failed (${exit.value})\n${stdout.value}\n${stderr.value}`,
            );
          // An unreferenced child can exit zero before an awaited observation completes.
          for (const marker of expectedOutput)
            if (!stdout.value.includes(marker))
              throw new Error(
                `${command} exited before ${marker}\n${stdout.value}\n${stderr.value}`,
              );
        } finally {
          active.delete(child);
        }
      } catch (cause) {
        failures.push(
          new Error(
            `Packed ${command} probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          ),
        );
      }
    }
  };
  // Fresh processes preserve cold state; bound live cohorts because heap probes also own workers.
  // The 16-core complete-hook comparison favored eight lanes; sixteen added sampled RSS.
  // The core bound still limits two-core CI to two lanes.
  // Finish every child before the caller changes or deletes their shared packed fixture.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(8, navigator.hardwareConcurrency)) }, lane),
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (interrupted) failures.push(new Error("Packed host probes were interrupted"));
  if (failures.length > 0)
    throw new AggregateError(failures, failures.map((failure) => failure.message).join("\n"));
};
