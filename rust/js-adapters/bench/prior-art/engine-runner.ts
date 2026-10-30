// SPDX-License-Identifier: Apache-2.0

/** Measure a complete native or WASM call against the same runtime's parser and expected values. */

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { ANY, parse, parseMany } from "../../dist/index.js";
import { ANY as ENGINE_ANY } from "../../src/selector";
import type { EngineParseOutcome, EngineStreamItem } from "../../src/engine-wire";
import { estimate } from "../estimator.ts";
import { loadEngine } from "./engine-load";
import { ENGINE_MODES, engineModeOf } from "./engine-routes";

const [requestedMode, artifact] = process.argv.slice(2);
const mode = engineModeOf(requestedMode);
if (mode === undefined || artifact === undefined)
  throw new Error(`usage: engine-runner.ts ${ENGINE_MODES.join("|")} ARTIFACT`);

const documents = JSON.parse(readFileSync(0, "utf8")) as Record<string, string>;
const expected = (name: string, text: string): unknown => {
  if (name === "jsonl")
    return [...parseMany(text)].map((outcome) => {
      if (!outcome.ok) throw new Error(outcome.failure.kind);
      return outcome.value;
    });
  const outcome = parse(text);
  if (!outcome.ok) throw new Error(outcome.failure.kind);
  return outcome.value;
};

const loaded = await loadEngine(mode, artifact);
if (!loaded.ok) throw new Error(loaded.failure.reason);
const engine = loaded.value;
const run = (input: string): EngineParseOutcome => engine.parse(input);

const timed = (bytes: number, operation: () => void): number =>
  bytes / 1024 / 1024 / (estimate(operation) / 1e9);
const values = (outcomes: readonly EngineParseOutcome[]): unknown[] | undefined => {
  const recovered: unknown[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) return undefined;
    recovered.push(outcome.value);
  }
  return recovered;
};

const rates: Record<string, number> = {};
for (const [name, text] of Object.entries(documents)) {
  if (name === "jsonl") continue;
  const want = expected(name, text);
  const observed = run(text);
  if (!observed.ok || !isDeepStrictEqual(observed.value, want)) continue;
  rates[name] = timed(text.length, () => void run(text));
}

const jsonl = documents["jsonl"];
if (jsonl === undefined) throw new Error("engine cases have no JSONL document");
const batchWant = expected("jsonl", jsonl);
if (isDeepStrictEqual(values(engine.parseMany(jsonl)), batchWant))
  rates["batch"] = timed(jsonl.length, () => void engine.parseMany(jsonl));

const selectedOptions = { select: [[ENGINE_ANY, "id"]] } as const;
const selected = engine.configure(selectedOptions) as
  | { readonly ok: false }
  | { readonly ok: true; readonly value: { parse(input: string): EngineParseOutcome } };
const selectedWant = parse(documents["clean"] ?? "", { select: [[ANY, "id"]] });
if (selected.ok && selectedWant.ok) {
  const selectedRun = () => selected.value.parse(documents["clean"] ?? "");
  const observed = selectedRun();
  if (observed.ok && isDeepStrictEqual(observed.value, selectedWant.value))
    rates["selected"] = timed((documents["clean"] ?? "").length, () => void selectedRun());
}

const boundedInput = "123456789";
const bounded = engine.configure({ maxScalar: 8 }) as
  | { readonly ok: false }
  | { readonly ok: true; readonly value: { parse(input: string): EngineParseOutcome } };
if (bounded.ok) {
  const boundedRun = () => bounded.value.parse(boundedInput);
  const observed = boundedRun();
  if (!observed.ok && observed.failure.kind === "limit-reached")
    rates["bounded"] = timed(boundedInput.length, () => void boundedRun());
}

const chunks = Array.from({ length: Math.ceil(jsonl.length / 1024) }, (_, index) =>
  jsonl.slice(index * 1024, (index + 1) * 1024),
);
const streamRun = (candidate: typeof engine): readonly EngineStreamItem[] | undefined => {
  const built = candidate.createStream() as
    | { readonly ok: false }
    | {
        readonly ok: true;
        readonly value: {
          feed(input: string): readonly EngineStreamItem[];
          end(): readonly EngineStreamItem[];
          close(): unknown;
        };
      };
  if (!built.ok) return undefined;
  const outcomes = chunks.flatMap((chunk) => built.value.feed(chunk));
  outcomes.push(...built.value.end());
  built.value.close();
  return outcomes;
};
const streamOutcomes = (streamRun(engine) ?? []).filter(
  (item): item is EngineParseOutcome => "ok" in item,
);
if (isDeepStrictEqual(values(streamOutcomes), batchWant))
  rates["streaming"] = timed(jsonl.length, () => void streamRun(engine));

const clean = documents["clean"];
if (clean === undefined) throw new Error("engine cases have no clean document");
const reference = clean.length / 1024 / 1024 / (estimate(() => void JSON.parse(clean)) / 1e9);
const hosts = globalThis as {
  Bun?: { version: string };
  Deno?: { version: { deno: string } };
};
const runtime = (): string => {
  if (hosts.Deno !== undefined) return `deno ${hosts.Deno.version.deno}`;
  if (hosts.Bun !== undefined) return `bun ${hosts.Bun.version}`;
  return `node ${process.versions.node}`;
};
console.log(
  JSON.stringify({
    runtime: `${runtime()} ${mode}`,
    rates: { "JSON.parse": { clean: reference }, [`partial-json-repair/${mode}`]: rates },
  }),
);
