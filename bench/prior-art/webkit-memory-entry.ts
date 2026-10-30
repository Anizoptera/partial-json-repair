// SPDX-License-Identifier: Apache-2.0

import { PORTABLE_LIBS } from "./libs";
import { DOCS, records } from "./speed-docs";
import { sameValue } from "./same-value";
import { MEMORY_CALLS } from "./memory-method";

let parse: ((text: string) => unknown) | undefined;
let value: unknown;
let calls = 0;

// Keep the final value held through the OS sample; validate only after sampling, as on native hosts.
export const select = (name: string): boolean => {
  parse = PORTABLE_LIBS.find((library) => library.name === name)?.parse;
  if (parse === undefined) throw new Error(`Unknown memory subject: ${name}`);
  parse(records);
  calls = 0;
  return true;
};
export const advance = (count: number): boolean => {
  if (parse === undefined) throw new Error("Select a memory subject before parsing");
  for (let i = 0; i < count; i++) {
    const parsed = parse(records);
    if (++calls === MEMORY_CALLS) value = parsed;
  }
  return true;
};
export const validate = (expectedCalls: number): boolean =>
  calls === expectedCalls && sameValue(value, DOCS.clean.want);

export const control = (): boolean => {
  value = Array.from({ length: 500_000 }, (_, index) => ({ index, text: `control-${index}` }));
  return Array.isArray(value) && value.length === 500_000;
};
