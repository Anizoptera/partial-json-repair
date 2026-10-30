// SPDX-License-Identifier: Apache-2.0

import type { AsyncExecution, initAsyncParser, parseManyAsync } from "../src/async";

export const preIterationStops = ["task", "call", "both"] as const;

// Share the actual caller across source, packed servers and browsers; host setup must not replace
// a known cancellation, and equal-looking cloned reasons must not pass the identity check.
// Keep the body free of module bindings: host probes embed its compiled JavaScript directly.
export async function verifyPreIterationCancellation(
  createParser: typeof initAsyncParser,
  iterate: typeof parseManyAsync,
  first: (typeof preIterationStops)[number],
  execution: AsyncExecution,
): Promise<void> {
  const task = new AbortController();
  const call = new AbortController();
  const parser = createParser({ execution, signal: task.signal });
  const values = iterate("{}", parser, { signal: call.signal });
  const taskReason = { stopped: "task" };
  const callReason = { stopped: "call" };
  try {
    if (first !== "call") task.abort(taskReason);
    if (first !== "task") call.abort(callReason);
    for (const signal of [task.signal, call.signal])
      Object.defineProperty(signal, "addEventListener", {
        configurable: true,
        value() {
          throw new Error("Cancelled call tried to subscribe to a signal");
        },
      });
    const item = await values.next();
    const expected = first === "call" ? callReason : taskReason;
    if (
      item.done === true ||
      item.value.ok ||
      item.value.failure.kind !== "aborted" ||
      item.value.failure.reason !== expected ||
      // Before input starts, recovery, diagnostics and cleanup must add no payload to this result.
      Object.hasOwn(item.value, "diagnostics") ||
      Object.hasOwn(item.value.failure, "recovered") ||
      Object.hasOwn(item.value.failure, "cleanupFailure")
    )
      throw new Error("Cancelled lazy call did not preserve the original reason", { cause: item });
    if ((await values.next()).done !== true)
      throw new Error("Cancelled lazy call continued iteration");
  } finally {
    for (const signal of [task.signal, call.signal])
      Reflect.deleteProperty(signal, "addEventListener");
    try {
      await values.return();
    } finally {
      parser.close();
    }
  }
}
