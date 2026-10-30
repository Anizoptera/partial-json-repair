// SPDX-License-Identifier: Apache-2.0

import { isExactNumber } from "./exact-number";
import { defineOwn } from "./tree";

type Frame =
  | { kind: "array"; source: unknown[]; target: unknown[]; at: number }
  | {
      kind: "object";
      source: Record<string, unknown>;
      target: Record<string, unknown>;
      keys: Generator<string>;
    };

function* keysOf(source: object): Generator<string> {
  // Yield even inherited keys so ignoring them cannot hide an unbounded loop between checkpoints.
  for (const key in source) yield key;
}

const frameOf = (source: object): Frame =>
  Array.isArray(source)
    ? { kind: "array", source: source as unknown[], target: [], at: 0 }
    : {
        kind: "object",
        source: source as Record<string, unknown>,
        target:
          Object.getPrototypeOf(source) === null
            ? (Object.create(null) as Record<string, unknown>)
            : {},
        keys: keysOf(source),
      };

export function* selectionCopy(
  root: unknown,
  units: number,
): Generator<void, { value: unknown; spent: number }, number> {
  // Overlapping mutable selections need independent containers. Bulk shallow copies cannot
  // yield within a wide container; this path visits members incrementally only for bounded calls.
  // Exact numbers are immutable leaves, so retaining their identity preserves the existing clone.
  if (typeof root !== "object" || root === null || isExactNumber(root))
    return { value: root, spent: 0 };
  const first = frameOf(root);
  const pending = [first];
  let left = units;
  let spent = 0;
  while (pending.length > 0) {
    if (left === 0) {
      // The selection drain supplies its remaining budget on each resume, so small copies
      // share one quantum rather than multiplying it by the number of selected containers.
      left = yield;
      spent = 0;
    }
    left--;
    spent++;
    const frame = pending[pending.length - 1] as Frame;
    let key: string | undefined;
    let value: unknown;
    if (frame.kind === "array") {
      if (frame.at === frame.source.length) {
        pending.pop();
        continue;
      }
      value = frame.source[frame.at++];
    } else {
      const next = frame.keys.next();
      if (next.done === true) {
        pending.pop();
        continue;
      }
      key = next.value;
      if (!Object.hasOwn(frame.source, key)) continue;
      value = frame.source[key];
    }
    if (typeof value === "object" && value !== null && !isExactNumber(value)) {
      const child = frameOf(value);
      value = child.target;
      pending.push(child);
    }
    if (frame.kind === "array") frame.target.push(value);
    else defineOwn(frame.target, key as string, value);
  }
  return { value: first.target, spent };
}
