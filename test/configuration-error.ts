// SPDX-License-Identifier: Apache-2.0

/**
 * Invalid options throw a `TypeError` carrying the typed `ConfigurationFailure` as `cause` (HLD).
 * These read that cause back so a test asserts the reason, not just that something threw.
 */
import { expect } from "vitest";

/** The `cause` of the `TypeError` the call throws synchronously; fails the test if it returns. */
export const configurationCause = (call: () => unknown): unknown => {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as TypeError).cause;
  }
  throw new Error("expected the call to throw a configuration TypeError");
};

/** The `cause` of the `TypeError` the promise rejects with; fails the test if it settles. */
export const rejectedCause = async (pending: Promise<unknown>): Promise<unknown> => {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return (error as TypeError).cause;
  }
  throw new Error("expected the promise to reject with a configuration TypeError");
};
