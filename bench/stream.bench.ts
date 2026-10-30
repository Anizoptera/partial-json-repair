// SPDX-License-Identifier: Apache-2.0

/**
 * What the transport layer costs over the parser it wraps.
 *
 * Two questions, each with a live rival answer, and each changing something a reader is told:
 *
 * ① Is `parseStream` affordable against a hand-written `feed` loop? It adds an async generator, a
 *    source-shape probe and an abort check per chunk. If that costs little, the README can recommend
 *    it without qualification; if it costs a lot, the honest advice is to drive `feed` directly.
 * ② Is feeding BYTES worse than feeding text? The parser decodes and holds an undecoded tail so a
 *    multi-byte character split across chunks survives. A consumer holding `Uint8Array` could decode
 *    it themselves instead — and would corrupt exactly that character. The number decides whether
 *    "hand us the bytes" is advice or an apology.
 *
 * Never gates.
 */
import { bench, describe, run } from "./harness.ts";

import { initParser } from "../src/parser";
import { parseStream } from "../src/stream";
import { createStreamParser as configuredCreateStreamParser } from "../src/index";

const CHUNKS = 200;

/** Many top-level values, so `feed` returns something on most chunks rather than only at the end. */
const text = Array.from({ length: 400 }, (_, i) =>
  JSON.stringify({ id: i, name: `item-${i}`, tags: [`a${i}`, `b${i}`], ok: i % 2 === 0 }),
).join("\n");

const size = Math.ceil(text.length / CHUNKS);
const chunks = Array.from({ length: CHUNKS }, (_, i) => text.slice(i * size, (i + 1) * size));
const bytes = chunks.map((c) => new TextEncoder().encode(c));

const parser = initParser();

/**
 * The floor: no generator, no source probe, no abort check — just the parser. Everything else in
 * this file is measured against it, because a transport's cost is only meaningful as a difference.
 */
const direct = (source: readonly (string | Uint8Array)[]): number => {
  const sp = configuredCreateStreamParser(parser);
  let n = 0;
  for (const chunk of source) for (const item of sp.feed(chunk)) if (item.ok) n++;
  // `end()` yields only the tail the chunks left open, so the two counts add up to the stream.
  for (const item of sp.end()) if (item.ok) n++;
  return n;
};

describe(`${CHUNKS} chunks, ${(text.length / 1024).toFixed(0)} KB, 400 values`, () => {
  bench("feed loop, text (floor)", () => {
    direct(chunks);
  });

  bench("feed loop, bytes", () => {
    direct(bytes);
  });

  bench("parseStream, text", async () => {
    for await (const v of parseStream(chunks)) void v;
  });

  bench("parseStream, bytes", async () => {
    for await (const v of parseStream(bytes)) void v;
  });
});

await run();
