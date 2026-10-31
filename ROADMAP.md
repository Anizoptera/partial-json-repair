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
- [ ] **Commit hook over its 10 s warning (10.4–12.6 s, nearly all `test:bun`).** A changed non-code path (README, `corpus/`) runs the whole suite, because `--changed=HEAD` follows imports and cannot see a test that reads a file (`scripts/check.ts`, `test:bun` step). Run only the test files that read the changed path, found from the tests' own file reads rather than a hand list; done when a README-only commit stays under 10 s and still runs `readme.test.ts`.

### Targets: the physical limit, not the next rival

Aim for 50–100x on every axis until the measured floor; an unknown floor is a measurement to make, and reaching a rival or a round number is not done. The gap to the floor is the work left. Keep or kill each item on measured evidence; replace a killed item with the next idea aimed at the same gap. Floors:

- Clean bytes, whole or streamed: native `JSON.parse` throughput on the same runtime. Our engine only has to touch what is damaged.
- Per stream frame: work proportional to the new chunk and to what the caller reads, never to what was already read.
- Consumer size: the bytes of the capabilities a call actually reaches. A caller using no option pays for no option machinery, and a stream-only caller pays for no whole-input path (and the reverse).
- Memory: one copy of the input at most, plus the value being built.

### Speed

Streamed model output is the first caller job; the streaming table in `docs/PRIOR-ART.md` (`e608afe`) puts both streaming rivals ahead on every cell and predates the routes below. Goal: match or beat the fastest rival on every cell and runtime with the one-shot oracle still equal, then reach the clean-bytes floor; a fix that wins one cell and loses another is not done. Why the lever is routing, not scanning: no scanner function exceeds ~18% of a profile, and the scanner costs ~19x `JSON.parse`. So undamaged containers go to `JSON.parse` (`src/native-slice.ts`, also in streams without a report, selection or shared view), and the walks that guard `JSON.parse` skip string content with native `indexOf` (`closingQuote` in `src/chars.ts`), which brought clean and cut long-string input to near `JSON.parse`. Measured residue (Bun 1.4.4, 640 KB records with short strings): clean ~1.8x and missing comma ~3.7x `JSON.parse`; the walk over number tokens and the scanner remain. Contract costs that stay: freezing closed branches (~8% of a stream profile) and owning each string (~6%; `structuredClone` beats rebuilding from code units on Bun at every length). Rejected inside the scanner (within `ab.ts` noise or slower): bulk-skipping plain string content in `readString`, which decodes as it reads, and hoisting its mismatch closure.

- [ ] Rerun `bun bench/prior-art/baseline.ts` on every runtime, update `docs/PRIOR-ART.md` and the README speed claims from it (its "two thirds of `JSON.parse` on clean input" predates the `indexOf` skip), and pick the next cell where a rival still leads. `indexOf` gains are measured on Bun only; Node and browsers ship other string search code.
- [ ] Give shared views (`sharedView`) the native route. They still scan every token because each closed branch must be frozen and a `JSON.parse` tree is not; freeze the native tree iteratively (`maxDepth` can be deep, so never recursion) and keep it only if it beats the scanner's freeze-on-close.
- [ ] Skip quoted content in `candidate-reader`'s skip walk with `closingQuote` (`src/chars.ts`), as the pre-scan does. That walk reads every character of skipped values; `closingQuote` handles only `"` and keeps no escape state across chunks, so extend it for `'` and a chunk ending in a backslash run. Done when `bun bench/ab.ts HEAD` is not slower, `size:check` does not grow and the corpus matches.

### Consumer size

A `parse`-only app is ~105 KB minified, ~33 KB gzip (README "What each import costs"); rivals are 0.8–6 KB gzip with far fewer capabilities (`docs/PRIOR-ART.md`). Unused opt-in features already cost zero bytes (`size:check`). Every capability in a `parse` app sits on the HLD default path (byte input ~4%, exact numbers ~3%, options validation ~6%, refusal context ~7%, the proved `JSON.parse` route ~10%), so none can leave; the bulk is the three recovery lexers (`scalar-reader`, `candidate-reader`, `lexical-window`: ~35%) plus scanner and builder. Measured non-levers: string literals ~8% of raw bytes; property renaming ≤7% gzip; merging repeated statements inside `scalar-reader` saved 20 B gzip, since gzip already folds repetition. So halving needs fewer lexers, which reopens the lexer row under Rejected designs; no size task is open until that row is reopened. Judge any size change on the packed matrix (six bundlers, raw/gzip/Brotli/zstd), speed and allocation; reject a win that slows the hot path or grows compressed output.

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
