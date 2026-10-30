# Public API

Recover JSON with simple calls; request reports and selective output only when needed.

This document is the public contract; `README.md` shows the package at work. Examples use
caller-provided input and handlers.

## Design

Return explicit outcomes, keep diagnostics optional, preserve source content, and use each
language's normal types without changing recovery semantics.

## Rules every call follows

- Simple work needs no setup; reusable configuration does not remove per-call options.
- Repair diagnostics are collected only when requested.
- A call pays only for the capabilities it requests. Streaming, diagnostics, locations
  and selection are each opt-in and each cost something, so a call that asks for none of them must
  take the fastest route available for that set. This binds implementations, not just defaults: a
  whole-input `parse` built on top of the streaming parser would charge every caller for a resumable
  scanner they did not ask for, and is refused however tidy it looks.
- Existing API behavior: expected failures come back as typed values rather than exceptions.
- Both implementations answer the same for the same input.

Expected failure, recovered data, and optional explanation are different facts; an absent report
must not hide a refusal or stopped scan.

## Public calls

Keep the existing action names. Reporting changes requested output, not the action's name.

- `parse(text)` — the first value in the text; its success says `more: true` when a later value
  follows, without a report, and a requested report lists the later ones in `laterValues`.
  `repair` and `findJsonSpan` say `more` the same way.
- `parseMany(text)` — every JSON value in the text, lazily. A value showing no colon, no quoted
  string inside brackets and no second item (`1`, `"a"`, `[1]`) counts only when it stands alone,
  fills a fence, or sits in a run of values separated by line breaks: `[1]\n[2]` reads both,
  while `[1] [2]` on one line is declined as a citation. Values joined by a comma touching the
  first (`1,2,3`, `{..},\n{..}`) are one array, reported as `missing-brackets`; a list led by such
  a value must stand alone the same way, so `1, 2 and 3` stays prose.
- `repair(text)` — the repaired candidate as JSON text, preserving source spelling where no edit is needed.
- `parseStream(source)` — values as they complete, from a stream of chunks.
- `stringify(value)` — encode recovered values as JSON, including exact numbers.
- `findJsonSpan(text)` — locate the first candidate's source extent; useful for
  source extraction and indexing. Candidacy and boundaries still require scanning.
- `tryParsers(text, parsers, options?)` — supply synchronous callbacks to try in order and return the
  first value accepted by `isResult`. Parser exceptions and rejected values advance; detected Promise
  or thenable results, predicate exceptions, inspection failures and exhaustion return typed failures.
  Callbacks and their property/Promise-construction hooks run as application code in the caller's
  context. The async-result guards catch ordinary mistakes; they do not isolate hostile callbacks or
  guarantee classification of objects deliberately hiding their Promise identity.
- `createMetrics(options?)` — create a caller-owned accounting scope: a configured parser that
  every verb accepts in place of an `initParser` handle and that counts each outcome, with detached
  `read` snapshots and `reset`. It collects diagnostics inside that scope only.

Optional features are values the caller imports and passes under their option key; see
[Optional features](#optional-features). Everything is exported from `partial-json-repair`; the only
other entry is `partial-json-repair/async`.

Import whole-input async work from `partial-json-repair/async`. The entry exports `parseAsync`,
`parseManyAsync`, `repairAsync`, `findJsonSpanAsync`, `initAsyncParser`, and the execution strategies
`auto`, `cooperative` and `worker`. Each async verb returns
the same logical outcome as its synchronous peer and accepts `signal?: AbortSignal`. The async entry
may load scheduling adapters such as the worker; importing the core entry must not load them.

`initAsyncParser(options)` validates configuration once; pass its handle to the same imported verb,
such as `parseAsync(input, parser, overrides?)`, so unrelated operations remain removable.
One operation chooses one execution strategy before consuming input and
keeps it through completion, failure, or cancellation. `execution` is required and takes an imported
strategy, never a string, so an app ships only the strategies it names: without `worker` imported,
no worker code reaches the bundle, and with only `worker` imported, no same-thread engine does. An
omitted default would be referenced by every verb and so ship in every app. `auto` runs small work
inline and the rest cooperatively on the calling thread. A missing or unrecognised strategy throws
the `invalid-options` `TypeError`, whose message names the imports. Automatic worker placement requires measured policy for the host and workload, including
startup and transfer costs; that policy is not established, and will arrive as its own imported
strategy. Pass `{ execution: worker }` when other work keeps the calling thread busy. A forced worker the host cannot start returns
`execution-unavailable` without consuming input.
Execution changes scheduling and placement only, never recovered data or diagnostics.
An abort stops additional scanning at checkpoints; receiving computed recovery can continue until the failed call settles.
Parse, parse-many, repair and span derive from the same resumable operation; cancellation
never turns streamed progress into a second whole-input parse. Cooperative cancellation and host
scheduling are separate: every executor checks one cancellation state at bounded safe points, while
only same-thread work must yield to the host task queue so callbacks can update that state. A worker
whose cancellation arrives through its event loop must keep servicing that channel until an
independently observable cancellation state replaces it.

Synchronous whole-input calls remain direct TypeScript calls and do not accept `signal` or
`execution`. A signal cannot interrupt a same-thread call while it owns the JavaScript thread, so
accepting one would promise cancellation the implementation cannot perform.

```
parse(input)                       no setup; explicit outcome and data
parse(input, options)              one call with explicit options
initParser(options)                validate once; bad options throw here
parse(input, parser, overrides?)   reuse that configuration without importing other operations
```

`initParser` amortizes option validation and selector compilation and returns the parser. Invalid
options are the caller's bug: constructors and verbs validate them before reading input. Invalid
options produce a `TypeError`, with the typed `ConfigurationFailure` (`invalid-options`, `field`, `reason`) as
its `cause`. Promise-returning async verbs reject with it; `parseManyAsync` throws when the iterator
is created, before its first pull. The option types are exact, so a key a verb does not
take is a compile error whether it is written inline or passed in a variable; the `TypeError` covers
what types cannot say, such as numeric ranges and options loaded at run time. Every other failure is
a returned result. A parser holds immutable settings; each call or stream owns its mutable state.
`createStreamParser(options)` builds one stream from one configuration. Many streams over the SAME
configuration go through `createStreamParser(parser, streamOptions?)`, which is what that amortisation promises:
one validation and one compiled selector set, shared. That form takes the stream-only options
(`view`, `summary`) because they cannot be settled earlier — `view` decides whether containers are
frozen as they close. It takes ONLY those: a parse option there is refused with `parse-option-on-stream`, never ignored, because the
parse options are already fixed and a dropped one would run the stream under settings nobody chose.
A `fragments` selection is therefore passed to `parseStream` or the free `createStreamParser`; a
parser's selection cannot change per stream.
Rust generic mode types and associated outputs can preserve precise types without a new verb.

### Optional features

A feature whose code most calls do not need is a value the caller imports and passes under its
existing option key. Its code is then reachable only through that import, so an optimized build that
never imports it contains none of it, with no bundler configuration and no import-time work.

| Import | Passed as | Adds |
| --- | --- | --- |
| `diagnostics` | `{ diagnostics }` or `{ diagnostics: diagnostics({ maxEntries?, scope? }) }` | `diagnostics` on both result branches |
| `locations` | `{ locations }` | `span` on every successful whole value |
| `select` | `{ select: select(paths, { occurrences?, fragments? }) }` | Matches instead of whole values |
| `decodedFragments` | `{ select: select(paths, { fragments: decodedFragments }) }` on a stream | Decoded scalar contents in bounded pieces |
| `sourceFragments` | `{ select: select(paths, { fragments: sourceFragments }) }` on a stream | Original scalar spelling in bounded pieces |
| `skip` | `{ skip: skip(paths) }` | Named object members are not built |
| `ownedView` | `{ view: ownedView }` on a stream | Independent mutable snapshots |
| `sharedView` | `{ view: sharedView }` on a stream | Read-only snapshots sharing frozen completed branches |

- The option key keeps its name; only its value changes. A feature value is the feature itself, or
  the feature called with its settings. Settings travel with the feature, because a setting for a
  feature that is not loaded would type-check and do nothing.
- `maxEntries` (default 1000) caps the entries one report retains; `entriesComplete` says whether
  that cap left any out. `scope: "all"` also audits skipped and unselected content; the default
  covers the selected results and the recovery needed to find them.
- `select` and `skip` are factories because their paths are compiled behind the import; a path that
  cannot be compiled throws the configuration `TypeError` at the factory call. `skip` is its own
  value so a skip-only call needs no selection.
- `fragments` is stream-only: a selection built with `fragments: decodedFragments` is accepted by
  the free `parseStream` and `createStreamParser`, and refused at compile time by the one-shot verbs
  and at run time with `fragments-stream`. Streams built from reusable configuration keep its
  selection, which cannot change per stream.
- Views are imported values so a stream without snapshots retains no snapshot implementation;
  select the required ownership through `ownedView` or `sharedView`, never a string option.
- `locations` is its own feature, never a report setting, so a caller who wants spans pays for no
  report.
- Passing `true` where a feature belongs is a compile error, and at run time a `TypeError` whose
  message names the import to use and whose `cause` is the typed `invalid-options` reason.
- `exactNumbers`, `cutSuffix`, `builtinParsers`, `recover`, the limits and the root filters stay plain
  options: each is a branch inside code that default parsing needs anyway, so an import would remove
  nothing.
- Worker execution rebuilds each feature from a serialisable descriptor it carries, so the async
  entry accepts the same values.
- A later native engine arrives the same way, as an imported value from its own entry; adding it
  breaks no caller.

Handing a source to the transport and feeding chunks by hand are different jobs, so they have
different verbs and neither is a spelling of the other. `parseStream(source, options?)` is the
transport; `parseStream(source, parser, streamOptions?)` reuses validated configuration through the
same imported verb, so unrelated operations remain removable. `createStreamParser(parser, streamOptions?)` is for the caller who owns the chunk boundaries
and drives `feed`/`end` themselves. Both transport doors run one `drive`, which is why cancellation,
cleanup and the terminal-item rules cannot differ between them.

The transport doors carry `snapshot()` when `view` was requested, because the caller rendering
partial JSON as it arrives needs the stream and the view together, and holding the parser separately
to get one is what made them re-drive the transport by hand.

### Results

Keep status outside parsed data so one `ok` check distinguishes success from failure.
Typed failure values need no `Error` subclass, identity helper, or dependency.

<!-- not-compiled -->
```ts
type Result<T, F> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: F };

type Cut = {
  readonly path: SourcePath;
  readonly kind: "string" | "number" | "missing" | "between";
  readonly text?: string;
};
type Completion =
  | { readonly complete: true; readonly cut?: undefined }
  | { readonly complete: false; readonly cut: Cut };

type Recovery<T> = { readonly value: T } & Completion;

type MaybeReported<T, F> = Result<T, F> & {
  readonly diagnostics?: Diagnostics;
};
type Reported<T, F> = Result<T, F> & { readonly diagnostics: Diagnostics };
```

Parsing `{"ok":false}` succeeds with that object in `value`. Success requires `value`, even when
it is null or a supported undefined value. Failure may carry `recovered: { value, complete, cut? }`;
omitting `recovered` means nothing was recovered. Partial data never occupies the success field.

### Completion and the cut

Recovered values and repaired text carry `complete` and, exactly when `complete` is false, `cut`:
successes of `parse`, `repair` and `parseMany`, retained stream values, snapshots, and
`failure.recovered`. Incomplete recovery may accompany success or failure; inspect `ok` separately
to distinguish accepted recovery from refusal or stopped processing.

- **One cut per value.** Text is written front to back, so the cut is at the end, and every container
  on `cut.path` may be missing later items.
- **`path` names an item only when the source made it addressable.** An array index or a complete
  key names that item: `[1, tru` gives `{ path: [1], kind: "missing" }`, and `{"a":1,"b":` gives
  `{ path: ["b"], kind: "missing" }`. Input ending inside a key names no item: `{"a":1,"ke` gives
  `{ path: [], kind: "between", text: '"ke' }`. A key is never invented.
- **`kind`**: `string`, the string at `path` was still arriving and holds every character written,
  quoted or not (`{"status": complet`, and `01`, which is kept as its text);
  `number`, a number cut where it is already a valid token, which may be short; `missing`, the item
  at `path` was started but is not in the value (an unfinished number such as `1e`, `-` or a trailing
  digit separator in any radix, a partial `true` or other word, a member whose value never arrived);
  `between`, the source ended between
  items of the container at `path`, and nothing it wrote was dropped. A complete literal the end
  touched (`[1, true`) counts as finished, so its cut is `between`: no continuation extends `true`.
- **`text`** is the unfinished token the value leaves out (`tru`, `"ke`, `\u00`), never a delimiter
  or whitespace, and is absent when there is none. An incomplete escape is never placed in a value;
  it is in `text`.
  Selection preserves this text too; retained-storage limits may stop a stream while it is still
  reading the token. Skipping a value does not authorize dropping its cut metadata.
- **A consumer's test**: a path that prefixes `cut.path` identifies the source occurrence still
  being extended. A closed occurrence is not final membership: later duplicate keys or ancestors
  may replace it. Final selected matches wait for their root to complete.
- **`cutSuffix`** (`true` for `…`, or a string) is appended to a cut string, and only to a cut string:
  never to a number, which would become a string, and never as a placeholder for a missing item.
  It is applied at one point per route, so the value is the same through `parse`, a stream's final
  item, a snapshot (the copy, never the live tree), `repair()` text (escaped inside the literal) and
  the last `data` fragment. Off by default, because a suffix is text the source never wrote.
- The value is never changed to mark a cut unless `cutSuffix` asks for it.

Diagnostics are optional on either outcome. Turning them on does not change the success check
or move the data. The outer object needs no tree copy, report arrays, or confidence calculation.
`readonly` helps TypeScript callers; it does not protect live parser state at runtime.

```ts
import { parse } from "partial-json-repair";

const result = parse(text);
if (result.ok) {
  useValue(result.value);
} else {
  handleFailure(result.failure);
}
```

`Value` includes every supported recovered type, including exact numbers. Parsing does not validate
an application type: no unchecked `parse<T>()`. `Result<T, F>` describes the container only.

Stream failures preserve the source's cause or abort reason as `unknown`. A source failure may
carry the unfinished recovered prefix, but never repeats delivered values. Expose only failures
an operation can encounter; configuration, parsing, streaming, and manual feeding need distinct unions.

Branch on `failure.kind`, not message text. Format messages when needed; refused input does not
require a stack trace. Transport must handle causes, exact numbers, and JavaScript-only values
explicitly; wrapping them in an object does not make them serializable.

### Call results and selection

`Input` is `string | Uint8Array`; `Value` is the recovered value domain, not a caller-supplied type.
An absent `select` returns whole values. A present `select` returns matches, including for `[]`.
A match carries its value WHOLE: selecting a container gives everything beneath it, to any depth.
Only what lies outside every match goes unbuilt.
Passing a `Parser` to the same imported verb reuses its validated settings and compiled selectors;
the table names each operation once because its recovery behavior is unchanged.

| Call | Without `select` | With `select` |
| --- | --- | --- |
| `parse(input, options?)` | `Result<Value, ParseFailure>` | `Result<readonly Match<Value>[], ParseFailure>` |
| `repair(input, options?)` | `Result<string, RepairFailure>` | `Result<readonly Match<string>[], RepairFailure>` |
| `findJsonSpan(input, options?)` | `Result<Span, ParseFailure>` | `Result<readonly Match<Span>[], ParseFailure>` |
| `parseMany(input, options?)` | iterator of value results | iterator of match results |
| `parseStream(source, options?)` | async iterator of value results | async iterator of match results |
| `initParser(options?)` | validated `Parser` configuration | selection reflected in calls using that handle |
| `createStreamParser(options?)` | `StreamParser` | same, with selection reflected in drain results |
| `stringify(value, options?)` | `Result<string, EncodingFailure>` | selection is not an encoding option |

The async entry preserves those payload shapes while making progress and cancellation explicit:

| Call | Result |
| --- | --- |
| `parseAsync(input, options)` | `Promise` of the corresponding `parse` result |
| `repairAsync(input, options)` | `Promise` of the corresponding `repair` result |
| `findJsonSpanAsync(input, options)` | `Promise` of the corresponding `findJsonSpan` result |
| `parseManyAsync(input, options)` | async iterator of the corresponding `parseMany` results; invalid options throw at the call |
| `initAsyncParser(options)` | `AsyncParser`, synchronously |

`options` always holds `execution`; a configured parser holds it instead, and its per-call overrides
may replace it. `execution` belongs to async configuration and per-call async options. A constructor `signal`
cancels current and future operations on that parser; a per-call signal cancels only that call.
Local cancellation cannot bypass task cancellation. The first observed reason wins; when both
signals are already aborted at the call, the task reason wins. Operation subscriptions are released
on settlement. `close()` prevents new calls; cancel the task to stop running calls.

```ts
type SourcePath = readonly (string | number)[];
type Position = {
  readonly offset: number;
  readonly unit: "utf16" | "byte";
  readonly chunk?: number;
};
type Span = { readonly start: Position; readonly end: Position }; // half-open
type Match<T> = {
  readonly value: T;
  readonly path: SourcePath;
  readonly valueIndex: number;
  readonly span: Span;
  readonly selectors: readonly number[];
};
```

`valueIndex` counts recognized roots, including refused roots, from zero. Selector indexes refer
to the supplied list. Concrete output paths contain only keys and indexes, never wildcards.
Whole-value results add `span` only with the `locations` feature; diagnostics carry their own positions.
Optional report and location fields stay outside `value` on both branches where applicable.

### Configured reporting

Reaching the report is one option, not a second verb:

```ts
import { diagnostics, initParser, parse } from "partial-json-repair";

const p = initParser({ diagnostics });
const r = parse(text, p);
if (r.ok) console.log(r.value);
else console.error(r.failure);
console.log(r.diagnostics.repairs, r.diagnostics.confidence);
```

```rust
let p = Parser { diagnostics: DiagnosticsMode::On, ..Parser::default() };
let r = p.parse(text)?;
let report = r.diagnostics.expect("requested above");
```

In Rust the configuration IS the parser, and there is no builder: struct-update syntax already means
"everything I did not write", every field is independently valid, so a `build()` returning `Result`
would be a call that can never fail. `initParser` exists on the TypeScript side because it validates
a caller's literal at run time; Rust's types do that at compile time.

**Reports are selected at run time, not by type.** A `Parser<Reporting>` could make `diagnostics`
non-optional and remove the `expect` above, and it is rejected because every binding this core feeds
— native, WASM, the C header — crosses one byte-buffer boundary carrying options as DATA: a
type-level choice would compile both engines into every artifact and a C header could express
neither. The cost is stated rather than hidden — a caller who asked for a report still unwraps an
`Option` the type could have guaranteed. Report-enabled failures also carry diagnostics. Both modes
use ordinary `Result`; checked recovery remains attached to failures, not successful data.

Use one `diagnostics` feature for repairs, errors, and confidence so callers need not coordinate
separate report switches. Scan limits, policy checks, refusals and their positions still run when
reports are off: a default `policy-refused` or `limit-reached` failure carries its `issue` or `at`
with line, column and context.

### Caller-owned metrics

`createMetrics(options?)` validates parse options once and returns a mutable accounting scope: a configured parser with `read` and `reset`. It
always reads a report, so passing `diagnostics` throws `metrics-report` instead of being overridden.
Every verb given the scope (`parse(text, measured)`, `parseMany`, `repair`, `findJsonSpan`,
`parseStream(source, measured)`, `createStreamParser(measured)`) accumulates outcome counts and repair counts
keyed by `RepairKind`; `security.blockedKeys` counts blocked occurrences per dangerous key, dropped
or refused with the document under `reject`, one entry per configured key, so it cannot grow with
the input (a null-prototype record, so `__proto__` is an ordinary entry). `read(reset?)` returns
detached nested records, and `reset()` begins a new interval without changing an active stream.

`parseDuration` is the elapsed time of the last consumed parse or stream drain. Retained-input peak
and compaction counts come from the stream scanner's cursor; buffer refusals come from its typed
terminal outcome. Metrics expose no engine counters because automatic routing is intentionally
invisible. The ordinary parser has no counter owner, and a supported bundler drops the metrics
module when its export is unused.

Set `objectOnly` / `object_only` to accept only object roots. `requiredKeys` / `required_keys`
also requires every named own key, so inherited JavaScript properties never qualify. Every verb
skips earlier candidates in source order: single-result verbs use the first match and multi-result
verbs yield every match. Exhaustion after candidates is `no-match`, with the required keys and the
first object candidate when one was available; refusal and resource failures still take precedence.
Source occurrences and scalar fragments cannot be combined with root filters, because both deliver
a match before its root closes and a filter accepts the root only once it has. Any verb given
`select(paths, { occurrences: true })` with `objectOnly` or a non-empty `requiredKeys` throws
`invalid-options` with reason `root-filter`, and so does a stream given a `fragments` selection with
them; final matches combine freely.

### The same actions everywhere

Rust uses `parse`, `parse_many`, `repair`, `parse_stream`, and `find_json_span`. Keep the same
actions, plus `stringify` for encoding recovered values, but use Rust's naming, `Result`,
ownership, and iterator conventions.

Native and WASM adapters preserve behavior, not JavaScript signatures. Reuse configuration and
batch results to reduce crossings. Define handle lifetime, buffer ownership, release, and typed
failure before fixing a binary boundary; byte ranges alone do not specify an incremental parser.

### Rust needs more than the same names

The Rust crate is not released with the first npm release and has not yet caught up with the
recorded corpus; the Rust sections below are the contract it
must meet when it ships, not a description of a published crate.

Rust callers need typed errors, explicit ownership, and optional application-type validation;
matching JavaScript method names alone does not provide those contracts.

**Serde is optional integration, not the recovery core.** A Rust caller may recover a dynamic
value or deserialize it into an application type. Deserialization checks that type; unlike a
TypeScript assertion, it may fail. Keep its typed failure distinct from failed recovery.

An application struct can omit unwanted fields, but this does not by itself prove recovery avoided
building those fields. Selection also supports dynamic paths, source locations, and scalar fragments.

**Choose scanner control flow by measured integration costs.** A resumable state machine can serve
pull and push consumers without a thread or coroutine. Serde's ignored-value facility can skip
unwanted values; it is not a capability missing from `serde_json`. A recovered-value adapter is
simple but may materialize more; direct typed recovery can avoid that work only if it preserves
the same repair, duplicate-key, and refusal semantics. Neither control-flow style wins by definition.
See [Serde's ignored-value interface](https://serde.rs/ignored-any.html).

**Borrow when input lifetime permits; own when the result must outlive it.** A Rust value
borrows unchanged source slices and owns decoded or repaired content. An explicit owned conversion
lets callers release input storage. Stream results may own content or retain bounded backing storage;
the public lifetime must make that cost clear. `Cow<str>` alone cannot represent unpaired surrogates.

**Malformed input is an expected typed failure, not a reason to panic.** Lints catch some panic
sites, not stack exhaustion, allocation failure, or every panic in called code. Test malformed
inputs, depth limits, cleanup, and native boundary behavior; do not call a lint ban proof of safety.

### Rust call sites and ownership

The Rust crate is `partial-json-repair` (`partial_json_repair` in code). The core has no required
third-party dependencies. Enable `serde` for checked application-type conversion and `async` for
standard async-stream integration; neither changes the recovered value domain.

```rust
let value = partial_json_repair::parse(input)?.value; // shipped defaults, no setup
let owned = value.into_owned();
let parser = Parser { exact_numbers: true, ..Parser::default() };
let value = parser.parse(input)?.value;
let order: Order = value.deserialize()?; // optional serde feature; validation can fail
```

Every verb exists twice: as a `Parser` method, and as a free function of the SAME name reading the
shipped defaults. D2 gives the common task no setup, D3 keeps one action from answering to two
names, and the free function is D4's shortcut — it removes setup and nothing else.

`Value<'a>` represents null, booleans, numbers, lossless strings, arrays, ordered objects, and
explicitly enabled undefined. `Number<'a>` distinguishes ordinary floating point from exact
tokens. Deserializing preserves that distinction: an exact number reaches the narrowest integer that
holds it, and a magnitude no double can hold reaches a text field as its digits rather than becoming
infinity. `JsonString<'a>` carries recovered strings, repaired text and diagnostic context; it exposes
checked `as_str()` and lossless `code_units()`. Object lookup accepts text or code units, so a lone surrogate key remains addressable.
`into_owned()` releases the result's dependency on source storage. Public wrappers hide storage
layout; they do not expose a particular hash table or string encoding as a permanent contract.

Borrow unchanged one-shot input through `Input<'a>` conversions from `&str`, `&[u8]`, or `&[u16]`.
Rust text and UTF-8 bytes use byte positions; explicit UTF-16 input uses code-unit positions.
Stream chunks implement `AsInput`: strings, byte and UTF-16 slices or buffers borrow their existing
storage. Use `Input` when successive chunks have different representations. Custom transport
wrappers implement `as_input(&self) -> Input<'_>` without decoding or copying their contents.
Streaming results are owned. A manual `feed` drain borrows the stream mutably, preventing another
feed while active; a borrowed view likewise prevents mutation until that view is released.

`parse_many` accepts fixed input and returns an iterator. `parse_stream` accepts a fallible chunk
iterator; `parse_stream_async`, behind the `async` feature, accepts a standard fallible `Stream` and
returns a `Stream` of typed results without choosing an executor. It is a sibling verb rather than an
`async` module because `async` is a keyword: a module of that name is only reachable as `r#async`,
a wart every call site would pay. Preserve the source error type as a generic parameter.
Drop stops parser-owned work; callers needing asynchronous source cleanup explicitly await `close` —
in Rust `into_source` hands the source back for that, since no `Drop` can await.
The same drain core serves synchronous, asynchronous, and manual callers.

Call `with_summary()` on a Rust stream to append its completion account. Source iteration or manual
`feed`/`end` drains yield `StreamEvent::Item(result)`, then one `StreamEvent::Summary(StreamSummary)`
when the source ends or stops. The summary follows the counting and terminal rules below;
the async `Summarized` wrapper retains `into_source()` for caller-owned cleanup.

### Native and WASM contracts (deferred)

The first npm release ships the TypeScript engine only; the
parked adapters live in `rust/js-adapters/`. The rules below bind native and WASM when they return as
an imported feature from their own subpath — additive, so no caller breaks. They describe no entry
the current package has.

Native JavaScript bindings return the same plain results and value types as TypeScript. No binding
may turn a typed refusal into a thrown host error or round an exact number during conversion.

WASM exports the same logical operations with checked linear-memory ranges and handles. Return
typed failures for invalid ranges or stale handles; do not use traps for expected input failures.
Do not retain a host view across memory growth without recreating it from its offset and length.
Bulk value export and scalar-fragment batches avoid a host callback for every scanner token.

Ship a portable scalar WASM build. Ship other WASM variants only when their full startup, transfer,
size and fallback costs show a useful advantage. Probe required host features before instantiation;
unsupported variants fall back without changing results.

Core imports perform no optional engine loading. Synchronous whole-input calls use TypeScript and
perform no worker, native, or WASM initialization. A returning engine is an imported feature value
from its own entry, passed under its own option key like every other feature, so its arrival
changes no existing call. Loading a module is explicit at that import; the caller supplies a
compiled module or bytes, or explicitly requests the bundled artifact.
Load once per configured engine, not once per value; browser use never requires a native package.
Configured JavaScript parsers release engine state through idempotent `close()` or
`[Symbol.dispose]()`. `close()` returns and preserves the first typed cleanup result; disposal
performs the same release without returning it. Later calls return `parser-closed`; Rust parsers
rely on ownership and `Drop`.
Eligibility follows from those rules: Node and Bun may use the native binding when its package is
installed; Deno may use it only when the permission it needs is already granted, checked by a query
and never a request; browsers and edge runtimes choose between WASM and TypeScript; TypeScript is
eligible everywhere.

Here, a native target is one OS, CPU, and, on Linux, libc combination. Its optional package contains
exactly one OS-loadable native library file for the TypeScript API. That file exposes N-API and the
shared FFI ABI. A loaded adapter declares eligibility by exposing only the operations it can safely
run on the current host; selection joins those capabilities and advances when one is absent. A
runtime matrix proves this behavior but never becomes production version policy. A runtime with no
eligible native route remains supported through TypeScript. Rust callers use the Rust crate rather
than these host bindings. Evidence from one target, runtime, version, or loader does not establish
another.

The native package matrix covers macOS, Linux, and Windows on arm64 and x64, with separate glibc and
musl packages on Linux.

Node checks N-API before its flag-gated experimental FFI. Bun checks FFI before N-API. Deno checks
permissioned FFI before Node-API compatibility. Each loader performs a startup self-check before
reading input. Automatic selection advances after a reported load or self-check failure and
ultimately reaches TypeScript. Forced native selection tries every applicable native route, then
returns the typed load, permission, ABI, initialization, or capability cause. One configured parser
or stream keeps its selected engine until it closes.

Which engine ran is never a field on a success. P3 rules that only the route differs, so a fallback
must be invisible in the data — reporting which engine ran would contradict it and would let callers
branch on something we promise is not observable.

An automatic engine may decline a capability before consuming input. Once a stream starts, keep
one authoritative state; do not switch engines by silently rescanning its consumed prefix.
Measure startup, conversion, output construction, steady-state calls, and retained memory separately.

## Failure and diagnostic vocabulary

`src/types.ts` owns the published declarations. Every outcome a
caller branches on is a tagged name from a closed set, never prose: `RepairKind`, `ErrorKind`, and
the `Failure` kinds. English belongs to a formatter at the edge, because a caller branching on
wording breaks when the wording improves. Each union maps one-for-one onto a Rust `enum`.

Three outcomes that are easy to confuse and MUST stay distinguishable without inspecting the value:

- A **repair** describes a recovery change. Repairs may explain a successful value or recovered
  data attached to a failed operation; their presence does not prove the operation succeeded.
- A **diagnostic error** explains rejected syntax or another observed problem; it does not by
  itself say whether processing continued, stopped, or produced usable data.
- A **failure** means the requested operation did not succeed. It may contain recovered data,
  but not as ordinary success. `no-json-found` differs from successfully parsing `null`.

`confidence` summarizes repair penalties, not the probability that the answer is correct. If report
entries are capped, distinguish the aggregate's coverage from the entries retained for inspection.
Formatting repairs cost nothing — a trailing comma or a single quote says the input was sloppy, not
that anything was guessed.

### Failure fields

Use operation-specific unions drawn from these cases; do not make a synchronous parse handle a
source-cleanup failure it cannot produce. Include `recovered: { value, complete, cut? }` only where
data exists; `cut` is present exactly when `complete` is false. Recovery does not make the call succeed.
If processing stops before a root passes the requested filter and no unfinished value is available,
recovery keeps the stored fallback candidate. Earlier delivered roots are never repeated as recovery.
Its requested report still describes that candidate's repairs after later candidates were inspected.

| `kind` | Required information | Caller action |
| --- | --- | --- |
| `invalid-options` | `field`, typed `reason`; thrown as a `TypeError`'s `cause`, never returned | Correct the named option. |
| `execution-unavailable` | `execution: "worker"`, typed `reason` (`unsupported`: the host has no worker; `failed`: the worker did not start or stopped answering), `message` saying what failed and what to do; interrupted delivery retains received recovery and any source refusal or abort as `cause` | Inspect recovery before retrying; pass `auto`, deploy the worker file, or restore the required host capability. |
| `scheduling-failed` | original `cause`, optional recovery and independent `cleanupFailure` | Inspect recovery and retry only after restoring host scheduling; processing stopped without consuming more source. |
| `signal-failed` | original signal-provider `cause`, available `recovered`, optional `cleanupFailure` | Repair the signal provider before retrying; subscription failure consumes no input, later failure preserves available data. |
| `invalid-input` | received input type; optional recovery when borrowed bytes become unreadable, and any failure while recovering that prefix as `cause` | Supply text or a readable byte view. |
| `no-json-found` | none | Provide a candidate; null is a successful value. |
| `no-match` | expected object kind, required own keys, optional first compatible object | Change the filter or inspect the recovered candidate. |
| `policy-refused` | source issue, optional recovery | Inspect recovery or change the requested policy. |
| `limit-reached` | resource, configured limit, source position when known, optional recovery | Change the bound or request less retained output. |
| `unsupported-encoding` | encoding name | Decode that encoding before parsing. |
| `invalid-source` | invalid iterator, reader, or chunk shape, optional unfinished recovery | Inspect recovery and supply the documented source interface. |
| `source-failed` | original cause, optional unfinished recovery | Repair or retry the source; completed results are not repeated. |
| `aborted` | original reason, optional recovery | Inspect recovery; treat the operation as stopped, not complete. |
| `cleanup-failed` | original cause; a successful single-result async operation retains `completed` | Inspect retained output and resolve cleanup through the resource owner. |
| `stream-closed` | none | Create a parser for a new stream. |
| `parser-closed` | none | Create a new parser; this one was released by `close()`. |
| `async-parser`, `acceptance-failed`, `result-inspection-failed`, `parsers-exhausted` | `parserIndex` for the first three, plus `cause` for the middle two; only `attempts` for the last (`tryParsers`) | Pass synchronous parsers, fix the `isResult` check, or add a parser for the format. |
| `non-json-value` | value kind and path (`stringify` only) | Correct the value before encoding; `stringify` returns no partial text. |
| `overflow`, `underflow`, `inexact` | none (`toNumber`) | Keep the exact number, or pass `allowRounding` when `inexact` is acceptable. |
| `not-integer`, `digits-exceeded` | `digits` and `maxDigits` for the second (`toBigInt`) | Keep the exact number or raise `maxDigits`. |
| `cycle`, `accessor`, `invalid-value` | `path`, plus the thrown `cause` for `invalid-value` (`stringify`) | Remove a cycle, accessor, or unsupported value before encoding. |
| `non-scalar-selection` | selected path | Select scalar contents when requesting fragments. |

An independent cleanup failure accompanies an earlier failure as `cleanupFailure`; it never replaces
the original cause. A cleanup failure after otherwise normal exhaustion is itself a terminal failure.
For single-result async calls, that failure retains the successful operation as `failure.completed`,
including its requested report, selection, location and completion fields. Inspect that operation's
output; repaired text and spans are not recovered source values. The call itself remains failed.
Expected failures use these values; process termination, allocation failure, and arbitrary runtime
defects are not promises the library can turn into ordinary results.

Interrupted worker delivery can retain only the data that reached the caller. Its recovery's
`complete` and `cut` still describe the source; they do not promise that the whole value arrived.
Requested reports describe source recovery and arrive before that data, so a delivery failure does
not turn a missing report into a clean report. Successful repaired text and spans are projections,
not source recovery. An aborted cause keeps the caller's original cancellation reason, including
its identity; that value may not be cloneable.

### Options and defaults

Per-call options override reusable settings without changing the parser. Validate unknown keys,
types, positive integer bounds, selector paths, and incompatible options before consuming input.
On configured one-shot calls, supplied fields replace configured fields, including the `recover`
map; a field set to `undefined` is not supplied and keeps the configured value. Snapshot caller-owned settings before lazy iteration; calls without overrides reuse validation.

- Keep the independent leniency flags: comments, single quotes, trailing commas, unquoted keys,
  JavaScript extensions, and broken-input repair. The presets are `LLM_BALANCED` (the default),
  `LLM_FULL`, `STRICT`, and `COMPAT`. The default enables `allowJavaScript` to recover useful literal
  and non-decimal forms. `repair` fails exactly when `parse` fails: a recovered value with no JSON
  spelling is written as `null` in place and reported as `js-literal`. Read `docs/MIGRATION.md` before
  replacing a legacy preset with diagnostics-off defaults.
- `recover` overrides a single repair kind, winning over whichever flag would otherwise decide it,
  in both directions: switch on a recovery the preset leaves off, or switch off one it allows. It
  exists because one flag decides a family — a caller whose model never truncates cannot decline
  truncation-healing while keeping comma and bracket repair. Off means what it means for a flag, so
  the value is unchanged and only the verdict and the report move. Validate each key against the
  repair kinds and each value as a boolean, naming the offending key rather than the object. Kinds
  no flag governs are switchable too; `dangerous-key` is not, because `onDangerousKey` governs it.
- Refusing `duplicate-key` declines the `JSON.parse` fast path, because that path collapses a
  duplicate before any reviver sees it and would answer success for a document the scanner refuses.
  It is the only repair valid JSON can produce silently; every other needs syntax `JSON.parse`
  rejects, so refusing one costs nothing.
- An error that refused a recovery names it as `refused`. Every refusal reports as
  `unparsable-span`, so without it a caller who declined several kinds cannot tell which one fired,
  and that is the only thing they can act on. Absent where no kind was declined.
- A disabled spelling remains recognizable but produces `policy-refused`; preserve recoverable
  data under that failure. `STRICT` stops at its first refusal; it still extracts candidates from prose,
  because a refusal inside prose it rejects leaves with that prose.
- With JavaScript extensions off, `undefined`, `NaN`, and `Infinity` retain their source spelling
  as strings rather than becoming non-JSON values. Non-decimal number spellings retain their numeric
  value but report refused syntax when that leniency is off.
- Optional features are imported values passed under their option key: `diagnostics`, `locations`,
  `select(paths, settings)` and `skip(paths)`. An app that never imports one never bundles its code.
  `false` turns a parser's feature off for one call; `true` fails to compile and throws
  `invalid-options` with reason `import-required`, naming the import.
- `diagnostics` reports requested recovery; `diagnostics({ scope: "all" })` also audits skipped
  content. Passing the feature requires `diagnostics` in the return type; a dynamic option makes
  that property optional without changing `ok` or `value`.
- `maxErrors` bounds policy errors before stopping. A budget spent inside a root candidate that has
  not yet shown a mark of data (a quoted token, a colon, a second value) stops the scan only once it
  shows one or is accepted, and a candidate rejected as prose takes its errors with it: detection
  must not depend on which repairs are enabled. `diagnostics({ maxEntries })` caps the entries
  each report retains, per root, without stopping recovery. Both default to 1000; their effects differ.
- Keep the published `maxBuffer`, `maxDepth`, and `maxScalar` defaults. `maxBuffer` binds streams only and counts scanner-owned
  input carry in original units, not a borrowed active chunk; depth counts nested containers, including
  skipped ones. `maxScalar` also bounds an unfinished top-level bare token while candidacy is undecided.
- `maxRetained` bounds stream-owned recovered content, including selected values pending finality;
  its default is `maxBuffer`. Charge one unit per value and container entry, plus UTF-16 code units
  in strings and keys and characters in exact-number tokens, numbers still being read, or retained
  repaired text. These are
  logical units, not allocator bytes. Delivered values and caller-held snapshots are excluded.
  Whole-input calls do not enforce `maxBuffer` or `maxRetained`; callers must bound their input separately.
- `exactNumbers: false`, no selection, no skip, `summary: false`, and no locations are the defaults.
  Passing a `select` value requests selection, even when its path list is empty.
- Async streams accept `signal?: AbortSignal`; an already aborted signal prevents source reads.
  Once a terminal failure is observed, later cancellation does not replace its cause.
- Async whole-input calls accept `signal?: AbortSignal`; an already aborted signal prevents input
  consumption, and later cancellation stops at a scanner safe point or the chosen executor's
  cancellation boundary. Return any recovery available at that boundary under an `aborted` failure.
  Same-thread execution batches work between measured host-task yields. Background execution checks
  cancellation without yielding when its cancellation state is independently observable; receiving
  cancellation as an event still requires servicing that executor's event loop.
- `auto` runs cooperatively and keeps small work inline. Forcing `worker` returns
  `execution-unavailable` when the host cannot start one; the operation never falls through to
  another strategy. `cooperative` needs no worker, but depends on host-task scheduling; a failed
  yield returns `scheduling-failed` with its cause and available recovery, including unread stream EOF results. Unlike `auto`, it slices
  scanner work at every input size instead of running small input inline. Input
  shorter than one slice finishes before its first checkpoint, and text `parseAsync` or
  `repairAsync` hands to `JSON.parse` (see `builtinParsers`) is read in one unsliced call.
- `select(paths, { occurrences: true })` permits delivery before ancestor finality; output records
  source occurrences even when later duplicate ancestors replace them. It defaults to false.
- Keep `onDangerousKey: "keep"`, `customDangerousKeys`, and `nullPrototype: false`; `drop` removes
  only matching members, while `reject` refuses their containing object without erasing unrelated recovery.
- `builtinParsers` (default `true`) lets whole input reach the host's `JSON.parse` where that is
  proved to give the scanner's answer: clean text as it is, and cut-off text or text with comments
  or trailing commas after a one-pass rewrite; `false` keeps every input on the scanner. Only the route
  changes, never the outcome. The async `parseAsync` and `repairAsync` take it only for text up to
  64 Ki units, because `JSON.parse` cannot be sliced or stopped; longer text stays on the sliced
  scanner.
- `cutSuffix` (default off) appends a marker to a string the source cut off: `true` appends `…`, a
  string appends itself. Only a cut string gets it, because on a number or a missing item it would
  change the value's type or invent an item. Every route shows the same value: `parse`, a stream's
  `end()`, each snapshot, the last fragment piece, and `repair()` text, where it is escaped inside
  the literal. It is off by default because a caller cannot tell an appended marker from source
  text; `cut` already says where the value ended.

`Diagnostics` contains repairs, errors, their total counts, `entriesComplete`, `scanComplete`,
`scope`, and confidence. Count and score all issues in the requested scope even when entry storage
is capped. `entriesComplete: false` does not mean scanning stopped; `scanComplete: false` does.
Confidence uses the shared repair-penalty table, not just retained entries, and is not a probability.
`laterValues` lists the source span of each value after the one `parse`, `repair` or `findJsonSpan`
returned: what `parseMany` with the same options would deliver next. Verbs that deliver every value
leave it empty. It holds at most `maxEntries` spans (`entriesComplete: false` past that), and the scan
that finds them runs only for a requested report and only when non-whitespace follows the value.
Without a report, the success sets `more: true` exactly when `laterValues` would be non-empty. Cost:
the call reads past the value up to the next one, so text after the value that holds no later value
is read to its end.

## Selective work

Without selection, `parse(text)` builds the first recovered value. Requested features determine
additional work; reusable configuration can validate and compile options once for repeated calls.

**Measure dispatch where it runs.** The existing call-site microbenchmark motivates avoiding
needless polymorphism; it does not predict a whole-parser slowdown or rule out specialization.
Compare optimized complete paths, including calls that do not request selection.

The implementation must decide whether to build a subtree before allocating its contents.
This omits unrelated branches from the recovered tree; it does not promise zero temporary
allocations while decoding tokens or enforcing policies on excluded content.
Path changes are a possible place to update selection state. Keep duplicate and dangerous-key
policy at the insertion point; a selector is not a second authority for key handling.
Concrete matcher and dispatch choices remain measurable implementation decisions.

### Picking what gets built

`select` names the parts you want. `skip` names parts you do not. Both are lists of paths, and a
path is a list of segments:

```ts
import { ANY, ANY_DEPTH, initParser, select, skip } from "partial-json-repair";

initParser({ select: select([["items", ANY, "name"]]) }); // just the names
initParser({ skip: skip([["response", "embedding"]]) }); // everything except the huge one
initParser({ select: select([[ANY_DEPTH, "id"]]) }); // every id, wherever it turns up
```

Segments are values, not a string somebody has to parse. A string is an object key, a number is an
array index, and the two sentinels are the wildcards. Nothing needs escaping, nothing needs
splitting, and a document with a key literally called `*`, or one called `items.name`, still works —
without an escaping grammar. Encode wildcard sentinels explicitly when crossing native or WASM
boundaries; a JavaScript symbol is not a portable wire value.

`ANY` matches one key or index; `ANY_DEPTH` matches zero or more. `[]` as a path selects the root,
whereas `select([])` selects nothing. Index segments must be nonnegative safe integers; string
`"0"` matches an object key, not array index `0`. Match decoded keys without Unicode normalization.

JSONPath is a live alternative when callers need filters or an existing query language. Segment
paths avoid that grammar for key/index selection, but give up those expressions. This choice does
not claim every JSONPath implementation evaluates expressions per token or parses on every call.

`ANY_DEPTH` can require more active matches than a fixed path. Bound matcher work by selector
complexity and nesting depth; preserve parent state when descending and restoring siblings.
An automaton is a candidate, not evidence that recursive wildcards are free.

Use `ANY_DEPTH` when a field's ancestors are unknown; use fixed paths when they are known.

### What selection does to each verb

**`select` yields matches. It does not hand back a trimmed copy of the document.** Every value it
produces carries the path it came from, because a caller who selected two things otherwise cannot
tell which one arrived.

Matches retain source paths without inventing array placeholders or changing index meanings.
Compacted arrays are possible, but require a different, explicitly index-changing contract.

`skip` is the other operation and it does trim, because removing an object member raises none of
that. **A skip path may not end in a wildcard or an index**, so it can never target an array
element; that is checked when `skip(paths)` is called, and it is the whole reason skipping needs no rule
about holes. Skipping the huge field inside every record is `skip([["items", ANY, "embedding"]])`,
which ends in a key and is exactly the case that matters.

Where they overlap, **`skip` wins**, so selecting a parent cannot force an excluded member to be built.
Skipping controls output and allocation; it is not a security boundary for downstream use of other data.

Per verb:

- `parse`, `repair`, and `findJsonSpan` return matches from the first recovered root as an array;
  an existing root with no matches succeeds with an empty array. No root is `no-json-found`.
- `parseMany` and `parseStream` yield individual matches with their root index, path, and source span.
  `repair` matches contain repaired JSON text; `findJsonSpan` matches contain original source spans.
- Order matches by root, then source start, with ancestors before descendants. Source-occurrence
  mode delivers each match when it closes instead, so a descendant precedes its ancestor; holding
  descendants back for the ancestor would undo the early delivery that mode exists for. Merge
  repeated selectors at the same source occurrence and include all matching selector indexes on
  that match.
- Overlapping matches remain distinct. Returned mutable values must not alias another match or
  parser state; copying overlapping output is part of the work explicitly requested by those selectors.
- **Final matches may need retention until their ancestors close.** A later duplicate `items`
  member can replace every previously observed match beneath it. Explicit source-occurrence mode
  can release matches earlier, but those matches need not belong to the final recovered object.
  A large selected scalar still requires storage unless scalar fragments are requested.
- The live view follows the same selection, so a UI can track one part of a large document. It
  shows the match still being written — a selected container or a selected string — after the
  held ones, its span ending where it starts.

### Diagnostics describe the requested recovery

Skipping materialization does not skip the structural work needed to find the next selected value.
When requested, default diagnostics cover selected results and the recovery needed to find them;
whole-source auditing is a separate opt-in. State that coverage with the report.
Requested syntax and key policies still apply to the whole candidate. Report scope changes which
explanations are collected, not whether an unselected policy violation is accepted. Validation may
therefore scan skipped contents without constructing their values.
Scanning delimiters does not imply that every skipped scalar was decoded, converted, or audited;
do not report numeric-conversion loss where no conversion took place.

The depth budget applies inside a skipped subtree too, for the same reason: the budget protects the
scanner, which is still working, not the tree, which is not being built.

The one thing NOT reported is the skipping itself. A dangerous key dropped by policy gets a repair
because the caller did not ask for it; a subtree you selected away needs no record, because you
wrote the selector. Recording one per skipped member would also be unbounded on exactly the input
skipping exists to make cheap.

### Selectors that never match are reported

A path that matched nothing belongs in the requested stream summary, not only in diagnostics.
Deliver the summary through ordinary iteration, even when no values match. At early termination,
an unmatched path means not found in examined input, not absent from unread input. A final absence
cannot be known while the source is still open.

### The two ends of the same API

Choose the operation and requested output, not a separate fast-versus-capable API.

**Nothing declared** requests no repair report or selection. Use a measured suitable engine;
availability alone does not make a native crossing faster. A fast path must preserve requested
semantics, including exact-number handling and duplicate reporting when diagnostics are requested.

Text and byte paths have different conversion costs. `JSON.parse` accepts text; that does not
describe every API in each host. Compare complete paths for the actual input representation,
including decoding, native crossings, output construction, and valid as well as damaged input.

**Additional requests** may include reports, selectors, and live views. Each must justify its work.
Live views do not inherently require a TypeScript scanner; boundary cost depends on the view protocol.

Options change requested work without multiplying action names. Verify that disabled features
do not perform their optional work; an attractive option surface is not evidence of this property.

### What we deliberately do not build

- **A mandatory token visitor.** Ordinary callers should not assemble tokens. Selected scalar
  fragments remain in scope because one selected string can exceed memory; fragment batches can
  cross native boundaries without a callback per token.
- **Deferred source-backed access.** It can avoid work when fields are chosen after parsing starts,
  but retains input and adds lifetime rules. The first API excludes it; getters and indexes are
  possible mechanisms, not inherent requirements or sufficient reasons to reject the capability.
- **Value substitution during recovery.** It can avoid intermediate data, but couples recovery to
  caller code and its failures. The first API keeps transformations separate; this does not claim
  a later caller transformation always has the same memory cost.
- **Restorable parser checkpoints.** The first API excludes saving state across process restarts.
  Ordinary incremental feeding and pausing between pulls are different and remain in scope.

## Streaming

Two different jobs live here, and treating them as one is the mistake to avoid:

- **Values as they finish** — a log of JSON lines, a model emitting one object after another.
- **The value while it is still being written** — showing a form filling in as the model types it.

### Values as they finish

Chunk boundaries do not frame JSONL records. `parseStream` uses the same root detection as `parseMany`, so `[1]\n[2]` yields two arrays; a root with no mark of data is held until the next root or the end of input shows it stands alone, so the last one arrives at the end. JSONL whose lines may be cut off needs complete-line framing followed by `parse` per line, because a line cut inside a string otherwise continues into the next.

Default iteration yields ordinary `Result<T, StreamFailure<T>>` items. Root-local policy refusal
yields a failed result and permits the next root; limits, invalid input, source failure, and abort
are terminal. A source with no recognized root yields `no-json-found` once; an unmatched selector
over recognized roots does not. Never return partial recovery as a successful item.

With `summary: true`, append one `{ kind: "summary", complete, roots, matches, unmatched }` item
after normal exhaustion or a delivered terminal failure. `unmatched` contains selector indexes;
`complete` means the whole source was examined. Summary items have no `ok` field, so an ordinary
result cannot collide with them. Consumer exit suppresses further items, including the summary.

`roots` counts recognized roots, including refused roots. `matches` counts successfully delivered
matches, or started scalar occurrences in fragment mode; without selection it is zero. `unmatched`
lists selectors with no such delivery, not keys proven absent from refused or unread source.

```ts
import { parseStream, select } from "partial-json-repair";

for await (const result of parseStream(chunks)) {
  if (result.ok) useValue(result.value);
  else handleFailure(result.failure);
}

for await (const item of parseStream(chunks, { select: select([["id"]]), summary: true })) {
  if ("kind" in item) showUnmatched(item.unmatched, item.complete);
  else if (item.ok) useValue(item.value);
  else handleFailure(item.failure);
}
```

### HTTP frameworks and native streams

Read original request bytes, never through a framework's JSON body parser. `request.text()` can
erase an unsupported encoding marker before recovery sees it. For an already bounded whole request,
recover asynchronously and use checked serialization to keep exact digits:

```ts
import { auto, parseAsync } from "partial-json-repair/async";
import { stringify } from "partial-json-repair";

export async function recoverRequest(request: Request): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const result = await parseAsync(bytes, { execution: auto, signal: request.signal });
  if (!result.ok) return new Response(result.failure.kind, { status: 422 });
  const encoded = stringify(result.value);
  return new Response(encoded.ok ? encoded.value : encoded.failure.kind, {
    status: encoded.ok ? 200 : 422,
    headers: { "content-type": encoded.ok ? "application/json" : "text/plain" },
  });
}
```

For incremental consumption, pass `request.body` directly to `parseStream` with `request.signal`.
Await each downstream write before requesting the next item; always await `call.close()` in `finally`
and handle its typed failure. Native `ReadableStream` pull/cancel callbacks can expose the result
iterator without a background pump. This works when `ReadableStream.from` is absent too. Node
`Readable` and `IncomingMessage` inputs already implement the iterable protocol; no conversion is needed.

Wire either handler before framework body parsing:

| Framework | Raw request binding |
| --- | --- |
| Hono | `app.post("/recover", c => recoverRequest(c.req.raw))` |
| Elysia | `app.post("/recover", ({ request }) => recoverRequest(request), { parse: "none" })` |
| Fastify | Create `dispatch = getRequestListener(recoverRequest)` from `@hono/node-server`; call `reply.hijack()` and await `dispatch(request.raw, reply.raw)` in `onRequest`, before its JSON parser. Register the route too. |

The executable bindings in `bench/prior-art/http-server.ts` and request contracts in
`test/http-request-probe.ts` exercise real local HTTP requests and streamed responses. Framework
adapters own socket disconnect propagation; the library owns parser and source cleanup. Do not
buffer a streaming body with `.text()` first or decode byte chunks independently.

### Stream ownership

The iterable is single-consumer. `close()` stops delivery and returns the cleanup outcome;
repeated calls share the same cleanup attempt. Async streams also accept `close({ signal })` to
bound the wait: aborting that wait does not prove upstream cleanup completed. Early iterator
`return()` requests cleanup without waiting on a non-cooperative producer; callers needing its
acknowledgement await `close()`. Cleanup failures remain observable there even after iteration ends.
A close-wait signal failure returns `signal-failed` for that wait; other callers still observe the shared cleanup result.

Manual streams expose `feed(chunk)` and `end()` as lazy result iterators, `snapshot()` when a view
was configured, and idempotent `close()`. Each active drain owns its input until exhausted or closed.
With a requested view, `close()` releases scanner work but keeps the detached final view readable
through `snapshot()`, so abandoning input does not discard useful recovery. Release the stream handle
when that view is no longer needed; closing it does not erase snapshots the caller already holds.
Calling `end()` twice, feeding after end, or calling either after a failure that stopped reading
(a resource limit, or a refusal that ends the scan) returns `stream-closed`; no values are replayed.

```ts
import { createStreamParser, sharedView } from "partial-json-repair";

const stream = createStreamParser({ view: sharedView });
try {
  for (const result of stream.feed(chunk)) handleResult(result);
  const snapshot = stream.snapshot();
  if (snapshot.ok && snapshot.value !== undefined) render(snapshot.value.value);
  else if (!snapshot.ok) handleFailure(snapshot.failure);
  for (const result of stream.end()) handleResult(result);
} finally {
  stream.close();
}
```

An abort does not run normal EOF repair. Return only recovery already available without consuming
more source. A source exception may finish its retained prefix under the recovery policy, attached
to `source-failed`; this distinguishes failed delivery from an explicit request to stop work.

- `feed(chunk)` yields the results its chunk completed, after any an earlier unread `feed()`
  completed; `end()` yields only what is still undelivered. Each value arrives exactly once. A
  root completes when the character after it arrives (a touching comma would start a list), so a
  root that ends its chunk arrives with the next `feed()` or with `end()`; a stop before then
  returns it as complete recovery.
- Release delivered roots when no pending selected result or snapshot needs them; do not retain a history.
- Leaving early requests source cleanup and stops parser-owned delivery; it does not prove an
  arbitrary producer stopped or its underlying resource closed.

Feeding in slices limits one synchronous call, not total event-loop occupation. A loop over
immediately available chunks may still starve other work; yield cooperatively or use a worker
when responsiveness requires it. A pending producer read needs a cancellation-aware adapter.

**Responsiveness needs a measured work bound.** Synchronous `parse()` occupies its caller until
it returns; an abort scheduled on that same thread cannot interrupt it. Measure clean and damaged
inputs, wide and deep trees, large scalars, and requested reports on the actual runtime. Historical
single-shape timings do not establish a universal input-size threshold or repair-cost ratio.
Main-loop work targets at most 4 ms between yields, warns above 8 ms, and flags optimization above
32 ms. These targets guide later optimization; slowness alone never blocks development, review or
release. Measure event-loop delay, cancellation latency, complete-call latency, throughput and CPU
together, and record timing misses without disguising them as correctness or cleanup failures.
The same-thread async driver must yield after a measured work quantum even when a large skipped value
produces no result. It should do enough useful work between yields to avoid scheduler overhead; input
units alone cannot define that quantum because syntax, enabled features and terminal projection change
its cost. `auto` keeps small work inline and schedules the rest cooperatively; a forced worker runs
it in a lazily started worker, reused on Node, Bun and Deno and ended when idle in browsers.
Background executors poll cancellation without host-task yields when they own an independently
observable cancellation state. The execution strategy is fixed once before consumption. A planner
that lets `auto` choose a worker must measure scheduling, transfer, startup, queueing, cancellation
transport, worker readiness and finalization (`docs/DESIGN-REVIEW.md` F7b). Synchronous calls remain
explicitly synchronous.

### The value while it is still being written

`view: sharedView` or `view: ownedView` enables JavaScript `snapshot()`; no view is built by default, and a
stream parser built without one has no `snapshot` member in its type, so the omission is a compile
error rather than a runtime failure. A `shared` snapshot is read-only by contract: its open-container
copy is unfrozen only for speed, and pulls with no input between them return the same object, so a
caller's change shows in the next pull. Modify an `owned` snapshot instead.
It returns a typed result containing `undefined` before a root is available, otherwise a snapshot
`{ value, valueIndex, complete, cut }`. A refused or stopped root returns a failed result
with any snapshot under `failure.recovered`. A recovered null is not absence. `cut` is present
exactly when `complete` is false: `path` (keys and indexes from the root), `kind` (`string`,
`number`, `missing` or `between`) and, when the source left a token unfinished, `text`. Mid-stream
a number or word still arriving is held back, so its item is `missing` with its characters in
`text`. `complete` is root finality, not source exhaustion.
Retain only the current root for views; a delivered root is released when the next root begins,
unless the caller holds a detached snapshot. No hidden stream history is promised.

**The caller pulls a view when it is about to draw; the parser never pushes one.** A model emits
tokens far faster than a screen paints, and the two rates have nothing to do with each other, so
producing a view per chunk does work for frames nobody ever draws. Pulling makes the cost per frame
instead of per token.

Which view, declared once when the stream parser is built — the same rule as the report, and for the
same reason: the choice changes what the parser does internally and cannot flip mid-stream.

- **shared** — stable protected snapshots reuse unchanged branches. Finished branches are frozen
  once, as they close, because they are shared. The per-snapshot copy of the open containers is
  never frozen, on any runtime: it belongs to that snapshot alone, so a caller's write to it cannot
  reach parser state. Copying an open container costs its width as well as depth. A pull with no
  `feed` or `end` since the previous pull returns the same object. Sharing helps reference-based UI
  checks, but does not guarantee the rendering cost.
- **owned** — a full copy the caller may keep and modify. Cost is the whole tree, every time; never
  reused between pulls, because the caller may have modified the previous one.
- **borrowed** — Rust can express a scoped borrow. A JavaScript callback cannot prevent retaining
  its argument or mutating a nested object. Do not expose an unprotected live tree there; a shared
  protected snapshot or enforced read-only view must preserve parser state. Rust alone exposes
  `view()` as a borrow tied to the parser; feeding requires that borrow to end.

**What is still arriving is reported beside the value.** By default, nothing is appended to mark
incompleteness: the snapshot's `cut` identifies the unfinished path so a renderer can show it without
changing the recovered content. An explicit `cutSuffix` adds the caller's chosen marker to cut
strings; `cut` remains available to distinguish that marker from source content.

A string snapshot shows recovered content available so far; requested diagnostics identify any
reinterpretation. Hold incomplete escapes rather than invent missing digits. Do not show unfinished
numbers, bare words, or keys: `1` of `123` is a different number and `tr` of `true` is not a value.

#### A held snapshot stays stable; a later one can differ

After `{"a":1,`, a snapshot may contain `a: 1`; the later suffix `"a":2}` changes the next
snapshot to `a: 2`. The earlier snapshot must still contain `a: 1`. Duplicate-key handling and
recovery can revise unfinished data, so snapshot stability must not imply finality.

A root with no mark of data (`[1]`, `"top"`) stays in view after it closes, with `complete: false`,
until what follows shows it stands alone; prose after it (`"top" today`) withdraws it from the next
snapshot, as the whole parse refuses it.

#### What changed since you last looked

Compare shared branch identities between retained snapshots. Do not expose a separate change-path
API: it would need per-observer history, and cursor movement does not identify every changed branch.

### Going at the consumer's pace

- `parseStream` requests the next chunk only after draining the current chunk's output and receiving
  another consumer pull. This bounds parser-owned prefetch, not buffering inside an upstream source.
- `feed(chunk)` returns a lazy iterator, not an eager result array. A later `feed`, `end` or
  `snapshot` first finishes an unread drain into a held queue; the next iteration read delivers the
  held items first, so every value is delivered exactly once. Held items count toward `maxRetained`;
  past it the stream ends with `limit-reached` / `unread` after every held item.
- Retain a supplied byte view unchanged until its drain finishes. Breaking that drain closes the
  manual parser and releases its pending input; resuming requires a new parser, not an implicit replay.
- Check cancellation before delivering another buffered result. Request `return()` or `cancel()`
  once and distinguish that request from acknowledged cleanup. Consumer exit does not authorize
  draining the remaining source merely to obtain a final summary.
- `maxBuffer` bounds scanner-owned input carry, not the borrowed active chunk, recovered tree,
  diagnostics, snapshots, selected pending values, or caller-retained results. Describe each category's
  release condition; do not advertise a total-memory bound supplied by only one category.
  Raw text retained for quote replay counts even after it leaves the scanner window.

### Selected scalar fragments

Import `decodedFragments` and use `parseStream(source, { select: select(paths, { fragments: decodedFragments }) })`, or the same options on
`createStreamParser`, to process selected scalar contents. Quoted strings and proven unquoted strings
leave incrementally; trailing whitespace and a possible high surrogate stay pending. Numeric and literal
candidates buffer until their recovered type and spelling settle. Use source-text fragments below
when those candidates must leave without retaining their complete spelling. Fragments are
a selection setting, so they cannot be requested without one; a whole-input verb refuses them with
`fragments-stream`. They imply source-occurrence delivery, and cannot request final matches or live snapshots at the same
time. Selecting a container in this mode yields `non-scalar-selection`; select its scalar children.

Each successful decoded-content result contains one fragment with `kind: "start" | "data" | "end"`:
`start` supplies an occurrence ID, root index, path,
matching selector indexes, and scalar kind; `data` supplies that ID and a bounded text piece;
`end` supplies that ID, the final source span, and `complete`, which is `false` when the input
ended inside the value: a string without its closing quote, or a number more input could extend.
Strings yield decoded content, numbers their recovered spelling (`1.5000` becomes `1.5`), and
literals their spelling. An `end` confirms only that occurrence, not that a
later duplicate ancestor will preserve it. A terminal failure closes every unfinished occurrence
without fabricating successful end fragments.

Keep received fragments when handling a terminal failure. For example, after delivering decoded
text, a source failure can return cut metadata with an empty match list; it does not rebuild
the emitted prefix.

A decoded-content start fragment must name the recovered scalar kind. More input can turn a bare number prefix
into a string, so wait until its kind is known.

Do not split a completed surrogate pair between string fragments. Hold only the decoder tail,
escape state, and the bounded pending piece; large selected strings must not create a hidden full
value. Numeric fragments are not partial numbers callers can use in arithmetic. Fragment sizing
is an internal batching choice, and chunk boundaries are not part of the value contract.

An apparent mismatched quote can change where a value ends. Its undecided suffix counts toward
`maxRetained` and leaves only when that interpretation is settled.
The decoded prefix shared by both interpretations leaves immediately; settlement never repeats it.

Large final text still arrives in bounded pieces at EOF. Splitting delivery preserves the scalar
type, source span and completion, including requested `cutSuffix` content.

Emit scalar fragments only after JSON candidacy is established. An undecided top-level bare token
still obeys `maxScalar`; bounded early delivery cannot also wait for unlimited future context.
Incremental delivery inside an established object or array must not retain the whole scalar.

#### Bounded source-text delivery

Use `fragments: decodedFragments` for decoded strings and recovered numeric spelling. Use
`fragments: sourceFragments`, importing `sourceFragments` from the package, for copying an oversized
selected scalar without assembling it in memory. The imported capability keeps its implementation
out of consumers that use ordinary selection or decoded fragments.
Source pieces must contain its original spelling, including quotes and escapes; they are not repaired
JSON. Byte input follows the same UTF-8 decoding and replacement rules as every other call.
Do not append a generated `cutSuffix` to source pieces.

A source start must identify the occurrence without guessing its recovered type. Report that type
at completion, or an incomplete missing value if EOF leaves nothing recoverable. Preserve occurrence
IDs, chunk-local positions, policy refusals and bounded ambiguity carry. Cancellation or source
failure must preserve already delivered pieces and return typed failure without a successful end.
Classify the token through the shared scanner without constructing its complete recovered value.
The source representation must remain removable from consumers that do not request it.

### Which core serves which stream

Measure complete-value delivery and live snapshots separately. Slow model output is one workload;
buffered bursts, replay, large values, and requested reports can have different costs. Native
snapshot adapters can transfer changes or shared representations instead of rebuilding the whole
tree on each read; their added complexity must earn its place in measured caller workloads.

Use one authoritative recovery state per stream. Choose an engine that can honor its requested
outputs; unsupported capabilities require fallback or a typed refusal when the caller forces an
engine. A TypeScript live-view path is a valid baseline, not a proven universal winner or an
excuse to run a second scanner over the same stream.

## Inputs

One-shot input is `string | Uint8Array`. Streams produce chunks of those types; transports need
only expose the iteration or reader contract, not a parser-specific adapter.

- Accept sync and async iterables, or a Web Streams reader obtained through `getReader()`;
  validate returned chunks and reader results. A method name alone does not establish that contract.
- Pass a file's iterable or readable stream, not a file handle merely because it owns a file.
- Preserve decoder and token state across chunks, including split UTF-8, surrogate pairs, and escapes.
- Honour each byte view's offset and length; reading its whole backing buffer can expose unrelated data.
- Reject detached or out-of-bounds byte views with `invalid-input`, or `invalid-source` for an invalid producer chunk. Readable empty views remain valid input.
- Async byte calls read the initial visible window. If that range becomes unreadable between slices, return `invalid-input` with available prefix recovery; do not read later growth beyond the original window.

## Encoding

The byte-input contract is UTF-8, not a claim that every producer sends it. Validate
encoding and preserve the position of malformed bytes; converting into host strings can still cost work.

Accept the caller's existing representation. Avoid whole-input encoding or decoding merely to
reach another engine unless the measured complete path justifies that conversion.

- **Remove a leading UTF-8 BOM from repaired output.** Requested diagnostics report `bom-removed`
  at zero confidence cost; otherwise successful repaired text could still be refused by `JSON.parse`.
- **Refuse UTF-16 and UTF-32 BOMs with `unsupported-encoding`.** Recognize the longest mark first;
  do not mistake UTF-32 for UTF-16 or guess an unmarked encoding from arbitrary bytes.
- Recognize a BOM only at the start of the logical source, allowing its bytes to span chunks;
  a later U+FEFF inside a string is data, not another encoding declaration.
- **Replace malformed UTF-8 with U+FFFD using the Encoding Standard's decoding rules.** Requested
  diagnostics report `invalid-utf8` at the original bytes. The replacement is a recovery, not a
  refusal, so the value succeeds; it fails only when the errors it counts exhaust `maxErrors`, and
  then as `limit-reached` for `errors` with recovery attached. A genuine encoded U+FFFD is not a
  repair.
- **A stream may mix text and byte chunks.** A position identifies the source chunk and its local
  offset in that chunk's units. Keep an incomplete UTF-8 tail across empty chunks; a nonempty text
  chunk cannot supply the missing continuation byte: finish that byte sequence with the malformed
  encoding policy before consuming the text. Never insert text into an unfinished byte sequence.

### Strings one language can hold and the other cannot

`"\ud800"` is legal JSON text, and `JSON.parse` gives you a JavaScript string holding half a
character. Rust's `String` cannot hold that at all — it is not a limitation of any parser, it is
what the type is.

P3 requires preserving that value across engines. Rust can represent its code units without using
`String`; use an internal lossless representation and a checked conversion when a caller needs
`str`. Replacing it only on the Rust path would change the answer, even if a report mentions it.
The same issue applies to object keys, where replacement could merge previously distinct members.

This is a representation choice, not an impossibility: `serde_json` documents accepting unpaired
surrogates through its byte deserializer as WTF-8 while rejecting them for UTF-8 string targets.
See [the byte-deserializer contract](https://docs.rs/serde_json/latest/serde_json/struct.Deserializer.html#method.deserialize_bytes).

## Recovered values

- Objects, arrays, strings, numbers, booleans and null, with lossless representations where a host's
  ordinary type cannot preserve the required value.
- A key given twice keeps the last value, matching `JSON.parse`; requested diagnostics report the
  duplicate so callers can inspect the overwritten source member.
- Ordinary fractional arithmetic uses floating point; exact mode preserves decimal values.
  Integer precision loss, overflow, and underflow instead produce an exact-number value.
- Apply dangerous-key policy where a key enters the tree; requested diagnostics report dropped
  members so callers can distinguish policy removal from source absence.
- Nothing found is `no-json-found`, returned as a failure value — never silent, never a guess. P2
  says be strict about whether the text holds JSON at all and P1 says never invent content, so "I
  found nothing" has to be something the caller can branch on rather than an empty object that reads
  like data. `parse` of the text `null` is a different thing entirely: it SUCCEEDS, with the value
  null, and the tagged failure is what keeps the two apart without anybody inspecting the value.

### Exact numbers and JSON output

- **Preserve integer values and numeric range by default.** `9007199254740993`,
  `9007199254740993.0`, and `9007199254740993e0` are the same mathematical integer and need the
  same protection. `1e400` must not become infinity, nor `1e-400` zero.
- **Use `ExactNumber` for exact values.** It retains a validated JSON number token, including
  signed zero and decimal spelling. Exact mode uses it for every number; ordinary mode uses it
  only where the numeric policy requires protection. `bigint` alone cannot preserve fractions.

`ExactNumber` is a library-created type, not an object recognized by its JSON fields. Export
`isExactNumber(value)` for narrowing; a parsed object with a `text` field remains an ordinary object.
This identity is necessary inside arbitrary JSON data, unlike the outer result's structural `ok` tag.

Expose `text`, `toNumber({ allowRounding?: boolean })`, and `toBigInt({ maxDigits: number })`.
Conversions return typed results: number conversion is exact unless rounding is explicitly allowed;
overflow and nonzero underflow remain failures in either mode. Exactly representable integers may
remain ordinary numbers even outside the safe-integer range; parsing is not an arithmetic guarantee.
Integer conversion requires an integral value and a caller-supplied expansion bound. It converts
negative zero to `0n`, since BigInt represents integers, not numeric spelling. No implicit coercion.

`stringify(value, { maxOutput? })` returns `Result<string, EncodingFailure>` and emits exact-number
tokens unquoted on every runtime. Its default output bound is the default input-buffer bound;
callers can change it explicitly. Reject cycles, accessors, unsupported values, and exceeded bounds.
Do not call getters, custom coercion, or caller-defined `toJSON`. Proxy inspection can run traps;
convert their thrown errors to `invalid-value`, without claiming control over a nonreturning trap.
This is value encoding; `repair(input)` instead preserves source spelling.

Rust keeps `stringify(&value)` for defaults. Set `StringifyOptions::max_output` to a
`NonZeroUsize`, then call `options.stringify(&value)` for an explicit limit. The bound counts
encoded UTF-16 code units, including escapes and punctuation. Match
`EncodingFailure::NonJsonValue { value_kind, path }` or `EncodingFailure::LimitReached { limit }`;
neither returns incomplete JSON text.

Native `JSON.stringify` may use an exact number's `toJSON` only when `JSON.rawJSON` is supported;
otherwise it must fail visibly, never round, quote the number, or expose its fields. Use the library's
`stringify` for portable typed failures. The raw-number capability is defined in the
[ECMAScript JSON contract](https://tc39.es/ecma262/2026/multipage/structured-data.html#sec-json.rawjson).

Explicit JavaScript extensions `undefined`, `Infinity`, and `NaN` are distinct from numeric
overflow in JSON text. JSON output cannot represent those extensions unchanged: `repair` writes each as `null` in place
and reports it as `js-literal`, while `stringify` of a caller's value returns `non-json-value`.

### JSON inside a JSON string

Tool calls put JSON in a string: `{"tool":{"arguments":"{\"city\":\"Paris\"}"}}`. Cut a model off
mid-argument and the damage is nested — a truncated string in the outer document holding a truncated
document of its own.

Parse the outer value, check its outcome and field type, then parse the embedded string.
Keep the two outcomes separate: recovering the outer string does not prove its contents are JSON.
No recursive option is needed, and ordinary strings remain strings unless the caller asks to parse them.

## Source positions

`at` on a repair or an error, and `start`/`end` on a span, are positions: an `offset` into the
input the caller handed us, the `unit` it is counted in, and for streams the `chunk` it belongs to.
Hand us a JavaScript string and the offset indexes that string. Hand us bytes and it is a byte
offset.

The purpose is to locate the caller's own source without requiring a second representation.
String offsets count UTF-16 code units in JavaScript; byte offsets count bytes. A byte position
inside an invalid sequence is not automatically a valid Rust string-slice boundary. All streams
use chunk-local positions, including empty chunks in the chunk count, because later chunks may
change representation. A span may have endpoints in different chunks; never revise an emitted position.

For the comma in `{"é":1,}`, the text offset is 6 and the byte offset is 7; for `{"🙂":1,}`,
they are 7 and 9. ASCII-only tests cannot establish that an adapter preserves these units.

P3 applies to the caller-visible input even when an adapter changes its physical representation.
JavaScript text can reach Rust through a lossless encoding; an adapter must not replace lone
surrogates or return byte offsets when the caller supplied a string.

Two things follow for whoever builds this:

- Conformance needs text, bytes, and mixed chunk boundaries, not only a byte-input happy path.
- Native adapters must map reported positions to the original input units. Do not prescribe a
  per-character counter or an unconditional transcoding pass before measuring the actual adapter.

`ParseError` includes line, column and bounded context, also in typed refusals without reports.
Configuration and source failures need no source position; do not invent one.

## Key order

JavaScript returns ordinary objects, with integer-index keys enumerated in numeric order and other
keys in insertion order. Rust preserves insertion order and supplies a JavaScript-compatible traversal
for cross-runtime comparison. Updating a duplicate key changes its value, not its first insertion position.
Do not substitute a `Map` or normalize away order in the conformance comparison.

Use `repair()` when original member order or numeric spelling matters. It edits source text instead
of serializing a value, so untouched source spans retain their spelling and order.

## Implementation acceptance

Apply these checks to shipped routes; Rust, native and WASM checks remain deferred.
Performance measurements identify later optimization work; timing misses and unknown causes never
block acceptance by themselves. Keep correctness, resource ownership and working cancellation separate.

- Test public calls on clean, damaged, refused, empty, limited, and cancelled input, with reports on and off.
- Compare text, bytes, mixed chunks, and every split of short adversarial inputs across engines.
- Check repaired output with an independent strict parser; compare exact-number tokens without rounding.
- Compile real TypeScript and Rust callers, including invalid calls that must fail type checking.
- Exercise installed artifacts through their actual Node, Bun, Deno, browser, native, and WASM entry points.
- Measure optimized builds on clean and repaired input, including copying, crossings, selection, and reports.
- Check retained memory after delivery, early exit, retained snapshots, and large scalar fragments.
- A green TypeScript suite alone does not establish Rust, native, WASM, browser, or performance conformance.
