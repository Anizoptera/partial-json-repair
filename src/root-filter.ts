// SPDX-License-Identifier: Apache-2.0

import type { ResolvedOptions } from "./options";
import type { Scanner } from "./scan-contract";
import type { ParseFailure, Recovery } from "./types";

const filtersRoots = (options: ResolvedOptions): boolean =>
  options.objectOnly || options.requiredKeys.length > 0;

export const acceptsBuiltRoot = (value: unknown, options: ResolvedOptions): boolean =>
  !filtersRoots(options) ||
  (typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    options.requiredKeys.every((key) => Object.hasOwn(value, key)));

export const acceptsRoot = (
  scanner: Scanner,
  valueIndex: number,
  options: ResolvedOptions,
): boolean => {
  if (!filtersRoots(options)) return true;
  const info = scanner.rootInfoAt(valueIndex);
  return info?.object === true && info.missingRequired === 0;
};

export const noMatch = (options: ResolvedOptions, recovered?: Recovery): ParseFailure => ({
  kind: "no-match",
  expected: "object",
  requiredKeys: options.requiredKeys,
  ...(recovered === undefined ? {} : { recovered }),
});
