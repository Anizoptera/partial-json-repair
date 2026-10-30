# High-level design

This is the sole authority for high-level design. The maintainer role alone owns it. Agents MUST
read it before planning or changing this repository. Every meaning-changing edit requires the
maintainer's approval of the exact delta, with one exception: a sentence that makes the library refuse
JSON it can recover contradicts the Mission, P1 and P5, so replace it with reported recovery without
asking, and name the exact delta in the commit and to the maintainer. Refusing text P2 judges not to
be JSON is not covered.

## Mission

Recover usable data from JSON that is damaged, cut off, or buried in other text, preserving source
content rather than inventing it.

## Priorities

Conflicts resolve top-down.

- P1. Preserve source content rather than guess missing values; finish missing structure, and keep any permitted conversion or loss inspectable so callers can judge the recovered data.
- P2. Be strict about whether text holds JSON at all, and forgiving about how to read it once that
  is settled. A wrong yes turns `see [1] for the citation` into data; a wrong no only costs a
  recovery we might have made.
- P3. Every runtime gives the same answer for the same input; only the route differs. Falling back
  to another implementation must be invisible in the data, or it is not a fallback, it is a
  different library.
- P4. The default path returns recovered data with an explicit success or failure outcome; repair diagnostics are opt-in so ordinary calls do not pay for explanations they did not request. When the input holds a value after the one returned, the success outcome says so without a requested report, so a caller reading only the value can tell a later value exists.
- P5. Recover something rather than nothing. A partial value the caller can inspect beats a failure
  they cannot act on.
- P6. Speed, memory and size are features we keep improving, never a box we tick: measure on every
  runtime, and let a memory or size loss ship only when somebody chose it and wrote down why. Nobody notices a few
  percent lost at a time until the sum is unrecoverable. Every path aims to match or beat the best
  implementation available for the same job; where it does not, the reason is written down rather
  than assumed.
- P7. Every way a user can reach this library is measured as its own product: each runtime, and each
  way of crossing into native code. A number from one path tells you nothing about another.

Slowness alone never blocks development, review or release. Record timing misses and unknown causes
as later optimization work; keep measured limits and user impact visible without requiring a fix or
complete attribution before other work can finish. Correctness, data preservation, resource ownership
and working cancellation remain required independently of speed.

## Native and WASM (deferred)

The first npm release ships only the TypeScript implementation; the Rust code and its native and
WASM builds stay in the repository, outside the release gate, and return only by meeting the current
recorded cases.

## Purpose

- The library is designed first for imperfect machine-generated JSON, especially streamed LLM
  output. It also accepts any untrusted text or bytes containing JSON; the source does not change
  parsing semantics.
- Recover one deterministic best value. Whatever was invented, lost or uncertain stays available to
  a caller who asks for it, so they can accept, retry or reject.
- Recovery is open-ended: each plausible malformed form gets a named, reportable recovery kind with
  independent policy control. A spelling is never its own HLD decision.

## Impact

- The package is public under the Anizoptera brand on npm. Its only name is
  `partial-json-repair`; `@anizoptera/recover-json` is an alias package for search.
- Simple calls and reusable parsers share behavior, so convenience does not create a second implementation.
- Configured JavaScript parsers expose idempotent `close()` and standard disposal; calls after close
  return a typed failure. `close()` preserves its first typed cleanup result; standard disposal
  performs the same release but cannot report that result. Rust uses ordinary ownership and `Drop`
  where resources need cleanup rather than adding a no-op method.
- Failures use typed unions.
- Invalid options are the caller's bug: the types reject every misuse they can express, and the rest
  throws a TypeError with the typed reason attached before any input is read; every other failure is
  a typed result.
- Every recovered value says whether its source ended before the value finished and, if so, where and
  what kind of thing was cut; the value itself is never changed to show this unless the caller asks
  for a suffix on cut strings.
- JavaScript operation results use plain objects with `ok: true` and `value`, or `ok: false` and a typed `failure`, so result state cannot be confused with fields inside parsed data.
- The parsing API does not accept an unchecked caller-supplied result type; callers may assert their own types outside the library.
- When a limit stops recovery, return the recovered data with a typed indication that processing stopped, even when diagnostics are off.
- A strict-policy refusal is never an ordinary success; any recovered value remains available only with that refusal.
- When the source fails, expose any recoverable prefix separately from the source failure; do not report normal completion.
- Ordinary mode uses floating-point arithmetic for fractional numbers; callers request exact mode when decimal approximation is unacceptable.
- Overflow, underflow, and integers that cannot be represented exactly return an exact-number value, not a rounded value.
- Exact numbers support checked conversion and lossless JSON output, because preserving digits only in memory is insufficient.
- `repair` returns valid JSON for the recovered candidate, preserving source spelling outside required edits; a recovered value JSON cannot spell (NaN, an infinity, undefined) is written as null, keeping its key or array position, and each such conversion is a reported repair.
- Objects keep the last duplicate value; requested diagnostics report the duplicate, while repaired text preserves member order where no edit requires a change.
- Dangerous keys are ordinary data by default and never change prototypes; callers may instead drop those members or refuse their containing object.
- Byte input is UTF-8; recover malformed sequences with replacement characters and optional location reports, but refuse a declared unsupported encoding.
- Preserve lone surrogate code units in strings and keys across engines; conversion to a host type that cannot hold them must be checked.
- Diagnostics — what was repaired, the confidence, the errors — are collected only when the caller
  explicitly asks, never on the default path. Metadata the repair process itself needs is kept
  regardless.
- A call pays only for the capabilities it requests: the library takes the fastest route available
  for that set, so not asking for streaming, diagnostics, locations or selection costs nothing.
- A requested repair report includes duplicate keys; an engine that cannot report them must decline that request.
- If a diagnostic limit is reached, continue recovering data and mark the report incomplete.
- Callers can select nested values without building unrelated values.
- Selection returns final values by default; early source occurrences require an explicit request.
- Skipping removes named object members; array subsets are returned as selected matches with their source positions.
- With selection, diagnostics describe the selected results and the recovery needed to find them; auditing skipped content is a separate opt-in.
- Requested stream summaries and unmatched selectors are delivered through the iteration, including when no values match.
- Each completed stream value is delivered exactly once, even when the caller skipped reading an
  earlier `feed()`; unread values count toward the retained-results limit, and reaching it fails the
  stream with a typed reason instead of dropping data.
- Later input may revise an unfinished value, but must not mutate a snapshot the caller already holds.
- JavaScript live views must prevent caller writes from changing parser state.
- For mixed text-and-byte streams, positions identify the original chunk and an offset in that chunk's own units.
- The first public API includes incremental processing of selected scalar contents without retaining the whole scalar.
- Scalar fragments describe source occurrences rather than final object membership, because later duplicate keys may replace already delivered content.
- Stop reading when the consumer stops, release parser-owned resources, and expose source, cancellation, and cleanup failures without claiming control over an arbitrary producer.
- Resource limits name the work or storage they bound; input buffering alone does not bound retained results, reports, or snapshots.
- Deferred with native and WASM: Rust programs use this as an ordinary Rust library, not only as the engine behind the JavaScript
  package.
- Deferred with native and WASM: Rust supports optional Serde and async-stream integrations; the recovery core has no required third-party dependencies or executor.
- Deferred with native and WASM: The JavaScript package works with no native binary present and picks a faster one when it is
  there. Callers get the best available speed without choosing, and can still force a specific one.
- Synchronous JavaScript whole-input calls stay on the direct TypeScript path. They do not accept an
  abort signal because a same-thread signal callback cannot interrupt work that already owns that thread.
- A separate JavaScript async entry exposes whole-input async calls and configured async parsers.
  One planner chooses an engine and an execution strategy before consuming input, using requested
  capabilities, workload, available host facilities, worker readiness, and measured policy. Engine
  selection remains independent from execution placement. Automatic execution may keep proven-small
  work inline; callers may instead require cooperative scheduling or a worker. An unavailable forced
  choice returns a typed failure before consuming input.
- Async calls take a required execution strategy, imported as a value, so an app ships only the
  strategies it names: `auto` runs on the main thread (proven-small work inline, the rest
  cooperatively), `cooperative` always yields, `worker` runs in a background worker. A strategy
  failure says in words what failed and what to do. Automatic worker placement, once measured faster,
  is a further imported strategy that may start a worker by itself and uses it once ready; until
  then, or if the worker can't load, it runs on the main thread with no error.
- Async recovery is resumable at bounded scanner checkpoints. Every execution strategy observes one
  cooperative cancellation state and returns a typed failed outcome with any recovery already
  available. Same-thread work also yields to the host task queue at a measured cadence so callbacks
  can run. Background work does not yield merely to protect the caller's event loop when its stop
  state is independently observable; a message-driven worker still services the control channel that
  makes cancellation observable. Main-loop work targets at most 4 ms between yields, records a
  warning above 8 ms, and flags an optimization opportunity above 32 ms. These are consumer
  responsiveness targets, not release gates or physical constants; missing them alone never makes a
  route unacceptable. Stopped work never becomes success or silently reruns
  through another engine or execution strategy.
- The JavaScript package supports Node, Bun, Deno, current browsers and edge runtimes; where a host
  has no workers, async work runs on the same thread.
- Each is covered at named releases, not across a range: for Node the current and previous
  long-term-support releases and the current latest; for Bun the latest and the latest of the
  previous minor line; for Deno the latest; for browsers the current WebKit and Chromium engines; for
  edge the current Cloudflare workerd.
- Type declarations support the newest release of TypeScript 6, the last with the classic compiler, and of each major from 7 on released in the two years before the package release — at most the three newest, always including the latest.
- Deferred with native and WASM: Every reasonably useful WASM variant ships separately; none is cut down to fit another. Between
  them they serve browsers, edge runtimes, the JavaScript runtimes, standalone WASM hosts, and
  languages other than JavaScript and Rust.
- Deferred with native and WASM: The package offers what the best variant the host can take is able to do, not only what every
  variant shares, and steps down when the host cannot take one.
- The published comparison covers every runtime we ship and the best implementations available for
  the same job in any language, so a reader sees what they would actually get rather than one
  convenient number.

## Topology

- Two implementations of the same behaviour: TypeScript, and Rust, which also builds to native code
  and to WASM.
- One shared set of recorded cases holds the two to the same answers.
- Each shipped route is measured on its own; until native and WASM return, the TypeScript package is
  the only shipped route.

## One-way doors

- The Rust crate uses `partial-json-repair`; native and WASM artifacts retain that name with target or capability suffixes so bindings do not create another product identity.
- The first public API does not include deferred field access backed by retained source text.
- The first public API does not replace selected values during parsing; caller transformations remain separate from recovery.
- The first public API does not export parser state for restoration after a process restart.
- Version starts at `0.1.0`. This is the only free public-API consolidation point.
- License is Apache-2.0. The only borrowed code is test examples.
- Borrowed test examples may use MIT, ISC or BSD-2-Clause; retain each source’s required notices.
- For incompatible licenses, create original examples inspired by the cases instead of copying them.
- Test-example license obligations must not add unnecessary burden to published TypeScript or Rust packages.

## Permissions

- No remote creation, push, publication, tag, visibility change, or release without separate
  maintainer permission for that exact operation.
- Completion starts maintainer review; it is not release readiness.

## API rules

D1. Do not remove useful behavior or weaken correctness to make the API easier.

D2. Each common task must have one obvious import and one obvious function, with useful defaults and
no setup.

D3. Use one name for each thing and one verb for each action everywhere.

D4. Shortcuts may remove setup only. They must use the same code and behavior as the main API.

D5. If an app uses one feature, its optimized build must contain only that feature and the shared
code it needs. Other statically unused features must add zero bytes and do zero initialization work
with a supported bundler. Supported bundlers include Vite, webpack, Rspack, esbuild, Rolldown and
Bun.build, each measured on the packed package; a bundler that removes unused code as well as these
is supported too.

For the first TypeScript release, generic worker assets may retain code for worker-supported recovery operations and features the app does not use. All other D5 requirements still apply.

### Why

D1. A small-looking API is not simple if it moves work or risk to every caller. Correctness and useful
behavior come first.

D2. A low-level-only API repeats setup everywhere. One giant API makes simple work noisy. Simple
functions for common tasks, with separate advanced controls, avoid both problems.

D3. Aliases make the first guess easier, but every later search has several answers. This wastes more
time for people and coding agents than it saves.

D4. No shortcuts means repeated boilerplate. Separate shortcut logic drifts. Thin wrappers remove
boilerplate without creating another behavior.

D5. Good tree shaking leaves only the code needed by the features an app uses. One giant entry can pull
in unused code or run unused setup. One import path per symbol creates clutter and can still hide
coupling. Group exports by real features, keep modules free of import-time work, and share common code
once.
