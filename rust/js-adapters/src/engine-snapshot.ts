// SPDX-License-Identifier: Apache-2.0

/** Restores JavaScript snapshot ownership after a native or WASM boundary returns owned values. */
import type { EngineSnapshotOutcome } from "./engine-wire";
import { isExactNumber } from "./exact-number";
import { copyContainer, defineOwn } from "./tree";
import type { ViewMode } from "./types";

const sharedValue = (next: unknown, previous: unknown): unknown => {
  if (Object.is(next, previous)) return previous;
  if (isExactNumber(next)) {
    return isExactNumber(previous) && next.text === previous.text ? previous : next;
  }
  if (typeof next !== "object" || next === null) return next;

  const prior =
    typeof previous === "object" &&
    previous !== null &&
    !isExactNumber(previous) &&
    Array.isArray(next) === Array.isArray(previous) &&
    Object.getPrototypeOf(next) === Object.getPrototypeOf(previous)
      ? previous
      : undefined;
  const keys = Object.keys(next);
  const priorKeys = prior === undefined ? [] : Object.keys(prior);
  let unchanged = prior !== undefined && keys.length === priorKeys.length;
  const copy = copyContainer(next);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as string;
    if (unchanged && key !== priorKeys[index]) unchanged = false;
    const priorValue = prior === undefined ? undefined : (prior as Record<string, unknown>)[key];
    const value = sharedValue((next as Record<string, unknown>)[key], priorValue);
    if (unchanged && value !== priorValue) unchanged = false;
    defineOwn(copy as Record<string, unknown>, key, value);
  }
  if (unchanged) return prior;
  return Object.freeze(copy);
};

/** Applies the configured owned-copy or stable frozen-branch contract to decoded snapshots. */
export const engineSnapshotView = (
  view: ViewMode,
): ((outcome: EngineSnapshotOutcome) => EngineSnapshotOutcome) => {
  let previous: unknown;
  let valueIndex: number | undefined;
  return (outcome) => {
    if (view === "owned") return outcome;
    if (outcome.ok) {
      if (outcome.value === undefined) return outcome;
      if (outcome.value.valueIndex !== valueIndex) previous = undefined;
      previous = sharedValue(outcome.value.value, previous);
      valueIndex = outcome.value.valueIndex;
      return { ok: true, value: { ...outcome.value, value: previous } };
    }
    if (outcome.failure.kind !== "limit-reached" && outcome.failure.kind !== "policy-refused")
      return outcome;
    if (outcome.failure.recovered === undefined) return outcome;
    previous = sharedValue(outcome.failure.recovered.value, previous);
    return {
      ok: false,
      failure: { ...outcome.failure, recovered: { value: previous } },
    };
  };
};
