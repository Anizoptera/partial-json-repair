// SPDX-License-Identifier: Apache-2.0

import type { listen as listenHttp } from "../bench/prior-art/http-server";
import type { request as sendRequest } from "node:http";
import type { cooperative as cooperativeStrategy, parseAsync as recoverAsync } from "../src/async";
import type { parseStream as recoverStream, stringify as encodeJson } from "../src/index";

// Pass real implementations explicitly so the same contract can run against an installed package.
export async function httpRequestProbe(
  listen: typeof listenHttp,
  framework: Parameters<typeof listenHttp>[0],
  parseAsync: typeof recoverAsync,
  cooperative: typeof cooperativeStrategy,
  parseStream: typeof recoverStream,
  stringify: typeof encodeJson,
  send: typeof sendRequest,
): Promise<void> {
  const encoder = new TextEncoder();
  const interruptedEntered = Promise.withResolvers<void>();
  const interruptedClosed = Promise.withResolvers<Error | undefined>();
  let activeUpload: import("node:http").ClientRequest | undefined;
  // How each /stream request ended: undefined once its parser closed and released the request body.
  const streamEnds: Promise<Error | undefined>[] = [];
  const server = await listen(framework, async (request) => {
    if (new URL(request.url).pathname === "/whole") {
      // Keep encoding markers for core validation; request.json() also rejects damage and rounds digits.
      const bytes = new Uint8Array(await request.arrayBuffer());
      const result = await parseAsync(bytes, { execution: cooperative });
      if (!result.ok) return new Response(result.failure.kind, { status: 422 });
      const encoded = stringify(result.value);
      if (!encoded.ok) return new Response(encoded.failure.kind, { status: 422 });
      return new Response(encoded.value, { headers: { "content-type": "application/json" } });
    }
    const source = request.body;
    if (source === null) return new Response("Missing body", { status: 400 });
    if (new URL(request.url).pathname === "/interrupted") {
      // Omit the signal to exercise a broken native body, independently of host abort notification.
      const failed = parseStream(source);
      let failure: Error | undefined;
      try {
        const first = await failed.next();
        if (first.done === true || !first.value.ok)
          throw new Error(`${framework}: interrupted-upload control never delivered a value`);
        interruptedEntered.resolve();
        const last = await failed.next();
        if (
          last.done === true ||
          last.value.ok ||
          last.value.failure.kind !== "source-failed" ||
          last.value.failure.recovered?.complete !== false
        )
          throw new Error(
            `${framework}: interrupted upload hid its failure or unfinished recovery`,
          );
        const recovered = stringify(last.value.failure.recovered.value);
        if (!recovered.ok || recovered.value !== '{"kept":1,"text":"par"}')
          throw new Error(`${framework}: interrupted upload lost its available prefix`);
        if ((await failed.next()).done !== true)
          throw new Error(`${framework}: interrupted upload delivered after its terminal failure`);
      } catch (cause) {
        failure = new Error(`${framework}: interrupted-upload recovery failed`, { cause });
      } finally {
        interruptedEntered.resolve();
        const closed = await failed.close();
        if (!closed.ok || source.locked)
          failure = new Error(`${framework}: interrupted upload retained its reader`, {
            cause: failure,
          });
        interruptedClosed.resolve(failure);
      }
      return new Response(null, { status: 422 });
    }
    const call = parseStream(source, { signal: request.signal });
    const ended = Promise.withResolvers<Error | undefined>();
    streamEnds.push(ended.promise);
    const release = async (): Promise<void> => {
      const closed = await call.close();
      if (!closed.ok) throw new Error("HTTP parser cleanup failed", { cause: closed.failure });
      if (source.locked) throw new Error("HTTP parser left the request reader locked");
      ended.resolve(undefined);
    };
    const iterator = call[Symbol.asyncIterator]();
    // Pull owns demand. Eagerly pumping in start() would buffer an unbounded response.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done === true) {
              await release();
              controller.close();
            } else {
              const encoded = stringify(next.value);
              if (!encoded.ok)
                throw new Error("HTTP outcome cannot be serialized", { cause: encoded.failure });
              controller.enqueue(encoder.encode(encoded.value + "\n"));
            }
          } catch (cause) {
            await call.close();
            ended.resolve(new Error("HTTP response failed", { cause }));
            controller.error(cause);
          }
        },
        async cancel() {
          // The client left. The host may refuse to cancel a dead connection's body; close() reports
          // that as cleanup-failed rather than hiding it, and it is no leak. The oracle is that the
          // parser stopped and gave the body back.
          const closed = await call.close();
          const leaked = source.locked
            ? new Error("HTTP cancellation left the request reader locked")
            : !closed.ok && closed.failure.kind !== "cleanup-failed"
              ? new Error("HTTP cancellation did not stop the parser", { cause: closed.failure })
              : undefined;
          ended.resolve(leaked);
          if (leaked !== undefined) throw leaked;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  });
  try {
    const whole = await fetch(server.url + "/whole", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{label:"é",id:9007199254740993,}',
    });
    const text = await whole.text();
    if (whole.status !== 200 || text !== '{"label":"é","id":9007199254740993}')
      throw new Error(
        `${framework}: damaged JSON never reached whole-input recovery: ${whole.status} ${text}`,
      );

    const encodedBody = await fetch(server.url + "/whole", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xff, 0xfe, 0x7b, 0, 0x7d, 0]),
    });
    const encodingFailure = await encodedBody.text();
    if (encodedBody.status !== 422 || encodingFailure !== "unsupported-encoding")
      throw new Error(
        `${framework}: whole-body decoding hid the unsupported encoding: ${encodingFailure}`,
      );

    const received = Promise.withResolvers<import("node:http").IncomingMessage>();
    const upload = send(
      server.url + "/stream",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      received.resolve,
    );
    activeUpload = upload;
    upload.on("error", received.reject);
    // Keep EOF withheld until a real response arrives; buffering the request would deadlock here.
    for (const byte of encoder.encode('{label:"é"} ')) upload.write(new Uint8Array([byte]));
    const response = await received.promise;
    if (response.statusCode !== 200)
      throw new Error(
        `${framework}: damaged streaming request was rejected: ${response.statusCode}`,
      );
    const results = parseStream(response);
    let count = 0;
    try {
      for await (const item of results) {
        if (!item.ok)
          throw new Error(`${framework}: streamed response recovery failed`, {
            cause: item.failure,
          });
        const record = item.value;
        if (
          record === null ||
          typeof record !== "object" ||
          !("ok" in record) ||
          record.ok !== true ||
          !("complete" in record) ||
          record.complete !== true ||
          !("value" in record)
        )
          throw new Error(`${framework}: response lost its successful completion outcome`);
        const encoded = stringify(record.value);
        const expected = count++ === 0 ? '{"label":"é"}' : '{"id":9007199254740993}';
        if (!encoded.ok || encoded.value !== expected)
          throw new Error(`${framework}: streaming changed content, exact digits or outcomes`);
        if (count === 1) {
          const tail = encoder.encode("{id:9007199254740993,}");
          for (const byte of tail) upload.write(new Uint8Array([byte]));
          upload.end();
        }
      }
    } finally {
      upload.destroy();
      await results.close();
    }
    if (count !== 2) throw new Error(`${framework}: duplicated or missing streamed values`);
    const completed = await streamEnds[0];
    if (completed !== undefined) throw completed;

    // A client that leaves mid-response while its upload is still open: only the disconnect can
    // end this request, so the server must notice it, close the parser and release the body.
    const leaving = Promise.withResolvers<import("node:http").IncomingMessage>();
    const abandoned = send(server.url + "/stream", { method: "POST" }, leaving.resolve);
    activeUpload = abandoned;
    abandoned.on("error", () => undefined);
    abandoned.write("{first:1} {second:2} ");
    const partial = await leaving.promise;
    const firstLine = Promise.withResolvers<void>();
    partial.once("data", () => {
      firstLine.resolve();
    });
    await firstLine.promise;
    abandoned.destroy();
    const disconnected = await streamEnds[1];
    if (disconnected !== undefined)
      throw new Error(
        `${framework}: a client disconnect left parser work or the body reader open`,
        {
          cause: disconnected,
        },
      );
    const afterDisconnect = await fetch(server.url + "/whole", {
      method: "POST",
      body: "{next:1}",
    });
    if (afterDisconnect.status !== 200 || (await afterDisconnect.text()) !== '{"next":1}')
      throw new Error(`${framework}: a disconnected stream disrupted the next request`);
    const interrupted = send(server.url + "/interrupted", { method: "POST" });
    activeUpload = interrupted;
    // Socket failure is intentional; the server's typed outcome, not this event, is the oracle.
    interrupted.on("error", () => undefined);
    interrupted.write('{first:1} {kept:1,text:"par');
    await interruptedEntered.promise;
    const sibling = await fetch(server.url + "/whole", { method: "POST", body: "{sibling:1}" });
    if (sibling.status !== 200 || (await sibling.text()) !== '{"sibling":1}')
      throw new Error(`${framework}: an open upload blocked an independent request`);
    interrupted.destroy();
    const failedUpload = await interruptedClosed.promise;
    if (failedUpload !== undefined) throw failedUpload;
  } finally {
    activeUpload?.destroy();
    await server.close();
  }
}
