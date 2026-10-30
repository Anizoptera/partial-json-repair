// SPDX-License-Identifier: Apache-2.0

/** Select the host's native loaders without importing host-only modules. */

import { loadBunFfi } from "./bun-ffi";
import { loadDenoFfi } from "./deno-ffi";
import { NativeEngine } from "./native-engine";
import type { NativeEngineLoadFailure } from "./native-engine";
import { loadNodeFfi } from "./node-ffi";
import { nativeTargetsForHost } from "./native-targets";
import type { Result } from "./types";

type HostProcess = {
  readonly arch?: string;
  readonly platform?: string;
  report?: { getReport(): { header?: { glibcVersionRuntime?: string } } };
  getBuiltinModule?(name: "url"): { fileURLToPath(url: URL): string };
};

type DenoHost = { readonly build?: { readonly os?: string; readonly arch?: string } };
type ClosableNativeCandidate = { close(): boolean };
type NativeHost = "node" | "bun" | "deno";
type NativeArtifact = { readonly specifier: string; readonly url: URL };
type NativeLoaders<Candidate extends ClosableNativeCandidate> = {
  readonly napi: (specifier: string) => Result<Candidate, NativeEngineLoadFailure>;
  readonly bunFfi: (url: URL) => Result<Candidate, NativeEngineLoadFailure>;
  readonly denoFfi: (url: URL) => Result<Candidate, NativeEngineLoadFailure>;
  readonly nodeFfi: (url: URL) => Result<Candidate, NativeEngineLoadFailure>;
};

export const selectNativeCandidate = <Candidate extends ClosableNativeCandidate>(
  candidates: readonly (() => Result<Candidate, NativeEngineLoadFailure>)[],
  accepts: (candidate: Candidate) => boolean,
): Result<Candidate, NativeEngineLoadFailure> => {
  let failure: NativeEngineLoadFailure = {
    kind: "native-engine-load-failed",
    reason: "load",
  };
  for (const load of candidates) {
    let loaded: Result<Candidate, NativeEngineLoadFailure>;
    try {
      loaded = load();
    } catch (cause) {
      failure = { kind: "native-engine-load-failed", reason: "load", cause };
      continue;
    }
    if (!loaded.ok) {
      failure = loaded.failure;
      continue;
    }
    if (accepts(loaded.value)) return loaded;
    if (!loaded.value.close())
      return {
        ok: false,
        failure: { kind: "native-engine-load-failed", reason: "teardown" },
      };
    failure = { kind: "native-engine-load-failed", reason: "initialization" };
  }
  return { ok: false, failure };
};

export const loadNativeFrom = <Candidate extends ClosableNativeCandidate>(
  host: NativeHost,
  artifacts: readonly NativeArtifact[],
  loaders: NativeLoaders<Candidate>,
  accepts: (candidate: Candidate) => boolean,
): Result<Candidate, NativeEngineLoadFailure> => {
  if (artifacts.length === 0)
    return {
      ok: false,
      failure: { kind: "native-engine-load-failed", reason: "target" },
    };
  const routeLoaders =
    host === "node"
      ? [
          (artifact: NativeArtifact) => loaders.napi(artifact.specifier),
          (artifact: NativeArtifact) => loaders.nodeFfi(artifact.url),
        ]
      : host === "bun"
        ? [
            (artifact: NativeArtifact) => loaders.bunFfi(artifact.url),
            (artifact: NativeArtifact) => loaders.napi(artifact.specifier),
          ]
        : [
            (artifact: NativeArtifact) => loaders.denoFfi(artifact.url),
            (artifact: NativeArtifact) => loaders.napi(artifact.specifier),
          ];
  return selectNativeCandidate(
    routeLoaders.flatMap((load) => artifacts.map((artifact) => () => load(artifact))),
    accepts,
  );
};

export const installedNativePackages = (
  process = (globalThis as { process?: HostProcess }).process,
  deno = Reflect.get(globalThis, "Deno") as DenoHost | undefined,
): readonly string[] => {
  const denoOs = deno?.build?.os;
  const denoArch = deno?.build?.arch;
  const platform = process?.platform ?? denoOs;
  const arch = process?.arch ?? denoArch;
  const glibc =
    platform === "linux" ? process?.report?.getReport().header?.glibcVersionRuntime : undefined;
  return nativeTargetsForHost(
    platform,
    arch,
    platform === "linux" && process?.report !== undefined
      ? glibc !== undefined && glibc !== ""
      : undefined,
  ).map((candidate) => candidate.package);
};

const artifacts = (): Result<readonly NativeArtifact[], NativeEngineLoadFailure> => {
  const packages = installedNativePackages();
  if (packages.length === 0)
    return {
      ok: false,
      failure: { kind: "native-engine-load-failed", reason: "target" },
    };
  let cause: unknown;
  const resolved: NativeArtifact[] = [];
  for (const specifier of packages) {
    try {
      resolved.push({ specifier, url: new URL(import.meta.resolve(specifier)) });
    } catch (failure) {
      cause = failure;
    }
  }
  if (resolved.length > 0) return { ok: true, value: resolved };
  return { ok: false, failure: { kind: "native-engine-load-failed", reason: "load", cause } };
};

const host = (): NativeHost =>
  "Deno" in globalThis ? "deno" : "Bun" in globalThis ? "bun" : "node";

const loaders: NativeLoaders<NativeEngine> = {
  napi: (specifier) => NativeEngine.load(specifier),
  bunFfi: (url) => loadBunFfi(url),
  denoFfi: (url) => loadDenoFfi(url),
  nodeFfi: (url) => {
    const process = (globalThis as { process?: HostProcess }).process;
    const urlModule = process?.getBuiltinModule?.("url");
    return urlModule === undefined
      ? { ok: false, failure: { kind: "native-engine-load-failed", reason: "load" } }
      : loadNodeFfi(urlModule.fileURLToPath(url));
  },
};

const load = (
  accepts: (engine: NativeEngine) => boolean,
  selectedLoaders: NativeLoaders<NativeEngine> = loaders,
) => {
  const resolved = artifacts();
  return resolved.ok ? loadNativeFrom(host(), resolved.value, selectedLoaders, accepts) : resolved;
};

export const loadNative = (): Result<NativeEngine, NativeEngineLoadFailure> => load(() => true);

/** Load the first native route that can run controlled work away from the host event loop. */
export const loadNativeBackground = (): Result<NativeEngine, NativeEngineLoadFailure> =>
  load((engine) => engine.supportsAsyncRoute());
