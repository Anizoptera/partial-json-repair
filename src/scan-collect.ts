// SPDX-License-Identifier: Apache-2.0

import type { ResolvedOptions } from "./options";
import { DEFAULT_OPTIONS } from "./options";
import { MODE_EDITS } from "./edit-log";
import type { ScanResult } from "./scan-contract";
import { createScanner } from "./scan";
import { collectScan } from "./scan-readers";

/**
 * The internal probe collects source edits; public value readers must not retain that wrapper.
 * Feed and end the shared scanner once rather than create another interpretation of the source.
 */
export function scan(text: string, opts: ResolvedOptions = DEFAULT_OPTIONS): ScanResult {
  const scanner = createScanner(opts, undefined, MODE_EDITS);
  scanner.supply(text);
  return collectScan(scanner, scanner.end());
}
