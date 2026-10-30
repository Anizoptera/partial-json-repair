Keep outcome separate from recovered data so callers can handle failure without guessing from the data's shape.

# HLD and API review

`HLD.md` owns the design choices; `docs/API.md` owns their public contracts. This review preserves
the counterexamples, alternatives, and evidence limits behind them. Recorded probes describe the
implementation tested during the review; they are regression cases, not a claim about later code.

## Core rationale

### Byte cost of the recovery contract

Keep the required recovery and ownership mechanisms when setting the byte reference; the smaller
`6dd559b` implementation is not a valid substitute. On Bun 1.4.3 it accepts caller-overridden byte
slices, invokes shadowed dimensions, rejects genuine cross-realm bytes and throws on revoked proxies.
Those counterexamples justify correction, not every additional byte.

| Consumer | Why the retained mechanism is needed |
| --- | --- |
| Parse and locations | Native byte windows, settled numeric/word syntax and owned source pieces preserve the actual input and usable failure positions. |
| Stream views | Resumable decoding, retained-content bounds and detached snapshots preserve earlier deliveries and release abandoned input. |
| Selection | Final duplicate membership, selected scalar delivery and independent overlapping values preserve the requested data on success and failure. |
| Reports and metrics | Optional feature owners keep their work out of ordinary calls while sharing the corrected recognizer. |
| Async and workers | Cancellation, cleanup and bounded reply assembly preserve partial recovery, aliases and scalar fidelity without one indivisible whole-result transfer. |
| Parser fallback | Identify a local native Promise or a callable `then` before observing native rejection. Borrowed `then` observes foreign native rejections without invoking custom thenables; a receiver TypeError is expected for a non-native thenable. Preserve non-TypeError construction failures. Ordinary data must not pay for a throwing native-brand probe. Deliberately hidden foreign Promise identity remains outside the API's classification guarantee. |

Keep optional features in removable owners rather than duplicate the recognizer. Lazy imports alone
do not remove emitted code; producer minification must preserve the complete consumer graph.
The measured per-import costs are an engineering choice under P1–P6, not a claim that this design
is optimal. Keep the existing future-growth guard and all D5 checks. Reopen the choice when a
smaller complete consumer preserves these obligations; speed and memory need their own evidence.

### Async admission and iteration cost

Keep serial admission and direct cooperative iteration so resumed callers share the host-task budget
without a forwarding generator for every delivered root. A shared wake-all wait grants each queued
caller another scanner quantum; explicit queue storage adds another ownership mechanism. The native
promise chain keeps admission ordered and releases its state when the last waiter leaves. Terminal
delivery still closes the scanner and releases its public owner before exposing the result.

Accept the measured consumer-size reference for this design under P6, keeping the future-growth
margin and all feature-removal checks. The packed Node 26.12.1 comparison at `a262a5f` counts fewer
promises through the public many-root route; the high-fan-out comparison at `ebd0d9d` does not establish
a storage saving. Retain ordered resumption despite possible higher transient heap; reducing that
peak must preserve the shared turn budget and release after callers drop their results. Neither comparison
proves a throughput ranking. Timing misses remain later optimization work under HLD priorities.
Reopen this choice when a simpler complete route preserves admission, cancellation, terminal cleanup
and failure recovery at lower measured cost.

### Runtime cost of source ownership

Keep native byte-window validation and detached returned text, accepting their work over the older
source-sharing implementation. Correct visible bytes, lone surrogates and release of unrelated
backing storage take priority over that implementation's faster stream calls. Shared slices cannot
provide that release. Node and Deno use bounded flat code-unit copies for short strings to avoid
native clone setup on each small stream chunk or selected repair match; longer strings and other
hosts keep the existing copier.
Local code-unit arrays construct each short value in one call, avoiding repeated concatenation and
shared mutable scratch. Preserve measured ownership costs and timing misses as optimization evidence;
slowness alone never blocks release.

Keep known-escape batching: it avoids returning to the scalar decoder for each escape. The
equal-input source comparison at `ed66cb5` preserves outcomes and favors batching for escaped
streams on Bun 1.4.3 and Node 24.22.0. Removing it favors Node's plain-string control instead;
retain the escaped-input gain rather than optimize that control at its expense. This decision
accepts that trade-off without establishing a shipped speed ranking. Record responsiveness misses
as later optimization work. Revisit it
when a complete-route alternative preserves the escaped gain without the plain-input cost.

### R4 — Preserve source fidelity without promising automatic awareness

> Recover usable data from JSON that is damaged, cut off, or buried in other text, preserving source content rather than inventing it.

Why: the mission should state the value that survives a redesign, not the reporting switch.
P1 supplies the content-fidelity priority; P4 separately decides how callers request explanations.
An outcome distinguishes success from failure without claiming that the value reveals its repair
history. Numeric conversion has its own policy; the mission alone does not choose one.

Alternative: a mandatory alteration tag would improve default awareness of recovery, but adds
information beyond the success/failure outcome. A mandatory full report costs more; P4 keeps
that explanation optional. Making optional reporting the mission would obscure source fidelity.

### R2 — Live views: distinguish a stable snapshot from a final value

> Later input may revise an unfinished value, but must not mutate a snapshot the caller already holds.

Why: after `{"a":1,` a view can contain `a: 1`; a later `"a":2}` requires `a: 2` under
the last-key-wins policy. The old snapshot can remain immutable while the next view
differs. Immutable snapshots do not imply monotonic data.

Alternative: withhold revisable members until their containing object closes; this preserves
monotonic output but delays the main streaming-UI use case. Keeping the first duplicate instead
changes final parsing semantics and is a separate decision.

### R3 — Limits: stopping is part of the result

> When a limit stops recovery, return the recovered data with a typed indication that processing stopped, even when diagnostics are off.

Why: hiding errors must not turn a stopped scan into apparent completion; discarding the recovered
prefix would conflict with P5. A stop indication is necessary result state, not an optional report.

Alternative: return only a typed failure on a limit, which is simpler but discards a recoverable
prefix; or return only the prefix, which conceals whether more source was examined.

## Findings, ordered by consequence

Counterexamples identify behavior to test; a specified guarantee is not evidence of implementation.

### F1 — Optional diagnostics cannot promise automatic notice of loss

P4 makes reports optional. The ordinary outcome must expose refusal or stopped processing, but
does not explain every alteration. Numeric fidelity therefore needs a policy independent of reporting.

Measured: `parse('{"id":9007199254740993}')` returns `9007199254740992` with a precision-loss
repair. `parse('1e400')` returns infinity with a repair; `parse('1e-400')` returns zero with none.
The tested implementation reports by default; the chosen API makes that report optional. These
observations do not approve rounding. Exact integers, ordinary decimal rounding, overflow, underflow, and signed
zero must be considered separately; “exact numbers” implemented as `bigint` cannot cover fractions.

**Chosen contract:** ordinary fractions use floating point; inexact integers, overflow, and underflow
use exact-number values. Exact mode preserves every numeric token. Normal numbers reduce caller
burden; exact values protect identifiers and arithmetic but require checked conversion and lossless
serialization. These are explicit design choices, not consequences uniquely determined by P1.

### F2 — Optional diagnostics must not erase refusal or incomplete examination

Measured: `parse('{"a":1,}', STRICT)` returns `ok: true`, value `{a:1}`, confidence `1`,
`errorsComplete: false`, and `error-budget` in the errors. Turning the report off without moving
the stop indication into the ordinary result makes strictness invisible to a normal caller.
Likewise malformed UTF-8 changes the returned string while confidence stays `1`: confidence is
a repair-score, not a guarantee of validity, complete examination, or source fidelity.

The minimal separation is recovered data, processing outcome, and optional explanation. It need
not be three objects or three booleans. No value, JSON null, an unfinished value, a policy refusal,
a source failure, and an abort cannot all collapse into a successful empty iteration. A terminal
summary is also where unmatched selectors can become known; no match can be declared final while
an infinite source remains open. Early consumers have only the examined prefix.

**Derived requirement:** preserve the ordinary outcome without collecting the optional report.
The API places recoverable data under a failed outcome and delivers requested terminal summaries
through iteration, including streams with no selected matches.

### F3 — Host string conversion can violate fallback equivalence

The UTF-8 bytes spelling `"\ud800"` refute replacing lone surrogates only in Rust: JavaScript
can return the surrogate, so that conversion would give the same bytes a different value.
The distinction between string input and byte input does not resolve this escaped-byte case.
Measured separately: encoding a JavaScript string containing a raw lone surrogate with
`TextEncoder` changes code unit 55296 to 65533 before a native parser sees it.

Rust's ordinary `String` requires valid UTF-8; Rust itself is not restricted to that type.
Code units, retained escapes, or a dedicated value representation can preserve the distinction.
Alternatively, a native JavaScript engine can decline that input and use TypeScript. A different
normalization policy for every engine would weaken P3 and needs an explicit ruling.
See the [Rust String contract](https://doc.rust-lang.org/std/string/struct.String.html) and
[Encoding Standard](https://encoding.spec.whatwg.org/#interface-textencoder).

**Chosen contract:** retain P3; treat faithful representation as a condition of engine eligibility.
Define the shared value domain before selecting the Rust public value type. Typed Serde conversion
may fail after recovery succeeds; that must not redefine the recovered value or silently replace it.

### F4 — Stable snapshots and append-only results are different promises

Measured: feed `{"a":1,`, retain a frozen view, then feed `"a":2,`. The retained view still has
`a:1`; the next has `a:2`. This disproves “nothing already shown ever changes,” not snapshot
immutability. A later duplicate can also replace an entire earlier subtree.

Selection makes the problem deeper. For `{"a":{"id":1},"a":{"id":2}}`, immediately emitting
both `/a/id` occurrences does not equal selecting from the final last-key-wins object. The API
uses delayed final matches by default and explicit source occurrences for early delivery. A
revision protocol is another viable design, but requires consumers to process replacements.

The rejected changed-path shortcut needs more than the old and new cursor. If both pulls
end at `/items`, but the intervening input completed one item and added another, the path is only
a conservative invalidation region. The API uses shared branch identities instead. A separate
change-path API would need rules for root replacement, multiple roots, no change, and per-observer
history. A single path
can safely over-invalidate; it cannot promise that every descendant changed or that reading only
the two endpoints always identifies the edits.

### F5 — Snapshot cost depends on width; a JavaScript callback cannot enforce borrowing

Copying an ordinary array or object copies its entries, not just its pointer. The tested implementation
loops over every key in each open container. Cost is proportional to the sum of those widths;
a growing root array has depth one and arbitrarily many entries. Pulling after each append can
therefore copy a quadratic total number of entries. First use also freezes completed branches.
An explicit persistent representation or change stream can avoid that copying, at different
interface and implementation costs; ordinary shallow copying cannot.

A JavaScript callback does not enforce borrowing. The executable counterexample assigns its
argument to an outer variable and mutates the original object afterward, with no cast needed
to assign a readonly reference to a mutable structural type. Returning a Promise or reentering
`feed()` creates further lifetime problems. Rust borrowing proves a Rust lifetime, not a JS one.

“A person reads it” does not bound incoming traffic: a cached response, replay, many concurrent
generations, or a large embedding beside a small selected status can be fast. Native code need
not resend the whole tree: it can send changes to a stable JS-side projection. That is a viable
alternative, not a reason to build it now. Keep engine choice contingent on measured total cost.

### F6 — A buffer limit does not bound retained results or a single growing value

Measured with `maxBuffer:64`: feeding a quoted string in small chunks successfully builds a
1024-character value. The option bounds the source window, not the tree. A second probe hands
two values back from `feed()` and gets both again from `end()`; the tested implementation retains
them. The API requires tail-only `end()` delivery; that requirement is not evidence of a working change.

The memory account must include undecided input, open values, diagnostics, selector state, queued
results, retained source slices, and native buffers. Skipping removes the output subtree; it does
not remove the work of recognizing its boundaries or the storage cost of its requested report.
Streaming a million small selected records is bounded only if delivered records and past reports
are released, and no selected ancestor requires retaining them. One huge selected record still
requires space proportional to that record unless the public surface supports smaller pieces.

Do not promise constant memory without naming what may grow. The API's `maxRetained` separately
bounds parser-owned recovered content in logical units; neither bound measures total process memory.

### F7 — Cancellation cannot preempt arbitrary synchronous work or force an upstream close

A same-thread abort callback cannot run while a synchronous scan owns that thread. Slicing allows
yielding between calls; it does not enforce a wall-clock deadline inside one call. A worker,
cooperative checkpoints with scheduling, or shared cancellation state changes those conditions.

Cancellation must stop buffered deliveries too: a second value may already be available without
another source read. Calling `return()` cannot preempt an arbitrary producer's pending `await`;
the adapter needs producer cooperation to settle that read and acknowledge its cleanup.

The library can stop its own delivery, request source cancellation, and release resources it owns;
it cannot guarantee that an arbitrary source cooperates or closes a socket. Node even exposes an
iterator mode that deliberately preserves the stream on return; see
[Node stream iteration](https://nodejs.org/api/stream.html#readableiteratoroptions).
The API separates stopped delivery from acknowledged cleanup and retains cleanup failures.
The source adapter must state which cleanup it owns; method presence alone proves no guarantee.

### F7a — Async whole-input work needs one planner over separate engine and execution choices

Keep direct synchronous TypeScript calls for the lowest-overhead local path. Put `parseAsync`,
`parseManyAsync`, `repairAsync`, `findJsonSpanAsync`, and `initAsyncParser` in
`partial-json-repair/async`, so worker and native adapters add no imports, initialization, or I/O to
the core entry.

Every async call uses one operation protocol and one planner. The planner selects an engine and,
independently, an execution strategy before consuming input. Automatic execution may run
proven-small work inline, resume TypeScript at bounded checkpoints with cooperative host scheduling,
or use a lazy bounded reusable worker. A native engine uses host background work and observes the
same scanner cancellation state. Callers may constrain execution to `cooperative` or `worker`; inline
is an automatic optimization rather than a promise callers can force, and native remains an engine.

Cooperative cancellation does not require every executor to yield to a host task queue. Same-thread
TypeScript batches scanner advances between measured yields because its abort callback shares that
thread. A worker using message-driven cancellation must service its own event loop; a worker or native
task with an independently observable per-operation cancellation cell can poll it between scanner
advances and continue without scheduler yields. Parse-many backpressure remains a separate demand
boundary and may pause delivery even when cancellation polling itself is continuous.

One executor cannot optimize every workload: unconditional scheduling taxes tiny calls, cooperative
slices retain main-thread work, shared cancellation adds setup and atomic reads, and workers add
startup, transfer, queue, and lifecycle costs. Worker warmth can change the crossover without changing
the interface. Compare fixed-unit, elapsed-budget and adaptive quanta over complete routes and every
terminal projection. Thresholds therefore come from workload shape, requested features and measured
scheduler cost, not from input length alone or a guessed constant. Expose a caller tuning option only
if those measurements show a stable user-controlled need that `execution` cannot express; that would
require an HLD change before implementation.

Keep the candidates on independent axes: inline eligibility; fixed, elapsed, cost-weighted or adaptive
same-thread quanta; host task primitive; message, shared-atomic or native-owned cancellation; strict or
windowed parse-many demand; and automatic, preset, deadline or numeric public control. Compare coherent
compositions: inline proven-small work; batched same-thread work; reused workers with atomic cancellation;
native background work with evented completion; and portable message-driven workers. Keep a simple fixed
batch as a full rival after pricing clock reads, adaptive state and branches through complete calls.

Build one resumable whole-operation primitive for parse, parse-many, repair, and span before adding
executors. Each executor advances that primitive, observes the same stop state, and returns the same
typed aborted outcome with available recovery. Reusing only the existing stream facade would leave
repair and span on separate mechanisms and would invite a second parse. Once work begins, neither
engine nor execution strategy changes; fallback is allowed only before input consumption.

### F7b — Automatic placement needs host-specific evidence

Keep `auto` inline for proven-small input and cooperative otherwise; workers remain explicit.
The installed selected-scalar comparisons favor reused workers but delay cold calls. Equal-length,
equal-option early-root input instead favors cooperative calls, so readiness plus length and options
cannot distinguish those jobs. The narrower quoted-string span candidate also exceeds the
responsiveness target. Retain those timing costs for later optimization; they do not block release.
No general profitable placement rule is established; this is not a claim that workers never pay.
A worker runs the same scan as the cooperative executor and adds input and result transfer,
plus restoration of frozen, null-prototype and exact-number metadata in the receiving realm.
Cooperative adds slicing and host yields instead.

Use `bench/async.ts` to compare equivalent packed calls with matching inputs and oracle agreement.
Source-only timings and unconverged samples under contention cannot establish an installed-route
ranking. Separate cold startup from reused-worker calls, and compare complete-call cost, caller
responsiveness, cancellation and storage for each host and workload before choosing placement.
Treat worker construction as indivisible host work: Deno's Node-compatible constructor waits synchronously for its worker runtime. Deferring the call does not make that wait interruptible; worker CPU in a process total does not locate caller work. Any replacement must preserve reuse, idle process exit and failed-call cleanup.

Alternatives and their evidence requirements:

- A universal size threshold would ignore differences in host startup and transfer costs.
- Reopen operation/runtime placement when a pre-consumption predicate separates profitable work
  and installed calls qualify startup, storage, cancellation and responsiveness on that class.
- Learning the crossover from earlier calls in the realm: auto would have to run a worker before
  knowing it pays, and the choice must be fixed before input is read.

Callers can require `{ execution: worker }` to move work off the calling thread. Automatic placement
needs workload and host measurements that can distinguish this benefit from startup and transfer
costs; source-only timings and universal cross-runtime thresholds cannot establish that policy.

Split large worker results because structured-clone receipt and reconstruction also occupy the
calling thread. `src/async-worker.ts` sends one piece per pull, and `src/worker-executor.ts` requests
the next after assembling it, preventing the sender from queuing the entire result at once.
That protocol does not itself prove a responsiveness bound: measure cloning, assembly, metadata
restoration and garbage collection through the complete installed route, including large keys,
deep paths and overlapping selected values. A small receipt time alone cannot clear those costs.
Append received array values instead of reserving the final length. Full reservation reduces some
receiver pauses but slows later indexed reads on Bun. Reconsider it only with complete caller-cost
evidence; interrupted recovery must expose only received indexes and preserve frozen metadata.

Keep identity shells for containers already assigned a receiver slot instead of cloning their
payload again. Copy only wrappers needed to place those links; preserve the original frozen tree.
Converged paired overlapping-exact-selection calls favor this on their named Bun, Node and Deno
releases. Cold timings and sampled RSS are mixed, including Node increases. Accept the wrapper,
slot and byte costs for avoiding repeated payload transfer and improving that repeated-call job;
this establishes neither a memory ceiling nor large-reply responsiveness. Reopen the choice for a
complete-route alternative that preserves aliases, frozen metadata and received-prefix recovery.

### F8 — Selection requires cardinality, ownership, and completion semantics

The contract must cover overlapping ancestors and descendants, duplicate selectors, duplicate
source keys, source order versus completion order, selectors spanning multiple root values,
zero matches versus no JSON, and `findJsonSpan` with selection. A scalar `parse()` becoming a list
because a setting is supplied needs complete types and call sites. The same applies to `repair()`
returning multiple texts and live views of selected values; the API owns these contracts.

Skipped damage is not free to report. Duplicate-key reporting in a skipped object needs enough
state to recognize duplicates, even if no values are built. If the report covers a whole root,
a match emitted before the root finishes cannot carry that final report. If it covers only the
match, it cannot claim whole-document confidence. An aggregate report needs a terminal channel
or an explicit later read. Diagnostics-off must still enforce policies and limits.

`ANY_DEPTH` does not make an unbounded automaton, but “costs nothing extra” is unjustified. Its
active state is bounded by compiled pattern nodes, not merely selector count; a single long
pattern has many nodes. Descending and returning must preserve or reconstruct matching context.
The right proof varies selector length, overlap, wildcard count, depth, and skipped damage.

Specify the desired result and completion semantics before selecting the algorithm. Exact paths,
one-level wildcards, recursive wildcards, and `skip` can be evaluated independently. No feature is
rejected merely because its implementation is unfamiliar.

### F9 — Several external claims used to reject designs are demonstrably wrong

- Serde JSON already skips ignored values without building their value tree.
  Its `deserialize_ignored_any` calls `ignore_value`, which consumes strings through `ignore_str`
  and uses scratch storage for nested structure. This disproves the claimed exclusive capability;
  it does not prove literally zero allocation for every shape. Read the
  [implementation](https://docs.rs/serde_json/latest/src/serde_json/de.rs.html#1102-1198) and
  [Serde example](https://serde.rs/ignored-any.html).
- Rust can vary an output by a generic option type and associated type;
  builder configuration is a reasonable reuse choice, not the only type-safe or one-crossing shape.
  See [associated types](https://doc.rust-lang.org/reference/items/associated-items.html).
- Bun accepts bytes through `Bun.JSONL.parse`; the recorded local call returned
  `[{a:1}]`. Its [documented partial-success behavior](https://bun.sh/reference/bun/JSONL/parse)
  also shows why it cannot replace a strict single-document parse without checking semantics.
- Selectors yielding whole values do not subsume token visitors that process
  one enormous string or preserve duplicate occurrences. On-demand access does not inherently
  require JavaScript getters; methods or handles can expose it. Buffer retention is a real cost,
  but “then you wanted the tree” does not follow. See the
  [simdjson design](https://github.com/simdjson/simdjson/blob/master/doc/ondemand_design.md).
- Banning several syntactic panic sources does not prove panic freedom;
  library calls, arithmetic, allocation failure, foreign code, and destruction remain outside that
  check. State the untrusted-input outcome contract; test the reachable paths and dependency seams.
- JSON does not require every parser to use doubles. [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259#section-6) permits limits on
  numeric range and precision; the [Serde number type](https://docs.rs/serde_json/latest/serde_json/value/struct.Number.html)
  itself exposes integers and optional arbitrary precision.

These are factual corrections. None licenses a new subsystem or automatically selects a replacement.

### F10 — Mixed inputs and offsets need one explicit contract

Measured: byte input `{"🙂":1,}` reports the comma at UTF-16 offset 7, not byte offset 9.
The tested stream accepted bytes but did not preserve byte coordinates; one-shot parsing was
still string-only in that source.
Inserting an empty text chunk between UTF-8 bytes C3 and A9 changes `é` into two replacement
characters. The byte-only control succeeds. This is a chunk-composition defect, not evidence
that mixing encodings is fundamentally impossible.

“First chunk decides the units” needs rules for empty chunks, mixed text after an incomplete byte
sequence, and unpaired UTF-16 halves across string chunks. In a mixed stream there is no single
original array an absolute offset necessarily indexes. The API chooses source-chunk coordinates;
an explicit normalized coordinate space or homogeneous input would be different contracts.
Also define half-open spans, absolute versus per-root offsets, line/column units, and how edits
refer to malformed bytes. Ordinary UTF-8 cannot preserve every JavaScript code-unit sequence.

### F11 — Report completeness and confidence describe different facts

An engine must decline requested diagnostics if it cannot report duplicate keys. `JSON.parse`
collapses duplicates before a reviver runs, so it cannot fulfill that request. Report completeness
and confidence remain separate: formatting repairs have zero penalty, so confidence `1` does not
mean the source needed no changes.

The report must distinguish source truth from a repair-score and name its scope: selected match,
root value, or examined stream prefix. Source snippets can contain secrets and are visible
diagnostic data; absence of network access does not make arbitrary logging safe. Nothing in the
API should imply that confidence authenticates data or validates an application schema.

### F12 — `repair` returns candidate text, not the surrounding document

Measured: repairing `prefix {"a":1,} suffix` returns only `{"a":1}`. It does not preserve the
surrounding document. `repair('{"a":NaN}', {allowJavaScript:true})` returns `{"a":null}` and reports
`js-literal` at `["a"]`. The HLD specifies repaired candidate text, preserved source where no edit
is needed, and `null` in place of a value JSON cannot spell, so `repair` fails exactly when `parse` fails.

Preserving exact numeric spelling in text and returning an approximate host number can both be
useful, but the equivalence relation must say which numeric interpretation is compared. With
duplicates, byte preservation and preserving every historical member do not make the text a
canonical or security-normalized representation. Define what succeeds before choosing edit machinery.

### F13 — Keep design authority separate from evidence of implementation

HLD owns consequential behavior; API defines public contracts; source and executable checks show
what works. Moving a user-visible guarantee solely into code loses the design authority.
Mechanism rationale can live beside its implementation.

Dangerous-key treatment, resource-limit meanings, malformed-byte handling, and duplicate-reporting
coverage need explicit policies: broad priorities do not uniquely choose them. The HLD and API
state those policies; insertion and decoding machinery remain implementation decisions.

The reviewed source already contained lazy `parseMany`, UTF-8 streaming, snapshots, and typed
repair failure. A blanket “nothing is implemented” claim would discard that evidence. The shared
comparator in `scripts/corpus/canonical.ts` preserves key order; ignoring it would change the
contract, not merely normalize the comparison.

### F14 — Performance arguments overreach their instruments

A dispatch microbenchmark cannot establish that two complete builders make parsing four times
slower. Generic specialization, separate monomorphic scan loops, and statically selected sinks
remain live alternatives. No scanner change was made and no speed baseline was run for this
review; the old ratios and frame-size thresholds are not refreshed performance evidence.

Separate input size, damage density, container width/depth, report mode, selector complexity,
snapshot frequency, engine startup, boundary conversion, and steady-state throughput. A ratio
between clean and damaged workloads need not survive engine, hardware, or workload changes.
Ordinary valid input and damaged input both matter under P6 and P7.

D5 cannot control an arbitrary bundler or delete a feature selected by a runtime value it cannot
know statically. Static feature boundaries and supported optimizing builds are testable;
“zero bytes in every app” is not. Automatic native choice also needs cold-start and packaging
costs, not just parse throughput. Installing a native binary does not make every input faster.

Conservative detection is a preference against false positives, not proof of an author's intent.
“One best value” means one interpretation per candidate; it does not remove multi-value parsing.

### F14b — Which whole input a built-in parser reads

`parse` hands whole text to `JSON.parse` on two routes, and the text's ends pick the order
(`builtinRead`, `src/builtin-route.ts`). A container whose last character is not a closer is cut off, so
the pre-scan gate reads it first and `JSON.parse` reads the gate's text (closers appended, comments
and trailing commas deleted). Any other text goes to `JSON.parse` as written, then the cheaper
number-and-depth hazard check, and the gate only if `JSON.parse` threw. Each order avoids the other's
waste: on cut-off text `JSON.parse` builds nearly the whole tree before throwing, and on complete
text the gate's grammar work repeats what `JSON.parse` validates. Both routes are held to the
scanner's outcome by `test/pre-scan.test.ts`. `repair` keeps its byte edits and uses only the
whole-text attempt, because the gate's text drops source whitespace the edits keep.

Measured with `bun bench/whole-routes.ts` on an M4 Max at machine load 40-47 from unrelated
processes, Bun 1.4.2 and Node 24, records of 40 KB to 1.4 MB, shipped `parse` against the scanner
alone:

- complete JSON, pretty or compact: 3.9-7.6x faster;
- cut off mid-stream: 2.7-4.8x;
- trailing commas: 2.6-4.8x;
- a comment before the root, damage the gate declines early: parity (the gate declines a comment
  outside the root container rather than imitating the scanner there);
- **damage late in text ending with a closer: 0.71-0.83x, the one loss.** `JSON.parse` and the gate
  each read up to the damage before giving up, and the scanner then reads it all. Any speculative
  route pays one read when it cannot serve; this class is where that read is longest. Damage an LLM
  makes tends to repeat from the first record, which the early class covers.

Rejected:

- The gate first for every text: one mechanism instead of two, but on Node the gate costs 5-19%
  more than the hazard check on complete JSON, even after frames stopped shrinking the stack array
  (1.13-1.30x on the gate alone). Overturn: a gate as fast as the hazard check on V8; then the
  hazard check goes and the late-damage loss shrinks to one declined read.
- Stopping at the position `JSON.parse` failed: only V8's message carries it, and branching on
  message text is forbidden (`src/AGENTS.md`).
- Native `indexOf` to skip string content in the gate: slower (Bun 1.29 -> 1.86 ms on 0.75 MB);
  most strings are short keys and values, where each call costs more than the loop it replaces.

## Alternatives that remain credible

These are design alternatives, not assigned probabilities. There is no defensible statistical
distribution over architectures here. Costs follow from the named behavior; relative speed
requires a matched implementation experiment. No finite list proves that all designs are exhausted.

### Default data and fidelity — ten alternatives

1. Ordinary values plus optional full report: lowest normal caller burden; losses are opt-in knowledge.
2. Ordinary values plus mandatory alteration tag: notices damage without a full report; adds mandatory metadata.
3. Mandatory full reports: strongest direct explanation; makes all callers pay and conflicts with P4.
4. Fail on unrepresentable values: stable ordinary types; sacrifices recoverable content.
5. Omit unrepresentable members: preserves siblings; needs explicit loss semantics and harms root scalars.
6. Exact integers only when needed: protects identifiers; introduces an additional numeric type and JSON serialization work.
7. Exact numeric tokens for every number: preserves decimal/exponent spelling; burdens ordinary arithmetic.
8. Exact decimal/rational values: preserves mathematical value; changes types and does not preserve original spelling alone.
9. Lossless text first with explicit host conversion: preserves transport data; ordinary object callers perform another step.
10. Explicit normal/exact modes over one scanner: isolates cost and types; needs defined defaults and out-of-range behavior.

The chosen combination uses optional diagnostics, ordinary fractional arithmetic, exact values
for integer precision loss and out-of-range numbers, and explicit exact mode for every number.
An outcome wrapper does not make a repair report mandatory.

### Live values and selection — ten alternatives

1. Owned full snapshots: easy retention and mutation; pays for the whole visible value.
2. Shared immutable plain snapshots: familiar consumer objects; pays for widths of open containers.
3. Immutable persistent trees: cheap versioning; introduces a new representation or conversion cost.
4. Mutable borrowed Rust views: compiler-enforced lifetime; does not transfer to JavaScript callbacks.
5. Unsafe live JS references: least copying; lets consumers corrupt parser state and retain aliases.
6. Revocable read-only views: checks access and lifetime dynamically; adds per-access cost and proxy semantics.
7. Pull-based change batches: avoids full views and suits native transfer; consumers need a maintained projection.
8. Final matches only: no corrections after delivery; waits for duplicate-owning ancestors to settle.
9. Source occurrences as matches: early, bounded delivery; differs from querying the final object.
10. Revisable matches with identities: early delivery and eventual agreement; consumers must process replacements.

The chosen combination for ordinary UI is a stable immutable snapshot with explicit unfinished
status: it permits retention without exposing parser mutation, at the copying cost above.
For selected streams, final matches are the default and source occurrences require an explicit
request. Scalar fragments describe occurrences because later duplicates may replace their ancestors.

### Bounds and termination — ten alternatives

1. Source-window cap: bounds undecided input; does not bound materialized values.
2. Whole-root cap: bounds one ordinary returned value; refuses oversized useful roots.
3. Selected-value cap: allows large roots with small matches; each oversized match needs an outcome.
4. Aggregate retained-memory budget: addresses several allocations; accounting is more complex and host-dependent.
5. Work/byte quota per advance: predictable work slices; does not alone guarantee elapsed time.
6. Scheduled cooperative parsing: lets local abort callbacks run; changes synchronous call semantics.
7. Worker parsing: separates UI work; incurs transfer, setup, and cancellation coordination costs.
8. Diagnostic streaming: releases old report entries; requires consumers to retain what they need.
9. Capped diagnostic detail plus explicit truncation: bounds the report; weakens full-report coverage visibly.
10. Spill to external storage: serves very large values; introduces IO, privacy, and ownership outside the current core.

Use composable bounds that name their targets; do not label 1 as 4. Worker or spill support is not
authorized by discovering a memory or latency problem. Completion and cancellation must still
report the actual outcome under whichever mechanisms are approved.

### Runtime and parser structure — ten alternatives

1. TypeScript-only per call: avoids boundary conversion; gives up native acceleration where it wins.
2. Native-first with faithful decline: retains automatic acceleration; needs eligibility and loader proof.
3. WASM-first with TS fallback: portable native code; startup and memory transfer still count.
4. Input-aware engine choice: can retain strings in JS and bytes native; needs matched end-to-end evidence.
5. Capability-aware engine choice: declines unsupported reports/views instead of changing semantics.
6. Monomorphic push scanner and builder: simple hot path; typed selective consumers need an adapter.
7. Pull scanner and typed visitor: fits Serde; incremental interruption and recovery state must be explicit.
8. Statically specialized sinks: can eliminate unused work; grows code and build variants.
9. Bounded event batches across the native seam: amortizes calls; adds batch storage and delivery rules.
10. Native scan plus JS projection of changes: retains live object identity without rescanning; adds a cross-language protocol.

No control-flow style dominates all these axes. Prototype only the smallest alternatives whose
measurements could change a ruled outcome. A whole-tree bridge is not the only native design,
and token callbacks are not the only selective design.

### Unicode and positions — ten alternatives

1. Preserve code units in a shared lossless value representation: strongest parity; less idiomatic Rust strings.
2. Preserve raw escaped tokens: exact source survives; callers need decoding/conversion semantics.
3. Use a WTF-8-like internal representation: carries surrogates efficiently; not ordinary UTF-8 at external boundaries.
4. Normalize invalid Unicode in all engines: consistent ordinary strings; knowingly changes source data.
5. Reject an affected value everywhere: consistent and simple; loses recoverable content.
6. JS fallback for native-inexpressible strings: preserves JS behavior; Rust standalone still needs its own ruled conversion.
7. Input-native offsets for homogeneous streams: directly indexes callers' data; separate string/byte contracts.
8. A declared normalized unit for mixed streams: one stable coordinate space; caller data may need mapping.
9. Chunk identity plus offset: points to original mixed input; callers must retain chunks or a source map.
10. Optional dual coordinates: serves editors and byte transports together; extra tracking is paid only when requested.

Parity and idiomatic host values are independent axes. A shared lossless domain plus checked host
conversion can combine them; it does not force every caller to receive the same host type.

### Public call shape — ten alternatives

1. Direct common functions: no setup; defaults and result discrimination must remain explicit.
2. Reusable immutable parser: amortizes options; extra configuration call for advanced use.
3. Per-call statically typed option markers: one verb and precise output; more generic machinery.
4. Separate report functions: obvious return types; adds verbs for a change in requested output.
5. Separate feature import paths: static elimination; more imports to learn.
6. One barrel over feature modules: easy discovery; relies on the supported optimizer's reachability analysis.
7. A selected-parser type with match-only verbs: clearer cardinality; another configured surface.
8. Selection only on multi-result verbs: preserves the meaning of single parse; limits combinations.
9. Rust typed deserialization as an adapter: idiomatic call sites; schema failure is distinct from recovery.
10. A resumable batch ABI behind high-level functions: native streaming without per-token calls; needs handle lifetime and buffer ownership.

Prefer familiar common calls plus configured advanced behavior; do not choose a public type merely
because it is convenient for the implementation. Validate clean, repaired, stopped,
no-match, invalid-options (a thrown `TypeError` cause), and cancelled client code for each exposed result family.

## Implementation evidence limits

The implemented native ABI carries typed outcomes, incremental state, owned buffers and explicit
release through one binary protocol shared with WASM. Its synchronous and streaming contracts do
not establish the JavaScript async planner or a resumable four-verb native operation; those remain
separate route obligations. Internal background-work ownership remains replaceable because no public
lifetime contract exposes it.

The recorded corpus and host-boundary checks establish only the cases and routes they execute. They
do not prove every future input, split, target package, runtime-loader pair, failure boundary or
performance workload.
Nested ordinary parsing composes for the measured example; that is not proof for every malformed
embedded escape.

## Additional findings from the public call sites

### F15 — Bare data and ordinary tagged failures collide

The tested wrapper distinguishes `parse('{"kind":"no-json-found"}')` from
`parse('ordinary prose')` with `ok: true` versus `ok: false`. Projecting each to the
bare value or existing failure produces deeply equal objects with the same prototype.
Checking a JSON field such as `kind` cannot distinguish them. This is a defect in combining the
bare-data surface with that failure representation, not a defect in the tested wrapper.

Bare success would require failure identity that JSON cannot manufacture and a safe public test.
The chosen outer result object prevents the collision structurally.
Serialized or cross-worker results need an explicit representation; a private in-process identity
does not automatically survive serialization. Test both actual calls and the chosen transport.

### F16 — A TypeScript type argument is not Rust-style deserialization

An unchecked result type can label `{"x":"text"}` as `{x:number}` without checking the input.
Rust deserialization into a typed struct performs validation; a TypeScript assertion does not.
The API returns the recovered-value domain without an unchecked caller type parameter; callers
can still make an explicit TypeScript assertion outside the library.

### F17 — A source failure must retain available recovery

A source failure keeps its original cause and any recoverable unfinished root in separate fields.
For example, a failed source after `{"a":[1` retains `{a:[1]}` under `source-failed`; completed
results are not repeated. Cancellation is different: return recovery already available at the stop
boundary without consuming further source or applying EOF repairs after the caller requests a stop.

### F18 — A span result does not prove the tree was skipped

Measure span-only materialization through the complete public call before claiming that it skips
building values. Counting known span endpoints is cheap; establishing candidacy, nested boundaries,
and policy outcomes still requires reading input.
Likewise, a text-only repair result does not prove the implementation avoided building a tree.

### F19 — Overlapping selected results need an ownership rule

If `/a` and `/a/b` are both selected, sharing the same mutable `b` object lets a caller's edit to
one result change another result or a parent still being parsed. Source-occurrence delivery does
not remove that alias. Independent mutable results, explicit immutable sharing, or refusal of
overlapping selections are distinct contracts; copying every result is not the only mechanism.
The default must not let caller edits rewrite later parser output. This follows from source fidelity;
the API chooses independent mutable selected results.

## Rationale for the chosen contracts

These choices are owned by HLD and API. Alternatives explain their costs without reopening them.

### N-DECIMAL — Ordinary fractional arithmetic

> Ordinary mode uses floating-point arithmetic for fractional numbers; callers request exact mode when decimal approximation is unacceptable.

Why: ordinary arithmetic remains convenient, while financial or high-precision consumers can request
exact values. This explicitly permits approximation; P1 alone did not derive that permission.
Exact decimals by default avoid approximation but change ordinary arithmetic and types.
Overflow, underflow, and integer-digit loss are the separate N-RANGE decision.

### N-RANGE — Numbers outside the ordinary range or integer precision

> Overflow, underflow, and integers that cannot be represented exactly return an exact-number value, not a rounded value.

Why: preserves identifiers and nonzero values without discarding their surrounding data.
A typed refusal keeps ordinary numeric types stable but gives the caller less recovered data.
The API defines exact tokens, checked conversion, and lossless serialization together.

### S-FINAL — What a selected value means

> Selection returns final values by default; early source occurrences require an explicit request.

Why: a normal selection agrees with the final recovered object. For duplicate-owning ancestors this
can delay delivery and require substantial retention. Explicit occurrence delivery preserves the
early, bounded-work path without promising final-object equivalence. An early revision protocol can
also converge, but makes consumers handle replacement identities and events.

### S-SCOPE — Selective recovery as a public capability

> Callers can select nested values without building unrelated values.

Why: avoids materializing large unwanted fields. API defines paths and result types separately
from the matching algorithm. Whole-value parsing remains available.

### S-SKIP — Whether skipping may change array positions

> Skipping removes named object members; array subsets are returned as selected matches with their source positions.

Why: keeps array positions meaningful without inventing holes. Compacting arrays after explicitly
requested removal is also valid, not physically impossible, but adds a separate index-changing contract.

### D-SCOPE — What diagnostics cover after selection

> With selection, diagnostics describe the selected results and the recovery needed to find them; auditing skipped content is a separate opt-in.

Why: aligns paid work with selected output. The alternative audits all examined input by default,
which helps assess the whole source but needs extra tracking even where no values are built.
Neither policy may report a conversion or loss that did not actually happen.

### D-DUPLICATES — Report duplicates when diagnostics are requested

> A requested repair report includes duplicate keys; an engine that cannot report them must decline that request.

Why: makes the opt-in report dependable without charging calls that omit it. Allowing a
native-fast-path blind spot is a live alternative
if the report explicitly declares that duplicate coverage is incomplete.

### D-LIMIT — When the report reaches its memory limit

> If a diagnostic limit is reached, continue recovering data and mark the report incomplete.

Why: prioritizes useful data over auxiliary detail. Stopping the parse instead preserves full
report coverage for the examined prefix but may lose later useful data. Any confidence or totals
must state whether they cover the full examined input or only retained details.

### S-SUMMARY — Reaching the end without matching a value

> Requested stream summaries and unmatched selectors are delivered through the iteration, including when no values match.

Why: ordinary iteration cannot observe a generator's return value. A separate completion result
keeps values-only loops simpler but adds another result callers must remember to read. Leaving
early provides no promise that unexamined input or future matches are known.

### V-SAFETY — JavaScript live-view ownership

> JavaScript live views must prevent caller writes from changing parser state.

Why: the readonly-callback counterexample permits corruption. This allows protected no-copy
representations; it does not require copying. An explicitly unsafe raw view is the alternative,
trading enforceable isolation for less mediation and placing lifetime and mutation duties on callers.

### I-MIXED — Positions in mixed streams

> For mixed text-and-byte streams, positions identify the original chunk and an offset in that chunk's own units.

Why: every position refers to actual input rather than an imaginary combined buffer. Normalized
text offsets are a simpler alternative, but cannot directly index original byte chunks. The API
uses chunk-local positions for every stream so a later representation change cannot invalidate
an earlier position. Empty chunks must not change decoding or units.

### R-SERDE — Typed Rust integration

> Rust supports optional Serde and async-stream integrations; the recovery core has no required third-party dependencies or executor.

Why: serves typed Rust consumers without forcing that dependency on dynamic-value or WASM consumers.
Mandatory Serde reduces setup for those consumers; omitting it avoids another supported surface.
This does not choose push versus pull, borrowed versus owned, or a public Rust value representation.

### T-ASSERT-2 — Caller-supplied types need validation

> The parsing API does not accept an unchecked caller-supplied result type; callers may assert their own types outside the library.

Why: keeps parsing distinct from validation without dictating `unknown` or adding a schema framework.
Keeping the existing explicitly documented generic assertion avoids call-site changes, but lets the
library appear to establish a type that the input may contradict.

`unknown` is another honest payload type, but not the only one: a concrete recovered-value union
also works. The compiler probe reduced bare `unknown | Failure` to `unknown`, hiding the failure
union; placing the payload inside the chosen outer result preserves outcome narrowing.

### X-FRAGMENTS — One value larger than available memory

> The first public API includes incremental processing of selected scalar contents without retaining the whole scalar.

Why: a selected enormous string still defeats whole-value streaming. Batched fragments can cross
a native boundary without token callbacks. Deferring fragments would require every selected value
to fit the configured retained-value budget.

More input can turn the number prefix `123` into the string `123oops`; a numeric start would guess
the result. Earlier delivery must preserve the existing recovered text and resolved type.

Moving the scalar kind from start to completion does not settle numeric text: `0x10` and `0x100`
recover as `16` and `256`, so the first recovered digit cannot leave at that prefix. This rules out
append-only recovered-number delivery there; it does not require a new source-text mode. Compare
caller storage, decoding, undo and failure handling before adding a mode. The current start record
can change if needed to meet the HLD; it cannot justify weakening that requirement.

#### Keep decoded fragments and add selected source text

Use `fragments: decodedFragments` for decoded string processing. Keep the explicit source-text mode for copying
one selected scalar to a file or another stream without keeping it in memory. Source text is not
repaired JSON: for `0x100` it is `0x100`, while recovered fragments still produce `256`. Arithmetic,
validation and final tool execution need the completed value and final object membership; neither
fragment mode establishes those facts early. These complementary representations derive from HLD's
incremental selected-content requirement without removing recovered-content processing.

Pass the imported `sourceFragments` capability to `select` rather than a string switch. Its reader
and source-delivery implementation travel with that value, so importing ordinary selection does
not retain them. This adds an import for the source-copying job while preserving HLD D5.

Decoded delivery likewise travels through the imported `decodedFragments` value. A Boolean switch
would keep its constructor reachable from ordinary `select`, even when a caller requests only final
matches. Both delivery modes share candidacy and ordering through Picks; neither duplicates the matcher.

Selected `findJsonSpan` results already serve source extraction. Source fragments extend that job
to streaming input: an inspector or archive sink keeps only the selected occurrence instead of
retaining the full input.

| Alternative | Why it does not replace both modes |
| --- | --- |
| Buffer the token, then split it | Preserves output but still requires memory for the whole scalar. |
| Send only a stable recovered prefix | A long hex prefix can become a decimal number or a string starting with `0x`; even the first output character is unsettled. |
| Keep a bounded numeric summary | A later word suffix needs the original digits. Keeping them in a BigInt still uses storage that grows with the token. |
| Require exact-number mode | Preserves decimal spelling, but radix conversion and later string recovery still disagree at the first character. |
| Send corrections or replacements | A direct pipe cannot retract bytes; file output needs buffering or seek/rewrite. Both add caller work. |
| Spill or replay input | Moves storage and cleanup to another owner; live producers need not support replay, and portable storage is not part of this API. |
| Mix decoded strings with source numbers | Callers must interpret identical text fields differently; raw source also leaves number-versus-string ambiguity unresolved until completion. |

In source mode, send exactly the decoded input covered by the scalar's final span, including quotes
and escapes. Use the existing boundaries: `hello   ` includes its spaces; `"hello"   ` and `123   `
stop before them. Keep the recovered kind at completion, omit generated `cutSuffix` text, and preserve occurrence
IDs, source positions and typed failures. Ambiguous token boundaries still withhold source under the
existing limits. Never silently buffer a complete numeric token just to determine its final kind.

The deciding difference is consumer work: a source-copying sink can write each piece once; a decoded
text sink keeps its existing output without parsing JSON escapes. Neither must implement corrections.
Revisit the second mode if recovered numeric fragments may preserve source spelling instead of
normalized output; that would remove the incompatibility it addresses.

Source mode must classify tokens without constructing their recovered values. Its completion needs
only `string`, `number`, `literal` or `missing`; exact and floating-point numbers share `number`.
Extend the existing numeric scanner's state with syntax facts needed by its recovery decisions,
then share those decisions with the value-producing reader. Do not convert an unbounded token with
`Number` or `BigInt`, or add another recognizer beside the scanner. Differential cases must cover
chunk splits, numeric-to-word continuations, separators, radix prefixes, leading zeros, refused
repairs and EOF prefixes before that classification is trusted.

Keep decimal syntax validity in the existing token loop: track integer, fraction and exponent
progress across chunks, including malformed punctuation. The value reader consumes that verdict
before conversion. This avoids using a complete-token `Number` conversion as the only syntax
test, which a source-only reader could not perform after releasing delivered digits.

Carry the sign, radix, separators and non-JSON decimal forms with the token verdict, then apply
numeric policy from those facts after its follower settles. Source delivery needs the same policy
and final kind without decimal normalization or a BigInt. Keep numeric fidelity conversion in the
value-producing reader; the source-copying job does not request it.

Keep integer completion in that same verdict. Canonical exact integers, and integers too long for
a finite double, need their preserved digits rather than `Number` conversion or another digit scan.
The small verdict branch reuses existing syntax state without another retained field or recognizer.
Retain that cost; reconsider it only for a complete-route alternative that avoids the conversion
and preserves malformed-token policy, exact digits and caller-owned output. This does not qualify
large-scalar responsiveness or establish a cross-runtime throughput gain.

Determine an unfinished numeric suffix from the lexer’s remembered last unit and radix. Do not
re-read retained token text at EOF: that text may already belong to the fragment consumer.

Apply numeric policy only after the follower settles number versus word. A provisional refusal can
spend the error budget and stop recovery for text that is no number. Preserve policy order and
original error positions. Literal candidates need only their bounded candidate spelling; long pending whitespace
still needs source delivery because later text can make it string content. Quoted source retains
the existing bounded ambiguity/replay mechanism; it does not bypass its storage limits.

The source selection owner implements the reader's quoted-source contract directly. It already
owns carry and delivery; a forwarding object adds allocation and a second interface to maintain,
without providing a separate lifetime or behavior.

Share literal decoding with source-only delivery: a bounded candidate resolves to the existing
literal value or an explicit unquoted-text marker. Materialize text only in the value reader;
the source reader must not invent an empty recovered value to stand in for released content.

Delivered source belongs to the caller and must not be duplicated into a failed outcome or cut text.
Keep only undelivered recovery there, with the occurrence ID and source span identifying earlier
pieces. Existing decoded fragments already use this ownership: a source failure after delivered
text returns cut metadata without rebuilding that prefix. A missing EOF value needs an incomplete source end
without pretending it recovered a scalar; cancellation, refusal or source failure gets no successful
end. Existing recovered-mode cut text and failed recovery remain intact.

### X-LAZY — Choosing fields after parsing starts

> The first public API does not include deferred field access backed by retained source text.

Why: declared selection covers known fields without a second public lifetime model. On-demand
access remains useful when a later field determines which earlier payload to inspect; it is not
dominated and does not require JavaScript getters. Deferral is a scope choice, not an impossibility.

### X-REPLACE — Recovery versus transformation

> The first public API does not replace selected values during parsing; caller transformations remain separate from recovery.

Why: keeps repair and intentional rewriting distinguishable. In-parser replacement can avoid
building discarded values and rebuilding output, especially for arrays, so caller-side replacement
is not universally equivalent. Adding that capability needs its own transformation contract.

### X-CHECKPOINT — Surviving a process restart

> The first public API does not export parser state for restoration after a process restart.

Why: a published checkpoint format couples decoder state, source positions, pending values, options,
and delivered-output accounting. Existing in-process feed pauses need no new format. Restartable
long-running recovery is a real alternative; choosing it requires a versioned state contract and
source-resumption prerequisites, not a claim of exactly-once delivery.

### S-FAILURE — Recovery after the source fails

> When the source fails, expose any recoverable prefix separately from the source failure; do not report normal completion.

Why: the EOF control recovers data that the source-error path discards. This follows P5 without
turning a broken transport into success. It does not authorize further source reads or recovery
after cancellation; the API specifies the failed result and its optional recovered prefix.

### Q-STRICT — Refusal is not success

> A strict-policy refusal is never an ordinary success; any recovered value remains available only with that refusal.

Why: a caller requesting strictness must not accidentally consume a refused value when diagnostics
are off. Keeping the value beside a distinct refusal preserves P5 without weakening the policy.

## Contracts requiring implementation evidence

Exercise real success and failure calls for every dependent contract:

- Selection: cardinality per verb, overlapping and repeated selectors, ordering, multiple roots,
  skip conflicts, unmatched paths, selected text repair, and ownership of overlapping results.
- Values: exact mathematical value versus numeric spelling, exact-number conversion and serialization,
  signed zero, non-JSON literals, and a lossless Unicode representation before checked host conversion.
- Outcomes: no JSON versus JSON null, strict refusal, limited processing, source failure, cancellation,
  cleanup failure, and completion information visible to ordinary iteration.
- Deferred native/WASM: incremental state, input/output buffer ownership, release, cancellation, capability
  rejection, and measured eligibility for each shipped route; a pair of byte ranges is insufficient.

Verify key order, per-call options, dangerous-key policy, and malformed-byte handling against the
HLD/API contracts, including their crate and artifact names. Publication requires separate permission.

## WASM build variants

After native and WASM return to release scope, ship the scalar `wasm32-unknown-unknown` module alone until another build improves a
complete public call or reaches a host the scalar module cannot.

Do not add a scalar WASM worker route. It would use the same worker isolation and input/result
transfer as the TypeScript worker while adding module initialization and the WASM byte boundary.
The scalar module also cannot observe the worker's shared cancellation cell, so it supplies less
bounded cancellation than the existing worker operation. `bench/prior-art/baseline.json` has no
WASM member; re-measure complete calls with the parked engine harness in `rust/js-adapters/bench/`
before reconsidering this route. Reopen it only for a host capability
or workload that can offset those costs.

The measured SIMD build added another similar-sized module without improving rounded complete-call
throughput. WASI and shared-memory builds require boundary or synchronization changes. Do not add
those mechanisms without a complete-call or host-reach benefit measured on the distributable build.

A component build also needs a WIT contract that the public API does not define. Wrapping the existing
byte ABI without a new consumer requirement would add another boundary without increasing host reach.
Reconsider any rejected build only with a concrete host or complete-call workload that predicts a
different outcome; build failures alone are not evidence that the variants are inherently impossible.

## RESULT-OBJECT — Explicit JavaScript outcomes

Keep result state outside the parsed value; optional diagnostics must not require a different
way to recognize success.

Retain `ok`, `value`, and `failure`: an outcome check stays familiar and independent of the
parsed data's shape.

HLD P4:

> P4. The default path returns recovered data with an explicit success or failure outcome; repair diagnostics are opt-in so ordinary calls do not pay for explanations they did not request.

HLD Impact:

> JavaScript operation results use plain objects with `ok: true` and `value`, or `ok: false` and a typed `failure`, so result state cannot be confused with fields inside parsed data.

### Why the result stays outside the payload

A brand solves a collision that an outer result object prevents structurally. Bare data also
creates a second collision when a dynamic diagnostics option returns either data or a report.
An envelope uses one outcome check in both modes and needs neither a failure-identity protocol
nor a report-identity protocol. It preserves errors as values without adopting errore's shape or
dependency. Rust keeps its ordinary `Result`; common semantics do not require common syntax.

The cost is an outer success object and a `.value` access. That is not a repair report or a copy
of the recovered tree. No representative measurement establishes whether the allocation
is material; neither “free” nor “too slow” is supported. The strongest contrary evidence would be
a reproducible end-to-end regression in high-rate small-result streams, including retained results
and garbage collection, not just an allocation loop where the optimizer removes the objects.

### Alternatives considered

Each row is a distinct usable shape or composition, not a claim about its probability or universal
ranking. The comparison separates caller checks, partial recovery, reporting, transport, and cost.

| Shape | Strongest reason to use it | Cost relevant to this API |
| --- | --- | --- |
| Plain `ok` union | Familiar check; arbitrary payload stays separate | Outer success object |
| Plain `kind` union | One switch can name every outcome | Renames the existing success check |
| Three-way success/partial/failure | Partial recovery is immediately visible | More outer branches at every call |
| Flat named failure variants | One switch reaches actionable reasons | Every operation expands the outer union |
| Presence-based value/error objects | No extra status field | `in` checks are less familiar than existing `ok` |
| Boolean-tagged tuples | Explicit two-way union with few fields | Positional access and destructuring burden |
| Error/value tuples | Familiar multiple-return style | Null and undefined need precise slot rules |
| Bare data plus branded failure | No success wrapper | Identity protocol and reporting ambiguity |
| Bare data plus native `Error` | Familiar error check | Realm and transport rules; no library identity |
| Bare data plus private identity set | Parsed fields cannot forge identity | Recognition fails across independent copies |
| Bare data plus failure subclasses | Direct per-error narrowing | Class imports, identity, stack construction |
| Wrapped success plus native error | Payload separated from native errors | Two representation conventions and transport rules |
| Result class with match/map methods | Repeated composition can be concise | Methods, allocation, transport reconstruction |
| Mandatory fold callbacks | Both branches must be supplied | Callbacks for ordinary reads |
| Success callback plus returned status | Useful immediate sinks; no success wrapper | Callbacks and partial-failure ordering |
| Mutable caller-supplied result slot | Reuses result storage | Aliasing, reentrancy, retention hazards |
| Typed exceptions | Familiar to `JSON.parse` consumers | Expected failures absent from return types |
| Separate throwing and result verbs | Serves both error-handling styles | Duplicate surface and migration burden |
| Bare default plus wrapped report mode | Cheap successful default | Dynamic options recreate shape ambiguity |
| Envelopes plus opt-in batched streams | Amortizes high-rate result overhead | Batch size, ownership, latency contracts |
| Always return stream events | Uniform incremental processing | Lifecycle machinery for a single small input |
| Promise-only results | One async composition model | Scheduling burden for small synchronous parses |

The preferred baseline is a plain `ok` union with opt-in diagnostics. Batched streaming remains
an independent optimization candidate; this decision does not add it to the public surface.
Rejecting the other baselines here does not reject callbacks, classes, or tuples for unrelated
internal jobs where their benefits apply. No finite enumeration proves all designs exhausted.

### Falsification and limits

The local probe used the repository's native TypeScript compiler with strict null checking and
exact optional properties. Success and failure narrowed correctly with an `unknown` payload;
wrong-branch access, missing successful data, and missing failure reasons were rejected. Dynamic
diagnostics did not require narrowing the payload to discover the result mode.

Runtime probes on Bun 1.4.1 and Node v24.20.0 exercised null, false, zero, empty string, empty
containers, failure-shaped JSON, and report-shaped JSON. Wrapping retained the payload reference
and omitted diagnostics. Plain JSON-compatible outcomes survived clone and JSON round trips.
Controls showed that JSON serialization drops recovered `undefined`, a function-valued cause
prevents structured cloning, and cloning a branded `Error` loses its custom kind and symbol.
These checks validate the tested shapes, not parser correctness, browser coverage, or throughput.

Partial recovery belongs under the failed outcome, with presence distinct from a recovered null
or undefined value. Do not return that partial as ordinary success. Keep diagnostics outside the
payload on either outcome, and do not add empty arrays or calculate confidence when not requested.
An envelope is not an authenticity check for messages received from an untrusted sender; native
and worker adapters still validate their transport and handle values it cannot represent directly.

## 0.1.0 API decisions

Each decision below gives its basis, the alternatives that lost, and what would overturn it. The
contracts themselves live in `docs/API.md`; measurements cite their machine, runtime and date.

### D-FEATURES — Optional features are imported values

> If an app uses one feature, its optimized build must contain only that feature and the shared code
> it needs (HLD D5).

**Decision.** A feature whose code most calls do not need (`diagnostics`, `locations`, `select`,
`skip`) is a value the caller imports and passes under its existing option key:
`parse(text, { diagnostics })`, `diagnostics({ maxEntries, scope })`, `select(paths, { occurrences,
fragments })`, `skip(paths)`. Passing `true` is a compile error and a run-time `TypeError` naming the
import. Everything is exported from the package root, plus the async entry HLD requires.

**Why.** A boolean leaves the feature's code reachable from `parse`, so no bundler can drop it: the
feature is disabled at run time but present in every build. An imported value makes the feature's
code reachable only through the caller's own import. Which options became values was decided by
reading where each is consumed: report storage and confidence, value spans and the selector compiler
are code a default call never runs. `exactNumbers`, `cutSuffix`, `builtinParsers`, `recover`, the
limits and the root filters are branches inside code default parsing needs anyway, so an import
would remove nothing and still break the call. Refusals, limits and their positions stay core,
because a default `policy-refused` or `limit-reached` failure reports where it happened.

Settings travel with their feature (`diagnostics({ maxEntries })`), because a setting for a feature
that is not loaded would type-check and do nothing. `maxEntries` caps what the report's
`entriesComplete` says was left out, and `scope` is the name the report already uses for that field
(HLD D3). `locations` is its own feature rather than a report setting: HLD names diagnostics and
locations as separate capabilities, and spans inside the report would force a report on callers who
want spans only (P4). `skip` is its own value because skip-only calls exist and folding it into
`select` would remove them (D1).

**One root, not a path per feature.** Measured 2026-10-04 with a package shaped like this design
(features as values, a worker reference, a root re-exporting everything) under esbuild, rolldown,
Rspack and `Bun.build`, minified browser builds: with `sideEffects: false` every bundler dropped every
unused feature, including the unused worker reference, and an import-only build was empty. Without
the field, esbuild and rolldown kept two unused features and Rspack one, each with import-time work;
building each feature through a `/* @__PURE__ */` factory removed them again. So two independent
mechanisms each suffice, and the package uses both. The cost: a caller who loads the package with no
bundler (Node, Deno, a plain browser import) loads every feature module.

| Alternative | Why it lost |
| --- | --- |
| `.use()` composition | Needs a parser object; no free function per call (D2) |
| One verb per combination (`parseWithReport`) | 2ⁿ verbs (D3) |
| A `/full` entry with booleans | Two spellings per feature (D3) |
| A side-effect import that registers a feature | Import-time work and hidden global state (D5) |
| Lazy `import()` when a boolean is set | Makes `parse` async |
| A bundler define or condition flag | Every consumer must configure a bundler |
| Booleans kept | The feature stays reachable, so D5 fails |
| Variadic `parse(text, feature, …, options)` | A new call shape with ordering misuse |
| Always calling `diagnostics()` | Noise on the common call |
| A path per feature, or root plus per-feature paths | One path per symbol (D5's warning), or two paths per name (D3) |
| Grouped paths (`/report`, `/select`) | Same gain as one root, one more decision per import |
| Browser-specific conditional exports | Different exports per host (P3) |
| A `features` namespace object | Property reads on it defeat dead-code removal in some bundlers |
| Separate npm packages per feature | Version skew for a few KB |

The worker cannot receive a function through `postMessage`, so features need serialisable settings.
The generic worker rebuilds requested features from those settings, avoiding feature-specific asset
loading and consumer build setup. HLD D5 permits its shared feature code; keep it outside startup.
A later native engine arrives as one more imported value from its own entry, so adding it breaks no caller.

**Overturn.** A supported bundler that keeps an unused feature outside D5's worker exception; or a
feature grown heavy enough to need its own entry.

### D-CUT — `complete` and one `cut` per value

> Every recovered value says whether its source ended before the value finished and, if so, where and
> what kind of thing was cut; the value itself is never changed to show this unless the caller asks
> for a suffix on cut strings (HLD Impact).

**Decision.** Recovered values and repaired text carry `complete: boolean` and, when it is false,
`cut: { path, kind, text? }` with `kind` one of `string`, `number`, `missing`, `between`. It replaces
the snapshot-only `partialPath`.

**Why one cut.** Text is written front to back, so a value is cut at exactly one point, at its end,
and every container on that point's path may be missing later items. The scanner already knows the
point; the pre-scan computes it on the built-in-parser routes. Without it a cut-off reply looks like
a finished one, which is the silent failure this package exists to remove; making it a report entry
would leave that failure in place for every caller without a report.

**Why `path` names an item only when the source made it addressable.** Modelled on the three readers
of `kind`: a UI draws a placeholder at a `missing` path and a "more coming" mark at a `between`
container; an agent previews a field whose path is not a prefix of `cut.path`; a retry or continuation
reads `text`. A closed occurrence may still be replaced by a duplicate key or ancestor, so final
membership requires default selection or the finished root. An array index or a complete key names
that item. Input that ends inside a
key names no item, so it is `between` at the container with the fragment in `text`: naming the item
`["ke"]` would invent a key the source never wrote (P1). The diagnostics report still records the
dropped fragment as `dropped-member`; that entry describes a text deletion, not an identity.

**Why numbers and words are judged by their last character.** At the end of input, a number token
that is already valid JSON (`12`, `1e5`) is a real value that may be short, so it stays with
`kind: "number"`. An invalid prefix (`-`, `1.`, `1e`) or a partial word (`tru`) is not a token, and
returning it as a string would invent a type, so the item is dropped with `kind: "missing"`.
"Unfinished" is judged by the token's last character, never by `Number(raw)`, because the reader
accepts spellings `Number` rejects. An incomplete escape is never placed in a value; it goes to
`text`.

| Alternative | Why it lost |
| --- | --- |
| Flat fields on the result (`cutPath`, `cutKind`, `cutText`) | Not recorded when the shape was chosen |
| A symbol on each cut node | Strings are primitives and cannot carry one |
| A `WeakSet` registry of cut nodes | Same: primitives cannot be registered |
| Wrapper objects at cut leaves | The value's types flip between cut and finished |
| A tree mask of cut positions | A value has one cut, so the mask would hold at most one entry |
| Reporting the cut only in diagnostics | The silent failure stays for every default call |
| JSON Pointer strings for `path` | Escaping rules, and a second path spelling (D3) |
| A `toJsonPointer(path)` export | No consumer job on unfinished JSON needs a pointer string. Processing every closed occurrence uses `select(…, { occurrences: true })`, which delivers it once when it closes; default selection waits for final membership after duplicate replacement. Neither needs a path test. Placing a cursor or a "still writing" mark asks whether a node's path is a prefix of `cut.path`, an array comparison. Trimming a cut item reads `cut.path` by index. A log line is served by `JSON.stringify(path)`. Arrays are also what callers' tools already speak: Zod 4 and Standard Schema 1 issue paths are the same key-and-index arrays, so closure checks, walking a value and matching a validator issue need no conversion. Only pointer tools need a string (ajv's `instancePath`, JSON Patch ops), they ship their own escaping (`fast-json-patch` `escapePathComponent`), and the conversion is one line. A pointer also invites a wrong test: `"/items/10/n".startsWith("/items/1")` is true, so item 1 would read as unfinished; closure checks must compare arrays. For a lookup key, `JSON.stringify(path)` is exact where `join(".")` merges `["a.b"]` with `["a","b"]`. Overturn: a schema feature, which would map its validator's pointers onto `path` arrays itself (types read 2026-10-04: zod 4.6.5, @standard-schema/spec 1.1.0, ajv 8.20.0, fast-json-patch 3) |
| An `isOpen(path, cut)` export | The prefix test is one line, and the README shows it beside the one trap (indexes are numbers, so `["items", "0"]` never matches). An export can never be removed (D1); adding one later breaks nobody. Overturn: callers who keep getting the test wrong despite the recipe |
| A container path for every `missing` | Contradicts "the item at the path" and loses the field name UIs need |
| A fifth kind `key` | A public name the four kinds do not need |

**`cutSuffix`.** Off by default: a suffix is text the source never wrote, and data consumers must not
receive it unasked (P1). It is applied to a cut string only, at one insertion point per route (the
end-of-input value, the snapshot copy, `repair()` text escaped inside the literal, the last `data`
fragment, the completed text on the cut-off built-in route), so every route shows the same value
(P3). Per-kind suffixes lost because a number would become a string; placeholders for missing items
lost because types would flip; a caller-side helper lost because the owner required a mark with no
extra machinery.

**Overturn.** A job that needs two cut points in one value; front-to-back text cannot produce one.

### D-FREEZE — Freeze what is shared, copy what is open

> Later input may revise an unfinished value, but must not mutate a snapshot the caller already
> holds. JavaScript live views must prevent caller writes from changing parser state (HLD Impact).

**Decision.** Under `view: "shared"`, finished branches are frozen once, as they close, because they
are shared between snapshots. The per-snapshot copy of the open containers is never frozen, on any
runtime. A pull with no `feed` or `end` since the previous one returns the same object; `owned`
snapshots are never reused, because the caller may modify them.

**Why.** The open-path copy belongs to one snapshot, so a caller's write to it cannot reach parser
state, and HLD's guarantee holds without freezing it. Freezing it costs on the copy path. Measured
2026-10-04 on an M4 Max: on Bun 1.4.2 freezing costs about 0.13 µs per element, every array
construct tried costs the same for 10 000 elements, and `Object.isFrozen` on a frozen 10 000-element
array takes about 0.94 ms; on Node 24.21.0 freezing costs nothing measurable. Copies use `slice()`
and object spread instead of defining keys one by one. With freeze-once, the copy change and the
memo, a snapshot of a 100 000-wide open root array went from 24.7 ms to 0.35 ms on Bun (shared) and
from 2.0 ms to 0.04 ms on Node.

Whether the open copy is frozen is a guarantee level, chosen once for every runtime; the data is the
same on every runtime (P3).

| Alternative | Why it lost |
| --- | --- |
| Freeze everything, every snapshot | On Bun, about 17 ms per snapshot at 100 000 width |
| `Object.seal` or `preventExtensions` | Same cost as freezing, or not immutable |
| Proxy views | `structuredClone` and `postMessage` throw on them |
| A runtime-name switch | Different behaviour per runtime for the same call |
| A one-time capability probe (freeze vs plain copy) | Browsers coarsen `performance.now()` to about 1 ms, so the probe's verdict would be noise there |

**Floor.** An immutable plain array with a new identity must copy every element, so a snapshot per
chunk of a growing array is quadratic whatever the copy costs. Pulling once per rendered frame is the
right shape, and the docs say so; a value yielded per chunk was rejected for the same reason.

**Overturn.** A runtime where freezing the open copy becomes free, measured on the shipped build; or
a caller job that needs to hand the open copy to code that must not mutate it.

### D-FEED — Every completed value is delivered exactly once

> Each completed stream value is delivered exactly once, even when the caller skipped reading an
> earlier `feed()`; unread values count toward the retained-results limit, and reaching it fails the
> stream with a typed reason instead of dropping data (HLD Impact).

**Decision.** `feed()` returns a lazy iterator. A later `feed`, `end` or `snapshot` first finishes an
unread drain into a held queue; the next iteration read delivers held items before its own. Held
items count toward `maxRetained`; past it the stream ends with `limit-reached` naming `unread`, after
every held item. `break` still closes the stream.

**Why**, by modelling the uses against four designs:

| Use | Discard unread | Carry, unbounded | Eager array | **Carry, bounded** |
| --- | --- | --- | --- | --- |
| UI over one root, snapshots only | ok | ok | ok | ok |
| JSONL or selection consumer reading every iterator | ok | ok | ok | ok |
| `feed()` ignored, values expected from `end()` | **silent loss** | ok | **silent loss** | ok |
| Snapshot-only UI over endless JSONL | ok | **memory grows without limit** | ok | **typed failure that names the fix** |
| One huge chunk processed item by item, with yields | ok | ok | **all items held at once** | ok |

The bounded carry is the only design with no silent loss and no unbounded growth. Its failure tells
the caller what to do: read the items `feed()` returns, or raise `maxRetained`. Its cost is one queue
and accounting against an existing limit.

**Overturn.** A use in which a typed `unread` failure is worse for the caller than either losing the
values or holding them without bound.

### D-CONFIG — Invalid options throw a `TypeError` with a typed cause

> Invalid options are the caller's bug: the types reject every misuse they can express, and the rest
> throws a TypeError with the typed reason attached before any input is read; every other failure is
> a typed result (HLD Impact).

**Decision.** `initParser`, `createStreamParser` and `initAsyncParser` return the object itself.
Every constructor, and every verb given options, throws a `TypeError` before reading input, whose
`cause` is the `invalid-options` reason. Async verbs reject with it; `parseManyAsync` validates and
throws at the call, so a stored iterator never carries a latent configuration bug. Option types are
exact: a key a verb does not take is a compile error, inline or through a variable.

**Why.** A result for a configuration error makes every call site handle a bug that cannot occur once
the types pass. The cost was measured in this repository's own README: an example that read
`createStreamParser(…).value` compiled in the tests and failed for the reader. Throwing keeps call
sites plain, and the typed `cause` still serves callers who load options at run time. Async verbs
reject rather than throw, because a function returning a promise that throws synchronously escapes
`.catch()`. Generic option parameters skip TypeScript's excess-property check, so each public options
parameter maps unknown keys to `never`. Numeric ranges are checked at run time only, because literal
range types produce unreadable errors.

| Alternative | Why it lost |
| --- | --- |
| A typed result from every constructor | Every call site unwraps a bug that the types already exclude |
| A `validateOptions()` result helper | An export with no named consumer; `try { initParser(o) } catch (e) { e.cause }` serves the dynamic case |
| `initAsyncParser` returning a promise | The promise existed only to load the removed native engine |

**Overturn.** A caller job where configuration arrives at run time often enough that handling a
`TypeError` is materially worse than a result; none is known.

### D-SPEED — One pre-scan picks the route

> A call pays only for the capabilities it requests: the library takes the fastest route available
> for that set (HLD Impact). Every runtime gives the same answer for the same input; only the route
> differs (P3).

**Decision.** One pre-scan reads every text `JSON.parse` cannot take as written; complete text goes
to `JSON.parse` first and then through the cheaper hazard check alone. In a single pass the
pre-scan checks hazards (dangerous keys including escaped spellings, depth, `maxScalar`, number fidelity, `maxBuffer`),
validates the strict grammar, tracks the open containers for closers and the cut, records comment
and trailing-comma spans, and skips one leading code fence. Its text (closers and any `cutSuffix`
appended, comments and trailing commas deleted) goes to `JSON.parse`; whatever it declines goes to
the scanner. Which of `JSON.parse` and the pre-scan reads a text first is decided by its ends, as
F14b records with the measurements. No `Bun.JSONC.parse` route ships: deleting comments and
trailing commas before `JSON.parse` serves every runtime the same way.

A route is taken only if the policy enables every repair it implies and no report was requested: a
built-in parser cannot say what it repaired. `locations` is served only by the whole-text
`JSON.parse` attempt, whose span is the text itself; the pre-scan routes decline it. The cut-off route
removes an unfinished token at the cut (`tru`, `1e`, `-`, a half escape) before closing, exactly as
the scanner does, or the two routes would return different data. `builtinParsers` defaults to
`true`, which permits the pre-scan to route; it never forces a route. An input class goes to a
built-in parser on a runtime only where measurement shows a win on the corpus and on model-shaped
inputs, with no loss beyond noise on heavily damaged input; a class that does not win stays on the
scanner in the code, not through the caller's option.

**Why.** Measured 2026-10-04 on an M4 Max with Bun 1.4.2 and Node 24.21.0: the no-report path was
slower than the report path, because it paid a `JSON.parse` attempt that damaged input always fails
plus a separate pre-scan, which breaks "a call pays only for what it requests". On a 765 KB clean
document `Bun.JSONC.parse` took about 2.6 ms against 0.97 ms for `JSON.parse`, so JSONC could only
ever serve comment-bearing input, which deletions plus `JSON.parse` serve the same way on every
runtime; `Bun.JSON5.parse` was rejected outright because it
rounds big integers, keeps the last duplicate key and makes `__proto__` an own property.

**Proof obligation.** A differential test runs the pre-scan routes against the scanner over corpus
documents, their prefixes at every structural boundary, and seeded single-character mutations, and
compares value, `complete`, `cut`, `ok` and failure kind with `Object.is` at the leaves. A
divergence is a pre-scan defect.

**Routes and figures.** F14b: per input class on Bun and Node, from `bun bench/whole-routes.ts`,
including the one losing class (damage late in text ending with a closer, 0.71-0.83x).

**Overturn.** A route that diverges from the scanner on any input, or that measures no win on a
runtime; that class then stays on the scanner there.
