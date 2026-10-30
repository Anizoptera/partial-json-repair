import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { PackageArchive } from "./package-artifacts";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export interface RegistryArchive {
  readonly integrity: string;
  readonly tarball: string;
}

// Release inputs are small packages, not arbitrary bulk transfers. Bound decoded metadata and
// archives independently of Content-Length, which a server may omit or misreport.
function boundedBody(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit)
          throw new Error(`Registry input exceeds the ${limit}-byte release-tool bound.`);
        controller.enqueue(chunk);
      },
    }),
  );
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("npm metadata must be an object.");
  return value as Record<string, unknown>;
}

async function registryJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return undefined;
  if (!response.ok || response.body === null)
    throw new Error(`npm lookup failed: HTTP ${response.status}.`);
  return new Response(boundedBody(response.body, 16 * 1024 * 1024)).json();
}

function archiveMetadata(value: unknown, registry: string): RegistryArchive {
  const dist = metadataObject(metadataObject(value).dist);
  if (
    typeof dist.integrity !== "string" ||
    !dist.integrity.startsWith("sha512-") ||
    typeof dist.tarball !== "string"
  )
    throw new Error("npm metadata has no usable SHA-512 archive identity.");
  const url = new URL(dist.tarball);
  if (url.origin !== new URL(registry).origin)
    throw new Error("npm archive URL leaves the expected registry.");
  return { integrity: dist.integrity, tarball: url.href };
}

export async function registryHistory(
  name: string,
  registry = NPM_REGISTRY,
): Promise<ReadonlyMap<string, RegistryArchive>> {
  // Fetch the version index once: a missing selected version in existing history is not a first release.
  const metadata = await registryJson(`${registry}/${encodeURIComponent(name)}`);
  if (metadata === undefined) return new Map();
  const versions = metadataObject(metadataObject(metadata).versions);
  return new Map(
    Object.entries(versions).map(([version, value]) => [version, archiveMetadata(value, registry)]),
  );
}

export function historicalVersion(
  history: ReadonlyMap<string, RegistryArchive>,
  version: string,
  name: string,
): RegistryArchive | undefined {
  if (history.size === 0) return undefined;
  const archive = history.get(version);
  if (archive === undefined)
    throw new Error(
      `${name} has npm history but no ${version}; restore the matching release history, never substitute another baseline.`,
    );
  return archive;
}

export async function downloadRegistryArchive(
  archive: RegistryArchive,
  file: string,
): Promise<void> {
  const response = await fetch(archive.tarball, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok || response.body === null)
    throw new Error(`npm archive read failed: HTTP ${response.status}.`);
  const hash = createHash("sha512");
  const stream = boundedBody(response.body, 64 * 1024 * 1024).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  await Bun.write(file, new Response(stream));
  if (`sha512-${hash.digest("base64")}` !== archive.integrity)
    throw new Error("Downloaded historical npm archive differs from registry integrity.");
}

export async function unpackDeclarations(file: string, directory: string): Promise<string> {
  // Bound decompression before the archive parser allocates; only regular declaration files and
  // the manifest are written. Historical JavaScript and lifecycle scripts are never executed.
  const stream = Bun.file(file).stream().pipeThrough(new DecompressionStream("gzip"));
  const archive = new Bun.Archive(
    await new Response(boundedBody(stream, 128 * 1024 * 1024)).bytes(),
  );
  const files = await archive.files();
  for (const name of files.keys()) {
    if (
      !name.startsWith("package/") ||
      name.split("/").some((part) => part === ".." || part === "") ||
      name.includes("\\")
    )
      throw new Error(`Unexpected historical npm path: ${name}.`);
  }
  // Validate the complete inventory before starting writes; a rejected later path must not leave
  // unjoined writes racing the caller's cleanup.
  const writes = [...files].flatMap(([name, content]) =>
    name === "package/package.json" || name.endsWith(".d.ts")
      ? [Bun.write(`${directory}/${name}`, content)]
      : [],
  );
  const results = await Promise.allSettled(writes);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  if (!files.has("package/package.json"))
    throw new Error("Historical npm archive has no package manifest.");
  return `${directory}/package`;
}

export async function registryArchive(
  name: string,
  version: string,
): Promise<RegistryArchive | undefined> {
  // Outages must never be classified as unpublished versions, including during partial recovery.
  const metadata = await registryJson(
    `${NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  if (metadata === undefined) return undefined;
  const identity = metadataObject(metadata);
  if (identity.name !== name || identity.version !== version)
    throw new Error("npm returned a different package name or version.");
  return archiveMetadata(metadata, NPM_REGISTRY);
}

/**
 * npm serves a new version only after its metadata propagates, so a not-found right after our own
 * successful upload means "not yet", unlike everywhere else in the release. Without this wait the
 * main package's check fails before the alias uploads and a good release stops half-published. The
 * bound only stops a hang; a re-run of the publish job finishes the work, skipping matching versions.
 */
export async function awaitRegistryArchive(name: string, version: string): Promise<void> {
  const deadline = Date.now() + 240_000;
  /* oxlint-disable no-await-in-loop -- each probe decides whether to wait again */
  for (let delay = 2000; ; delay *= 2) {
    if ((await registryArchive(name, version)) !== undefined) return;
    if (Date.now() + delay > deadline)
      throw new Error(
        `${name}@${version} was uploaded but npm still does not serve it. Re-run the publish job: it skips versions npm already holds after matching their bytes.`,
      );
    await Bun.sleep(Math.min(delay, 30_000));
  }
  /* oxlint-enable no-await-in-loop */
}

export async function verifyPublishedPackage(
  item: PackageArchive,
  retainedFile: string,
): Promise<void> {
  const archive = await registryArchive(item.name, item.version);
  if (archive === undefined || archive.integrity !== item.integrity)
    throw new Error(
      `npm does not expose the reviewed ${item.name}@${item.version}; retain evidence and retry without replacing archives.`,
    );
  // Metadata alone cannot prove that the downloadable archive contains those bytes.
  const response = await fetch(archive.tarball, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok || response.body === null)
    throw new Error(`npm archive read failed: HTTP ${response.status}.`);
  const expectedSize = (await stat(retainedFile)).size;
  const hash = createHash("sha512");
  let size = 0;
  const chunks: AsyncIterable<Uint8Array> = response.body;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > expectedSize) throw new Error("npm archive exceeds the reviewed size.");
    hash.update(chunk);
  }
  if (size !== expectedSize || `sha512-${hash.digest("base64")}` !== item.integrity)
    throw new Error("Downloaded npm archive differs from the reviewed bytes.");
}
