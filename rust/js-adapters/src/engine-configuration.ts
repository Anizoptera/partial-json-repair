// SPDX-License-Identifier: Apache-2.0

/** Encode validated parser settings once for native and WASM parser handles. */

import type { ResolvedOptions } from "./options";

export type EngineStreamOptions =
  | { readonly summary?: boolean; readonly fragments?: false; readonly view?: "shared" | "owned" }
  | { readonly summary?: boolean; readonly fragments: true; readonly view?: never };

export const encodeEngineStreamOptions = (options?: EngineStreamOptions): number =>
  Number(options?.summary === true) |
  (Number(options?.fragments === true) << 1) |
  (Number(options?.view !== undefined) << 2);
import { RECOVERY_FLAG } from "./options";
import { ANY } from "./selector";
import type { SelectorPath } from "./selector";

const integer = (out: number[], value: number): void => {
  let remaining = BigInt(value);
  for (let i = 0; i < 8; i++) {
    out.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
};

const text = (out: number[], value: string): void => {
  out.push(7);
  integer(out, value.length);
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    out.push(unit & 0xff, unit >>> 8);
  }
};

const strings = (out: number[], values: readonly string[]): void => {
  integer(out, values.length);
  for (const value of values) text(out, value);
};

const names = (out: number[], values: readonly string[]): void => {
  integer(out, values.length);
  for (const value of values) {
    const bytes = new TextEncoder().encode(value);
    out.push(6);
    integer(out, bytes.length);
    out.push(...bytes);
  }
};

const paths = (out: number[], values: readonly SelectorPath[]): void => {
  integer(out, values.length);
  for (const path of values) {
    integer(out, path.length);
    for (const segment of path) {
      if (typeof segment === "string") {
        out.push(0);
        text(out, segment);
      } else if (typeof segment === "number") {
        out.push(1);
        integer(out, segment);
      } else out.push(segment === ANY ? 2 : 3);
    }
  }
};

export const encodeEngineConfiguration = (options: ResolvedOptions): Uint8Array => {
  const out: number[] = [
    1,
    options.diagnostics === false ? 0 : options.diagnostics === true ? 1 : 2,
    Number(options.locations) |
      (Number(options.nullPrototype) << 1) |
      (Number(options.exactNumbers) << 2) |
      (Number(options.objectOnly) << 3) |
      (Number(options.repairBroken) << 4) |
      (Number(options.occurrences) << 5),
    options.onDangerousKey === "keep" ? 0 : options.onDangerousKey === "drop" ? 1 : 2,
  ];
  for (const value of [
    options.maxDepth,
    options.maxErrors,
    options.maxDiagnostics,
    options.maxBuffer,
    options.maxScalar,
    options.maxRetained,
  ])
    integer(out, value);
  names(
    out,
    Object.keys(RECOVERY_FLAG).filter(
      (kind) => !options.recover[kind as keyof typeof options.recover],
    ),
  );
  strings(out, options.customDangerousKeys);
  strings(out, options.requiredKeys);
  paths(out, options.skip);
  out.push(options.select === undefined ? 0 : 1);
  if (options.select !== undefined) paths(out, options.select);
  return Uint8Array.from(out);
};
