// SPDX-License-Identifier: Apache-2.0

import { builtinRepair } from "./builtin-route";
import { MODE_EDITS } from "./edit-log";
import { ownText } from "./lexical-window";
import { spliceSteps } from "./repair-splice";
import type { Outcome } from "./parser-outcome";
import type { Match, RepairFailure } from "./types";
import type { ReaderResult } from "./whole-reader";
import type { WholeInputSource } from "./whole-source";

// Only repair callers pass this projection. Keeping it out of the shared executor lets a
// parse-only consumer omit text-edit code without another scanner or per-call factory object.
export const repairOperation = /* @__PURE__ */ Object.freeze({
  kind: "repair" as const,
  mode: MODE_EDITS,
  builtin: builtinRepair,
  project: repairOutcomeSteps,
});

type ProjectionBudget = { remaining: number; readonly units: number };

/**
 * Repair source ranges without re-encoding the recovered value.
 *
 * A recovered NaN, infinity or undefined needs no check here: the scanner already rewrote its token
 * as `null` and reported `js-literal` at its path, so the spliced text is valid JSON that keeps the
 * key or array position. JSON grammar has no spelling for these values, and callers who want them
 * get the real values from `parse`. `null` costs one field's value; the only numeric alternative,
 * `1e999` for an infinity, makes Go's encoding/json and Rust's serde_json reject the whole payload.
 */
export function* repairOutcomeSteps(
  source: WholeInputSource,
  { outcome, scanner, valueIndex }: ReaderResult,
  units: number,
): Generator<void, Outcome<string | Match<string>[], RepairFailure>> {
  if (!outcome.ok) return outcome;
  const budget: ProjectionBudget = { remaining: units, units };
  const matches = scanner.selecting ? (outcome.value as Match[]) : undefined;
  // No selected output needs repaired text; keep the scanner's outcome and reports unchanged.
  if (matches?.length === 0) return outcome as Outcome<Match<string>[], RepairFailure>;
  if (matches === undefined) {
    const span = { ...scanner.spanAt(valueIndex), until: Infinity };
    if (scanner.edits.length === 0) {
      // The source can itself be a caller slice; a whole-range return does not prove ownership.
      const value = ownText(source.text.slice(span.start, span.end));
      return { ...outcome, value };
    }
    const text = yield* spliceSteps(source.text, scanner.edits, [span], units);
    return { ...outcome, value: ownText(text.slice(span.start, span.end)) };
  }
  const spans = scanner.build.editLog?.takeMatchRanges();
  if (spans === undefined || spans.length !== matches.length)
    throw new Error("repair matches are missing their decoded ranges");
  const text =
    scanner.edits.length === 0
      ? source.text
      : yield* spliceSteps(source.text, scanner.edits, spans, units);
  const repaired: Match<string>[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const span = spans[index];
    if (match === undefined || span === undefined)
      throw new Error("repair match projection is incomplete");
    repaired.push({
      // Spliced text still includes unselected neighbors; retain only this match's spelling.
      value: ownText(text.slice(span.start, span.end)),
      path: match.path,
      valueIndex: match.valueIndex,
      span: match.span,
      selectors: match.selectors,
    });
    if (--budget.remaining === 0 && index + 1 < matches.length) {
      budget.remaining = budget.units;
      yield;
    }
  }
  return {
    ...outcome,
    value: repaired,
  };
}

export const repairOutcome = (
  source: WholeInputSource,
  result: ReaderResult,
): Outcome<string | Match<string>[], RepairFailure> => {
  const operation = repairOutcomeSteps(source, result, Math.max(1, result.scanner.edits.length));
  while (true) {
    const step = operation.next();
    if (step.done === true) return step.value;
  }
};
