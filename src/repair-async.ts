// SPDX-License-Identifier: Apache-2.0

import type { Exact } from "./options";
import type { Input, ParserClosedFailure } from "./types";
import type { Overridden } from "./parser";
import type { AsyncParser } from "./async-configuration";
import type { AsyncOptions, AsyncOverrides, AsyncRepairOutcome } from "./async-operation";
import { runOne } from "./async-operation";
import { repairOperation } from "./repair-operation";
export function repairAsync<O extends AsyncOverrides, C extends AsyncOverrides | undefined>(
  input: Input,
  parser: AsyncParser<O>,
  options: Exact<C, AsyncOverrides>,
): Promise<AsyncRepairOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function repairAsync<
  O extends AsyncOverrides,
  C extends AsyncOverrides | undefined = undefined,
>(
  input: Input,
  parser: AsyncParser<O>,
  options?: Exact<NoInfer<C>, AsyncOverrides>,
): Promise<AsyncRepairOutcome<Overridden<O, C>, ParserClosedFailure>>;
export function repairAsync<O extends AsyncOptions>(
  input: Input,
  options: Exact<O, AsyncOptions>,
): Promise<AsyncRepairOutcome<O>>;
export async function repairAsync(
  input: Input,
  options: AsyncOptions | AsyncParser,
  overrides?: AsyncOverrides,
): Promise<unknown> {
  const outcome = await runOne(repairOperation, input, options, overrides);
  return outcome;
}
