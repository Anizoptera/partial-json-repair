# Roadmap

HLD.md is the sole product authority. Ship TypeScript recovery for damaged or streamed JSON: preserve content, detect conservatively, recover forgivingly, keep equal runtime outcomes and useful typed failure recovery, select final values by default, and collect reports only on request. Calls pay only for requested capabilities; the recovery core has no runtime dependencies.
Release blockers are only correctness, data, resource release and cancellation failures; slowness, audits and tuning go to Later work. HLD decisions and remote writes stay reserved; never extend an HLD exception to other guarantees or costs; completion starts review, not publication. Current branch only; reasoning lives in source; no persistent scratch. Rust/native/WASM stay deferred.

## 1. Required before each release

Requalify after any packaged-source change: qualify one unchanged candidate through the full packed optimizer/compression matrix, declarations/resolution, both source runners (including the HTTP framework probe on the HLD compatibility runtimes), corpus, complete-only release machinery and cleaned-archive browser/edge coverage. Enumerate declared members; each must complete its behavior, graph or compiler checks. Empty, filtered, skipped or unrelated passing members leave gaps open. Keep the generic-worker exception outside startup only; never rewrite a size reference to clear a failure.

## 2. Maintainer review — only when requested

On explicit review request, prepare source and both cleaned packages against HLD.md and docs/API.md. Identify the committed tree and both package integrity values; old candidates cannot qualify changed source. Check metadata, workflow syntax and action pins with existing owners. Reuse checks only for unchanged subjects and conditions; local results prove no remote CI timing. Map each hunk to a request, delete task scratch and leave clean Git. No outside-repository changes, remote write, publication or provisioning is authorized.

## 3. Release execution — separate authorization

Each publication or release tag needs separate maintainer permission for the exact reviewed tree. A pushed `v*` tag runs `release.yml`, which publishes both names through npm trusted publishing (no token); follow `CONTRIBUTING.md` "Releasing".

## Later work — never release-blocking

Promote an observed contract or ownership failure to section 1, never a timing miss alone. Pause investigations need caller identity, clock brackets and running/runnable/blocked coverage first; no privileged capture is approved.

- [ ] **Bun/Hono pause attribution — stopped until explicitly reopened.** Replay Bun 1.4.4 cut-files with --fixture-ref 5d15e4a, --mode stream and --concurrency 1 through bench/prior-art/http.ts. Distinguish blocking from delayed dispatch before changing code. Raw-response decoding did not cure the pause; quiet replays and sampled residence do not establish its cause.
- [ ] **Node clean-array pause attribution — stopped until explicitly reopened.** Replay Node 22.23.4, cooperative parse, clean-array, 65,539 text units, concurrency 16, default options through bench/async.ts. Distinguish blocking from dispatch; low process CPU, stale remote counters, suspended-PC probes and switch counters alone do not identify either. Require a discriminating observation, never a quiet replay.

### Targets: the physical limit, not the next rival

Aim for 50–100x on every axis until the measured floor; an unknown floor is a measurement to make, and reaching a rival or a round number is not done. The gap to the floor is the work left. Keep or kill each item on measured evidence; replace a killed item with the next idea aimed at the same gap. Floors:

- Clean bytes, whole or streamed: native `JSON.parse` throughput on the same runtime. Our engine only has to touch what is damaged.
- Per stream frame: work proportional to the new chunk and to what the caller reads, never to what was already read.
- Consumer size: the bytes of the capabilities a call actually reaches. A caller using no option pays for no option machinery, and a stream-only caller pays for no whole-input path (and the reverse).
- Memory: one copy of the input at most, plus the value being built.

### Streaming speed

Streamed model output is the first caller job, and the streaming table in `docs/PRIOR-ART.md` (2026-10-28, `e608afe`) puts both streaming rivals ahead on every cell. Goal: match or beat the fastest rival on every cell and runtime, with the one-shot oracle still equal, then close in on the clean-bytes floor. A fix that wins one cell and loses another is not done. Damaged replies already hand undamaged members and sibling runs to `JSON.parse` (`src/native-slice.ts`); missing comma now costs ~4.3x the clean parse, mostly whole-text passes before the scanner. Profile of the worst cell's shape (Bun 1.4.4, `snapshot()` 60 times over 815 KB of records, 2026-10-30, `fbfd7ad`; machine under heavy load, so shares only): scanning and building cost ~19x `JSON.parse` at every chunk size; each feed adds ~0.25 µs (generator delivery ~30% of it, owning the caller's chunk with `structuredClone` ~14%). Freezing closed branches (~8%) and owning each string value (~6%; `structuredClone` already beats rebuilding from code units on Bun at every length) are contract costs. No single scanner cost exceeds ~18%; the lever is not scanning: streams without a report, selection or shared view now build each container the window closes through `src/native-slice.ts` (records of short fields, 4096-character feeds: ~14x → ~3.7x `JSON.parse`).

- [ ] Rerun the streaming table (`bun bench/prior-art/baseline.ts`, then `docs/PRIOR-ART.md`) and pick the next cell where a rival still leads. Shared views (`sharedView`) still scan every token: they need each closed branch frozen, so give them the native route only with an iterative freeze of the native tree (`maxDepth` can be deep, so never recursion), measured against the scanner's freeze-on-close. Rejected micro-levers (within `ab.ts` noise or slower): bulk-skipping plain string content, hoisting `readString`'s mismatch closure.

### Consumer size

A `parse`-only consumer keeps about 104 KB of minified JavaScript, no maps or sources (esbuild, 2026-10-30, `8ba78e6`), almost all of it the recovery engine; opt-in features already add zero bytes when unused (`size:check`). Rivals: 0.8–6 KB gzip against our ~28 KB (`docs/PRIOR-ART.md`). Hypothesis: the engine can be halved without dropping an HLD capability. Per-function attribution is flat (largest, `readString`, 6%; option machinery ~7%) and the name-level levers below are rejected, so no single function or rename halves it. Measure every change on the packed matrix (six bundlers, raw/gzip/Brotli/zstd), speed and allocation; reject a size win that slows the hot path or grows compressed output.

By capability (esbuild metafile, `parse`-only app, 105.6 KB raw / 33.4 KB gzip, 2026-10-30, `471e6f3`): recovery scanner and builder ~43%, prose candidacy (`candidate-reader`) ~11%, the proved `JSON.parse` route (`pre-scan`, `builtin-route`, `native-slice`) ~10%, options validation ~6%, refusal positions and context (`scan-diagnostics`, `configuration-error`) ~7%, byte input ~4%, exact numbers ~3% (HLD default for overflow). Each serves an HLD capability on the default path, so no capability can leave the bundle; the excess sits inside the recovery core.

- [ ] Shrink `scalar-reader` (15 KB, the largest module) without changing behaviour, judged by `size:check`, the packed matrix and `bun bench/ab.ts HEAD`.

## Rejected designs

Reopen one only for a complete public call that reaches the changed branch, preserves its contracts and benefits; reopen a measured kill only when a new measurement moves the figure that killed it.

| Candidate | Why it loses |
| --- | --- |
| Skipping whole-text passes one defect already condemns | Missing-comma reply, best of 15: the failed `JSON.parse` attempt (0.5x) and pre-scan (1.2x) that find the damage, plus sibling runs (~2x), leave ~3.5x even with every failed ancestor attempt (~1.5x) skipped, above the 3x goal set for it; skipping needs opener offsets recorded at ~40 pre-scan decline sites, in a module every `parse` bundle ships. |
| Cutting fixed per-feed overhead | ~400 ns per feed stays under a tenth of a 4 ms frame until a thousand feeds land in one frame (16,000 characters at 16 per chunk), far past any model's output rate. |
| Scan state in locals | Ceiling with every `this.cursor` (~400 uses) as a one-letter local: 189 B gzip (0.6%), 117 B Brotli on a `parse`-only esbuild app; compression already folds the repeated name. |
| Lazy worker/client/repair/codec imports; descriptor tricks | Unused output, extra chunks, startup disagreement or larger complete consumers. Keep the production private-worker boundary. |
| View assembly in Picks; shared edit mutation in Builder | Adds view work to selection-only/worker callers or repair work to default callers. |
| Merging the lexers (`pre-scan`, `candidate-reader`, `scalar-reader`, `lexical-window`) | jscpd at 40 tokens finds 1.8% of the engine duplicated and no clone between these four; character classes already have one owner (`chars.ts`). The walks differ by contract: `pre-scan` is strict to prove the `JSON.parse` handoff, `candidate-reader` tracks quotes without decoding, `scalar-reader` decodes resumably and leniently, `lexical-window` handles escaped delimiters; one walk would mix conservative detection with forgiving recovery. `pre-scan`'s fixed local copies of `chars.ts` constants fix no defect if imported, and the hot-path cost of module-binding loads is unmeasured. |
| Producer minification, annotation changes or internal-property renaming at our build | Minification and annotation changes lose matrix members or retain unused code; let consumers minify. Consumers already minify whitespace and locals; property names are all a producer pass adds. Ceiling on a `parse`-only esbuild app: 103.0 → 85.7 KB raw but 32.2 → 29.9 KB gzip (~7%), since gzip back-references repeated names. Opt-out renaming (reserve list of public declarations, host built-ins, identifier-shaped literals) failed 69 packed tests and the packed corpus: host members differ per runtime and source-built objects reach renamed copies, so it is unsafe by construction. Opt-in renaming is safe but marks ~450 names by hand and binds contributors and the Rust port to it, for at most 7% gzip. Reopen with a cheaper safe mechanism, never a longer reserve list; judge any build transform with `test:packed` and `corpus:conform:packed`. |
| Shared source blocks for sparse fields | Can retain unrelated backing. Bounded slice reuse added state without a material matched-call gain; replacement ownership needs its own proof. |
| Shared error tables, manual-feed facade, mode injection, empty flush/view/EOF helpers | No proved complete-call benefit to justify mixed or larger consumers. |
| Metrics registry/exit rebinding changes; shared packet literals or numeric keys | Smaller source/raw output does not offset compressed growth without runtime benefit. |
| Native-private hot scanner/transport fields | Bun slowdowns or compressed growth; cold-only privacy does not justify converting hot fields. |
| Automatic worker placement beyond the current planner | Warm-worker gains lose to cold startup, and length or options cannot tell long scans from early selected roots before input is consumed; reopen only with such a classifier and a complete-call benefit (docs/DESIGN-REVIEW.md F7b). |
| Profiling old wide-repair and workerd dense-repair pauses | Worker swaps, forced GC and copy-primitive swaps did not resolve them, and they have not recurred; reopen on a reproducible recurrence through a public call. |
| An options-free entry point | Callers passing no options already skip validation at run time (`DEFAULT_OPTIONS`); a bundler cannot drop the validator from a function that may receive options, so removing its ~9 KB needs a second entry point (HLD D2). |
| Byte input as an imported feature | Saves 4 KB (`utf8`, `byte-positions`) of a 104 KB `parse` bundle, but a caller passing bytes without the import gets a refusal it cannot predict: a second call shape (HLD D2) for 4%. |
| Every value of a multi-value input as one array | No caller needs it: callers read fields off one object, `parseMany` reads each value and `laterValues` names what `parse` left out (`rival-wraps-roots-in-array`). |
| Ending a string at a new root on the next line (`{"a":"cu⏎{"b":1}`) | No caller concatenates documents in one input; inside an object a `{` is no member, so the line stays text. |

## Deferred with native and WASM

The first npm release ships TypeScript only (HLD "Native and WASM (deferred)"). Native and WASM return only by meeting the current corpus; `rust/crates/conformance/pinned-contract.jsonl.gz` holds the corpus Rust last met.

- [ ] Bring the Rust crate up to the live corpus, then replace the pinned file (see `scripts/rust/conform.ts`).
- [ ] Return native and WASM as an imported feature (`{ native }` from its own subpath) using the adapters parked in `rust/js-adapters/`.
- [ ] Run the native packages on Windows arm64 and x64 hosts, then reconcile the complete host matrix.
- [ ] Publish native and WASM artifacts and verify channel readback against tested digests.
- [ ] Publish the Rust crate and verify clean consumers across supported feature combinations.
