// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate as yieldHost } from "node:timers/promises";
import { inspect } from "node:util";
import OpenAI from "openai";
import { parse, parseStream } from "../../dist/index";
import type { StreamItem } from "../../dist/parser";
import { auto, cooperative, parseAsync } from "../../dist/async";
import { captureHostContext, runtime } from "../async-host";
import { canonicalDigest } from "../async-oracle";
import { HTTP_ENDINGS, HTTP_MODES, MODEL_DELTA_BATCH } from "./http-model";
import type { HttpEnding, HttpMode, ModelFixture, Oracle } from "./http-model";
import { HTTP_SERVERS, listen } from "./http-server";
import { stoppedReference, streamReference } from "./http-reference";
import { readModelArguments } from "./http-response";

const fixtures = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as ModelFixture[];
const inputDigest = (input: string) => createHash("sha256").update(input).digest("hex");
if (process.argv[3] === "--oracle") {
  const oracles: Record<string, Oracle> = {};
  for (const fixture of fixtures)
    oracles[fixture.id] = {
      input: inputDigest(fixture.input),
      parts: canonicalDigest(fixture.parts),
      whole: canonicalDigest([parse(fixture.input)]),
      stream: canonicalDigest(streamReference(fixture.parts)),
      units: fixture.input.length,
      bytes: Buffer.byteLength(fixture.input),
      deltas: fixture.parts.length,
    };
  console.log(JSON.stringify({ runtime: runtime(), oracles }));
} else {
  const framework = HTTP_SERVERS.find((value) => value === process.argv[3]);
  if (framework === undefined) throw new Error("Select an HTTP server");
  const expected = JSON.parse(readFileSync(process.argv[5] ?? "", "utf8")) as {
    runtime: string;
    oracles: Record<string, Oracle>;
  };
  if (expected.runtime !== runtime())
    throw new Error("Oracle runtime differs from measured runtime");
  const client = new OpenAI({
    apiKey: "local-replay-only",
    baseURL: process.argv[4],
    maxRetries: 0,
  });
  type Captured = {
    fixture: ModelFixture | undefined;
    mode: HttpMode;
    ending: HttpEnding;
    parts: string[];
    outcomes: (Awaited<ReturnType<typeof parseAsync>> | StreamItem<Record<never, never>>)[];
    sourceClosed: boolean;
    parserClosed: boolean;
    sourceError?: unknown;
    elapsedMs: number;
    maxGapMs: number;
    samples: number;
    aborted: boolean;
    worst:
      | {
          from: number;
          to: number;
          observedAtMs: number;
          before: string;
          after: string;
          cpuMs?: number;
        }
      | undefined;
  };
  const records = new Map<string, Promise<Captured>>();
  type CpuUsage = ReturnType<typeof process.cpuUsage>;
  const gapCpu = process.argv.includes("--gap-cpu");
  const cooperativeResponse = process.argv.includes("--cooperative-response");
  const samplers = new Set<(now: number, cpu: CpuUsage | undefined) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let peakActiveJobs = 0;
  const observe = (sample: (now: number, cpu: CpuUsage | undefined) => void) => {
    // One host timer serves all active jobs; per-job timers would add load as concurrency grows.
    samplers.add(sample);
    peakActiveJobs = Math.max(peakActiveJobs, samplers.size);
    timer ??= setInterval(() => {
      const now = performance.now();
      const cpu = gapCpu ? process.cpuUsage() : undefined;
      for (const collect of samplers) collect(now, cpu);
    }, 0);
    return () => {
      samplers.delete(sample);
      if (samplers.size === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  };
  const encoder = new TextEncoder();
  const server = await listen(framework, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const id = url.searchParams.get("id") ?? "";
    if (url.pathname === "/settled") {
      const pending = records.get(id);
      if (pending === undefined) throw new Error(`Unknown request ${id}`);
      const {
        fixture: _fixture,
        parts: _parts,
        outcomes: _outcomes,
        sourceError: _sourceError,
        ...metrics
      } = await pending;
      return Response.json({ id, ...metrics, runtime: runtime(), framework });
    }
    if (url.pathname === "/verify") {
      for (const record of await Promise.all(records.values())) {
        if (!record.sourceClosed || !record.parserClosed)
          throw new Error("Unreleased source or parser");
        if (record.fixture === undefined) continue;
        const reference = expected.oracles[record.fixture.id];
        if (reference === undefined || inputDigest(record.fixture.input) !== reference.input)
          throw new Error("Wrong input identity");
        const last = record.outcomes.at(-1);
        if (record.ending === "complete") {
          if (
            canonicalDigest(record.parts) !==
            (record.mode === "stream" ? reference.parts : canonicalDigest([record.fixture.input]))
          )
            throw new Error("SDK changed argument deltas");
          if (
            canonicalDigest(record.outcomes) !==
            (record.mode === "stream" ? reference.stream : reference.whole)
          )
            throw new Error(`Outcome mismatch: ${record.fixture.id}/${record.mode}`);
        } else {
          if (
            last === undefined ||
            last.ok ||
            last.failure.kind !== (record.ending === "cancel" ? "aborted" : "source-failed")
          )
            throw new Error("Stopped source reported success");
          if (
            record.ending === "failure" &&
            (last.failure.kind !== "source-failed" || last.failure.cause !== record.sourceError)
          )
            throw new Error("SDK failure cause was lost");
          const prefix = streamReference(record.parts).at(-1);
          if (prefix === undefined || !prefix.ok || last.failure.recovered === undefined)
            throw new Error("Stopped stream lost recovery");
          const recovered =
            record.ending === "cancel"
              ? stoppedReference(record.parts)
              : {
                  value: prefix.value,
                  complete: prefix.complete,
                  ...(prefix.complete ? {} : { cut: prefix.cut }),
                };
          if (canonicalDigest(last.failure.recovered) !== canonicalDigest(recovered))
            throw new Error(
              `Stopped stream prefix differs: ${record.ending}, deltas=${record.parts.length}; ${inspect({ actual: last.failure.recovered, expected: recovered }, { depth: 8, maxStringLength: 100 })}`,
            );
        }
      }
      if (samplers.size > 0 || timer !== undefined)
        throw new Error("HTTP observation retained active jobs or its timer");
      return Response.json({
        verified: records.size,
        peakActiveJobs,
        observerPid: process.pid,
        host: captureHostContext(),
      });
    }
    if (url.pathname !== "/job") return new Response("Not found", { status: 404 });
    if (records.has(id)) throw new Error(`Duplicate request ${id}`);
    const mode = HTTP_MODES.find((value) => value === url.searchParams.get("mode"));
    const ending = HTTP_ENDINGS.find((value) => value === url.searchParams.get("ending"));
    const fixture = fixtures.find((value) => value.id === url.searchParams.get("case"));
    const control = url.searchParams.get("case");
    if (
      mode === undefined ||
      ending === undefined ||
      (fixture === undefined && control !== "idle" && control !== "blocking")
    )
      throw new Error("Invalid HTTP workload");
    const stop = new AbortController();
    const abort = () => {
      stop.abort("client-disconnected");
    };
    request.signal.addEventListener("abort", abort, { once: true });
    let bodyClosed = false;
    let complete!: (record: Captured) => void;
    let fail!: (error: unknown) => void;
    const captured = new Promise<Captured>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    // A failed request stays observable at /settled; it must not bypass source and listener cleanup.
    void captured.catch(() => undefined);
    records.set(id, captured);
    const body = new ReadableStream<Uint8Array>({
      start(writer) {
        const run = async () => {
          // Phase labels locate progress, not the native or JavaScript frame responsible for a gap.
          let phase = "sdk";
          let previousPhase = phase;
          let previous = performance.now();
          const start = previous;
          let maxGapMs = 0,
            samples = 0;
          let previousCpu = gapCpu ? process.cpuUsage() : undefined;
          let worst: Captured["worst"];
          const sample = (
            now = performance.now(),
            cpu = gapCpu ? process.cpuUsage() : undefined,
          ) => {
            const gap = now - previous;
            if (gap > maxGapMs) {
              maxGapMs = gap;
              worst = {
                from: previous - start,
                to: now - start,
                // Concurrent jobs can share one delayed timer reading; these are not independent stalls.
                observedAtMs: now,
                before: previousPhase,
                after: phase,
                ...(cpu === undefined || previousCpu === undefined
                  ? {}
                  : {
                      cpuMs: (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000,
                    }),
              };
            }
            previous = now;
            previousCpu = cpu;
            previousPhase = phase;
            samples++;
          };
          const releaseSampler = observe(sample);
          const record: Captured = {
            fixture,
            mode,
            ending,
            parts: [],
            outcomes: [],
            sourceClosed: false,
            parserClosed: false,
            elapsedMs: 0,
            maxGapMs: 0,
            samples: 0,
            aborted: false,
            worst: undefined,
          };
          let progress = false;
          const notify = () => {
            if (!progress && !bodyClosed) {
              writer.enqueue(encoder.encode("progress\n"));
              progress = true;
            }
          };
          try {
            if (fixture === undefined) {
              phase = control ?? "control";
              if (control === "blocking") {
                const until = performance.now() + 48;
                while (performance.now() < until) {
                  /* Deliberate positive control. */
                }
              } else
                for (let turn = 0; turn < 4; turn++) {
                  // eslint-disable-next-line no-await-in-loop -- Each control turn must reach the host queue.
                  await yieldHost();
                }
              record.sourceClosed = record.parserClosed = true;
            } else if (mode === "stream") {
              const source = async function* () {
                try {
                  const stream = await client.chat.completions.create(
                    {
                      model: fixture.id,
                      stream: true,
                      messages: [{ role: "user", content: "Return the tool arguments." }],
                    },
                    {
                      signal: stop.signal,
                      headers: { "x-replay-ending": ending, "x-replay-id": id },
                    },
                  );
                  try {
                    for await (const event of stream) {
                      const part = event.choices[0]?.delta.tool_calls?.[0]?.function?.arguments;
                      if (part === undefined) continue;
                      record.parts.push(part);
                      if (ending !== "cancel") notify();
                      phase = "parseStream";
                      yield part;
                      phase = "sdk";
                      // The producer holds after this batch; cancel while the real SDK read is pending.
                      if (
                        ending === "cancel" &&
                        record.parts.length === Math.min(MODEL_DELTA_BATCH, fixture.parts.length)
                      )
                        notify();
                    }
                  } finally {
                    stream.controller.abort();
                  }
                } catch (error) {
                  record.sourceError = error;
                  throw error;
                } finally {
                  record.sourceClosed = true;
                }
              };
              const stream = parseStream(source(), { signal: stop.signal });
              let closed: Awaited<ReturnType<typeof stream.close>>;
              try {
                for await (const outcome of stream) record.outcomes.push(outcome);
              } finally {
                closed = await stream.close();
                record.parserClosed = closed.ok;
              }
              if (!closed.ok) throw new Error("Parser cleanup failed", { cause: closed.failure });
            } else {
              try {
                const reply = client.chat.completions.create(
                  {
                    model: fixture.id,
                    messages: [{ role: "user", content: "Return the tool arguments." }],
                  },
                  { signal: stop.signal },
                );
                let args: string;
                if (cooperativeResponse) {
                  phase = "parseEnvelope";
                  args = await readModelArguments(await reply.asResponse(), stop.signal);
                } else {
                  const call = (await reply).choices[0]?.message.tool_calls?.[0];
                  if (call?.type !== "function")
                    throw new Error("Replay did not return function arguments");
                  args = call.function.arguments;
                }
                record.parts.push(args);
                phase = "parseAsync";
                notify();
                record.outcomes.push(
                  await parseAsync(args, {
                    execution: auto,
                    ...(mode === "cooperative" ? { execution: cooperative } : {}),
                    signal: stop.signal,
                  }),
                );
                record.parserClosed = true;
              } finally {
                record.sourceClosed = true;
              }
            }
            sample();
            record.elapsedMs = previous - start;
            record.maxGapMs = maxGapMs;
            record.samples = samples;
            record.worst = worst;
            record.aborted = stop.signal.aborted;
            complete(record);
          } catch (error) {
            fail(error);
          } finally {
            releaseSampler();
            request.signal.removeEventListener("abort", abort);
            if (!bodyClosed) {
              writer.close();
              bodyClosed = true;
            }
          }
        };
        void run();
      },
      cancel() {
        bodyClosed = true;
        abort();
      },
    });
    return new Response(body, { headers: { "content-type": "text/plain" } });
  });
  console.log(
    JSON.stringify({ ready: server.url, runtime: runtime(), host: captureHostContext() }),
  );
  process.stdin.resume();
  process.stdin.once("end", () => {
    void server.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}
