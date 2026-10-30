# scripts/ — the gate lane and its tooling

`bun run check` runs the complete `check.ts` graph; `bun run check:commit` runs its edit profile.
`--complete-only` runs the rest (`completeOnly` steps and what they read), so CI can run the two
halves in separate jobs: never put a CPU-heavy step on the same small runner as timed test cases.
Corpus tooling lives in `scripts/corpus/`; its doctrine is in `corpus/AGENTS.md` — read it before
touching the recorder, verifier or serialiser.

Before changing verification, read `test/AGENTS.md#check-value`; its evidence and cost rule also governs scripts and gates.

Read Markdown through the existing Markdown parser: links and code blocks must follow rendered syntax, including nesting and reference definitions. Text inside a code example is not a document link.

Reuse a passing edit profile for unchanged source and toolchains; run `bun run check --complete-only`
for the remaining steps. A commit hook pass is not a gate pass: it skips the packed artifact checks,
the second test runtime and the async replay. A changed subject invalidates only the evidence that depends on it.

**The commit hook is not the gate.** It runs the fast checks that judge what the commit carries and nothing else; `bun run check` and CI run everything. A hook people wait on gets bypassed, and then none of its checks protect anything, so aim well under its 10 s warning.
- Select by the candidate: the hook passes `git diff --cached` paths as `check.ts --commit --changed`. Never select from `git status`: an unstaged or untracked file belongs to someone else's next commit, and one untracked path must not widen a commit to the whole lane.
- Under `--changed` a step runs only when a changed path is outside its `ignores` and its `scope` leaves it a target; `scope` limits the tool to those paths. A tool whose config or pin changed (`lintPolicy`, `formatPolicy`) judges the whole tree. Declare `ignores` only for paths you have read the step's code never reads: an over-broad one is a false green.
- A producer (`build`) runs only when a consumer's `needsFor` demands it. Work whose output the commit does not carry, a build or a pack, is never hook work for its own sake.
- Before narrowing `needsFor` or claiming a step needs no build, run that step after `bash scripts/clean-generated.sh --build`. A `dist/` left by an earlier run hides the dependency, and a comment naming one `dist/` reader is not a list of them: tests reach `dist/*.d.ts` through `bench/` modules that import the package by name.
- Before adding hook work, name the defect in the committed paths it catches and why the full lane would catch it too late. When the value does not earn the wait on every commit, mark the step `hook: "skip"`, and add a `hook: "only"` stand-in when a narrow form of it exists (`test:bun --changed=HEAD` for `test:check`).
- The fixers write only committed paths whose worktree bytes equal the index; a path with unstaged edits is formatted in the index alone.

Benchmark figures require bench/AGENTS.md evidence, not runtime checks. Size-reference changes still require the complete consumer matrix; rerunning runtime tests cannot validate a byte reference.

## Adding or changing a step

- **Add steps to `check.ts`, never a shell chain.** The lane runs independent steps concurrently and
  reports all failures. Rust is not a step: `bun run rust:check` runs by hand when `rust/` changes,
  because the npm package ships TypeScript only and Rust replays a pinned corpus.
- **A step that reads `dist/` declares `needs: "build"`.** Git ignore does not prevent imports from
  resolving there, so an undeclared reader races the build.
  The `platform:check` package command rebuilds `dist`; run it separately from artifact readers,
  or build once and invoke `scripts/platform-check.ts` alongside those readers.
- Preserve `runScript`'s three states: passed, failed, and stopped. A deadline is not a test failure.
  A child error records the verdict but must not acknowledge stopped work; wait for native close before releasing its output and caller.
- **A step whose tool is missing fails; it never exits 0.** Every runtime a step spawns is declared in
  `.tool-versions` and installed by `check.yml`, because CI runs the gate on a bare runner where a
  skip reads as a pass.
- Keep deadlines in `run-script.ts`. The hook derives a wider bound because it formats first.
- Keep the slowest step's final summary in check.ts's success line, so the outer hook retains nested runner timings without dumping passing logs.
- Checks print diagnostic cohorts and failures; they must not create persistent receipt stores or automatic heap dumps. Use command-owned temporary scratch and remove it on every exit. Release preparation preserves only the package bytes and integrity inputs its publication and recovery steps need.
- Cleanup must stop when tracked-file discovery fails; a failed Git query is not permission to delete an apparently untracked path. Archive probes need a working tracking context for repository cleanup, or their outer owner must remove the entire disposable copy.
  Query all output targets before deleting any of them, so a tracked replacement cannot leave cleanup partially applied.
- **Local timings do not prove CI timings.** Keep CPU-heavy builds separate from timed tests on
  small runners. Assess headroom on this machine without starting infrastructure; compare local
  scheduling changes in alternating runs under comparable load.

## What individual steps actually assert

- **`artifact:check` judges the packed tarball.** It checks the allowlist, links, imports, build paths,
  browser bundles, installed worker routes, and typed startup failure. It also compiles a bare consumer
  (`lib: es2022`, no `@types/node`, `skipLibCheck: false`) against the shipped declarations. Build
  before running `check-artifact.ts` directly after source changes.
- **Public API snapshots must come from the cleaned tarball.** Its artifact callback must run API Extractor for every typed export and compare `api/*.api.d.ts`; do not repeat extraction as another gate step. Build before `bun run api:update` and review the generated diff; updating it never waives comparisons with published archives. Test both empty and populated release history. No predecessor skips comparisons for the first publication, not their implementation for later versions; breaking 0.x changes are permitted with the corresponding version and notes. Generated snapshots are compiler output: format them consistently but exclude them from lint fixes, which can change their declarations.
  Preserve type-only exports through rollup: a class reachable as a type is not necessarily a public constructor. Derive runtime-export expectations from the compiler's module value space in the original shipped declarations; alias target flags alone lose that distinction. Compatibility must distinguish removing a value from changing an instance type.
  Trace declaration dependencies through compiler-bound symbols; member names and shadowed type parameters are not references to identically named exports.
  Generic function assignability can accept a removed concrete overload. Compile actual old argument tuples against concrete top-level overloads too, with a valid widened replacement control; assignment alone does not prove those calls still work.
- Keep retained-input verification and finalization independent of preparation dependencies. Their clean-checkout jobs must run without installing Markdown parsers or compilers; probe those exact entry points with automatic dependency installation disabled. Preparation owns report generation, while later jobs consume the retained checked bytes.
- An archive suffix does not prove its encoding. Write a compressed `Bun.Archive` through its explicit `.bytes()` serialization and verify it with the decoder: passing the archive object to `Bun.write` can emit uncompressed tar despite its compression option.
- **`release:check` exercises release machinery with emitted declarations and a loopback registry.** Declare its build dependency and keep it in the complete profile: ordinary unit tests cover the small rules, while this step checks empty history, corrupt downloads, real old-caller compilation and breaking 0.x version control without publishing anything.
- **Editor promises need the packed language-service probe in `consumer-editor.ts`.** Compiler
  acceptance cannot prove option suggestions; locate completion queries through the fixture AST.
- **`artifact:check` also compiles every ```ts or ```typescript block in `README.md` and
  `docs/API.md`** as its own module against the packed package: a reader copies the doc's block,
  never the test's copy of it. Finding no block fails the check. A
  failure names `<doc>-L<line>.ts`. Fix the example, never the check: add the missing import, narrow
  on `ok` before reading `.value`, or declare a free CALLER name (never a package export) in
  `scripts/doc-prelude.d.ts`. Mark a block `<!-- not-compiled -->` only when it is a type sketch.
- **`treeshake:check` probes string literals or property names, never local identifiers.** Minifiers
  rename locals but keep property and method names. Never keep dead code as a marker: when a marker's
  code goes, pick a literal or member name the feature still needs. Require the marker in the full
  entry and its absence in the reduced entry. This proves only that the module
  graph permits removal; `src/AGENTS.md` owns the required shape.
  An optional delegate can retain a method name after its implementation is gone. For that boundary,
  match the implementation's definition, require full-import presence, and plant retention in a
  reduced entry to prove that the probe rejects it.
  Packed consumers need the same controlled markers when a module also holds required shared helpers; module presence alone cannot distinguish retained optional code. Keep marker definitions shared with the source probe and require their survival in a consumer that uses the feature.
- **`jit:check` reads JavaScriptCore's own inlining log, never a timer.** A function costing more
  than 10 000 bytecode units gets nothing inlined into it, so a hot loop slows 1.3-1.9x with identical
  results. Run it as a separate optimization diagnostic, outside the normal gate; its 9 000-unit
  threshold leaves headroom but never blocks commits, review or release. Record a miss for later
  work; moving a rare branch out of the hot function is an option, not a prerequisite to finish.
- **`steering:check` proves every tracked `AGENTS.md` has a sibling `CLAUDE.md` symlink and fits the
  supported context limit.** Copies fail because they can diverge. Enumeration comes from Git.
- **`wiring:check` proves Git calls the executable pre-commit target through `core.hooksPath`.** Test
  the hook by executing it; invoking `sh <path>` bypasses its executable contract and fixes its
  interpreter.
- **`async:conform` compares cooperative calls with the synchronous corpus oracle.** Pull
  `parseMany` one item at a time. Its corpus profiles always pass options, so they cannot prove
  default argument handling; `test/async.test.ts` owns the omitted-options case for every verb.

## Consumer checks

- Emit standalone comparison code from `test/consumer-outcomes.ts`, not from fixture data; copying a module's text does not carry its imports into the generated consumer.
- Compose generated programs with disjoint imports and bindings, or run them as separate modules. Use the first real matrix member to check shared setup; fix syntax or binding errors before launching the same program on other hosts.
- Link the repository's `node_modules` into a temporary bundled checker's directory when packages stay external; imports resolve from the runner file, not its working directory.
- For early scalar-fragment exit, require a nonempty source prefix and producer cleanup; require whole-token equality only when iteration is exhausted. Token completion does not imply that every bounded piece was delivered.
- Test argument failures through the CLI's actual parser; loading every bundler adds no evidence about a missing value. Keep packed behavior checks on real bundlers.
- Inject host faults only after reaching the lifecycle phase the probe names; startup, delivery and disposal can call the same method. Require that phase before interpreting the failure.
- Name the pending operation and cohort when a host probe times out; retain completed readings so navigation, collection and library progress remain distinguishable.
- Before using signal-read counts to locate a cancellation phase, read `test/AGENTS.md`'s calibration rule; independently timed calls can add different scheduler reads.
- Require a completion marker after an installed async probe's assertions, including expected-failure cases. Exit zero alone cannot prove that an awaited result was checked: an unreferenced worker can let its host exit first. Run each fault cohort to completion before restoring the shared package files.
- Memory cleanup must return every owned iterator and join all release attempts before acknowledging the phase; dropping JavaScript references does not release an active worker request. Await cleanup through each platform handler too.
- Keep generated consumer fixtures compatible with every supported bundler and host. Use public `close()` methods in `finally` instead of `using` declarations: a fixture is plain JavaScript, and TypeScript support does not prove a downstream parser or host accepts its disposal syntax.
- Await page-owned completion promises for browser results; navigation does not settle asynchronous page work. Bound hangs outside the page and close the view after timeout. Pass an expression to `Bun.WebView.evaluate`; wrap statement lists in an immediately invoked function.
- Use scripts/browser.ts for platform and benchmark browser sessions: Playwright for Chromium, Bun.WebView for native WebKit. Before blaming library code for a driver stall, test the same engine on a trivial served page; opening about:blank does not prove renderer navigation works.
- Serve existing `Bun.build` outputs directly. Writing a file-backed artifact to its own path can truncate it; require nonempty entry bytes before browser navigation.
- For workerd heap probes, discover the user isolate from the local inspector target list and keep normal request activity running until collection is acknowledged. A single request can finish before the inspector command arrives. Join collection and request activity before returning; an idle timeout does not prove that GC is unsupported.
- **`size:check` and `platform:check` judge the packed tarball as the HLD's supported bundlers see
  it.** Fixtures are data rows in `consumer-fixtures.ts`; absence comes from each bundler's own module
  report, never a text search. `platform:check` runs the same bundles in WebKit, Chromium and workerd
  against Node. Ownership failures must retain the measured cohorts in their error message; a
  difference alone cannot identify retained input, and a passing retry cannot recover lost readings.
  Required source maps must be read successfully before judging emitted modules; a missing map is failed observation, never evidence of zero package code.
- For final release qualification, set `PJR_CONSUMER_ARCHIVE` to the retained cleaned main archive for both checks. An explicit archive must be read directly or fail without requiring workspace build output; never silently repack a different subject. Ordinary development checks may pack the current build and require its output.
- **Configure each bundler as a default browser app would: no `external`, no plugin.** A harness
  setting a consumer would not write hides package defects: with `external: ["node:*"]` a webpack or
  Rspack build of `/async` can pass while a real app's build fails on the Node-only import.
- **Run each build on its own thread, from a work directory with a fixed path.** webpack compiles in
  JavaScript, so builds sharing one thread queue behind each other and dominate the run. Bundlers
  hash chunk names from module paths, so a random temp directory changes compressed sizes enough to
  cross the 2% bound with identical code.
- A bundler's `entryFile` is a filesystem path, not a browser URL. Serve its basename relative to the output directory, and require the entry request to succeed before waiting for page results.
- **Judge worker behaviour in browsers only.** The size check runs bundles in Bun, where `process`
  sends the package down its Node branch, so a worker result there measures the host.
- **Rewrite `bench/size-baseline.json` with `--write-baseline` only in a commit that says why.** The
  2% regression bound is meaningful only against a baseline whose growth was read.
  Refuse the write when the candidate fails any graph or behavior check; a failed candidate must leave the existing reference untouched.
- For unused imports, inspect every emitted chunk: zero startup bytes does not prove zero package output. Keep emission, startup and lazy-loading checks separate. HLD D5 permits shared generic-worker features only outside startup; classify those as `lazy` when required, or `notAtStartup` when optional, never exempt unrelated modules or import-only consumers.
- Compare startup feature modules across bundlers on the published package. Root entry wrappers can disappear from source attribution when inlined into consumer code; explicit absence checks still apply. Without package metadata, shared-chunk placement can differ; keep that variant's behavior and explicit feature-presence checks, but do not require identical private placement.
- **`size:check` is a complete-profile step; `platform:check` runs by hand before a release.** A step
  red at HEAD blocks every commit, so add one only once it exits 0. `size:check` judges `dist/` as it
  stands: run `bun run build` first when calling it directly.
- Use `size-check.ts --fixture <id> --bundler <name>` for a narrow packed graph experiment; either filter is optional. Filtered reports prove only their named cells and cannot write a baseline. Release verification must omit both filters.
- Use `bun run platform:check --bundler <name>` to build and isolate a failed consumer, or `platform-check.ts --bundler <name>` after building. Require the printed scope and bundle census to match the filter. Omit the filter for release verification; a passing retry does not explain an earlier timeout.
- Use `platform-check.ts --host webkit|chromium|workerd` to rerun a failed host without repeating unchanged members. Workerd-only probes omit browser builds. Require the printed host scope and final census to agree; omit all filters for complete release verification.
- Before comparing size JSON, read `size-check.ts`'s `Row` type and check one complete retained row; guessed fields can silently yield `undefined`. Match fixture and bundler keys and reject missing controls before calculating deltas.
- **Pin bundlers and `miniflare` exactly.** Their versions decide what ships. Take the newest stable
  release: npm's `latest` tag for `miniflare` can name a pre-release.

## Typechecking: two TypeScript packages, deliberately

Build before running the standalone typecheck: benchmark projects import shipped `dist/` entries.
After cleanup, check that prerequisite before interpreting missing package declarations as a
source-type defect; use the gate graph or build first.

`typescript` is the latest major and the default for everything: typechecking, `tsc`, and declaration
emit (tsdown then uses its `tsgo` generator and prints an "experimental API" warning; the emitted
`.d.ts` matched the 6.x emit byte for byte). The commit hook type-checks with `bun check` alone (`typecheck.ts --bun`) because it is several times faster. A full run uses `tsc` and `bun check` concurrently: `tsc` is what consumers run, and the full lane is where the two checkers' disagreements must surface. Never drop `tsc` from it. `typescript-6` serves only what 7.x lacks, the classic
compiler API (`createSourceFile`) that the AST checks parse source with, and it is the 6.x leg of the
supported-consumer check in `artifact:check`. Never downgrade the default to reach a 6.x API; import
`typescript-6` at that one call site.

The consumer check's compiler list IS the HLD's supported TypeScript set (newest release of 6, plus
each major from 7 on within two years, at most three, always the latest). Before a release, when a new
major ships, add its alias and leg; drop a 7+ major the rule no longer covers. A major missing from the
list is an unproved support promise. Read installed versions from `package.json`; do not copy them
here.

**Keep both packages.** They are aliases with the same `tsc` binary name, so `typecheck.ts` resolves
the checker through its package manifest and owns the project list. Do not call
`node_modules/.bin/tsc` or assume a hoisted path. Keep prior-art configuration beside its imports.

Type-aware lint sees only the root `tsconfig.json` include set. Typecheck excluded benchmark trees
through their own configs; do not treat lint's missing types there as runtime evidence.
