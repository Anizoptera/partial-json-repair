// SPDX-License-Identifier: Apache-2.0
/* eslint-disable no-await-in-loop -- Concurrent measurement cells would contend for the same event loop and machine. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { packConsumer } from "../../scripts/consumer-package";
import { HTTP_MODES, modelEvents, modelFixtures, modelReply } from "./http-model";
import type { HttpEnding, HttpMode, Oracle } from "./http-model";
import { concurrentResults } from "../async-sample";
import { HTTP_SERVERS } from "./http-server";
import { bounded, observeHttpService, requestHttpJob, startHttp } from "./http-process";
import {
  supportedBunRuntimes,
  supportedDenoRuntime,
  supportedDenoVersion,
  supportedNodeRuntimes,
} from "./runtimes";
import type { InstalledRuntime } from "./runtimes";

// A separate server process keeps the producer and competing client off the measured event loop.
const root = resolvePath(import.meta.dir, "../..");
const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    server: { type: "string" },
    case: { type: "string" },
    "fixture-ref": { type: "string" },
    mode: { type: "string" },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "1" },
    "fault-oracle": { type: "boolean", default: false },
    "gap-cpu": { type: "boolean", default: false },
    "cooperative-response": { type: "boolean", default: false },
  },
});
const samples = Number(values.samples);
const concurrency = Number(values.concurrency);
const responseDecoding = values["cooperative-response"] ? "cooperative" : "sdk";
if (!Number.isSafeInteger(samples) || samples < 2)
  throw new Error("--samples must include a cold and a repeated call");
if (!Number.isSafeInteger(concurrency) || concurrency < 1)
  throw new Error("--concurrency must be a positive safe integer");
const selected = <T extends string>(
  all: readonly T[],
  filter: string | undefined,
): readonly T[] => {
  const chosen = all.filter((value) => filter === undefined || value === filter);
  if (chosen.length === 0)
    throw new Error(`Expected one of ${all.join(", ")}; got ${String(filter)}`);
  return chosen;
};
const frameworks = selected(HTTP_SERVERS, values.server);
const modes = selected(HTTP_MODES, values.mode);
// Resolve once before reading inputs: a branch name can move while the measurement is running.
const fixtureRevision =
  values["fixture-ref"] === undefined
    ? undefined
    : run([
        "git",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${values["fixture-ref"]}^{commit}`,
      ]);
const fixtures = (await modelFixtures(root, fixtureRevision)).filter(
  (fixture) => values.case === undefined || fixture.id === values.case,
);
if (fixtures.length === 0) throw new Error("No model fixture selected");
const runtimes = [
  ...supportedBunRuntimes("bun", values.runtime),
  ...supportedNodeRuntimes("node", values.runtime),
  ...(values.runtime === undefined || `deno ${supportedDenoVersion}`.includes(values.runtime)
    ? [supportedDenoRuntime()]
    : []),
];
if (runtimes.length === 0) throw new Error("No declared runtime selected");
// Fastify's documented runtime is Node; an explicit selector can investigate Bun compatibility.
const frameworksFor = (runtime: InstalledRuntime) =>
  frameworks.filter((framework) =>
    runtime.label.startsWith("deno ")
      ? framework === "hono"
      : framework !== "fastify" || !runtime.label.startsWith("bun ") || values.server === "fastify",
  );
const plan = runtimes
  .map((runtime) => ({ runtime, frameworks: frameworksFor(runtime) }))
  .filter((job) => job.frameworks.length > 0);
if (plan.length === 0)
  throw new Error(
    "No HTTP server/runtime pair selected; Deno uses Hono, and Fastify defaults to Node.",
  );
function run(args: string[]) {
  const result = spawnSync(args[0] ?? "", args.slice(1), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${args.join(" ")} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
const treeState = () => {
  const revision = run(["git", "rev-parse", "HEAD"]);
  const hash = createHash("sha256")
    .update(revision)
    .update(run(["git", "diff", "HEAD", "--binary"]));
  for (const path of run(["git", "ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .toSorted()) {
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(join(root, path)));
  }
  return { revision: revision.slice(0, 7), tree: hash.digest("hex") };
};
const initialState = treeState();
console.error(run([process.execPath, "run", "build"]));
const packed = packConsumer(root, "pjr-http-model-");
try {
  const work = join(packed.consumer.dir, "fixtures");
  symlinkSync(join(root, "bench/prior-art/node_modules"), join(work, "node_modules"));
  symlinkSync(join(root, ".tool-versions"), join(packed.work, ".tool-versions"));
  const dataPath = join(work, "model-fixtures.json");
  writeFileSync(dataPath, JSON.stringify(fixtures));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "http-consumer.ts")],
    outdir: work,
    target: "node",
    packages: "external",
    plugins: [
      {
        name: "packed-library",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/\.\.\/dist\/(index|async)$/u }, ({ path }) => ({
            path: path.endsWith("/async") ? "partial-json-repair/async" : "partial-json-repair",
            external: true,
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "HTTP consumer bundle failed");
  const entry = join(work, "http-consumer.js");
  const artifact = createHash("sha256").update(readFileSync(packed.tarballPath)).digest("hex");
  const replies = new Map(
    fixtures.map((fixture) => [
      fixture.id,
      { text: modelReply(fixture), events: modelEvents(fixture) },
    ]),
  );
  const sources = new Map<string, { closed: Promise<void>; state: string }>();
  let excludedCalls = 0;
  let cells = 0;
  let identities: string | undefined;
  const producer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string; stream?: boolean };
      const reply = replies.get(body.model);
      if (reply === undefined) return new Response("Unknown model", { status: 400 });
      if (!body.stream)
        return new Response(reply.text, { headers: { "content-type": "application/json" } });
      const ending = request.headers.get("x-replay-ending") ?? "complete";
      const id = request.headers.get("x-replay-id") ?? "";
      let release!: () => void;
      const source = {
        closed: new Promise<void>((resolve) => {
          release = resolve;
        }),
        state: "active",
      };
      sources.set(id, source);
      let index = 0;
      let releasePull: (() => void) | undefined;
      const finish = (state: string) => {
        source.state = state;
        request.signal.removeEventListener("abort", onAbort);
        releasePull?.();
        release();
      };
      const onAbort = () => {
        finish("cancelled");
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index > 0 && ending === "cancel") {
            await new Promise<void>((resolve) => {
              releasePull = resolve;
            });
            return;
          }
          if (index > 0 && ending === "failure") {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"error":{"message":"replay-source-failed","type":"server_error","code":"fixture"}}\n\n',
              ),
            );
            controller.close();
            finish("failed");
            return;
          }
          const next = reply.events[index++];
          if (next === undefined) {
            controller.close();
            finish("eof");
          } else controller.enqueue(next);
        },
        cancel() {
          finish("cancelled");
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    for (const { runtime, frameworks: servers } of plan) {
      const observerRuntime = runtime.label.startsWith("deno ")
        ? {
            ...runtime,
            argv: [
              ...runtime.argv,
              "run",
              "--no-check",
              "--no-config",
              "--no-lock",
              "--node-modules-dir=manual",
              `--allow-read=${root},${packed.work}`,
              "--allow-env",
              "--allow-sys",
              "--allow-net=127.0.0.1",
            ],
          }
        : runtime;
      const oraclePath = join(work, `oracle-${runtime.label.replaceAll(" ", "-")}.json`);
      const oracle = JSON.parse(run([...observerRuntime.argv, entry, dataPath, "--oracle"])) as {
        runtime: string;
        oracles: Record<string, Oracle>;
      };
      if (oracle.runtime !== runtime.label)
        throw new Error(
          `Runtime label ${runtime.label} resolved to ${oracle.runtime}; repair the declared executable before measuring.`,
        );
      const identity = JSON.stringify(oracle.oracles);
      if (identities !== undefined && identities !== identity)
        throw new Error("Model inputs or reference outcomes differ across runtimes");
      identities = identity;
      if (values["fault-oracle"])
        for (const reference of Object.values(oracle.oracles))
          reference.whole = reference.stream = "0".repeat(64);
      writeFileSync(oraclePath, JSON.stringify(oracle));
      for (const framework of servers)
        for (const fixture of fixtures)
          for (const mode of modes) {
            console.error(`HTTP ${runtime.label} ${framework} ${fixture.id} ${mode}`);
            const session = await startHttp(
              observerRuntime,
              [
                entry,
                dataPath,
                framework,
                producer.url.origin,
                oraclePath,
                ...(values["gap-cpu"] ? ["--gap-cpu"] : []),
                ...(values["cooperative-response"] ? ["--cooperative-response"] : []),
              ],
              root,
            );
            try {
              const rows: Record<string, unknown>[] = [];
              const invoke = async (
                caseId: string,
                execution: HttpMode,
                ending: HttpEnding,
                ordinal: number,
              ): Promise<Record<string, unknown>> => {
                const id = `${framework}-${runtime.label}-${caseId}-${execution}-${ending}-${ordinal}`;
                const metrics = await requestHttpJob(session.url, {
                  id,
                  case: caseId,
                  mode: execution,
                  ending,
                });
                const source = sources.get(id);
                if (execution === "stream" && fixture.id === caseId) {
                  if (source === undefined) throw new Error("SDK never reached replay producer");
                  await bounded(source.closed, "Replay source cleanup");
                  if (
                    source.state !==
                    (ending === "complete" ? "eof" : ending === "cancel" ? "cancelled" : "failed")
                  )
                    throw new Error(`Wrong upstream ending: ${source.state}`);
                }
                return { ...metrics, ordinal, case: caseId, producer: source?.state };
              };
              const runBatch = (caseId: string, ending: HttpEnding, ordinal: number, count = 1) => {
                let next = ordinal;
                return observeHttpService(
                  session.url,
                  () =>
                    concurrentResults(count, () => {
                      const current = next++;
                      // A stopped request must not stop its concurrently parsed siblings.
                      return invoke(
                        caseId,
                        mode,
                        current === ordinal ? ending : "complete",
                        current,
                      );
                    }),
                  (metrics) => {
                    rows.push({
                      case: caseId,
                      firstEnding: ending,
                      ordinal,
                      concurrency: count,
                      ...metrics,
                    });
                  },
                );
              };
              const [idle] = await runBatch("idle", "complete", 0);
              const [blocking] = await runBatch("blocking", "complete", 0);
              if (
                idle === undefined ||
                blocking === undefined ||
                Number(blocking.maxGapMs) < 40 ||
                Number(idle.maxGapMs) >= Number(blocking.maxGapMs)
              )
                throw new Error("HTTP observer failed idle/blocking controls");
              const measured: Record<string, unknown>[] = [];
              for (let sample = 0; sample < samples; sample++)
                for (const result of await runBatch(
                  fixture.id,
                  "complete",
                  sample * concurrency,
                  concurrency,
                ))
                  measured.push(result);
              if (mode === "stream" && fixture.id === "write-files")
                for (const ending of ["failure", "cancel"] as const)
                  for (const result of await runBatch(
                    fixture.id,
                    ending,
                    (samples + (ending === "failure" ? 0 : 1)) * concurrency,
                    concurrency,
                  ))
                    measured.push(result);
              const verify = await fetch(`${session.url}/verify`, {
                signal: AbortSignal.timeout(10_000),
              });
              if (!verify.ok)
                throw new Error(`Full outcome validation failed: ${await verify.text()}`);
              const checked = (await verify.json()) as { verified: number; peakActiveJobs: number };
              if (checked.verified !== measured.length + 2)
                throw new Error("HTTP validation omitted a request");
              if (concurrency > 1 && checked.peakActiveJobs < 2)
                throw new Error("Concurrent HTTP requests did not overlap in the service");
              const gaps = measured.map((record) => Number(record.maxGapMs));
              const excluded = gaps.filter((gap) => gap > 32).length;
              excludedCalls += excluded;
              cells++;
              console.log(
                JSON.stringify({
                  artifact,
                  command: [process.execPath, ...process.argv.slice(1)],
                  ...initialState,
                  ...(fixtureRevision === undefined ? {} : { fixtureRevision }),
                  runtime: runtime.label,
                  framework,
                  fixture: fixture.id,
                  mode,
                  concurrency,
                  responseDecoding: mode === "stream" ? "sdk-sse" : responseDecoding,
                  diagnostics: values["gap-cpu"] ? "gap-cpu" : "none",
                  oracle,
                  eligibility: {
                    excludedCalls: excluded,
                    warnings: gaps.filter((gap) => gap > 8).length,
                    maxGapMs: Math.max(...gaps),
                  },
                  controls: { idle, blocking },
                  measured,
                  health: rows,
                  ...checked,
                }),
              );
            } finally {
              await session.close();
            }
          }
    }
    const expectedCells =
      plan.reduce((count, job) => count + job.frameworks.length, 0) *
      fixtures.length *
      modes.length;
    if (cells !== expectedCells)
      throw new Error(`HTTP matrix covered ${cells} of ${expectedCells} cells`);
    // Keep receipt fields stable for diagnostic readers; timing counts never change the exit status.
    console.log(JSON.stringify({ kind: "summary", cells, expectedCells, excludedCalls }));
  } finally {
    await producer.stop(true);
  }
  if (treeState().tree !== initialState.tree)
    throw new Error("Library or measurement source changed during HTTP measurements");
} finally {
  rmSync(packed.work, { recursive: true });
}
