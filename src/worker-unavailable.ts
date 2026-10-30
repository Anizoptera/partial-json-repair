// SPDX-License-Identifier: Apache-2.0

/**
 * The worker strategy's typed failure, in its own leaf module: both the worker route and its lazy
 * receiver (`worker-executor`) build it, and taking it from `async-operation` would make the
 * receiver drag the planner into apps that keep the worker asset without calling any verb.
 */

import type { ExecutionUnavailableFailure } from "./async-operation";

export const unavailable = (
  reason: ExecutionUnavailableFailure["reason"],
): ExecutionUnavailableFailure => ({
  kind: "execution-unavailable",
  execution: "worker",
  reason,
  // The fix differs by cause: a host without workers needs another strategy, a failed load needs
  // the worker file deployed. Built here, not in a module-level table, because a module does no
  // work at import.
  message:
    reason === "unsupported"
      ? 'partial-json-repair: the `worker` strategy cannot run on this host, which has no `Worker` or `MessageChannel`. Pass `auto` or `cooperative` from "partial-json-repair/async" here instead.'
      : 'partial-json-repair: the background worker did not start or stopped answering, so nothing ran there. Check that your bundler or server deploys the package\'s worker file and that the host allows workers, or pass `auto` from "partial-json-repair/async" to run on this thread.',
});
