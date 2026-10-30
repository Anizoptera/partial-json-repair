// SPDX-License-Identifier: Apache-2.0

/** Discover installed runtime binaries once so every benchmark names the same executable. */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import releases from "./runtime-releases.json";

export interface InstalledRuntime {
  readonly argv: readonly string[];
  readonly label: string;
}

const asdf = (...args: string[]): string =>
  spawnSync("asdf", args, { encoding: "utf8" }).stdout?.trim() ?? "";

type RuntimePaths = {
  readonly bun: Readonly<Record<string, string>> | undefined;
  readonly deno: Readonly<Record<string, string>> | undefined;
  readonly node: Readonly<Record<string, string>> | undefined;
};

const configuredPaths = (): RuntimePaths => {
  const value = process.env.PJR_RUNTIME_PATHS;
  if (value === undefined) return { bun: undefined, deno: undefined, node: undefined };
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("PJR_RUNTIME_PATHS must be a JSON object");
  const record = parsed as Readonly<Record<string, unknown>>;
  const result: Record<"bun" | "deno" | "node", Readonly<Record<string, string>> | undefined> = {
    bun: undefined,
    deno: undefined,
    node: undefined,
  };
  for (const [kind, paths] of Object.entries(record)) {
    if (kind !== "bun" && kind !== "deno" && kind !== "node")
      throw new Error(`PJR_RUNTIME_PATHS has unsupported runtime: ${kind}`);
    if (typeof paths !== "object" || paths === null || Array.isArray(paths))
      throw new Error(`PJR_RUNTIME_PATHS.${kind} must map releases to executable paths`);
    const entries = Object.entries(paths);
    if (entries.some((entry) => typeof entry[1] !== "string"))
      throw new Error(`PJR_RUNTIME_PATHS.${kind} paths must be strings`);
    result[kind] = Object.fromEntries(entries);
  }
  return result;
};

/** Report whether an explicit host-runtime map supplies this runtime family. */
export const runtimeIsConfigured = (kind: keyof RuntimePaths): boolean => {
  if (process.env.PJR_RUNTIME_PATHS === undefined) return true;
  const paths = configuredPaths()[kind];
  return paths !== undefined && Object.keys(paths).length > 0;
};

const reportedVersion = (bin: string, kind: "bun" | "deno" | "node"): string | undefined => {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const output = result.stdout.trim();
  if (kind === "deno") return /^deno (\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1];
  return /^v?(\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1];
};

const configuredRuntimes = (
  kind: "bun" | "deno" | "node",
  label: string,
  versions: readonly string[],
  required: readonly string[] = versions,
): InstalledRuntime[] | undefined => {
  const paths = configuredPaths()[kind];
  if (paths === undefined) return undefined;
  const unknown = Object.keys(paths).filter((version) => !versions.includes(version));
  if (unknown.length > 0)
    throw new Error(`PJR_RUNTIME_PATHS.${kind} has unsupported releases: ${unknown.join(", ")}`);
  return required.map((version) => {
    const bin = paths[version];
    if (bin === undefined)
      throw new Error(`PJR_RUNTIME_PATHS.${kind} requires ${required.join(", ")}`);
    const reported = reportedVersion(bin, kind);
    if (reported !== version)
      throw new Error(`${kind} ${version} is required at ${bin}, found ${String(reported)}`);
    return { argv: [bin], label: `${label} ${version}` };
  });
};

/**
 * Each installed version of one runtime, addressed by ABSOLUTE BINARY PATH.
 *
 * The path, not the environment: `ASDF_BUN_VERSION` selects a version only for a process that goes
 * through asdf's shim, and Bun prepends its OWN directory to a child's `PATH`, so a `bun` spawned
 * from a bun script silently resolves to the parent's binary. MEASURED: the pin was ignored and
 * bun 1.4.1 ran under the label `bun 1.3.14`, which `baseline.ts`'s runtime-label check caught.
 * Naming the file removes the shim, the `PATH` and the variable from the question at once.
 *
 * `asdf latest <tool> <prefix>` cannot pick one: measured, `asdf latest bun 1.3` answered `1.4.1`,
 * so a script trusting it installs the version it already had and reports success. The pinned
 * releases come from `runtime-releases.json` instead.
 */
export const installedAsdfRuntimes = (
  tool: string,
  bin: string,
  label: string,
): InstalledRuntime[] =>
  asdf("list", tool)
    .split("\n")
    .map((line) => line.replace("*", "").trim())
    .filter((line) => /^\d+\.\d+\.\d+$/u.test(line))
    .map((version) => ({
      argv: [join(asdf("where", tool, version), "bin", bin)],
      label: `${label} ${version}`,
    }));

const requiredAsdfRuntimes = (
  tool: string,
  bin: string,
  label: string,
  versions: readonly string[],
): InstalledRuntime[] => {
  const installed = new Map(
    installedAsdfRuntimes(tool, bin, label).map((runtime) => [
      runtime.label.slice(label.length + 1),
      runtime,
    ]),
  );
  const missing = versions.filter((version) => !installed.has(version));
  if (missing.length > 0) throw new Error(`${tool} requires ${missing.join(", ")}`);
  return versions.map((version) => {
    const runtime = installed.get(version);
    if (runtime === undefined) throw new Error(`${tool} lost required ${version}`);
    return runtime;
  });
};

// Filter declared labels before discovery; an absent unselected host must not block a narrow job.
const matchingVersions = (versions: readonly string[], label: string, requested?: string) =>
  requested === undefined
    ? versions
    : versions.filter((version) => `${label} ${version}`.includes(requested));

/** Resolve the exact release candidates selected from the HLD runtime channels. */
export const supportedBunRuntimes = (label = "bun", requested?: string): InstalledRuntime[] => {
  const required = matchingVersions(releases.bun, label, requested);
  if (required.length === 0) return [];
  return (
    configuredRuntimes("bun", label, releases.bun, required) ??
    requiredAsdfRuntimes("bun", "bun", label, required)
  );
};

/** Resolve the exact current, previous-LTS, and latest Node release candidates. */
export const supportedNodeRuntimes = (label = "node", requested?: string): InstalledRuntime[] => {
  const required = matchingVersions(releases.node, label, requested);
  if (required.length === 0) return [];
  return (
    configuredRuntimes("node", label, releases.node, required) ??
    requiredAsdfRuntimes("nodejs", "node", label, required)
  );
};

export const supportedDenoVersion: string = releases.deno;

/** Resolve the exact Deno release candidate from its reported semantic version. */
export const supportedDenoRuntime = (label = "deno"): InstalledRuntime => {
  const configured = configuredRuntimes("deno", label, [supportedDenoVersion]);
  if (configured !== undefined) {
    const runtime = configured[0];
    if (runtime === undefined) throw new Error("configured Deno runtime disappeared");
    return runtime;
  }
  const bin = Bun.which("deno");
  if (bin === null) throw new Error(`Deno ${supportedDenoVersion} is required`);
  const reported = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const version = /^deno (\d+\.\d+\.\d+)(?:\s|$)/u.exec(reported.stdout)?.[1];
  if (reported.status !== 0 || version !== supportedDenoVersion)
    throw new Error(`Deno ${supportedDenoVersion} is required, found ${String(version)}`);
  return { argv: [bin], label: `${label} ${version}` };
};
