// SPDX-License-Identifier: Apache-2.0

/**
 * Holds the two properties that decide whether an `AGENTS.md` REACHES the agent it was written for.
 *
 * Steering is the one artefact here with no reader that can complain. Code that fails to load
 * throws; a document that fails to load leaves an agent behaving exactly like one that read it and
 * disagreed. Both failures below are silent, permanent, and invisible in a diff — the same reason
 * `check-wiring.ts` exists for a hook Git never calls.
 *
 * 1. A `CLAUDE.md` symlink beside every `AGENTS.md`. Maintainer's ruling; the mechanism is that
 *    Claude Code reads only `CLAUDE.md` while the other agents read `AGENTS.md`, so a missing link
 *    drops that directory's whole steering for one vendor with nothing to report it. A symlink and
 *    not a copy, because two files diverge and then two agents follow different rules.
 *
 * 2. A byte ceiling, 32 KiB — the smallest context-file cap the maintainer named across the agents
 *    in use. What a given harness does past its own cap (refuse, truncate, drop) is NOT something
 *    this repository can observe, and that is the argument for staying under the number rather than
 *    for discovering the answer. The limit lives here and in no document: a number written into
 *    prose rots at the first edit, and two documents disagreeing about it is worse than neither
 *    stating it. The working target is far lower and stays prose — a target that fires is a nag.
 *
 * `git ls-files` rather than a directory walk: it enumerates exactly the files that can enter
 * history, so there is no skip list to rot as build and tool directories come and go, and no way to
 * wander into a dependency's own steering. `--others --exclude-standard` includes a file not yet
 * staged, so a new one is caught on the first `bun run check` instead of at the commit.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_BYTES = 32 * 1024;

const problems: string[] = [];
const steering = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: ROOT, encoding: "utf8" },
)
  .split("\0")
  .filter((p) => p === "AGENTS.md" || p.endsWith("/AGENTS.md"));

for (const path of steering) {
  const { size } = lstatSync(join(ROOT, path));
  if (size > MAX_BYTES) {
    problems.push(
      `${path}: ${size} bytes, over the ${MAX_BYTES} ceiling an agent may not read whole. Move a section into a document beside it and point at it from here.`,
    );
  }

  // `lstat`, never `stat`: through `stat` a copy and a symlink are indistinguishable, and a copy is
  // exactly what this rejects.
  const link = join(dirname(path), "CLAUDE.md");
  let target: string | undefined;
  try {
    target = lstatSync(join(ROOT, link)).isSymbolicLink()
      ? readlinkSync(join(ROOT, link))
      : undefined;
  } catch {
    target = undefined;
  }
  if (target !== "AGENTS.md") {
    problems.push(
      `${link}: must be a symlink to AGENTS.md (\`ln -s AGENTS.md ${link}\`) — Claude Code reads only that name, so without it every rule in ${path} is invisible to it.`,
    );
  }
}

// Same guard, same reason as `check-invariants.ts`: every assertion above is satisfied by a run that
// found nothing, so a broken enumeration prints a pass over files nobody looked at. The root file
// alone means the listing failed, not that the repository has one.
if (steering.length < 2) {
  problems.push(
    `git ls-files under ${ROOT} yielded ${steering.length} AGENTS.md — this check read nothing, so it proves nothing`,
  );
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(
  `steering: ${steering.length} AGENTS.md, each linked as CLAUDE.md, each under ${MAX_BYTES} bytes`,
);
