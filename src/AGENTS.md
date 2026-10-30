# src/ — design invariants

These rules protect the core design. Root `AGENTS.md` wins on conflict; `HLD.md` owns guarantees and
`docs/API.md` owns the public contract. A later Rust catch-up must meet the recorded corpus.

## Reading input

- Read byte brands, dimensions and windows through native storage access, never caller-overridable methods or getters; direct, streaming and worker routes must consume the same visible bytes.
- Reject detached or out-of-bounds byte views through the existing typed input failure. Their brand survives and their native length can be zero; that must not make unreadable storage an empty chunk. Validate without caller hooks or writes, including when a shared view grows.
  Capture the initial visible byte count for resumed reads; stay inside it and fail if that range becomes unreadable. Keep available decoded and built recovery rather than treating a shrunken window as EOF or letting a native exception escape.
- **Scan once. The scanner calls the builder DIRECTLY.** No event bus: one consumer is a seam where
  nothing varies, paid per token in the hottest loop.
- **The scan buffer also owns diagnostic context.** Rewind by moving the cursor; keep the bytes.
  Streams and incremental whole-input byte scans may release consumed prefixes while preserving diagnostic context. Keeping bytes must not copy them: never grow a
  retained string with `+=` per slice, since each next `charCodeAt` flattens the whole rope again
  (quadratic: enough to exhaust V8's heap on a 4 MB input). Whole input re-slices its complete source
  (`LexicalWindow.append`); incremental byte scans compact between slices and retain decoded context separately.
- **No regex decides structure.** It cannot match nested delimiters. The scanner counts them;
  `invariants:check` enforces this on the AST. Run it before retaining new regex syntax: its ban
  covers every runtime module, including host adapters.
- **Detection is conservative; recovery is forgiving.** Detection evidence cannot depend on enabled
  repairs. A budget stop means unread input remains; it does not mean the source contains no JSON.
  A candidate rejected as prose takes its errors with it, and an error budget spent before the
  candidate shows a mark of data waits for that mark; `test/prose-candidacy.test.ts` holds both.
- **Brackets inside prose need a data mark.** A standalone or fenced value is a candidate. Inside
  prose, require a source colon, a quoted string, or multiple values. This is candidacy, not repair.
- **An input made only of values holds no prose, so every root stands alone.** A markless root may
  follow another across a line break when both are spelled as JSON spells values (plus JavaScript
  literals the policy reads). Never on one line otherwise: `[1] {"n":1}` is a label and `[1] [2]`
  a citation. Track the gap while it is consumed; its bytes can leave the buffer before the next
  root starts.
- **Values joined by a comma touching the first are one array (`missing-brackets`).** Every root
  waits for its next character, because a delivered value cannot be withdrawn; requiring the comma
  to touch keeps that wait to one character, so whitespace after a value settles it at once. Wrap
  the root only when a second value begins (`scan.ts` `wrapList`): a list of one must never exist,
  or a view shows `[root]` and then takes the brackets back.
- **An opener in a root object's first key position is a template marker, not JSON.** This overrides
  data marks. Apply it only to the first key at the candidate root; nested openers remain recovery.

## Building values

- **One insertion point for keys.** Apply dangerous-key policy there and use
  `Object.defineProperty`; assignment invokes the `__proto__` setter. Drop or reject only the
  dangerous member unless the public policy says otherwise.
- **Path reads require own-property checks.** `obj["__proto__"]` resolves through the prototype, so
  bracket lookup can leave the recovered tree even when writes are guarded. Walk with
  `Object.hasOwn` and stop on a missing member.
- **Identify data descriptors by their own `value` field.** Descriptor objects inherit from
  `Object.prototype`; `"value" in descriptor` can accept an accessor or invoke a polluted getter.
- Give attribute-only native descriptors a null prototype; inherited `value` fields can replace the data whose attributes are being changed.
- **Snapshots may expose string prefixes only.** A number prefix is another number; a bare-word or
  key prefix is no value. Rewind other tokens. Graft visible prefixes onto the snapshot copy, never
  the live tree.
- Refund retained content only against its matching ownership charge. Decoder tails remain parser-owned after fragment delivery; completing them must not create credit that bypasses a later storage limit.
- Apply retained-storage limits during stream scalar decoding, before banking a caller-sized chunk. In whole-input and stream calls, selection must not retain full decoded unrelated values; edits, root candidacy and cut metadata still keep the spelling they need.
- Selection's cut metadata is output too. Preserve withheld token text under the retained-storage bound; removing that text requires an HLD ruling, even when the token's value is unselected. Delivered fragments already belong to the caller and are not withheld text; repeating them would defeat bounded delivery.
- Bound retained text's backing storage independently of output limits. Own small input windows at entry and detach pieces and contexts from larger sources, even when output capacity is unlimited; a caller's short slice can hide arbitrarily large storage. Whole-input batching must preserve the smaller stream backing-store bound. Measure sparse selected results too: fewer copies can retain more neighboring source. Never copy the accumulated token prefix on every feed. Test numeric-to-word continuations, sliced input and closed views.
  A primitive `structuredClone` may return its input string unchanged. Prove backing-store release through retained-string controls on the host; clone availability alone proves no copy.
- Keep stopped string prefixes in failed recovery even without a view; eager occurrence delivery must not publish those prefixes as successful values. Cut metadata describes consumed unfinished content, never the caller-sized unread suffix.
- Fragment delivery cannot be retracted. Keep an ambiguous quote suffix charged against `maxRetained` and unpublished until its interpretation settles; EOF must not replay already delivered content.
- An unquoted value may deliver existing recovered-string fragments once no literal interpretation remains. Keep trailing whitespace and a possible high surrogate pending, preserve policy/report order and source offsets, and bound both active-chunk work and withheld storage. Keys and undecided root candidates keep their existing retention; this does not choose a source-fragment API.
- Keep fragment-only word draining in Picks. LexicalWindow owns word grammar and delegates delivery accounting. Check selection before constructing a drain prefix; repeatedly testing an unselected growing word copies its accumulated text.
- Keep decoded-fragment banking, word-tail finalization, state and delivery in its own selection implementation; StreamScalarReader delegates only for a streaming selection. Ordinary selected matches and streams without selection must not retain fragment emission or decoder-tail accounting. Share candidacy and match ordering through Picks rather than duplicating selection.
- Choose decoded delivery through imported decodedFragments, as source spelling uses sourceFragments; a Boolean switch on select makes its unused constructor reachable. Keep serialized corpus and worker mode flags unchanged.
- Raw quote-replay source remains input carry under `maxBuffer` after window compaction. Count only its released range outside the live window; decoded-value charges cannot bound retained escape spellings.
- **Append nothing to mark incompleteness unless the caller set `cutSuffix`.** An appended marker
  manufactures source content callers cannot tell from input; the `cut` record says where the value
  ended. The suffix goes only onto a cut STRING, at one insertion point per route, and only into a
  copy — never the live tree.
- **Retraction removes stale reports, then records the loss.** Otherwise a dropped member disappears
  from both the value and diagnostics.
- **Use one closer predicate in every parser state.** A mismatched closer still closes the current
  container, emits one edit, and reports one repair. Changed source meaning is never silent.

## Outcomes, policy and cost

- **Branch on typed tags, not prose.** Outcomes use `ok`; failures use literal `kind` fields. No
  `any`, exceptions for control flow, bare `Error`, or message parsing. Format English at the edge.
- When stopped processing has no live recovery, preserve the stored fallback from root filtering until a root has been accepted. Do not replace it with empty selected recovery or repeat earlier delivered roots.
  Keep its requested report before later candidates release the scanner logs; returning that value with an empty report hides its repairs.
- **A leniency flag OFF does not mean "unrecognised".** The construct is still CONSUMED, reported as
  an `unparsable-span` error instead of a repair. Refusing to recognise it would build a different
  tree per preset from the same bytes, so tightening a flag would change the VALUE too. Recognition
  preserves recoverable data, but any policy refusal fails the outcome even with diagnostics off.
  `maxErrors: 1` stops at the first policy error. Exceptions exist only where two values cannot both
  be produced: `allowJavaScript` for LITERALS (`undefined` or `"undefined"`), and the opt-in
  `leading-zero-number` (`0123` as 123, else its text through `invalid-number`, or at the root
  `unquoted-root-string`). A new one needs the same proof.
- **Compatibility follows legacy defaults, not preset names.** Read `docs/MIGRATION.md` before
  changing compatibility presets.
- Settle a numeric token's follower before converting its value or applying numeric policy. A prefix that continues as a word is governed by word recovery; abandoned numeric errors must not consume its error budget or stop the scan.
- Decide decimal syntax in the numeric token loop, including across chunks; value conversion must consume that verdict rather than serve as a second syntax recognizer. Source-only fragments need the same decision after delivered digits have been released.
- A numeric separator at EOF promises another digit in every radix: keep the token missing and preserve its source in the cut. Hexadecimal `e` and `b` are completed digits, but that exception must not accept a trailing underscore or spend numeric-policy errors on an unfinished value.
- **Report and selector state live only in imported feature owners.** `Report` owns diagnostics,
  `Picks` owns selected delivery, and `SkipFilter` owns skip-only path matching. Each
  is built only when asked for and reached through one optional field (`report?.`, `picks?.`). A
  report or selection field on `Builder` or `ScanDiagnostics` puts that work back on every parse and
  its code into every bundle.
  Keep filtering separate from delivery so importing `skip` cannot retain selected matches, fragments or views.
  Carry fragment-position history through the selection feature too; importing its implementation from the general stream owner retains it in streams that never select fragments.
  Report projection and overflow accounting also belong to the imported diagnostics feature;
  collection alone being optional still leaves report-only code in default outcomes. The
  tree-shaking owner must reject projection in default calls and retain it in the full control.
- **An engine must honour every requested capability.** `JSON.parse` collapses duplicate keys before
  a reviver sees them, so it cannot serve requested duplicate diagnostics. Decline that path when
  reports or numeric fidelity need more. Measure the COMPLETE path: a ratio on a tiny object measures
  fixed overhead, not throughput.
- Use a canonical integer token's digit count to prove certain overflow; preserve sign, leading-zero, separator and policy guards.
- **A call pays only for requested capabilities.** Keep streaming, reports, locations, edits, and
  selection out of paths that do not request them. Whole-input `parse` is not a one-chunk stream.
  Preserve the eligible `JSON.parse` fast path and measure complete public routes. A refusal or limit
  is not a report: with diagnostics off a refusal's `issue` still carries `line`, `column`, `context`
  and a byte- or chunk-unit offset, and a limit its `at` offset when the scanner knows it, so
  verdicts, budgets and position code stay on the default path.
- Close each whole-input reader in `finally` after projection, releasing its source, fallback, scanner and source-owned callback state. Returned values and positions must remain readable without that state; native frames can retain finished readers.
- Resolve stable host capabilities once into a concrete function; hot loops call it directly. Keep unused selection removable, so importing another feature does no setup work.
- **Freeze what is shared, never a per-snapshot copy.** Finished branches are shared between
  snapshots, so they are frozen once, when they close. The open-path copy and match list are private
  to one snapshot and stay unfrozen on every runtime: JavaScriptCore freezes at ~0.13 µs per element
  (17 ms per snapshot of a 100 000-wide open array), and HLD requires only that caller writes cannot
  reach parser state, which a private copy meets unfrozen. A per-runtime probe was rejected because browsers coarsen timers to ~1 ms. Fixed-shape
  records may stay frozen. `test/parser.test.ts` asserts the open path is unfrozen.
- **Copy containers with built-ins, never key by key.** `slice`, spread, and `Object.assign` onto a
  null-prototype target define own properties, so a `__proto__` member stays data; a loop through
  `defineOwn` makes a wide snapshot 50-100x slower.
- Append unbounded result batches with a loop, never call-argument spreading such as `push(...matches)`: host argument limits must not become hidden selection limits. Spreading into an array literal does not use call arguments.
- **Run `bun bench/ab.ts HEAD` before committing any edit to the scanner or its readers, however
  small.** JIT size limits make cost non-linear in code size, so a few behaviour-preserving lines can
  slow every scan with all gates green. Record material slowdowns beyond clean-control variation
  as later optimization work. `jit:check` diagnoses JavaScriptCore's inlining limit; speed alone
  never gates development, review or release.
- **A built-in parser may take input only after the pre-scan proves it gives the scanner's answer.**
  The differential test over the corpus and its prefixes is the proof; a route it does not cover
  stays on the scanner.

## Repairing text

- Returned repair strings must own their backing storage, including selected ranges and no-edit returns. A short projection must not keep unrelated source or splice text alive.
- **A synchronous facade drains resumable projection until `done`.** A work quantum can end before a
  phase does.
- **Repairs and edits are parallel records.** Repairs use human-facing locations; edits use byte
  spans. `repair(text)` applies edits in source order without reserialization and returns only the
  recovered value's span. Every source-changing scanner decision emits an edit. Test the whole
  returned text with `JSON.parse` and compare its value with recovery.

## Streaming

- Use shared-memory cancellation when available; otherwise service per-call cancellation messages through the existing cooperative executor. Missing shared memory alone does not make an available worker unusable, and a local stop must preserve siblings.
- **A transport adapter drives no scanner.** `transport.ts` alone owns source iteration, final tail,
  early closure, and abort. `parser.ts` owns build or refusal. Other stream shapes delegate to these
  paths. Keep imports from transport to parser type-only to avoid a cycle.
- **Check current platform bridges before adding an adapter.** Prefer standard composition when it
  preserves cancellation and backpressure. If it measures worse, first test whether this library
  breaks the bridge.
- **Every rewind retracts builder state to the same mark.** Pair the mark with the rewind target so
  replay cannot duplicate repairs or penalties.
- **Cancellation, host yielding, and backpressure are separate controls.** All executors check one
  operation-owned stop state. Same-thread work also yields for callbacks; pull acknowledgements bound
  demand. Apply the delivery budget to buffered EOF results too; consumer microtasks do not service
  host callbacks. Test cancellation from a queued host task, preserving unread recovery; synchronous
  abort inside the consumer does not prove callback liveness. Measure scheduler changes through
  `bench/async.ts` on public routes.
  Prefer an available explicit host-task wait over MessageChannel fallback; channel delivery alone
  does not prove queued timer service. Keep the packed browser/edge queued-cancellation case.
  Resumed callers must still share the host-task budget; resolving one wait must not grant every caller another scanner quantum. Bound admission without waking the whole backlog again on each turn.
  After creating a channel, a host yield MUST attempt both port closes before settling; preserve setup and cleanup failures.
  A failed host yield must stop chunk and buffered-EOF delivery with typed unread recovery, never a source-error label or rejected iteration.
- Capture an existing abort before listener setup; task wins an already-aborted tie. Unneeded host setup must not replace cancellation with a failure.
- Cancellation subscription or signal-read failures return typed `signal-failed` outcomes, including joined task/call signals. Setup failures consume no input; later failures preserve available recovery. Release partially acquired listeners and keep their cleanup causes; valid options must not turn host failures into thrown public calls.
- **Each async engine projects all whole-input verbs from one resumable operation.** A worker around
  a synchronous call cannot provide bounded cancellation; reparsing after progress can disagree with
  the stopped state.
  Charge validation stack unwinding and skipped inherited keys too; counting value visits alone
  leaves unbounded work after the last leaf or between own members.
- Nested mutable selected values must stay independent in failed recovery as in normal delivery.
  Use the resumable copier when stopped; an open container is not frozen merely because the mode
  freezes completed branches. Test parent writes against the separately selected child.
- Use cloned parent references and registered slots for worker metadata; repeating root paths grows with depth and key length. Freeze reference slots only after their identity links land. A settled scalar prefix may become readonly earlier, while its array is still packet-sized; the first readonly index can otherwise trigger width-sized native work. Counted property calls do not prove bounded native cost. Verify storage and receipt costs through installed routes.
  Worker byte requests must own only the caller's visible window and transfer that copy; never clone unrelated backing storage or detach caller-owned bytes.
  Exact numbers are leaf objects, not primitive scalars: restore each shared clone once and keep
  aliases across batches, including a selected parent and its separately selected numeric child.
  Once a shared container has a registered destination, later batches send a shell and identity
  link rather than cloning its payload again; light containers need this rule too.
  Batch identity links under the piece budget; one message per alias adds needless host turns.
- Before changing transfer planning for a synthetic graph, reproduce its alias identity and delivery
  order through a public caller; same-thread recovery is the oracle, not the fixture's assumptions.
- **Test worker failure through packed public calls on every host.** Observe errors and terminal
  events, including per-port `messageerror`; discard that call's worker state without stopping siblings.
  Restore caller-owned cancellation reasons at reception, including nested causes; structured clone
  cannot preserve functions, symbols or local object identity.
  Retain early failures until subscribers attach, close both channel ends, and settle every
  active call with a typed failure.
  Port listener registration and startup can fail before a request is sent; guard both through
  the same cleanup, release without waiting for acknowledgement, and prove the next call is usable.
  Retain startup release handles until the host release succeeds, so failure cleanup can retry.
  Allocate the shared stop cell before owning a channel so allocation failure cannot strand ports.
  If allocation, listener setup or request posting fails, return the typed failure with any cleanup cause; termination must not escape as a rejected public call.
  Cache only successful worker startup; failed attempts must preserve their typed reason and permit a later retry. Clear a failed cache entry only if it is still that attempt, so older waiters cannot erase a newer load.
  Own a worker until termination completes or its exit is observed; an error alone proves neither. After failed termination, unref an idle server worker so a settled failure cannot keep the process alive, and retain a live worker for cleanup retry before replacement.
  When the host reports port closure, stop that call without waiting for an impossible discard
  acknowledgement; the packed regression must settle without its fallback and preserve siblings.
- **Bound async scans with source slices, not a masked cursor length.** Lookahead reads retained text
  directly. Keep complete source only for diagnostics and compare every observable with one-shot
  parsing.
- **A stream holds what it has not delivered, never what it has seen.** Per-root facts live in one
  `FinishedRoot` record in a `RootLog`, released by the reader once delivered; a new array indexed
  by `valueIndex` grows forever on an endless stream. `test/stream-memory.test.ts` guards it.
  Clear delivered payload references immediately; deferred array compaction must not retain them.
- Fragment delivery must release obsolete source-position history too. Keep positions needed by open values, diagnostics and replay without retaining an entry for every delivered chunk; a single large scalar must not make mapping storage grow with everything already emitted. Preserve chunk-local byte/UTF-16 offsets at completion and on failure. Keep optional history traversal in stream code; methods on the shared lexical class can survive in ordinary parse bundles.
- A closed stream with a requested view keeps detached recovery readable through `snapshot()`.
  Detach that view when a limit stops processing, before clearing scanner state; preserving recovery must not retain the abandoned decoder or replay source until an explicit `close()`.
  Owned snapshots must copy mutable match records, spans and cut metadata from stored state, not only value trees.
  Retention checks must distinguish that view from abandoned scanner state; callers release the
  stream handle when they no longer need it. Preserve snapshots already held by the caller.
- **Every completed value is delivered exactly once.** `feed()` yields what its chunk completed,
  preceded by anything an earlier unread `feed()` completed; `end()` yields only what is still
  undelivered. Replaying delivered values duplicates consumer work; dropping unread ones loses data
  silently. Unread values count toward `maxRetained`. Test multiple roots across both drains.
- **A manual async-iterator wrapper calls `return()` in `finally`.** A `next()` loop does not inherit
  `for await` cleanup. Worker abandonment discards, waits for acknowledgement, then releases or
  terminates; signal cancellation still returns available recovery.
  Preserve a consumer's thrown cause even when disposal fails: aggregate the consumer cause first and cleanup second, with cleanup as `cause`; thrown `undefined` is still a cause.
- Caller listener removal must not prevent parser closure or producer cleanup. Attempt independent releases even when one throws, preserve each cause, and verify terminal iteration plus the shared `close()` result. Iteration reports removal failure before its final summary, secondary to any source failure or abort; later `close()` retains that cause.

## API shape

- Derive public settings from public types, then extend them with internal state. Omitting internal keys from an internal type still ships that type's reachable declaration graph.

- Capture every own named option once, including nonenumerable settings; wrappers must not use spread to discard a limit or policy before validation. Reuse the resolver for inherited settings and `copyOwnOptions` when separating execution or stream settings.
- Anchor patches to the enclosing function or block when branch text repeats; an identical condition does not identify its owner. Read the changed block and diff before verification.
- Commit added modules and callers affected by an internal interface change together. When the hook reports other dirty files, its pass covers the working tree; verify the committed dependency chain from a Git archive before claiming that revision builds.
- **Three objects, three lifetimes.** `Parser` holds immutable validated options. `StreamParser` is
  mutable and single-use for push sources. `ParsedStream` owns one pull operation, its view, and its
  cancellation. Keep counters outside shared parsers. `Parser` is a validation checkpoint, not an
  options cache; caching mutable option objects can return stale resolution.
- Reusable configuration must not import every operation. Pass its handle to the same imported verbs used for ordinary calls, preserving overrides and closed-parser failures; verify configured consumers separately from free calls. A returned method bundle keeps unrelated operations reachable and violates D5 even when free calls shake correctly.
- Configuration cleanup must remain usable as a detached callback. Moving state behind a class must not add a receiver requirement; keep that case in the lifecycle test.
- **A closed async parser must release its task signal without cancelling existing calls.** Keep
  execution closures separate from caller options and the original plan; clearing one signal
  binding can leave another reference alive. Measure retention with the closed parser still reachable.
- **Finished streams and whole-input iterators release caller input, signals and stored reasons.** Keep
  reasons until terminal delivery and cleanup; whole-input handles then drop their private generator.
  An unstarted generator skips `finally`, so its `return` and `throw` paths must release it too.
- Keep the same operation name for ordinary and configured calls (HLD D3); `test/envelope.types.ts`
  verifies configured result shapes and override inference through those imported verbs.
- **`init` creates shared immutable configuration; `create` creates mutable single-use state.** Keep
  the verbs distinct because they teach the object's lifetime.
- **Returned object methods are retained together by bundlers.** Each imported verb must invoke only
  its resolved operation, including calls with reusable configuration. `treeshake:check` gates unused repair and streaming code.
  Keep reader projections as free functions too: a retained state class keeps unrelated prototype
  methods in consumers that never call them.
- **A module does no work at import; only the worker entry may.** A bundler keeps every statement
  that runs on load, so a module with one ships in apps that never call it (HLD D5). Build a value in
  a function called once as `/* @__PURE__ */ f(...)` with literal arguments; `invariants:check`
  enforces this on the AST.
  Keep optional subclass setup inside the imported feature's pure factory so Rspack can remove its superclass dependencies; check packed unused-import and no-metadata consumers when adding one.
- Declare URL-loaded modules as explicit producer entries; source-runtime resolution does not prove that the packed package emits them.
- Check worker host prerequisites before loading deployment assets; a missing asset must not turn an unsupported host into a loading failure. Verify both causes through packed platform calls.
