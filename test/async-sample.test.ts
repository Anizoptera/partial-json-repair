// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { sampleRoute } from "../bench/async-sample";
import { measureConcurrencySample } from "../bench/async-rss-sample";
import { canonicalDigest } from "../bench/async-oracle";
import { cooperative } from "../src/async";

it.each([1, 3])(
  "measures and verifies every call with an expired budget and concurrency %i",
  async (concurrency) => {
    const captured: unknown[] = [];
    let calls = 0;
    let verified = 0;
    const result = await sampleRoute(
      { id: "expired-budget", input: "", operation: "parse" },
      {
        boundary: "javascript",
        execution: cooperative,
        id: "expired-budget",
        implementation: "typescript",
        placement: "cooperative",
        run: () => Promise.resolve(++calls),
      },
      {
        capture(value) {
          captured.push(value);
        },
        finish(count) {
          verified = count;
        },
      },
      // A positive subnormal budget rounds the phase deadline to now, without a fake clock or wait.
      { budgetMilliseconds: Number.MIN_VALUE, cancelAfterFirst: false, concurrency },
    );
    expect(result.status).toBe("passed");
    if (result.status === "passed")
      expect(result.firstHostGapMilliseconds).toBeLessThanOrEqual(result.firstMilliseconds);
    expect(captured).toEqual(Array.from({ length: concurrency * 2 }, (_, index) => index + 1));
    expect(verified).toBe(captured.length);
  },
);

it("keeps native RSS sample gaps inside its invocation interval", async () => {
  const digest = canonicalDigest(1);
  const result = await measureConcurrencySample(
    { id: "rss-window", input: "", operation: "parse" },
    () => digest,
    1,
    () => Promise.resolve(1),
  );
  expect(result.longestHostGapMilliseconds).toBeLessThanOrEqual(result.fastestMilliseconds);
});

it("joins a live sibling before reporting a rejected concurrent call", async () => {
  const cause = new Error("one call failed");
  let calls = 0;
  let siblingSettled = false;
  let sibling: Promise<string> | undefined;
  const unexpectedVerification = () => {
    throw new Error("failed batch reached verification");
  };
  try {
    const failure = await sampleRoute(
      { id: "rejected-batch", input: "", operation: "parse" },
      {
        boundary: "javascript",
        execution: cooperative,
        id: "rejected-batch",
        implementation: "typescript",
        placement: "cooperative",
        run: () => {
          if (++calls === 1) return Promise.reject(cause);
          // A host task finishes after rejection microtasks; a fail-fast join returns too early.
          sibling = new Promise<string>((resolve) => {
            setTimeout(() => {
              siblingSettled = true;
              resolve("sibling");
            }, 0);
          });
          return sibling;
        },
      },
      { capture: unexpectedVerification, finish: unexpectedVerification },
      { budgetMilliseconds: Number.MIN_VALUE, cancelAfterFirst: false, concurrency: 2 },
    ).catch((error: unknown) => {
      expect(siblingSettled).toBe(true);
      return error;
    });
    expect(failure).toMatchObject({ errors: [cause] });
  } finally {
    await sibling;
  }
});
