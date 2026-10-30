import { readFile } from "node:fs/promises";
import path from "node:path";
import { readReleaseInputs, RELEASE_DIRECTORY, RELEASE_REPOSITORY } from "./release-inputs";
import { requirePublicationContext } from "./release-publish";
import { verifyPublishedPackage } from "./registry-integrity";
import { releaseVersion } from "./release-history";

type Release = { readonly id: number; readonly draft: boolean; readonly body: string };

function release(value: unknown): Release {
  // A retry must tell a public release from a draft and compare its notes before touching it.
  if (value === null || typeof value !== "object")
    throw new Error("GitHub release is not an object.");
  const data = value as Record<string, unknown>;
  if (
    typeof data.id !== "number" ||
    !Number.isSafeInteger(data.id) ||
    typeof data.draft !== "boolean" ||
    (data.body !== null && typeof data.body !== "string")
  )
    throw new Error("GitHub returned an incomplete release.");
  return { id: data.id, draft: data.draft, body: data.body ?? "" };
}

function github(route: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.GH_TOKEN;
  if (token === undefined || token.length === 0)
    throw new Error("GH_TOKEN is required for release finalization.");
  const url = `https://api.github.com/repos/${RELEASE_REPOSITORY}${route}`;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
}

function checked(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`GitHub release operation failed: HTTP ${response.status}.`);
  return response.json();
}

async function findRelease(tag: string): Promise<Release | undefined> {
  const response = await github(`/releases/tags/${encodeURIComponent(tag)}`);
  if (response.status !== 404) return release(await checked(response));
  // The tag endpoint omits drafts; inspect them before creating one on a retry.
  const signal = AbortSignal.timeout(20_000);
  /* oxlint-disable no-await-in-loop -- each response determines whether another page is needed */
  for (let page = 1; ; page++) {
    signal.throwIfAborted();
    const values: unknown = await checked(
      await github(`/releases?per_page=100&page=${page}`, { signal }),
    );
    if (!Array.isArray(values)) throw new Error("GitHub release list is not an array.");
    const found: unknown = values.find(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === "object" &&
        "tag_name" in entry &&
        entry.tag_name === tag,
    );
    if (found !== undefined) return release(found);
    if (values.length < 100) return undefined;
  }
  /* oxlint-enable no-await-in-loop */
}

export async function finalizeRelease(tag: string, version: string): Promise<void> {
  requirePublicationContext(process.env, tag);
  const inputs = await readReleaseInputs(tag, version);
  // The release page must never announce a version npm does not serve with the reviewed bytes. The
  // tarballs are not attached: npm hosts them and its provenance already binds them to this commit.
  await Promise.all(
    inputs.packages.map((item) =>
      verifyPublishedPackage(item, path.join(RELEASE_DIRECTORY, item.file)),
    ),
  );
  const notes = await readFile(path.join(RELEASE_DIRECTORY, "notes.md"), "utf8");
  const current = await findRelease(tag);
  if (current === undefined) {
    await checked(
      await github("/releases", {
        method: "POST",
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: inputs.commit,
          name: tag,
          body: notes,
          prerelease: version.includes("-"),
        }),
      }),
    );
    return;
  }
  if (current.body !== notes && !current.draft)
    throw new Error("Never replace different notes on an already public release.");
  // A retry finds its own release; a draft (made by hand) is published with the reviewed notes.
  if (current.draft || current.body !== notes)
    await checked(
      await github(`/releases/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: notes, draft: false }),
      }),
    );
}

if (import.meta.main) {
  const [tag = process.env.GITHUB_REF_NAME, ...extra] = process.argv.slice(2);
  if (tag === undefined || extra.length > 0)
    throw new Error("Usage: bun scripts/release-finalize.ts <tag>");
  await finalizeRelease(tag, releaseVersion(tag));
}
