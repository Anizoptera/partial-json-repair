// SPDX-License-Identifier: Apache-2.0

import type { Exact } from "./options";
import type { Input, ParserClosedFailure } from "./types";
import type { Overridden } from "./parser";
import type { AsyncParser } from "./async-configuration";
import type { AsyncOptions, AsyncOverrides, AsyncSpanOutcome } from "./async-operation";
import { runOne } from "./async-operation";
import { spanOperation } from "./span-operation";

// Keep span assembly reachable only from its public verb, using the same executor and plan.
export function findJsonSpanAsync<O extends AsyncOverrides, C extends AsyncOverrides | undefined>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): Promise<AsyncSpanOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function findJsonSpanAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): Promise<AsyncSpanOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function findJsonSpanAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): Promise<AsyncSpanOutcome<O>>;
export async function findJsonSpanAsync(
  input: Input,
  options: AsyncOptions | AsyncParser,
  overrides?: AsyncOverrides,
): Promise<unknown> {
  const outcome = await runOne(spanOperation, input, options, overrides);
  return outcome;
}
