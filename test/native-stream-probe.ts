// SPDX-License-Identifier: Apache-2.0

import type { parseStream as recoverStream, stringify as encodeJson } from "../src/index";
import type { StreamItem } from "../src/index";

// No enclosing runtime bindings: packed Node, browser and edge programs run this same contract.
export async function webStreamProbe(
  parseStream: typeof recoverStream,
  stringify: typeof encodeJson,
): Promise<void> {
  const bytes = new TextEncoder().encode('{label:"é"} {id:9007199254740993,}');
  let offset = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(offset, ++offset));
    },
  });
  const call = parseStream(source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()));
  const iterator = call[Symbol.asyncIterator]();
  // The constructor is the portable bridge when a host has no ReadableStream.from.
  const output = new ReadableStream<StreamItem<Record<never, never>>>(
    {
      async pull(controller) {
        const next = await iterator.next();
        if (next.done === true) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await iterator.return?.();
        const closed = await call.close();
        if (!closed.ok) throw new Error("Web output cleanup failed", { cause: closed.failure });
      },
    },
    { highWaterMark: 0 },
  );
  const values: string[] = [];
  try {
    await output.pipeTo(
      new WritableStream<StreamItem<Record<never, never>>>({
        write(item) {
          if (!item.ok)
            throw new Error("Web stream refused valid recovered input", { cause: item.failure });
          const encoded = stringify(item.value);
          if (!encoded.ok)
            throw new Error("Web result lost JSON encoding", { cause: encoded.failure });
          values.push(encoded.value);
        },
      }),
    );
    if (
      values.length !== 2 ||
      values[0] !== '{"label":"é"}' ||
      values[1] !== '{"id":9007199254740993}'
    )
      throw new Error("Web transform/output pipeline changed chunk decoding, digits or delivery");
  } finally {
    await call.close();
  }

  // Wait for the real second read before injecting an external source error into native machinery.
  let failSource: ReadableStreamDefaultController<string> | undefined;
  let pendingRead: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    pendingRead = resolve;
  });
  let pulls = 0;
  const broken = new ReadableStream<string>(
    {
      start(controller) {
        failSource = controller;
      },
      pull(controller) {
        if (++pulls === 1) controller.enqueue('{kept:1,text:"par');
        else pendingRead?.();
      },
    },
    { highWaterMark: 0 },
  );
  const failed = parseStream(broken);
  const cause = new Error("native read failed");
  try {
    const outcome = failed.next();
    await pending;
    if (failSource === undefined) throw new Error("Native source was not acquired");
    failSource.error(cause);
    const next = await outcome;
    if (
      next.done === true ||
      next.value.ok ||
      next.value.failure.kind !== "source-failed" ||
      next.value.failure.cause !== cause ||
      next.value.failure.recovered?.complete !== false
    )
      throw new Error("Native stream source failure was thrown, hidden or completed");
    const recovered = stringify(next.value.failure.recovered.value);
    if (!recovered.ok || recovered.value !== '{"kept":1,"text":"par"}')
      throw new Error("Native source failure lost available recovery");
  } finally {
    await failed.close();
  }

  let cancelled = false;
  const cancelSource = new ReadableStream<string>(
    {
      pull(controller) {
        controller.enqueue("{next:1} ");
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const stopped = parseStream(cancelSource);
  try {
    const first = await stopped.next();
    if (first.done === true || !first.value.ok)
      throw new Error("Cancellation control never delivered a value");
    await stopped.return?.();
    const closed = await stopped.close();
    if (!closed.ok || !cancelled || cancelSource.locked)
      throw new Error("Leaving native Web input retained its producer or reader lock");
  } finally {
    await stopped.close();
  }
}

export const nativeStreamProbe = (): string => `
  import { Duplex, Readable, Writable } from "node:stream";
  import { pipeline } from "node:stream/promises";
  import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { parseStream, stringify } from "partial-json-repair";
  await (${webStreamProbe.toString()})(parseStream, stringify);
  const bytes = new TextEncoder().encode('{label:"é"} {id:9007199254740993,}');
  for (const bridge of [false, true]) {
    const input = Readable.from(Array.from(bytes, unit => Uint8Array.of(unit)), { objectMode: false, highWaterMark: 1 });
    const source = bridge ? Readable.fromWeb(Readable.toWeb(input)) : input;
    const call = parseStream(source);
    const values = [];
    try {
      await pipeline(Readable.from(call), new Writable({ objectMode: true, highWaterMark: 1,
        write(item, _encoding, done) {
          if (!item.ok) return done(new Error("Node stream recovery failed", { cause: item.failure }));
          const encoded = stringify(item.value);
          if (!encoded.ok) return done(new Error("Node stream encoding failed"));
          values.push(encoded.value); done();
        },
      }));
      if (values.length !== 2 || values[0] !== '{"label":"é"}' || values[1] !== '{"id":9007199254740993}')
        throw new Error("Node/Web bridge changed byte decoding, exact digits or delivery: bridge=" + bridge + "; values=" + JSON.stringify(values));
    } finally { await call.close(); input.destroy(); source.destroy(); }
  }
  // Exercise the documented Duplex.from bridge with native pipeline error propagation.
  let released = false;
  async function* chunks() { try { while (true) yield '{next:1} '; } finally { released = true; } }
  const input = Readable.from(chunks(), { highWaterMark: 1 });
  let call;
  const transform = Duplex.from(source => { call = parseStream(source); return call; });
  const cause = new Error("consumer stopped");
  try {
    try { await pipeline(input, transform, new Writable({ objectMode: true,
      write(item, _encoding, done) { done(item.ok ? cause : new Error("Node cancellation control failed")); },
    })); throw new Error("Node pipeline swallowed the consumer failure"); }
    catch (error) { if (error !== cause) throw error; }
    if (!call) throw new Error("Duplex bridge never acquired the parser");
    const closed = await call.close();
    if (!closed.ok || !released || !input.destroyed) throw new Error("Node pipeline abandoned its producer");
  } finally { await call?.close(); input.destroy(); transform.destroy(); }

  const directory = mkdtempSync(join(tmpdir(), "pjr-native-file-"));
  try {
    const file = join(directory, "input.json");
    writeFileSync(file, bytes);
    // Node file streams and Bun's native Web file stream must consume the same bytes.
    const sources = [() => createReadStream(file, { highWaterMark: 1 }),
      ...(globalThis.Bun ? [() => Bun.file(file).stream()] : [])];
    for (const source of sources) {
      const call = parseStream(source()); const values = [];
      try { for await (const item of call) {
        if (!item.ok) throw new Error("Native file recovery failed", { cause: item.failure });
        const encoded = stringify(item.value);
        if (!encoded.ok) throw new Error("Native file lost exact serialization");
        values.push(encoded.value);
      }
      if (values.length !== 2 || values[0] !== '{"label":"é"}' || values[1] !== '{"id":9007199254740993}')
        throw new Error("Native file stream changed content or delivery");
      } finally { const closed = await call.close();
        if (!closed.ok) throw new Error("Native file cleanup failed", { cause: closed.failure }); }
    }
  } finally { rmSync(directory, { recursive: true }); }
`;
