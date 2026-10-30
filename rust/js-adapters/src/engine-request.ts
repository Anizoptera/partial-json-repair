// SPDX-License-Identifier: Apache-2.0

/** Frame one operation and its source without transcoding JavaScript string units. */

import type { Input } from "./types";

export type EngineOperation = "parse" | "parseMany" | "repair" | "findJsonSpan";

const OPERATION_TAG: Readonly<Record<EngineOperation, number>> = Object.freeze({
  parse: 0,
  parseMany: 1,
  repair: 2,
  findJsonSpan: 3,
});

export const encodeEngineRequest = (
  input: Input,
  operation: EngineOperation = "parse",
): Uint8Array => encodeInput(input, [1, OPERATION_TAG[operation]]);

export const encodeEngineChunk = (input: Input, finalSlice = true): Uint8Array =>
  encodeInput(input, [1, Number(finalSlice)]);

const encodeInput = (input: Input, prefix: ArrayLike<number>): Uint8Array => {
  if (typeof input !== "string") {
    const request = new Uint8Array(input.byteLength + prefix.length + 1);
    request.set(prefix, 0);
    request[prefix.length] = 0;
    request.set(input, prefix.length + 1);
    return request;
  }
  const request = new Uint8Array(input.length * 2 + prefix.length + 1);
  request.set(prefix, 0);
  request[prefix.length] = 1;
  const view = new DataView(request.buffer);
  for (let i = 0; i < input.length; i++)
    view.setUint16(i * 2 + prefix.length + 1, input.charCodeAt(i), true);
  return request;
};
