import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { requireArchiveIdentity } from "../scripts/package-artifacts";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { packConsumer } from "../scripts/consumer-package";
import type { Packed } from "../scripts/consumer-package";

it("reads the supplied archive without a workspace build and refuses a missing archive", () => {
  // Retained bytes are the subject; workspace output must neither gate nor replace them.
  const work = mkdtempSync(join(tmpdir(), "pjr-retained-archive-"));
  const previous = process.env.PJR_CONSUMER_ARCHIVE;
  let packed: Packed | undefined;
  try {
    const archive = join(work, "retained.tgz");
    const source = join(work, "package");
    mkdirSync(source);
    writeFileSync(join(source, "package.json"), '{"name":"retained","version":"0.0.0"}');
    writeFileSync(join(source, "index.js"), "export const retained = true;\n");
    execFileSync("tar", ["-czf", archive, "-C", work, "package"]);
    process.env.PJR_CONSUMER_ARCHIVE = archive;
    packed = packConsumer(join(work, "unbuilt"), `${basename(work)}-consumer`);
    expect(packed.tarballPath).toBe(archive);
    expect(readFileSync(join(packed.consumer.installed, "index.js"), "utf8")).toBe(
      "export const retained = true;\n",
    );
    process.env.PJR_CONSUMER_ARCHIVE = join(work, "missing.tgz");
    expect(() => packConsumer(join(work, "unbuilt"), `${basename(work)}-missing`)).toThrow(
      "which does not exist",
    );
  } finally {
    if (previous === undefined) delete process.env.PJR_CONSUMER_ARCHIVE;
    else process.env.PJR_CONSUMER_ARCHIVE = previous;
    if (packed !== undefined) rmSync(packed.work, { recursive: true });
    rmSync(work, { recursive: true });
  }
});

it("rejects an archive substitution without changing the retained bytes", async () => {
  // Equal length and the same filename in another directory do not establish publication identity.
  const work = mkdtempSync(join(tmpdir(), "pjr-archive-identity-"));
  try {
    const expected = join(work, "reviewed.tgz");
    const actual = join(work, "upload.tgz");
    writeFileSync(expected, new Uint8Array([0, 1, 255]));
    writeFileSync(actual, readFileSync(expected));
    await expect(requireArchiveIdentity(actual, expected)).resolves.toBeUndefined();
    writeFileSync(actual, new Uint8Array([0, 2, 255]));
    await expect(requireArchiveIdentity(actual, expected)).rejects.toThrow(
      "differs from the reviewed bytes",
    );
    expect([...readFileSync(expected)]).toEqual([0, 1, 255]);
    await expect(requireArchiveIdentity(actual, join(work, "missing.tgz"))).rejects.toThrow();
  } finally {
    rmSync(work, { recursive: true });
  }
});
