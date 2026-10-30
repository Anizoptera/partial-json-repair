// SPDX-License-Identifier: Apache-2.0

/** Register only executable public async routes behind one benchmark invocation seam. */

import {
  auto,
  cooperative,
  findJsonSpanAsync,
  parseAsync,
  parseManyAsync,
  repairAsync,
  worker,
} from "partial-json-repair/async";
import type { AsyncExecution, AsyncOptions } from "partial-json-repair/async";
import type { AsyncWorkload } from "./async-cases";

export type AsyncRoute = {
  readonly boundary: "javascript" | "planner" | "worker-message";
  // `undefined` is the omitted strategy: the automatic planner.
  readonly execution: AsyncExecution;
  readonly id: string;
  readonly implementation: "automatic" | "typescript";
  readonly placement: "automatic" | "cooperative" | "host-worker";
  run(
    workload: AsyncWorkload,
    signal?: AbortSignal,
    afterDelivery?: () => void,
    afterRecovery?: () => void,
  ): Promise<unknown>;
};

const run = async (
  workload: AsyncWorkload,
  execution: AsyncExecution,
  signal?: AbortSignal,
  afterDelivery?: () => void,
): Promise<unknown> => {
  const options: AsyncOptions = {
    ...workload.options,
    execution,
    ...(signal === undefined ? {} : { signal }),
  };
  switch (workload.operation) {
    case "parse":
      return parseAsync(workload.input, options);
    case "parseMany": {
      const items = [];
      for await (const item of parseManyAsync(workload.input, options)) {
        items.push(item);
        afterDelivery?.();
      }
      return items;
    }
    case "repair":
      return repairAsync(workload.input, options);
    case "findJsonSpan":
      return findJsonSpanAsync(workload.input, options);
  }
  throw new Error(`unknown async benchmark operation: ${String(workload.operation)}`);
};

type RouteDefinition = Omit<AsyncRoute, "run">;
const definitions: readonly RouteDefinition[] = [
  {
    boundary: "planner",
    execution: auto,
    id: "automatic-planner",
    implementation: "automatic",
    placement: "automatic",
  },
  {
    boundary: "javascript",
    execution: cooperative,
    id: "typescript-cooperative",
    implementation: "typescript",
    placement: "cooperative",
  },
  {
    boundary: "worker-message",
    execution: worker,
    id: "typescript-worker",
    implementation: "typescript",
    placement: "host-worker",
  },
];

const route = (definition: RouteDefinition): AsyncRoute => ({
  ...definition,
  run: (workload, signal, afterDelivery) =>
    run(workload, definition.execution, signal, afterDelivery),
});

const routes = definitions.map((definition) => route(definition));
export const asyncRoutes: readonly AsyncRoute[] = routes;

// Opt in explicitly: ordinary matrices must not pay for an experimental preparation control.
if (typeof process !== "undefined" && process.argv?.includes("cooperative-worker-preparation")) {
  let prepared = false;
  routes.push({
    boundary: "javascript",
    execution: cooperative,
    id: "cooperative-worker-preparation",
    implementation: "typescript",
    placement: "cooperative",
    run: async (workload, signal, _afterDelivery, afterRecovery) => {
      if (prepared) return run(workload, cooperative, signal);
      prepared = true;
      // Await both to include the startup tail in host-gap observation; completion time is an
      // upper bound for an implementation that can deliver recovery before preparation finishes.
      const [startup, outcome] = await Promise.all([
        parseAsync("null", { execution: worker, ...(signal === undefined ? {} : { signal }) }),
        run(workload, cooperative, signal).then((value) => {
          // Observe usable recovery separately without abandoning startup or hiding its tail.
          afterRecovery?.();
          return value;
        }),
      ]);
      return startup.ok ? outcome : startup;
    },
  });
}
