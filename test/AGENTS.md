# test/ — the suite

Covers `src/` and `scripts/`. Two runners gate it: `test` (vitest) and `test:bun` (`bun test --parallel --no-isolate ./test/`).

## Check value

Keep a verifier only when its extra defect evidence exceeds its total cost.
Before adding or revising one, and during test/gate audits, name the material wrong behavior it rejects, existing guarantees, the extra evidence and the decision it changes. Charge runtime, flakiness, setup, isolation, fixtures, coupling and maintenance. Exercise a representative defect when its reach is uncertain; acceptable behavior must still pass. Consolidate or delete tautologies, implementation copies, incidental structure and duplicate evidence; preserve every distinct behavioral regression. Prefer the real implementation and state, observe readiness instead of sleeping, and reuse an existing owner before adding another check. This project's explicit test location is `test/`.

Before calling an adversarial probe a contract defect, read that operation's boundary and exclusions in `docs/API.md` against the HLD. An old test or implementation behavior cannot establish a stronger promise by itself.

`bun run test:packed` (after a build) runs the unmarked test files against `dist/` instead of `src/`, so a
build transform is judged by the same tests. Import public behaviour from `src/index` or
`src/async` only; a file that must reach another source module (directly or through a helper)
carries the line `// test-scope: private-modules` and is left out of that run. Never add the mark
to a file whose private import a public export could replace: every marked file is a gap in it.

## Why two runners

Vitest isolates files. `bun test` keeps one global across the files each worker runs, so it exposes
leaked global state. It also runs JavaScriptCore instead of V8. Both differences matter to prototype
safety, number spelling, and UTF-8 decoding.

- Keep `--no-isolate` with `--parallel`: plain `--parallel` implies `--isolate`, a fresh global per
  file, which removes the shared-global exposure. Run serially, Bun's sum of case times was the
  commit hook's critical path.
- A heap bound shares its worker with other files' leftovers. Measure the subject right after its
  baseline and any large control last; growth between them otherwise reads as retention.
- Run Bun as `bun run test:bun` or `bun test ./test/`. A bare `bun test test/` is a substring
  FILTER, not a path: it also runs `rust/js-adapters/test/` and vendored rival suites.
- Put test flags after `bun test`; flags before `test` can select the package's test script instead. A preload probe must show both the Bun test banner and its injection marker before its result counts.
- **A filtered run proves nothing until its output identifies the intended test and a nonzero count.**
  Bun's `-t` treats the name as a regular expression: escape metacharacters or use a distinctive plain
  substring. Require the selected name and expected execution count; zero matches is a failed probe.
- Compare parameterized test discovery with `vitest list --staticParse=false --json`; its default static parser lists declarations without expanding their generated cases.
- Require both runners to pass and report the same test count. A lower count can hide an aborted file.
- Require a successful control before claiming route parity; two unavailable outcomes do not prove input was read. Exercise worker success through installed imports when a source runner cannot load the emitted worker entry.
- Before changing Vitest pools, require `structuredClone({})` to have the test realm's `Object.prototype`. In VM pools, a borrowed host cloner can return another realm's prototypes. Preserve the worker-transfer tests' strict prototype checks; do not weaken them to adopt a pool.
- Run type-aware lint on changed test files before the full commit hook. File-level helpers reserve local names under `no-shadow`; passing runners do not prove lint passes, and the hook also builds packed consumers.
- Keep host subprocess probes in `artifact:check` when it exercises the same behavioral contracts through installed imports. A Bun child has the same host under either parent runner; keep source subprocess cases for contracts the packed owner does not exercise. Preserve every source form, lifecycle boundary, recovery assertion and successful control before deleting overlap.
- Before changing a helper embedded through `toString()`, find every embedding and pass external runtime functions as explicit parameters. Source typechecks cannot see which bindings the generated program provides; exercise a packed caller after changing that seam.
- Give Node helper workers their intended `execArgv`; parent eval flags can change their module mode. Reject readiness on startup error or exit so collector failures cannot strand a probe.
- Test failed worker termination before the native termination call, then require bounded allocation and successful retry; throwing after the thread stops proves only cause handling. Release captured live threads in `finally`; observe exit to remove stopped threads rather than terminating them again.
- Test scheduled-render failures from a callback outside the producer's call stack, after a visible
  prefix exists. Invoking the callback inside `next()` can turn a rendering fault into a source
  fault; require consumption to stop, source cleanup to run and the original render cause to survive.
- Test printed preview failures after a completed root too: keep that root rendered, but never return it as the result of a later failed outcome.
- If a file passes alone and fails in the suite, inspect shared global state before blaming the runner.
- Before planting prototype options, save each touched own descriptor. Define temporary own data properties, then restore the exact descriptors in `finally`; delete only keys originally absent. Assignment can invoke a host setter, and unconditional deletion destroys borrowed host state.
- Before releasing a held async boundary, require an observation that every competing caller has reached the phase being tested; invoking its async function does not prove entry.
- When signal-read counts locate a cancellation phase, fix the cost clock for both calibration and subject; timed yields otherwise add workload-dependent reads. `async.test.ts`'s `withFixedCostClock` owns that fixture. Keep real-timer checks for callback responsiveness.
- Test listener-removal failures on an acquired subscription; an already-cancelled operation owns no listener to release.
- **Exercise the omitted form of every optional public options argument.** An explicit `{}` proves
  only the object branch; it cannot catch a wrapper that rejects or destructures `undefined` before
  the shared resolver applies defaults. For a new public wrapper, test omission, malformed options,
  and one explicit override through the public seam before adding feature combinations.
- **Build stream and memory fixtures from marked roots such as `{"a":1}`.** A markless root (`1`,
  `[1]`) is held until the next root or the end of input shows it stands alone, and on one line with
  another root it is prose (`src/AGENTS.md`): a loop waiting for item N after feeding N such lines
  never ends, and a measurement over it measures held state, not delivery. Follow each root with a
  line break inside its chunk (`'{"a":1}\n'`): every root waits for the character after it, which
  could be a list comma, so a chunk ending on `}` delivers that root only with the next feed or
  the end, and a source that then fails or aborts returns it as recovery instead.
- Run a test that can hang under `timeout`. A stalled transport outlived Bun's 5 s test timeout
  even though a plain never-settling `await` times out normally.
- **Read per-case times from a JUnit report on both runners.** Bun prints nothing for a passing
  test, so its times exist only in `bun test ./test/ --reporter=junit --reporter-outfile=<file>`;
  vitest writes the same with `--reporter=junit --outputFile=<file>`. Keep each case under 0.3 s
  and treat one over 1 s as a defect to split or redesign; compare under equal load, since the
  shared CI runner multiplies every time.
- **Assert a cost as a ratio to same-size work, never as a millisecond limit.** Validate both results reach the intended processing boundary before timing; an early refusal in the reference compares different work. CI's shared runner
  ran ~15x slower than a laptop and failed a bound "30x from both outcomes". Time the subject
  against a reference of the same size that is read in one linear pass, with `costRatio` in
  `cost-ratio.ts`. Comparing n with 8n fails too: the short run fits in one scheduler slice while
  the long one is preempted. Prove the bound by re-planting the defect.
- Redirect Bun test output before searching for `(fail)`. Terminal output uses a glyph instead of
  that word; stripping ANSI escapes cannot restore text that was never written.

## Inspecting recovered values

NEVER inspect recovered values through `JSON.stringify`: it maps `NaN` and infinities to `null` and
drops `undefined`. Use `Object.is` or inspect the value directly.

Assert shared-object identity with `toBe` or `Object.is`; deep equality cannot detect copied aliases.
Compare stream spans at the same delivery stage, or resolve them through the caller chunks: an early fragment can name the previous chunk's end before a later chunk exists, while a final match names the same boundary as the next chunk's origin.
Worker transfer cases must cover shared leaf objects as well as containers, while keeping distinct
objects with equal contents distinct.

## Memory

Make both retained-control and subject bounds reject non-finite readings; ordinary comparisons with NaN can otherwise pass both checks.

Keep an ownership proof in `artifact:check` when its installed probe already checks the same lifetime and bounds. Do not duplicate it with a shared-process heap assertion that cannot distinguish parser references from caller data held by native GC roots.
Generate large text with reused bounded binary scratch; unrelated fixture buffers must not dominate the returned-storage bound. Preserve input digests and the held-source control. If a heap failure lacks a retaining path, repeat the same fixture with a constant result before attributing it to the library.

Test retention as heap after a forced full collection, compared across input sizes an order of
magnitude apart: `Bun.gc(true)` on Bun, `gc()` under vitest (`--expose-gc` in `vitest.config.ts`).
Without the forced collection the reading is allocation churn, not retention.
Compare automatic disposal with explicit close on the same reachable owners before and after close,
not separately allocated groups; keep the retained-input control and heap bounds.
Compare absolute retained storage across input sizes at each promised release boundary; release deltas alone can pass when unwanted input stays alive throughout both samples.
Construct retention owners at the call site, outside async measurement; pass only that owner to measurement or consumption.
Read retained controls and validate recovery after the heap sample, before clearing either owner.
Observers and callers must share one mutable control owner; clear construction and validation aliases before returning that owner, because native frames can retain them after return. Clearing a copied field leaves the original reference unchanged.
Release each held control through that owner and collect before the next cohort's baseline; reclaiming an earlier control during the next measurement can hide the new control's storage. Reverse cohort order when a control fails to distinguish this interference from a subject failure.
For async heap probes, complete collection in a later host task before reading the counter; collection in the consumer's resumed native frame can retain its temporary references. Use an unrelated owner control before blaming retention on production code.
For Node async ownership probes, await `gc({ type: "major", execution: "async", flavor: "last-resort" })`, require its completion promise, then sample in a fresh task. Keep Deno's two-task collector until an alternative completes its actual packed probe; a startup control cannot prove that lifecycle. Preserve the retained-input control and bound.
Record caller-payload reachability when a process-wide heap bound fails; the byte delta alone cannot identify its owner. Keep the bound and retained control unchanged. Create WeakRefs only when reachability changes the diagnosis: construction temporarily roots the target too. Read needed weak references after the heap measurement.
Capture failed ownership samples before validation or throwing, with the measured owner still reachable; reading strings can change their backing representation, and unwinding can lose the retaining path.
Restore saved source in a separate command before deleting fault-probe scratch; a cleanup rejection must not leave the planted defect in place. Use absolute paths and verify the restored bytes before cleanup.

## Compile-held invariants

`envelope.types.ts` checks configured result shapes, rejected calls and override inference through the imported verbs.
Extend it instead of writing runtime tests for constraints the type system can enforce.
