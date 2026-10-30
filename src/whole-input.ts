// SPDX-License-Identifier: Apache-2.0

/** Share whole-input behavior without making a free call retain every configured-parser method. */
import type { ParserOptions, ResolvedOptions } from "./options";
import type { ParseOutcome, RepairOutcome, SpanOutcome } from "./parser";
import type { Input } from "./types";
import { MODE_NATIVE } from "./native-slice";
// Keep repair mode out of the shared builder exports so esbuild can leave it in the lazy worker chunk.
import { MODE_EDITS } from "./edit-log";
import { bareFailure, shaped } from "./parser-outcome";
import { builtinAllowed, builtinParse, builtinRepair } from "./builtin-route";
import { repairOutcome } from "./repair-operation";
import {
  readFirst,
  spanOutcome,
  createWholeInputReader,
  withLaterValues,
  withMore,
  WHOLE_INPUT_SLICE,
} from "./whole-reader";
import { wholeInputSource, wholeInputScanSource } from "./whole-source";

// Options have already been captured and validated by the caller; each verb owns only its input state.
export const parseResolved = <O extends ParserOptions>(
  opts: ResolvedOptions,
  input: Input,
): ParseOutcome<O> => {
  const source = builtinAllowed(opts)
    ? wholeInputSource(input)
    : wholeInputScanSource(input, WHOLE_INPUT_SLICE);
  if ("kind" in source) return shaped(bareFailure(source, opts.diagnostics));
  const built = source.text === undefined ? undefined : builtinParse(source, opts);
  if (built !== undefined) {
    source.releasePositions?.();
    return shaped(built);
  }
  const reader = createWholeInputReader(source, opts, MODE_NATIVE);
  try {
    const result = withLaterValues(input, readFirst(reader));
    return shaped(withMore(reader, result, result.outcome));
  } finally {
    // Release the reader's source too; native frames can outlive this returned recovery.
    reader.close();
  }
};

/** Locate the same candidate as parse without paying for text repair. */
// Keep recovery materialized: refusal and limits must return the available prefix. A span-only
// scan would need a second recovery pass on failure unless the scanner retained that value itself.
export const spanResolved = <O extends ParserOptions>(
  opts: ResolvedOptions,
  input: Input,
): SpanOutcome<O> => {
  const source = wholeInputScanSource(input, WHOLE_INPUT_SLICE);
  if ("kind" in source) return shaped(bareFailure(source, opts.diagnostics));
  const reader = createWholeInputReader(source, opts, MODE_NATIVE);
  try {
    const result = withLaterValues(input, readFirst(reader));
    return shaped(withMore(reader, result, spanOutcome(result)));
  } finally {
    // Span projection needs live positions; the returned spans do not own the scanner.
    reader.close();
  }
};

/** Preserve source spelling through the existing fast route or scanner edit projection. */
export const repairResolved = <O extends ParserOptions>(
  opts: ResolvedOptions,
  input: Input,
): RepairOutcome<O> => {
  const source = wholeInputSource(input);
  if ("kind" in source) return shaped(bareFailure(source, opts.diagnostics));
  const built = builtinRepair(source, opts);
  if (built !== undefined) {
    source.releasePositions?.();
    return shaped(built);
  }
  const reader = createWholeInputReader(source, opts, MODE_EDITS);
  try {
    // Repair projection reads the scanner's edits, so `withMore` continues the reader only after it.
    const result = withLaterValues(input, readFirst(reader));
    return shaped(withMore(reader, result, repairOutcome(source, result)));
  } finally {
    // Apply source edits before releasing input, including on typed refusal or stopped recovery.
    reader.close();
  }
};
