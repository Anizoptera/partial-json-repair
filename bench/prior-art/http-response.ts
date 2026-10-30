// SPDX-License-Identifier: Apache-2.0

import { parseStream, select } from "../../dist/index";
import type { SelectFeature } from "../../dist/index";

// The fields are fixed; reuse their immutable selection across concurrent responses.
let fields: SelectFeature<false> | undefined;

export async function readModelArguments(response: Response, signal: AbortSignal): Promise<string> {
  // SDK body decoding is synchronous before arguments reach the parser; consume that envelope here.
  if (response.body === null) throw new Error("Model reply has no response body");
  fields ??= select([
    ["choices", 0, "message", "tool_calls", 0, "type"],
    ["choices", 0, "message", "tool_calls", 0, "function", "arguments"],
  ]);
  // Final fields matter: a later duplicate ancestor can discard earlier argument text.
  const stream = parseStream(response.body, { select: fields, signal });
  let callType: string | undefined;
  let args: string | undefined;
  let failure: { cause: unknown } | undefined;
  let closed: Awaited<ReturnType<typeof stream.close>>;
  try {
    for await (const outcome of stream) {
      if (!outcome.ok) throw new Error("Model response JSON failed", { cause: outcome.failure });
      if (!outcome.complete) throw new Error("Model reply ended inside a function field");
      const match = outcome.value;
      if (typeof match.value !== "string") throw new Error("Model function fields must be text");
      if (match.path[match.path.length - 1] === "type") callType = match.value;
      else args = match.value;
    }
  } catch (cause) {
    failure = { cause };
  } finally {
    closed = await stream.close();
  }
  if (!closed.ok)
    throw new AggregateError(
      failure === undefined ? [closed.failure] : [failure.cause, closed.failure],
      "Model response cleanup failed",
      failure,
    );
  if (failure !== undefined) throw failure.cause;
  if (callType !== "function" || args === undefined)
    throw new Error("Model reply must contain a function tool call with string arguments");
  return args;
}
