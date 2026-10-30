# Publish the verified npm archives

Prepare cleaned archives without publication credentials, then publish only those verified bytes through `.github/workflows/release.yml`. Use `@anizoptera/publish-clean` for both `partial-json-repair` and its search alias; the core package has no runtime dependency on release tooling.

Local preparation does not authorize repository creation, version changes, tags, pushes, publication or GitHub release finalization. Each operation needs the maintainer's explicit permission. Keep the sibling UUID-slug repository read-only when comparing procedures.

## Preparation

Run the complete gate and the HLD runtime qualification before requesting release authorization. Keep the runtime evidence separate from registry credentials. Build before checking packages. The artifact validator must inspect the cleaned archive supplied by publish-clean, never repack inside that callback.

Retain source files for shipped source maps and the worker executor/receiver files for the documented worker build recipe. These are explicit publish-clean unreferenced-file exceptions because an ordinary import graph does not describe those consumers; the artifact and consumer-graph checks still validate their contents and wiring.

Bind retained release inputs to the annotated tag, commit, version, both package names and their archive digests. Use release-artifacts/npm-release only for an explicitly requested release or package review; never store audit logs or heap dumps there. Prepare both packages before uploading either. The alias pins the main package's exact version, so publish the main package first. Retain the original pair after any failure; a successful main upload does not turn a partial release into a completed one-package release.

Read the committed changelog section as consumer-facing release notes. Before a first publication there is no published predecessor; do not invent a compatibility baseline from unpublished commits. Keep Rust/native/WASM out of these artifacts and release notes.

## Public API, notes and versions

Generate the reviewed TypeScript API from shipped declarations with API Extractor. Include every typed public entry and the private declarations those entries require. Compile actual cleaned-package consumers under every supported TypeScript compiler; textual snapshots cannot prove usable types or working exports.

The first publication is `0.1.0` and has no published predecessor. That is the empty-history branch of the release machinery, not permission to omit machinery for subsequent releases. Review the API that will ship; do not impose compatibility with private commits or require deprecation and migration ceremonies for unpublished changes. Later 0.x releases may change their API intentionally; classify and explain their consumer effect without imposing 1.x stability.

Prepare historical comparisons now. Select the newest lower Git release and a distinct older release line when present; verify their npm archives against registry integrity. Compare actual prior and candidate declarations with old-caller witnesses under the supported compilers, and compare package metadata separately. Updating a local API snapshot must not erase those comparisons. Retain the selected history and its verified bytes across retries. No predecessor means an explicit empty comparison, not a fabricated baseline or a skipped future implementation.

A missing selected version in an existing package history, a registry failure or different bytes must stop preparation; never substitute a different baseline. Before classifying a change as breaking, verify the old-caller failure rather than changing notes to accommodate a faulty checker.

When the newest predecessor is a prerelease, also compare the latest distinct stable predecessor. Otherwise a break introduced in a prerelease can disappear from the next stable release's version check. Generate stable-release notes against the latest stable predecessor when one exists, and prerelease notes against the immediate predecessor; only that comparison belongs in consumer notes.

Keep committed changelog prose unchanged. Select its dated release section, check that Unreleased has no remaining notes, and read declared rename pairs with the same Markdown parser so fenced examples cannot impersonate headings. Append generated public declaration changes under Breaking changes, Added and Changed when a published predecessor exists; keep private inventories and duplicate older comparisons out of consumer notes. First-publication notes describe the package's capabilities without an invented API diff.

Require the main version, alias version, alias's exact dependency and release tag to agree. Publication versions must be valid SemVer and must not be development versions. Version changes, tag creation and publication remain separate authorized operations; Rust versioning and publication stay deferred.

For subsequent versions, classify the full consumer effect: fixes require patch, compatible additions minor, and incompatible changes major or minor before 1.0. A deliberate breaking 0.x release is allowed with the corresponding version and migration notes. Before the first publication retain the planned version. After publication, development versions advance to the required next version with a `-dev` suffix; development-version changes never create tags or publish anything.

## Publication and recovery

Run preparation in a job without npm credentials or OIDC write permission. Transfer the verified archives and retained inputs to the dependent publication job. Use public access, provenance and the Git tag's npm channel: stable versions use `latest`, prereleases use `next`.

If publish-clean repacks during upload, its validation callback must require byte identity with the retained archive before permitting publication. Reuse that proof instead of repeating all consumer tests in the credentialed job. Never regenerate retained evidence after any package has reached npm. Repair a partial release with "Re-run failed jobs" on its original workflow run, which reuses that run's evidence; "Re-run all jobs" repacks and is refused. Actions artifacts expire, so a partial release left past that retention cannot be completed under its version: release the next patch version of both packages instead.

Read npm directly. Only an explicit not-found response means an unpublished version; outages, malformed metadata or different integrity must stop the release. Skip an existing version only after comparing its registry integrity with the retained archive, and verify every newly uploaded version the same way. A retry repairs missing steps without overwriting a published version or moving its tag. After a new upload, wait for npm to serve the version before verifying it or uploading the next package: the registry is eventually consistent, and a not-found right after our own upload means "not yet".

Create the GitHub release, with the reviewed notes, only after npm serves both packages with the reviewed bytes. Do not attach the tarballs: npm hosts them, and its provenance already binds them to the commit and workflow. Never present local checks as remote CI evidence.

## First publication credentials

When separately authorized, put a short-lived first-publication npm token directly into the repository's `NPM_TOKEN` Actions secret. Never put credentials in chat, source files or command arguments. Configure trusted publishing for both npm names with owner `Anizoptera`, repository `partial-json-repair` and workflow filename `release.yml`; read back those settings before deleting the secret and revoking the token. An already-published-version retry skips authentication and cannot prove that trusted publishing works; verify it on the next authorized new version, never create a release solely to test credentials.
