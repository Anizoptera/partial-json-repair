// SPDX-License-Identifier: Apache-2.0

import type { ParserOptions, ResolvedOptions } from "./options";
import type { ManyOutcome } from "./parser";
import { bareFailure, shaped, takeOutcome } from "./parser-outcome";
import type { Outcome } from "./parser-outcome";
import type { Input, ParseFailure } from "./types";
import { createWholeInputReader, readMany, WHOLE_INPUT_SLICE } from "./whole-reader";
import { wholeInputScanSource } from "./whole-source";

type Item = Outcome<unknown, ParseFailure>;

// Reach shared iterator helpers without allocating or retaining a native generator instance.
const nativeIteratorPrototype = (): object =>
  Object.getPrototypeOf(Object.getPrototypeOf(outcomes.prototype as object)) as object;
const iteratorPrototype = /* @__PURE__ */ nativeIteratorPrototype();

function* outcomes(
  opts: ResolvedOptions,
  input: Input,
): Generator<Item, Item | undefined, unknown> {
  // Source access stays inside the first pull; closing an unstarted handle must read nothing.
  const source = wholeInputScanSource(input, WHOLE_INPUT_SLICE);
  if ("kind" in source) return bareFailure(source, opts.diagnostics);
  const reader = createWholeInputReader(source, opts);
  const steps = readMany(reader);
  try {
    // A terminal failure returns rather than yields, so ownership ends before public delivery.
    while (true) {
      const step = steps.next();
      if (step.done === true) return step.value;
      yield takeOutcome(step);
    }
  } finally {
    steps.return(undefined);
    reader.close();
  }
}

export const parseManyResolved = <O extends ParserOptions>(
  opts: ResolvedOptions,
  input: Input,
): IterableIterator<ManyOutcome<O>> => {
  // Finished generators can retain their arguments. Public handles retain only the live generator.
  let iterator: Generator<Item, Item | undefined, unknown> | undefined = outcomes(opts, input);
  const handle: IterableIterator<ManyOutcome<O>, unknown, unknown> = {
    next(value?: unknown) {
      if (iterator === undefined) return { value: undefined, done: true };
      try {
        const step = iterator.next(value);
        // Resolved options already shape each yielded outcome; reuse the native result record.
        if (step.done !== true) return step as IteratorYieldResult<ManyOutcome<O>>;
        iterator = undefined;
        return step.value === undefined ? step : { value: shaped(step.value), done: false };
      } catch (cause) {
        iterator = undefined;
        throw cause;
      }
    },
    return(value?: unknown) {
      try {
        // Private cleanup never yields; the caller's return value belongs to the public protocol.
        iterator?.return(undefined);
        return { value, done: true };
      } finally {
        iterator = undefined;
      }
    },
    throw(cause?: unknown) {
      try {
        // The private generator has cleanup but no catch; public throw always preserves a cause.
        iterator?.throw(cause);
        throw cause;
      } finally {
        iterator = undefined;
      }
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  // Keep native iterator helpers; this protocol handle has no native generator brand.
  Object.setPrototypeOf(handle, iteratorPrototype);
  return handle;
};
