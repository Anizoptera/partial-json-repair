// SPDX-License-Identifier: Apache-2.0

// Observe the real request: correct parsing alone cannot detect unrelated transferred storage.
export const workerInputProbe = (module: string, coreModule: string): string => `
  import { Buffer } from "node:buffer";
  import { Worker as ThreadWorker } from "node:worker_threads";
  import { runInNewContext } from "node:vm";
  import { parseAsync, worker, cooperative } from ${JSON.stringify(module)};
  import { parse } from ${JSON.stringify(coreModule)};
  const bytes = new TextEncoder().encode('{"a":1}');
  const inputs = [
    ["empty", new Uint8Array(new ArrayBuffer(4 * 1024 * 1024), 4096, 0)],
    ["whole", new Uint8Array(bytes)],
    ["cross-realm", runInNewContext("new Uint8Array(7)")],
    ["slice", new Uint8Array(new ArrayBuffer(4 * 1024 * 1024), 4096, bytes.length)],
    ["pooled", Buffer.allocUnsafe(64).subarray(7, 7 + bytes.length)],
    ["shared", new Uint8Array(new SharedArrayBuffer(4 * 1024 * 1024), 4096, bytes.length)],
    ["shadowed", new Uint8Array(new ArrayBuffer(4 * 1024 * 1024), 4096, bytes.length)],
  ];
  const sizeOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get;
  const prototypes = [ThreadWorker.prototype];
  if (typeof globalThis.Worker === "function" && !prototypes.includes(globalThis.Worker.prototype))
    prototypes.push(globalThis.Worker.prototype);
  const posts = prototypes.map(prototype => [prototype, prototype.postMessage]);
  let observed;
  for (const [prototype, post] of posts) prototype.postMessage = function(message, transfers) {
    if (ArrayBuffer.isView(message?.input))
      observed = { visible: message.input.byteLength, backing: message.input.buffer.byteLength };
    return post.call(this, message, transfers);
  };
  try {
    for (const [name, input] of inputs) {
      if (name === "cross-realm" && input instanceof Uint8Array)
        throw Error("cross-realm fixture must have a foreign prototype");
      const content = bytes.subarray(0, input.byteLength);
      input.set(content);
      const storage = input.buffer, capacity = storage.byteLength;
      if (name === "shadowed") {
        Object.defineProperty(input, "subarray", {value: () => new TextEncoder().encode('{"a":2}')});
        for (const key of ["length", "buffer", "byteOffset", "byteLength", "constructor"])
          Object.defineProperty(input, key, {get() {throw Error("caller " + key);}});
        const direct = parse(input);
        const scheduled = await parseAsync(input, {execution: cooperative});
        if (!direct.ok || direct.value.a !== 1 || !scheduled.ok || scheduled.value.a !== 1)
          throw Error(name + ": byte properties changed recovery by route");
      }
      observed = undefined;
      const result = await parseAsync(input, { execution: worker });
      if (content.length === 0 ? result.ok || result.failure.kind !== "no-json-found" :
          !result.ok || result.value.a !== 1)
        throw Error(name + ": worker changed recovered data");
      if (observed?.visible !== content.length || observed.backing !== content.length)
        throw Error(name + ": worker request retains unrelated backing storage");
      if (sizeOf.call(input) !== content.length || storage.byteLength !== capacity ||
          content.some((byte, index) => input[index] !== byte))
        throw Error(name + ": worker detached or changed caller bytes");
    }
    console.log("worker byte windows exclude unrelated storage and preserve caller ownership");
  } finally { for (const [prototype, post] of posts) prototype.postMessage = post; }
`;
