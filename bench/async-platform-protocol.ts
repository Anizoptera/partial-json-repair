// SPDX-License-Identifier: Apache-2.0

import type { InstalledRuntime } from "./prior-art/runtimes";

export type AsyncRuntime = InstalledRuntime & { readonly observerEntry?: string };

// Shared by the CLI and its browser/edge program without loading either host implementation.
export const PLATFORM_HOSTS = ["webkit", "chromium", "workerd"] as const;
export type PlatformHost = (typeof PLATFORM_HOSTS)[number];
export const platformMembers = (requested?: string) =>
  PLATFORM_HOSTS.flatMap((host) =>
    (host === "workerd" ? ["plain"] : ["iso", "plain"]).map((isolation) => ({
      host,
      isolation,
      label: host === "workerd" ? host : host + " " + isolation,
    })),
  ).filter(
    (member) =>
      requested === undefined || requested === "platforms" || member.label.includes(requested),
  );

export type PlatformRequest = {
  readonly host: PlatformHost;
  readonly runtime: string;
  readonly workload: string;
  readonly route: string;
  readonly size: number;
  readonly budgetMilliseconds: number;
  readonly concurrency: number;
  readonly cancelAfterFirst: boolean;
  readonly oracleOnly: boolean;
  readonly expectedRecord?: string;
};
