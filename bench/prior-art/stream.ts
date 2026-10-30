// SPDX-License-Identifier: Apache-2.0

/**
 * The streaming workload: one document arriving in chunks while a renderer reads the value being
 * built once per frame, for this package and every streaming rival, each through its OWN API.
 *
 *     bun bench/prior-art/stream.ts            # human-readable correctness and rates
 *     EMIT=json bun bench/prior-art/stream.ts  # the runner protocol `baseline.ts` reads
 *
 * A runner in the `baseline.ts` matrix, not a report of its own: it prints the same {@link Emitted}
 * shape, so the forks, the ratio against this runtime's `JSON.parse` and the rounding are shared.
 *
 * **Pull-per-frame, with the frame count fixed per document.** A renderer reads at its display
 * rate, not once per network chunk, so the frame count is independent of the chunk size: chunk size
 * then prices feeding, and the frames price reading. A rival with no incremental state (the
 * re-parse family: the OpenAI and Anthropic vendored parsers, the AI SDK, `partial-json`) pays one
 * full parse of the buffer per frame, which is exactly what its users pay; a rival with no partial
 * view at all (`@streamparser/json` delivers only finished values at the root) reads nothing per
 * frame, and its cell prices feeding alone.
 *
 * **Correctness first.** Every session's final value is compared with the one-shot oracle by a
 * strict structural walk — not a serialiser, which drops `undefined` and prints `NaN` as `null`,
 * the very differences a wrong answer would show. A subject whose final value differs gets no rate
 * for that cell, so stopping early can never read as speed.
 */

import { readFileSync } from "node:fs";

import { JSONParser } from "@streamparser/json";
import { partialParse as anthropicPartialParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser";
import { parsePartialJson as aiParsePartialJson } from "ai";
import { parse as jsonriverParse } from "jsonriver";
import { partialParse as openaiPartialParse } from "openai/_vendor/partial-json-parser/parser";
import { ALL, parse as partialJsonParse } from "partial-json";

// Keep the emitted-JS extension for Deno's direct module loader.
import { createStreamParser, parse as ours, sharedView } from "../../dist/index.js";
import { estimate, estimateAsync } from "../estimator.ts";
import type { Emitted } from "./speed-docs.ts";
import { sameValue } from "./same-value.ts";

/** Frames read per document, whatever its size or chunking: one second of a 60 Hz renderer. */
const FRAMES = 60;

/** Chunk sizes in UTF-16 units: a token-sized delta, a small network read, a large one. */
const CHUNK_SIZES = [16, 256, 4096] as const;

/** Rows of the shared clean payload per document; the largest repeats the payload. */
const SIZES = [
  { label: "4k", rows: 48 },
  { label: "34k", rows: 400 },
  { label: "1m", rows: 12_000 },
] as const;

/** One streaming session's input: the chunks and, per chunk, whether a frame reads after it. */
type Session = { readonly chunks: readonly string[]; readonly frameAfter: readonly boolean[] };

const session = (text: string, chunk: number): Session => {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunk) chunks.push(text.slice(i, i + chunk));
  const n = chunks.length;
  // Frame f falls after the chunk where the cumulative share of FRAMES first passes f; with fewer
  // chunks than frames every chunk ends a frame.
  const frameAfter = chunks.map(
    (_, i) => Math.floor(((i + 1) * FRAMES) / n) > Math.floor((i * FRAMES) / n),
  );
  return { chunks, frameAfter };
};

/** Defeats dead-code elimination of a frame read without costing a traversal. */
let sink = 0;
const touch = (v: unknown): void => {
  if (v !== undefined) sink++;
};

/** A subject returns the final value of one whole session, or throws. */
type Subject = {
  readonly name: string;
  readonly run: (s: Session) => unknown;
  readonly async?: false;
};
type AsyncSubject = {
  readonly name: string;
  readonly run: (s: Session) => Promise<unknown>;
  readonly async: true;
};

/** Re-parse family: accumulate text, run the whole-buffer parser per frame and once at the end. */
const reparse = (name: string, fn: (text: string) => unknown): Subject => ({
  name,
  run: ({ chunks, frameAfter }) => {
    let text = "";
    for (let i = 0; i < chunks.length; i++) {
      text += chunks[i];
      if (frameAfter[i]) touch(fn(text));
    }
    return fn(text);
  },
});

const SUBJECTS: readonly (Subject | AsyncSubject)[] = [
  {
    name: "partial-json-repair",
    run: ({ chunks, frameAfter }) => {
      const stream = createStreamParser({ view: sharedView });
      let final: unknown;
      for (let i = 0; i < chunks.length; i++) {
        for (const r of stream.feed(chunks[i] ?? "")) {
          if (!r.ok) throw new Error(r.failure.kind);
          final = r.value;
        }
        if (frameAfter[i]) {
          const snap = stream.snapshot();
          if (snap.ok) touch(snap.value?.value);
        }
      }
      for (const r of stream.end()) {
        if (!r.ok) throw new Error(r.failure.kind);
        final = r.value;
      }
      return final;
    },
  },
  {
    // Its only API is an async iterator over an async chunk source; each yield is the value so far,
    // mutated in place, so the frame read is the latest yield.
    name: "jsonriver",
    async: true,
    run: async ({ chunks, frameAfter }) => {
      let pulled = 0;
      // A plain async iterable rather than an async generator, so the source adds no awaits of its
      // own: the hops measured are the ones jsonriver itself requires.
      const source: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const c = chunks[pulled];
            if (c === undefined) return Promise.resolve({ done: true, value: undefined });
            pulled++;
            return Promise.resolve({ done: false, value: c });
          },
        }),
      };
      let latest: unknown;
      let read = 0;
      for await (const v of jsonriverParse(source)) {
        latest = v;
        // Read once for every frame boundary among the chunks handed out since the last yield.
        for (; read < pulled; read++) if (frameAfter[read]) touch(latest);
      }
      return latest;
    },
  },
  {
    // Delivers finished values only; with `paths: ["$"]` that is the root, once. No partial root.
    name: "@streamparser/json",
    run: ({ chunks, frameAfter }) => {
      const parser = new JSONParser({ paths: ["$"] });
      let final: unknown;
      parser.onValue = ({ value }) => {
        final = value;
      };
      for (let i = 0; i < chunks.length; i++) {
        parser.write(chunks[i] ?? "");
        if (frameAfter[i]) touch(final);
      }
      // With no `separator` it ends itself after the first document, and `end()` on an ended
      // parser throws; calling it only on an open parser keeps a truncated stream an error.
      if (!parser.isEnded) parser.end();
      return final;
    },
  },
  {
    name: "ai parsePartialJson",
    async: true,
    run: async ({ chunks, frameAfter }) => {
      let text = "";
      for (let i = 0; i < chunks.length; i++) {
        text += chunks[i];
        // Sequential by nature: each frame parses the buffer as it stood at that frame.
        // oxlint-disable-next-line eslint/no-await-in-loop
        if (frameAfter[i]) touch((await aiParsePartialJson(text)).value);
      }
      const done = await aiParsePartialJson(text);
      if (done.state === "failed-parse") throw new Error("failed-parse");
      return done.value;
    },
  },
  reparse("openai partialParse", (t) => openaiPartialParse(t) as unknown),
  reparse("anthropic partialParse", (t) => anthropicPartialParse(t)),
  reparse("partial-json", (t) => partialJsonParse(t, ALL)),
];

type Doc = { readonly label: string; readonly text: string; readonly want: unknown };

/** The documents, built from the shared clean case so the rows keep one owner. */
const documents = (clean: string): Doc[] => {
  const payload = JSON.parse(clean) as unknown[];
  return SIZES.map(({ label, rows }) => {
    const value = Array.from({ length: rows }, (_, i) => payload[i % payload.length]);
    const text = JSON.stringify(value);
    return { label, text, want: JSON.parse(text) as unknown };
  });
};

const attempt = async (subject: Subject | AsyncSubject, s: Session): Promise<unknown> => {
  try {
    return { ok: true, value: subject.async ? await subject.run(s) : subject.run(s) };
  } catch (error) {
    return { ok: false, error };
  }
};

const runtime = (): string => {
  const deno = (globalThis as { Deno?: { version: { deno: string } } }).Deno;
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return deno
    ? `deno ${deno.version.deno}`
    : bun
      ? `bun ${bun.version}`
      : `node ${process.versions.node}`;
};

/** The case documents arrive on stdin from `baseline.ts`, or are read from `compare.ts`'s owner. */
const cleanCase = (): string => {
  const input = readFileSync(0, "utf8");
  const cases = JSON.parse(input) as { clean?: unknown };
  if (typeof cases.clean !== "string") throw new Error("stdin carries no clean case");
  return cases.clean;
};

const main = async (): Promise<void> => {
  const clean = cleanCase();
  const docs = documents(clean);
  // The oracle is checked against this package's own one-shot parse once, so a document the
  // oracle and the package disagree on cannot silently become the reference.
  for (const d of docs) {
    const r = ours(d.text);
    if (!r.ok || !sameValue(r.value, d.want)) throw new Error(`oracle disagrees on ${d.label}`);
  }
  const rates: Record<string, Record<string, number>> = {
    "JSON.parse": {
      clean:
        clean.length /
        1024 /
        1024 /
        (estimate(() => {
          JSON.parse(clean);
        }) /
          1e9),
    },
  };
  const rejected: string[] = [];
  for (const subject of SUBJECTS) {
    const cells: Record<string, number> = {};
    for (const d of docs)
      for (const c of CHUNK_SIZES) {
        const cell = `stream-${d.label}-c${c}`;
        const s = session(d.text, c);
        // Cells run one after another on purpose: concurrent timings would contend for the CPU.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const got = (await attempt(subject, s)) as {
          ok: boolean;
          value?: unknown;
          error?: unknown;
        };
        if (!got.ok || !sameValue(got.value, d.want)) {
          rejected.push(
            `${subject.name} ${cell}: ${got.ok ? "final value differs from oracle" : String(got.error)}`,
          );
          continue;
        }
        const ns = subject.async
          ? // oxlint-disable-next-line eslint/no-await-in-loop
            await estimateAsync(() => subject.run(s))
          : estimate(() => {
              subject.run(s);
            });
        cells[cell] = d.text.length / 1024 / 1024 / (ns / 1e9);
      }
    rates[subject.name] = cells;
  }
  if (process.env["EMIT"] === "json") {
    const emitted: Emitted = { runtime: runtime(), rates };
    console.log(JSON.stringify(emitted));
    return;
  }
  console.log(`${runtime()} · ${FRAMES} frames per document · sink ${sink}`);
  for (const [name, cells] of Object.entries(rates))
    for (const [cell, rate] of Object.entries(cells))
      console.log(`${name}\t${cell}\t${rate.toFixed(1)} MB/s (single process, no error bar)`);
  for (const line of rejected) console.log(`rejected ${line}`);
};

await main();
