// SPDX-License-Identifier: Apache-2.0

import type { Pending, SnapshotState } from "./scan-contract";
import type { ViewFeature } from "./types";
import { copyFrame, defineOwn } from "./tree";
import { createView, graftPending } from "./snapshot";

/**
 * Copies only the open path from the root to the container being filled; every finished branch is
 * already frozen by the builder and is shared. Private copies stay unfrozen because caller writes
 * cannot reach parser state through them.
 * O(depth + width of the open containers), not O(size):
 * each open container is copied shallowly, so a 100 000-item array still being filled costs 100 000
 * slot copies per call.
 */
const shareSpine = (
  spine: readonly object[],
  labels: readonly (string | number)[],
  pending: Pending | undefined,
): unknown => {
  // Only the root and current parent need to survive traversal; no array of copied ancestors.
  const root = copyFrame(spine[0] as object);
  let parent = root;
  for (let i = 1; i < spine.length; i++) {
    const copiedChild = copyFrame(spine[i] as object);
    // Stored labels relink copies without searching parents or confusing equal child values.
    const label = labels[i];
    // A refused member leaves its frame on the spine but absent from its parent. Relink only the
    // child the live tree actually contains, or a snapshot would resurrect rejected data.
    const live = spine[i];
    if (label === undefined) {
      parent = copiedChild;
      continue;
    }
    if (Array.isArray(parent)) {
      const index = label as number;
      if (parent[index] === live) parent[index] = copiedChild;
    } else {
      const key = label as string;
      // Own members on both sides: reading `__proto__` would answer with the prototype, and writing
      // it would REPLACE the copy's prototype instead of relinking a member. `defineOwn` is the one
      // insertion mechanism; the guard above is what keeps a refused member from being resurrected.
      if (Object.hasOwn(parent, key) && parent[key] === live) defineOwn(parent, key, copiedChild);
    }
    parent = copiedChild;
  }
  graftPending(parent, pending);
  return root;
};

const copyOpen = ({ spine, labels, pending }: SnapshotState): unknown =>
  shareSpine(spine, labels, pending);
const finished = (value: unknown): unknown => value;

// Closed branches are already frozen; sharing copies only the containers still being filled.
export const sharedView: ViewFeature<"shared"> = /* @__PURE__ */ createView(
  "shared",
  copyOpen,
  finished,
);
