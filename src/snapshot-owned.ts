// SPDX-License-Identifier: Apache-2.0

import type { SnapshotState } from "./scan-contract";
import type { ViewFeature } from "./types";
import { cloneJson } from "./tree";
import { createView, graftPending } from "./snapshot";

const tipOf = (root: unknown, labels: readonly (string | number)[]): unknown => {
  let tip = root;
  for (let i = 1; i < labels.length; i++) {
    const label = labels[i];
    if (label === undefined) return undefined;
    if (Array.isArray(tip)) tip = tip[label as number];
    else if (typeof tip === "object" && tip !== null) {
      // Reads need their own guard: following a dropped dangerous key through the prototype would
      // graft pending text onto Object.prototype even though insertion correctly refused the key.
      if (!Object.hasOwn(tip, label)) return undefined;
      tip = (tip as Record<string, unknown>)[label as string];
    } else return undefined;
  }
  return tip;
};

const copyOpen = ({ spine, labels, pending }: SnapshotState): unknown => {
  const copy = cloneJson(spine[0]);
  graftPending(tipOf(copy, labels), pending);
  return copy;
};

// Full-tree copying belongs only to callers who request independent mutable snapshots.
export const ownedView: ViewFeature<"owned"> = /* @__PURE__ */ createView(
  "owned",
  copyOpen,
  cloneJson,
);
