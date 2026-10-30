// SPDX-License-Identifier: Apache-2.0

// Cancel after posting a real request; a timer cannot identify that boundary.
export const workerRequestCancellationProbe = (module: string): string => `
import { Worker as RequestWorker } from "node:worker_threads";
import { parseAsync as requestParse, repairAsync as requestRepair, findJsonSpanAsync as requestSpan, parseManyAsync as requestMany, worker as requestWorker } from ${JSON.stringify(module)};
{
  const prototypes = [RequestWorker.prototype];
  if (typeof globalThis.Worker === "function" && !prototypes.includes(globalThis.Worker.prototype))
    prototypes.push(globalThis.Worker.prototype);
  const posts = prototypes.map(prototype => [prototype, prototype.postMessage]);
  const input = '{"a":1}';
  const firstByteItem = async (bytes, options) => {
    const sequence = requestMany(bytes, options);
    try {
      const first = await sequence.next();
      if (first.done || !(await sequence.next()).done)
        throw new Error("request cancellation lost or repeated terminal delivery");
      return first.value;
    } finally { await sequence.return(); }
  };
  for (const [execute, source] of [[requestParse, input], [requestRepair, input], [requestSpan, input], [firstByteItem, new TextEncoder().encode(input)]]) {
    const controller = new AbortController();
    const reason = { source: "posted-request" };
    let posted = false;
    for (const [prototype, post] of posts) prototype.postMessage = function(message, transfers) {
      const returned = post.call(this, message, transfers);
      if (message && Object.hasOwn(message, "input")) {
        posted = true;
        controller.abort(reason);
      }
      return returned;
    };
    try {
      const result = await execute(source, { execution: requestWorker, signal: controller.signal });
      if (!posted || result.ok || result.failure.kind !== "aborted" || result.failure.reason !== reason)
        throw new Error("posted worker request lost cancellation or caller reason");
    } finally { for (const [prototype, post] of posts) prototype.postMessage = post; }
  }
}
`;
