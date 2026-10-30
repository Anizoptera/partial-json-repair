// SPDX-License-Identifier: Apache-2.0

import { createStreamParser, ownedView } from "../../dist/index";

export const streamReference = (parts: readonly string[]) => {
  // Synchronous parsing keeps the scheduler under measurement out of the expected result.
  const parser = createStreamParser();
  try {
    return [...parts.flatMap((part) => [...parser.feed(part)]), ...parser.end()];
  } finally {
    parser.close();
  }
};

export const stoppedReference = (parts: readonly string[]) => {
  // An abort keeps the live prefix; EOF repair is a different operation and can reinterpret its tail.
  const parser = createStreamParser({ view: ownedView });
  try {
    for (const part of parts)
      for (const outcome of parser.feed(part))
        if (!outcome.ok) throw new Error("Reference prefix failed");
    const snapshot = parser.snapshot();
    if (!snapshot.ok || snapshot.value === undefined)
      throw new Error("Reference prefix has no recovery");
    const { valueIndex: _valueIndex, ...recovered } = snapshot.value;
    return recovered;
  } finally {
    parser.close();
  }
};
