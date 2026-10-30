# Contributing

Keep changes focused on recovering damaged or streaming JSON. Schema inference, validation, and code
generation are separate products.

## Before changing code

Read the root `AGENTS.md`, then the nearest directory `AGENTS.md`. Read `HLD.md` and `docs/API.md`
before changing public behavior. HLD meaning changes require maintainer approval for the exact edit.

Use Bun for JavaScript and TypeScript tooling:

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs the complete local gate, then removes its build outputs even on failure; use
`bun run build` when you need to keep them. The pre-commit hook formats staged files and runs the
checks your changed files affect (`bun run check:commit`). Read command exit status directly; piping output can hide failure. Inspect staged and
unstaged diffs after the hook.

CI runs the same command as two parallel jobs, `bun run check --commit` and
`bun run check --complete-only`, which together run every step. Keep workflow steps reproducible
through `bun run check`.

## Behavior and tests

Treat a corpus mismatch as changed behavior, then decide whether code or the recorded contract is
wrong. Regenerate approved changes with `bun run corpus:record`; never edit generated observations.
Read `corpus/AGENTS.md` before changing fixtures or conformance.

Test public behavior rather than implementation details. Both Vitest and Bun test runners must pass
with equal counts. Read `test/AGENTS.md` before changing the suite.

## Performance claims

Read `bench/AGENTS.md` before measuring, comparing, or citing a number. Benchmark the exact artifact
and runtime a consumer uses. Record the command, workload, runtime, machine, and uncertainty with the
claim. Slowness alone never gates commits, review or release; record timing misses and unknown causes
as later optimization work. Correctness, resource ownership and working cancellation remain required.

## Documentation

Write for a reader who never saw the original discussion. Docs hold reasons and current
instructions; completed work goes in the changelog. In prose, name people by role ("the
maintainer"); keep legal names in attribution and contributor metadata.

## Commits

Use focused Conventional Commits with a brief body that states the behavior, reason, and relevant
evidence. Choose the type by user impact and mark breaking changes with `!`.

Before a workflow commit, run:

```bash
actions-up --yes
```

Report security issues through the private channel described in `SECURITY.md`.

## Releasing

Read [the release procedure](docs/RELEASE.md) before preparation. Creating the repository, changing
the version, tagging, pushing, publishing to npm and finalizing a release each need separate
maintainer permission.

1. For an authorized version change, set `<version>` in `package.json` (the
   `@anizoptera/recover-json` alias is generated from it at pack time), rename `## Unreleased` in `CHANGELOG.md` to `## <version> — <YYYY-MM-DD>`, and commit.
2. Build, run `bun run api:update` for intentional public API changes and review its declaration
   diff. `bun scripts/release.ts check v<version>` must pass. The first release has no published
   predecessor to compare against; later releases must be checked against theirs, including
   intentional breaking 0.x changes.
3. Prove the HLD runtime matrix, which CI does not run: update the runtime pins in
   `bench/prior-art/runtime-releases.json` to the current releases of the lines the HLD names, and
   commit them; then
   `bun run bench:baseline` must validate every registered route, with none unavailable; review
   moved cells and their uncertainty before accepting the candidate. Use `bench:baseline:routes`
   only to isolate route failures, since it repeats the normal comparison's route validation.
   `bun run platform:check` must report WebKit, Chromium and workerd proved.
4. On a clean committed tree, `bun scripts/release.ts preview v<version>` prepares both cleaned
   packages for local review without a tag. A preview's results never count as publication
   evidence.
5. After separate authorization, create an annotated `v<version>` tag and push it. The public
   repository's workflow checks the source, prepares and keeps both cleaned archives without npm
   credentials, publishes the main package before the alias, then verifies the registry bytes
   before creating the GitHub release. To repair a failure, use "Re-run failed jobs" on that run;
   never repack a partially published release. Follow `docs/RELEASE.md` for
   first-publication credentials and trusted-publisher setup.
