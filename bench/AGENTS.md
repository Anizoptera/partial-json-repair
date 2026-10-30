# Benchmarks and measurement

Read this file before producing, changing, or citing any number. Benchmarks do not gate commits, so a
green `bun run check` says nothing about a performance claim. Read `MEASUREMENT.md` before changing
sampling, error bars, convergence, or rounding.

Timing misses are optimization work, never development, review or release blockers. Keep raw slow
samples and unknown causes visible. An `excluded` or `ineligible` timing label describes the speed
comparison, not unusable functionality or failed release acceptance. Separate outcome, resource
ownership and cancellation failures from latency; do not require pause attribution to finish other work.

## Choose the instrument

Read [test/AGENTS.md#Memory](../test/AGENTS.md#memory) before collecting or interpreting heap-retention results; collection timing, caller roots and value reads change what the counter can prove.

- Use `bench/async.ts` for async correctness, scheduling, cancellation, scaling, concurrency, and
  public-route timing. Its outer process builds, typechecks and packs the package; do not prebuild it. Only the `--observe` child
  measures. Bound each sample's time and gaps to invocation through promise settlement; observer setup, timer cleanup and post-call counters are outside that interval. Keep the launcher's default workload set equal to the selected observer mode's set; explicit workload filters may select other cases. Verify dispatch through the real CLI's per-case output. Add isolated-route axes there; benchmark logic never belongs in `src/`.
  Ordinary timings include WebKit/Chromium (iso and plain) and workerd (`--runtime platforms`). Use `--workload concurrent` for CONCURRENT_WORKLOADS; `--concurrency N` reports whole-batch completion and verifies each call, not per-call latency. Checkpoint, RSS concurrency, profile and CPU probes remain native-only. Qualify browser and edge async scheduling before final speed comparison; synchronous throughput and platform-correctness checks do not measure callback responsiveness.
  Use `--cancel-after-first --workload many-roots` to measure cancellation from the first
  delivered value through terminal iteration and cleanup. The oracle requires that value once
  followed by an aborted failure; cold settlement is separate, and the maximum includes cold,
  warmup and timed calls. Abort runs in the consumer callback, so this measures settlement, not
  queued-callback liveness, cancellation during startup or cancellation during an active token scan.
  Use `--gap-cpu` only to pair a host gap with process CPU in that interval. CPU includes GC and workers;
  low CPU can still mean synchronous blocking. It identifies no library frame and does not explain a timing miss.
  Before trusting event-loop counters, require idle and blocking controls to differ. Omit optional probes from ordinary timings.
  For CPU-counter qualification, budget the busy control in caller CPU time and bound hangs separately in wall time: a wall-time loop can expire while descheduled. Responsiveness still uses wall time. Do not call a remote counter delta an upper bound without bounding stale accounting; repeated caller-side CPU reads in the busy control can refresh what it should challenge. Read caller CPU at both callback-gap endpoints when attributing that interval.
  Parse generated Bun preloads with `Bun.Transpiler` before launching a build; quoting errors must fail before setup work. For inherited preloads, use `BUN_OPTIONS=--preload=<path>` and require the observer's marker. The spaced form can make `bun run` print help and exit zero without running its script.
- If a selected slow route cannot converge within the default budget, use `--sampling-budget <milliseconds>` with explicit runtime, workload and route selectors. It divides the budget between invocation-count warmup and convergence sampling, records the requested budget with `--json`, and retains the observer timeout. Check actual warmup calls and convergence before using throughput; a larger budget establishes neither convergence nor a met timing target by itself.
- Use `--route-concurrency --concurrency 1` to isolate one call's sampled process RSS. Keep the
  highest observed peak, including warmup; a minimum cannot establish a storage ceiling. RSS
  includes allocator and worker storage and can miss between-sample peaks; it is not a heap bound.
- **Judge the worker route's main-thread gap at 8 MB too:** `bun bench/async.ts --route
  typescript-worker --workload clean-array --size 8388608` (one workload: all of them overrun the
  observer's 30 s bound). The default 64 KB size cannot see a cost that grows with the result:
  receiving one whole 8 MB result blocked the main thread past 32 ms while every default cell passed.
- Use `bench/prior-art/baseline.ts` for cross-runtime and cross-language comparisons. Run the normal
  baseline once: it validates each returned measurement before aggregation. Do not run a
  separate `bench:baseline:routes` preflight that repeats those timings. Use that command to isolate
  route failures. Every registered member must pass, fail, or report unavailable.
  Empty output proves nothing. WebKit, Chromium and workerd are members through `prior-art/web.ts`,
  which bundles the same documents and adapters; a host that cannot start fails its member.
- Reject failed memory children, empty output and invalid RSS values; only the child's explicit `NaN` sentinel means that its parser cannot run the workload. An empty string converts to zero in JavaScript and must never become a published footprint.
  Validate the final parsed value against the shared clean oracle after the final RSS sample; a positive footprint is not evidence that the parser completed the same job, and validation must not inflate or warm the measured working set.
  Use `prior-art/webkit-memory.ts` for WebKit renderer RSS after building. It samples the owned renderer PID directly; inspector heap-node sums omit backing storage and cannot replace RSS. Keep its held-control check and report the renderer scope separately from whole-runtime RSS.
  Chromium/workerd footprint measurements must reuse the portable clean-input adapter and sample only owned host processes. Identify Chromium renderers through its browser protocol and workerd through its direct parent PID; reject an ambiguous process set. State when summed renderer RSS can count shared pages more than once.
- Native and WASM route measurement (startup, peak memory, artifact bytes) is parked with the adapters in
  `rust/js-adapters/bench/`, which the package does not build; it has no script until those routes return.
- After a behaviour change or rival update, run `EMIT=differences bun bench/prior-art/compare.ts`
  (rebuild first). It fails on any rival difference that `test/rival-differences.ts` cannot explain or
  whose cause moved. Judge each against `HLD.md` priorities, and judge what our result tells the
  caller there (`complete`, the report, confidence): values alone cannot show a silent loss, such as
  `parse` returning the first of several values at full confidence. Add or widen a cause with a pinned case,
  then rerun with `ACCEPT=1`. `EMIT=disagreements` prints raw per-input records for inspection.
- Use `bench/ab.ts <git-ref>` for small regressions. It compares old and new source in one process;
  stored figures cannot isolate a later code change from machine drift.
- Use a profiler before naming a hot frame. For Bun, start with `bun --cpu-prof`; timing alone shows
  cost, not cause.
  Before interpreting profile counts as CPU time, compare arithmetic and a native wait while measuring caller CPU use. If waiting collects samples with little CPU, report stack residence instead.
  Keep native trace output separate from observer JSON: their writes can share a line. Prove both
  channels with a small control before the full run; a line filter cannot separate writers.
  Prove the measured public call reaches the branch or allocation you plan to replace; a hot function does not establish that.
  Before tracing native message callbacks, prove one real message/pull on that runtime. Capture the port at registration: a host can invoke its listener without binding that port as `this`.
- Before correlating profiles with host gaps, bracket target events visible in both clocks at start and stop; count only samples inside the gap across the full uncertainty. Matching units or a trace's displayed start date do not prove its event-clock origin. For Node on macOS, qualify CPU-profile and native-trace clocks separately against a blocking control; process.hrtime alone does not establish a common origin. Test timestamps already captured directly against the control before adding clock helpers or offset conversions.
  Before expanding a native capture, require a small exported control to identify the caller thread and the events needed to distinguish the proposed causes. Save raw events and control brackets before validation, including on failure. A successful recorder, target exit or helper-thread samples do not prove caller-thread coverage; file-write markers qualify only a recorder that captures those writes.
  Bound capture, finalization, export and output storage before starting; a recording time limit does not bound the other phases. Start with the target process and required events. Expand scope only when a bounded control proves it supplies missing evidence.
  Stop a method when its coverage control fails. Retry only when a specific change predicts a different control result; repeated quiet calls or a longer recording cannot explain an uncaptured pause.
  For Unix workerd captures, drain with SIGTERM before Miniflare disposal; forced shutdown skips Perfetto flush. Keep high-volume async activity in separate JSONL alongside native GC tracing to avoid overwriting caller packets. Decode with full sorting and reject decoder errors or packet loss before interpreting missing events.
- Compare archived profiles against the original profile filenames: macOS tar can hide AppleDouble entries that Python lists. Require successful payload verification before deleting originals.

- Use `bench/prior-art/http.ts` for SDK decoding and parsing under real HTTP traffic: Elysia/Hono on Bun and Node, Hono on Deno, Fastify through its Fetch bridge on Node. Explicit --server fastify also probes experimental Bun compatibility. Its separate process measures the service loop while the producer and competing client run outside it. Keep idle/blocking controls, packed imports, complete-outcome oracles, delta identities and acknowledged source/parser/server cleanup. Use --concurrency for simultaneous jobs; keep one sampler and one health probe, prove overlap, and stop one source without stopping siblings. Shared timer readings are one event, not independent stalls. Model fixtures must say they are modeled; they are not live captures. Imports and startup load only the selected framework. --gap-cpu adds diagnostic process counters, not caller-frame attribution; --fault-oracle must reject a corrupted outcome digest. These observations do not rank throughput.
  Keep the usual SDK response decoder as the default and use --cooperative-response to measure raw-response envelope parsing; compare identical inputs, loads and complete-call costs before recommending either path. Streaming always uses the SDK's SSE decoder.

For raw damaged-JSON request bodies, bypass framework JSON parsing before dispatch: Hono passes context.req.raw, Elysia uses parse: "none", and Fastify dispatches in onRequest before its content-type parser. A malformed application/json POST must reach recovery unchanged; a GET-only SDK response replay cannot prove ingress.

## Build and identify the subject

- Rebuild before direct `compare.ts` calls or other `dist` readers: a previous packing or gate step can remove those outputs.
- For archive-based controls, link the installed dependency homes of every project checked by `scripts/typecheck.ts`, including `bench/prior-art/node_modules`. A root-only dependency link cannot validate the complete benchmark harness.
  When a copied-tree probe inventories untracked source, exclude each dependency-directory symlink
  through a task-local Git excludes file: a directory-only ignore does not hide a symlink. Before
  launch, check every dependency link is excluded and a known tracked source file remains listed.

- Build the instrument before the code change it must watch. Re-measure on the exact source and
  artifact being shipped.
- Capture a reusable candidate's tree state before building; reject it if completion sees a different state. Capturing only after measurement can label earlier measurements with later source. Report each active runner before its fork.
- Derive a failure replay's runtime, workload, route, input digest and concurrency from its failing row, then check them in the replay output. HTTP model inputs contain repository documents: use `--fixture-ref <revision>` to recover their recorded bytes; the same fixture name or approximate size does not identify the input.
- Verify documented package commands and direct launchers with build output absent; testing only
  the launcher misses wrapper prerequisites. Build declarations before checking harness types, then
  load public fixtures; a gate that builds first cannot prove this ordering.
- Run Rust benchmarks through `bun scripts/rust/cargo.ts run --release --manifest-path
  rust/bench/Cargo.toml -- [mode]`; direct target binaries may be stale.
- Measure each variant as a production artifact. Include Rust optimization, `wasm-opt`, and the
  variant's allowed WASM features. Never optimize a fallback with instructions its hosts cannot run.
- Pin historical toolchains and engines. Use absolute runtime paths, link the current build tools into
  temporary worktrees, assert runtime versions, and prove one known build before a bisection.
- Build shared artifacts once. Parallelize only work that cannot contend for the measured resource.
  Import feature factories from the measured revision; structural option checks cannot prove version identity.
- Give each runtime, workload and route a fresh observer so another cell cannot warm its first-call worker pool; reuse workers only within that cell's warmup and repeated calls.
  Construct the worker and attach readiness and error listeners in the same task, before yielding. A web worker's readiness event can otherwise be lost; require its acknowledgement before interpreting startup timings.
  Compute route oracles in a separate process using the same runtime and packed package; reuse each workload's digest across forks. Verify input, options and workload identity with the first result, after timing: hashing input beforehand warms the first measured read. An oracle in the measured process also leaves garbage that can pause later calls. Validate every result after timing; sample route memory before validation while results remain held.
  For ordinary timings, retain every sample output until sampling ends, then verify each. Require the captured count to equal first + warmup + timed calls; missing captures must fail. Verification between samples contaminates later calls with its garbage. Batch retention is not a footprint measure; memory probes keep their own lifecycle and sample before validation with results held.
  Pass option hashes in oracle arguments, not selector text; large literal paths can exceed the host's argument limit.
- Resolve runtime executables through `prior-art/runtimes.ts`; do not construct installation paths
  from version labels, because runtime families use different installation layouts.
  Before release measurements, refresh channel pins through their version managers; readback proves a version, not freshness. Requalify changed releases without repeating unchanged members.
  For releases installed outside asdf, set `PJR_RUNTIME_PATHS` to the family's release-to-executable map; the resolver checks each binary's reported version.
- Check workerd itself for edge freshness; stable Miniflare may pin an older engine. Verify any engine override through the existing workerd platform member before treating that runtime as qualified.
- Choose an isolated test browser before changing a shared installation. Inspect configured paths, application homes and managed browser caches; read the actual engine version, since user agents can hide it. Qualify the engine named by HLD; identify a WebKit test build as that engine, never as a Safari application release. Do not add a stable-Safari gate absent from HLD.
- Identify the renderer executable and mapped engine libraries when a browser runs page code in another process; the UI process's framework alone does not identify that engine.
- Open benchmark browsers through scripts/browser.ts so platform proof and timing use the same engine-selection and cleanup path.

## Prove correctness before timing

- Compare every measured result with the public oracle. Reject a timing cell whose structural digest
  differs; stopping early is not speed.
- Require identical input digests and units across hosts. A runtime-local oracle can agree with a
  route while both consume a different document; reject those timings before comparing them.
- Keep valid JSON beside damaged input. Ordinary input must not pay for recovery features.
- Generate complete tokens for clean workloads at every accepted size; check odd and even sizes with `JSON.parse`, because a recovery oracle can agree on malformed input.
- Compare equivalent jobs. A dialect parser belongs on its dialect; each row uses that runtime's
  standard parser as its denominator.
- Keep one comparison matrix. New JavaScript, Rust, native, WASM, or rival subjects implement the
  registered runner protocol and use the shared cases.
- A runtime probe does not typecheck a harness. Run the repository typecheck before keeping it.

## Control the machine and estimator

- Inspect machine activity before timing. Native async JSON observations retain host load and parallelism;
  record `uptime` separately for instruments without that context. Stop when contention makes the run
  unrepresentative; retain slow observations and do not infer their cause from load alone.
- For speed, take the minimum within each process and the median across fresh processes. Report
  cross-process spread. Warm up by invocation count and stop on convergence within a wall-clock
  budget. `MEASUREMENT.md` owns the rationale and cross-language translation.
- Compare ratios against the same runtime's standard parser in the same process. Absolute throughput
  describes one machine state.
- Change microbenchmark inputs each iteration; check that the final values differ so the optimizer cannot remove the operation.
- Source checkpoints do not bound final conversion or assembly. Vary total input and time indivisible
  finalizers separately.
- Measure one large object key separately from many nested keys: equal total input does not prove
  the same structured-clone or property-insertion cost. Use `single-long-key` alongside
  `deep-long-keys` before judging worker receipt bounds.
- Measure cancellation checks, host yields, and backpressure separately. For cooperative work, record
  event-loop delay, cancellation latency, complete-call latency, throughput, and scheduler cost.
- Explore numeric policy geometrically from mechanism boundaries. Expand until two consecutive values
  on each side lose across every decision metric or hit a contract boundary; then test interactions
  where frontiers cross.

## Publish a claim

- Re-run `bun run bench:baseline` after scanner, builder, or repair-path changes and before citing
  speed. Normal runs save no candidate. Use `--candidate <ignored-file>` only when the maintainer requests retained measurements for review; accept with `bun run bench:baseline:accept --candidate <same-file>`, then delete that temporary file. Use `bench:baseline:accept` only after recording changed measurements and material slowdowns
  as optimization work; mark an unknown cause as unknown rather than require attribution before release.
- Re-run `bun bench/prior-art/compare.ts` after behavior changes and before citing prior-art tables;
  its agreement column depends on this package's current answers.
- Publish speed on the fixed log-uniform ladder owned by `bench/estimator.ts`. Do not copy exact
  intermediate timings into docs.
- Treat size and peak memory as separate instruments. Size is deterministic and may be exact; memory
  gets its own repeated-run precision. Do not apply speed rounding to either.
- Before trusting a retention bound, require the same heap counter to detect a deliberately retained
  control of the same shape on that runtime; a counter can omit owned backing storage.
- Put the measured runtime, machine, workload, artifact, and command beside a claim. State the
  uncertainty and the strongest control that could still change the conclusion.
- A sentence saying a rival lacks a mode, an input type or a report is a measurement. Read the rival's
  shipped declarations first, register every such mode as a `compare.ts` adapter, and write the
  sentence from the resulting row.
- README and prior-art tables are not checked by `bun run check`; their author must re-measure them.
