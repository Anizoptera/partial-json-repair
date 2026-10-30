# Changelog

Notable user-visible changes, newest first.
Revise unpublished sections when behaviour changes; keep released notes unchanged and write later changes under Unreleased.

## 0.1.0 — 2026-10-30

The initial release parses text that is probably broken, says whether each value is complete and
where it was cut, and on request tells you everything it had to change to get a value out of it.
The npm package contains the TypeScript implementation.

### Added

- **Every async call names its execution strategy, an imported value, so an app ships only the
  strategies it names.** Pass `{ execution: auto }` (same thread, small input inline),
  `{ execution: cooperative }` (same thread, yielding at every size) or `{ execution: worker }`, all
  from `partial-json-repair/async`. An app that never imports `worker` contains no worker code: a
  Vite build of a cooperative app fell from 270 KB to 111 KB of minified JavaScript; an app that
  imports only `worker` ships no same-thread engine. A missing, string or copied strategy throws a
  `TypeError` whose message names the import, and `execution-unavailable` carries a `message` saying
  what failed and what to do beside its typed `reason`.
- **A colon where a value begins is removed as a doubled separator, reported as `extra-colon`.**
  `{"a"::1,"b":2}` reads `{ a: 1, b: 2 }` and `[1,:2]` reads `[1, 2]`; read literally, the colon
  started the invented string `":1"`. A colon inside an unquoted value stays content (`{a: b:c}`).
  Switched off, the input is refused, as `STRICT` does.
- **A string missing its closing quote ends at a line break that a quoted key follows.** By
  default, `{"a": "x⏎ "b": 1}` reads `{ a: "x", b: 1 }` and `["a⏎, "b"]` reads `["a", "b"]`,
  reported as `missing-quote`. Literally, the string closes at the next quote and the word after it
  becomes an invented member (`{ a: "x⏎ ", b: ": 1}" }`), sometimes marked complete. It applies at a
  raw line break (LF, CR or CR LF) followed, past blank lines and comments, by a quote of the
  string's own kind that opens a key and its colon or follows a comma. It also ends a string still
  open at the end of input before closers it did not open: `{"d": "x⏎ }` reads `{ d: "x" }`, while
  cut code keeps the closer its own text opened (`{"code": "f() {⏎}` keeps the `}`). On one line,
  closers the string did not open, a comma and a quoted key with its colon end it the same way:
  `[{"n":"a},{"n":"b"}]` reads two objects, where the literal reading returned `ok` with the invented
  member `b: "},{"`. Switched off,
  the same value is refused, as `STRICT` does.
- **`guessed-string-end` ends such a string at other structure, on request.** With `recover: {
  "guessed-string-end": true }`, `{"code": "f() {⏎}` reads `{ code: "f() {" }` and
  `{a: 'x⏎ b: 2⏎}` keeps both members, where by default the string keeps those lines: models also
  write unescaped multi-line text, a code or graph value cut mid-stream ends in `}`, and prose
  writes `Note:` on its own line. It applies at a line break
  followed by a closer, a comma, or a bare-word key and its colon; a later quote that fits the
  structure proves the break was content and keeps it. A stream holds such a break unread until
  the next line shows which it is, so delivered fragments never need taking back.
- **A result says when another value follows.** `parse`, `repair` and `findJsonSpan` return only
  the first value. A model often sends a corrected answer below its first one, and a caller reading
  only `value` would take the wrong answer with no sign of it. Their success sets `more: true` when
  another value follows. Cost: the call reads past the value up to the next one, so text after the
  value that holds no later value is read to its end.
- **A report says what `parse` left out.** `parse`, `repair` and `findJsonSpan` return one value;
  with `diagnostics`, `laterValues` lists the source span of every value after it, exactly what
  `parseMany` with the same options would deliver next, so the report for `{"a":1}\n{"b":2}`
  shows the second value. It holds at most `maxEntries` spans. Finding them scans the input a second time, only
  for a requested report and only when something other than whitespace follows the value.
- **Values joined by commas are one array.** `1,2,3`, `{"a":1},{"b":2}` and MongoDB shell dumps
  (`{...},\n{...}`) recover as the array they spell, reported once as `missing-brackets` (a
  switchable repair, refused under `STRICT`), with every report path inside the list. The comma
  must touch the value before it, so whitespace after a value still ends it, and a list led by a
  value with no mark of data must stand alone: `1, 2 and 3` stays prose. A stream therefore
  delivers a root once the character after it arrives: a document ending exactly at its chunk's
  end arrives with the next `feed()` or `end()`, and a stop before then returns it as complete
  recovery. Root filters and selection judge each value alone and form no lists.
- **Every recovered value says whether the source finished it.** Each result holding a value —
  `parse`, `parseMany` items, stream items, `repair`, snapshots and `failure.recovered` — carries
  `complete`, and `cut` exactly when it is false: `path` (keys and indexes from the root), `kind`
  (`string`, `number`, `missing` or `between`) and `text`, the unfinished token the value leaves
  out (`[1, tru` → `{ path: [1], kind: "missing", text: "tru" }`). A match is cut when the root's
  cut runs through it. `findJsonSpan` returns a location, not a value, and carries neither.
  `cutSuffix: true` appends `…` to a cut string (a string option appends itself), the same on
  every route, snapshots and `repair()` text included.
- **Root-filter failures retain the fallback and its requested report.** `no-match` and interrupted
  searches preserve its repairs and confidence; accepting a root releases that fallback.
  Streams charge that stored recovery and report alongside the next root under `maxRetained`.
- **Signal-read failures preserve available recovery.** Pull streams and async whole-input
  calls return `signal-failed` with the original cause instead of rejecting iteration.
- **Streaming preserves recovery across chunk boundaries.** Across `feed()` and `end()`, recovered
  values, completion and cuts match whole-input recovery while stream limits remain unspent,
  including splits inside comments, keys, strings and fences. Selection preserves withheld token text;
  retained-storage limits still apply while a bare token is being read.
  A trailing numeric separator leaves the value missing in every radix, including hexadecimal;
  its unfinished spelling remains in the cut rather than becoming a shorter number.
  Numeric-looking words retain non-ASCII letters and surrogate units instead of splitting off
  a numeric prefix and dropping the remaining source.
  Under `maxErrors` the scan stops between tokens: under `STRICT`, `{"a": 1 /* c */}` stops before
  the closer (`complete: false`, cut `between`); a token that was started is finished before the
  stop; and errors after the budget is spent are not counted.
- **Byte input decodes at the platform's speed.** The well-formed body of each byte chunk goes
  through the runtime's own UTF-8 decoder; carried sequences, byte-order-mark probes and malformed
  chunks stay on the package's decoder, so replacement characters and byte positions are the same on
  either path.
  Unreadable byte views return a typed failure. If borrowed storage disappears during async reading,
  the failure keeps available recovery and any prefix refusal instead of throwing or ending silently.
- **Feeding a long token costs what the chunk costs.** A string, key, word or number arriving a few
  characters at a time streams in linear time, with or without a snapshot after each chunk.

- **`parse` hands whole input to `JSON.parse` where it gives the scanner's answer.** Complete
  JSON goes to `JSON.parse` first; text cut off mid-value, or whose damage is comments or trailing
  commas, goes through a pre-scan that appends the closers and deletes the comments, then to
  `JSON.parse`. Each route is held to the scanner's value, `complete` and `cut`, and runs
  several times faster than the scanner on its input class; damage late in text that ends with a
  closer is the one class that loses (measurements in docs/DESIGN-REVIEW.md F14b).
  `builtinParsers: false` keeps every input on the scanner.
- **Prose before JSON is found under `STRICT`.** `Here: {"a": 1}` gives the object under `STRICT`
  and with any bare-word repair switched off: detection does not depend on which repairs are
  enabled.
- **Metrics count exactly past the report cap**, and count blocked dangerous keys per key, in a
  record bounded by the configured key set. A metrics scope is a configured parser: pass it to any
  verb (`parse(text, measured)`, `parseStream(source, measured)`) and that call is counted, so an
  app counting only `parse` does not bundle the stream code.
- **Option objects are exact.** A key a verb does not take is a compile error, written inline or
  passed through a variable.
- **`0o17` and `1_000` are numbers.** A JavaScript or Python octal literal and digit separators read
  as the number both languages give them (`octal-number`, `numeric-separator`), like `0x1f` already
  did. A spelling either language rejects (`0_1`, `1__0`, `0x_1`) keeps its source text.
- **A lone unquoted word is refused, not returned.** An input that is one bare word (`Sorry`,
  `invalid`, an emoji), or one token that is no number (`1..5`, a `-` a stray closer ended), holds no
  JSON evidence, so it is `policy-refused` with the text in `recovered`. So is a root opened by an
  apostrophe that never closes (`'tis the season`), since prose writes apostrophes. Inside a container such a
  token keeps its text. `recover: { "unquoted-root-string": true }` reads it as a string, as
  `COMPAT` does.
- **`0123` keeps its leading zero.** No grammar gives it a decimal value and dropping the zero loses
  data (postal codes), so it stays the string `"0123"` with an `invalid-number` repair. The decimal
  reading is the opt-in `leading-zero-number` kind, on in `COMPAT`.
- **Bounded whole-input scans resume long root numbers after the prefix already read**, so
  exact-number input scales with source length.
- **Whole-input recovery has a cooperatively cancellable async entry.** `parseAsync`, `parseManyAsync`,
  `repairAsync`, `findJsonSpanAsync`, and `initAsyncParser` advance the shared scanner at bounded
  checkpoints, decode byte input incrementally, and return typed cancellation with available
  recovery. Same-thread execution batches scanner work between host-task yields. Worker execution
  uses the same resumable operation and reads a shared stop cell between batches, so cancellation
  needs no message. Callers may force cooperative scheduling or a lazily started worker, reused on
  Node, Bun and Deno and ended when idle in browsers; unavailable worker support is refused before
  input processing.
- **Stream error-budget failures arrive when the token settles.** Keep its recovered content and
  report, then close without waiting for EOF or requesting more source.
- **String fragments keep raw and escaped surrogate pairs together.** A trailing high surrogate
  waits for the next decoded unit or scalar termination; lone surrogates remain preserved.
  Held decoder tails count toward `maxRetained`; completing them releases that charge without
  granting extra storage to later values.
- **Streamed string refusals retain the opening line and column.** Releasing a decoded prefix
  cannot move errors for controls, invalid escapes, missing closers or mismatched quotes.
- **Non-JSON token whitespace recovers without changing string content.** `non-json-whitespace`
  follows `repairBroken` and can be refused separately. Repairs emit valid JSON, preserve interior
  whitespace, and retain source positions across chunks. Leading-trivia refusals keep the current
  root token before the error budget stops processing.
- **Escaped structural delimiters recover without losing members.** `escaped-delimiter` follows
  `repairBroken` and can be refused separately. Dropped members remove their own trivia and
  separator edits, so repair preserves retained neighbors and emits valid JSON.
- **Configured calls accept isolated overrides.** `parse`, `parseMany`, `repair` and `findJsonSpan`
  accept per-call settings, with result types following the effective options. Caller mutation and
  interleaved iterators cannot change another call; invalid overrides throw like any invalid option.
- **Invalid options throw; every other failure is a result.** `initParser`, `createStreamParser`,
  `initAsyncParser`, `createMetrics` and every verb given options throw a `TypeError` before reading
  input, with the typed reason (`invalid-options`, `field`, `reason`) as its `cause`; async verbs
  reject with it. Constructors return the object itself, so no call site unwraps `.value`.
  `initAsyncParser` is synchronous. A released parser's `createStreamParser` returns a stream that
  answers `parser-closed`.
- **Leading-dot and leading-plus numbers retain their numeric values.** `.5`, `-.5` and `+5`
  use `leading-dot-number` and `leading-plus-number`; `+.5` reports both. Each follows
  `repairBroken` and can be refused independently. Exact mode preserves digits after the required
  spelling change, and longer words remain strings.
- **Foreign literals recover their values.** Case variants of `true`, `false` and `null` use
  `literal-case`; `None` and `nil` use `null-alias`, in any letter case. Both follow `repairBroken`
  and can be refused separately. Quoted strings, keys and longer words stay unchanged. Text repair
  preserves the whitespace after a bare word.
- **One result envelope.** Every call returns `{ ok: true, value }` or `{ ok: false, failure }`,
  where `failure.kind` is a literal tag. A refusal or a resource limit that still read data attaches
  it as `failure.recovered.value` — never as a success. There is no `parse<T>`; the value is
  `unknown`.
- **Optional features are imports.** `diagnostics`, `locations`, `select(paths, { occurrences,
  fragments })` and `skip(paths)` are values imported from the package root and passed under their
  option key (`parse(text, { diagnostics })`), so an app that never imports one never bundles its
  code. `true` fails to compile and throws `invalid-options` with reason `import-required`, naming
  the import; `false` turns a parser's feature off for one call. Settings travel with the feature:
  `diagnostics({ maxEntries, scope })`.
- **Reports are opt-in.** `{ diagnostics }` puts a `diagnostics` object on every result, success
  and failure alike: `repairs`, `errors`, their `counts`, `entriesComplete` (false when
  `maxEntries` left entries out), `scanComplete` (false when a limit stopped the scan) and
  `confidence`. Without it nothing is recorded or allocated, and the result type says so. A report
  turns the `JSON.parse` fast path off, since that path cannot see duplicate keys.
- **A stream never answers something the whole document does not.** A value standing alone with no
  mark of data (`"just a string"`, `[1]`) is held until what follows shows it stands alone, because
  text that has not arrived can still make it prose: `"just a ` + `string"` + ` and more` answers
  `no-json-found`, as the same bytes do in one call. The live view shows the held value with
  `complete: false`.
- **A value behind a leading comment is found.** `/* the answer */ 42` gives `42`: comments and
  whitespace the parser consumes are not content, as a byte-order mark is not. A comment further into
  the text still counts as prose, so a sentence with a comment in it does not become a document.
- **A closing code fence is never a value of its own**, wherever a stream's chunks split the fence.
- **An error budget stops between tokens, never inside one.** Under `STRICT` (`maxErrors: 1`),
  `'; DROP TABLE users; --` with single quotes off is `policy-refused` carrying the single-quote
  error and the text as `recovered`, never `no-json-found`: a budget is the parser declining to read
  further, not a statement about your input.
- **A refused construct is reported once**, and counted once in `counts.errors` and against
  `maxErrors`, even for a value standing alone that is read before and after the input ends.
- **`repair(text)` never hands back a dangerous key that `parse` dropped**, including a member the
  input cut off: with `onDangerousKey: "drop"`, `{"__proto__": {"x":1` repairs to `{}`, the value
  `parse` recovers (`SECURITY.md`).
- **A literal or number the input cut off is no value.** `{"a": tru` recovers `{}` and `[1, 1e`
  recovers `[1]`, each with `cut.kind: "missing"` and a `dropped-member` repair. A finished number
  stays (`[1, 12` is `[1, 12]`), and a word the source followed with whitespace is the text it
  wrote. A string cut inside an escape keeps what came before it: `"x\u00` recovers `"x"`, never
  the raw half escape, and a stream snapshot never shows one; a string ending in a complete escape
  (`{"a":"xé`) keeps its member.
- **Every error quotes the same amount of your document.** `context` is the 20 characters either
  side of the offset, clipped only where the document itself ends. A stream can show less, because
  bytes it has already released are gone.
- **`parse(text)`** — the first value in the text. Truncated strings, unclosed containers, single
  quotes, comments, unquoted keys, trailing commas and duplicate keys are all recovered and, when a
  report is asked for, all reported with the path where it happened and the position in the source
  as `{ offset, unit: "utf16" }`.
- **Exact numbers.** An integer past 2^53, an overflow such as `1e400` and a nonzero underflow such
  as `1e-400` come back as an `ExactNumber` holding the source token, never as a rounded `number`,
  `Infinity` or `0`. `isExactNumber` narrows it; `toNumber({ allowRounding? })` and
  `toBigInt({ maxDigits })` are checked conversions returning the envelope, with `overflow`,
  `underflow`, `inexact`, `not-integer` and `digits-exceeded` as the reasons. `exactNumbers: true`
  keeps every number that way. `stringify(value, { maxOutput? })` writes them back unquoted, walks
  without recursion, refuses `undefined`, `NaN`, cycles and getters with a typed failure at the
  path, and never calls `toJSON`.
- **`repair(text)`** — the same repairs applied to the text rather than to a value. It splices your
  source rather than re-serialising, so a value that needed no repair comes back byte-identical:
  key order, number formatting and whitespace intact. It returns the VALUE, not the document: prose,
  fences and surrounding whitespace are not part of the JSON. A successful result parses under
  strict `JSON.parse`. It fails exactly when `parse` fails: a recovered `NaN`, infinity or
  `undefined` is written as `null` in place, keeping its key or array position, and reported as
  `js-literal`.
- **`parseMany(text)`** — every value in the text, lazily. JSONL, multi-document responses, and
  values scattered through prose. A text holding no value yields one `no-json-found` item.
- **`{ locations }`** puts the value's source `span` on every success, as two positions.
- **Importing one verb ships one verb.** A bundle that imports `parse` and nothing else carries
  neither the streaming transport, the snapshotter, nor any optional feature, and a gate keeps it
  that way.
- **`initParser` / `createStreamParser`** — configuration and scan state are separate objects. A
  parser holds frozen options and no counters, so it is safe to share; a stream parser is used once.
- **Streaming**, in two shapes over one parser. `parseStream` consumes any async source, honours
  an abort signal, and is the one entry point: Node streams bridge with
  `Duplex.from(src => parseStream(src))`, web streams with `ReadableStream.from(parseStream(src))`.
  A manual stream's `feed(chunk)` and `end()` are lazy drains — one root per pull, the chunk taken
  at the call — and every completed value is delivered exactly once: a `feed()` whose iterator was
  never read hands its values to the next iteration read, counted toward `maxRetained`, past which
  the stream ends with `limit-reached` naming `unread`. Leaving a drain early closes the stream.
  However you leave a stream early — a `break`, a `throw`, or an abort — the source's cleanup is
  requested without waiting on it; `close()` waits, shares one attempt across every call, and
  answers with the cleanup outcome, `close({ signal })` bounding the wait. An abort yields a final
  `aborted` item, a source that throws a `source-failed` one carrying the cause and the value it
  was inside, a source that finishes and then refuses to release a `cleanup-failed` one; feeding or
  ending a finished stream answers `stream-closed`. `summary: true` appends one `summary` item with
  `complete` and `roots`.
- **Selection.** `select` names the parts you want as paths of keys and indexes, with `ANY` for one
  segment and `ANY_DEPTH` for any number; `skip` names the parts you do not, and wins where the two
  overlap. `select` yields `Match` objects — value, path, source span, and the selectors that hit —
  because a trimmed document cannot say which selector found what. `repair` gives each match its own
  repaired text and `findJsonSpan` its span. Nothing outside a match is built, and a match arrives
  WHOLE — selecting a container gives you everything under it, however deep. A match is the
  final value at its path by default; `select(paths, { occurrences: true })` delivers each source
  occurrence as it closes. A skip path may not end in a wildcard or an index, so it can never target
  an array element, and that is checked when `skip(paths)` is called. Reports follow the selection
  and say so in `scope`; `diagnostics({ scope: "all" })` audits the skipped content too.
- **Scalar fragments.** `select(paths, { fragments: true })` on a stream delivers a selected scalar
  as `start`/`data`/`end`. Selected strings inside established JSON deliver decided content in
  internal batches, including large caller chunks. Unquoted strings stream once no literal
  interpretation remains; trailing whitespace and a possible high surrogate stay pending.
  Numeric and literal tokens, undecided root
  strings and ambiguous quote suffixes wait until settled. `end.complete` is `false` when the input ended inside the value. Stream verbs only, implies occurrence delivery, refuses to be paired with a view, and
  fails a selected container with `non-scalar-selection`. A surrogate pair is never split between
  two pieces. An ambiguous quote suffix stays unpublished and counts toward `maxRetained`, because
  later input can change which text belongs to the value. A top-level string leaves only once the input
  shows it stands alone, since `"hi" today` is prose.
  Quote replay preserves the original source position after stream input compaction.
  Quote-follower lookahead resumes after whitespace already inspected when another chunk arrives.
  Raw source held for quote replay stays under `maxBuffer` after compaction, separately from decoded
  content under `maxRetained`.
  Streams without views release private scanner state at a limit stop,
  preserving their returned recovery and summaries.
  A later pull cannot erase a limit-stopped string's prefix or change its cut marker to `between`.
  Selected string fragments deliver the common prefix before an ambiguous quote settles, retaining
  only the undecided suffix and decoder tail.
  Large final data leaves lazily in bounded pieces, including settled ambiguity, root strings,
  exact numbers and requested cut suffixes. Additional data pieces do not duplicate repair entries.
- **`maxRetained`** bounds what a stream holds while waiting — matches pending their ancestors, the
  part of a string that has arrived — rather than what it has read. Defaults to `maxBuffer`, and
  like it applies to streams only.
  Replaced members, superseded final matches and discarded keys release their storage charge;
  an unfinished replacement remains charged alongside the previous value until it takes its place.
  Strings and keys stop at the remaining decoded capacity while reading a chunk. Failures retain
  the consumed string prefix even without a view; ignored string values keep recognition and policy
  without accumulating decoded text. Stop positions identify unread source rather than the token opener.
  Unfinished numbers and bare words stop before banking excess raw text; their bounded cut remains
  readable after scanner release. Completed numeric spellings and large source backing stores are
  released when no unfinished value or requested report needs them.
  Completed bare strings, keys and exact numbers also stop before oversized insertion. Failed
  recovery keeps a bounded string prefix or token cut, never a fabricated truncated number or key.
- **Views** — the value being assembled, mid-stream, through `snapshot()` on a stream built with
  `view: "shared"` (finished branches frozen and shared, open containers copied and never frozen:
  O(depth + their width); two pulls with no input between them return the same object) or
  `view: "owned"` (a deep copy you may modify). The result is `{ value, valueIndex, complete, cut? }`,
  with `cut` naming the point still being written; a refused or stopped root fails with the view
  under `recovered`. Both include the **string still arriving** — a member, an element, a
  top-level string, and under `select` a selected string — so text can be rendered as the
  model types it; nothing marks its end, because a marker would be invented text you could not tell
  from real text. The live tree is never handed out.
- **Bytes as input, everywhere.** `parse`, `repair`, `parseMany`, `findJsonSpan` and `feed` accept
  a `Uint8Array` as well as a `string`, and own the decode: a multi-byte character split across
  chunks is whole, a malformed sequence becomes U+FFFD and is reported as `invalid-utf8` at its
  bytes, and positions in byte input count in bytes. A UTF-8 byte-order mark is removed with a
  `bom-removed` repair that costs no confidence; a UTF-16 or UTF-32 mark fails with
  `unsupported-encoding` naming the encoding. In a stream every position carries the `chunk` it
  sits in and counts from that chunk's start in that chunk's unit.
- **`confidence`**, a pure function of every repair made, stored or not. Formatting repairs cost
  nothing, because nothing was guessed; completing a truncated value costs the most.
- **`findJsonSpan(text)`** — where the value sits in the source, so what was ignored around it is
  answerable without a second parse.
- **Per-kind recovery.** `recover` decides any single repair kind past the coarse flag that would
  otherwise govern it, in both directions: enable one a preset leaves off, decline one it allows.
  For a caller who knows their source — a model that never writes single quotes should not have one
  read as damage it did not do. Off keeps the same contract as a flag: the construct is still
  consumed, reported as `unparsable-span`, and the outcome fails carrying the value, so a switch
  moves the verdict and the report and never the data. Numeric-looking words such as `+5x` use word
  recovery; an abandoned numeric interpretation cannot refuse them or spend `maxErrors`.
  `dangerous-key` is not among them, because
  `onDangerousKey` already governs it with three choices. Every refusal names the recovery it declined
  as `refused` on the error, so a caller who switched several kinds off learns WHICH assumption
  about their input broke rather than only that something somewhere was refused.
- **Four presets** as constants: `LLM_BALANCED` (the default), `LLM_FULL`, `STRICT` and `COMPAT`.
  Under `STRICT` the first refusal fails the value with `policy-refused`, carrying the construct as
  `issue` and what was read as `recovered`. `COMPAT` adds two readings the default refuses: a lone unquoted word as a string, and `0123` as a
  decimal number.
- **`builtinParsers`** — on by default, it permits the built-in-parser routes; `false` keeps every
  input on the scanner. A route is declined wherever it could not give the same answer, including a
  refused `duplicate-key` — the one repair valid JSON can produce that `JSON.parse` performs silently.
- **Prototype-pollution policy** at the one point where a key enters the tree, with
  `onDangerousKey` as `keep`, `drop` or `reject`, plus `nullPrototype` and `customDangerousKeys`.
  All three policies keep the key's siblings. Every report about a member — `dangerous-key`,
  `duplicate-key`, `dropped-member` — points at the KEY, which is also where the edit that removes
  the member begins.
- **Typed outcomes throughout.** Every repair, error and failure carries a literal-tagged `kind`, so
  an unhandled case is a compile error. Nothing throws for anything the input did.
- **Resource bounds** for hostile input: `maxBuffer`, `maxDepth`, `maxErrors`, `maxScalar` and
  `maxRetained`. Past any of them the value fails with `limit-reached` naming the resource and
  carries what was read as `recovered` — never a stack overflow, and never a silent success.
  `diagnostics({ maxEntries })` caps the entries each report stores without stopping recovery: past
  it the report says `entriesComplete: false`, and its counts and `confidence` stay exact.
- Zero runtime dependencies, ESM only, and no platform import in the root entry — the same build
  runs in Node, Bun, Deno, browsers and edge runtimes; `/async` loads `node:worker_threads` only to
  start a worker on Node, Bun and Deno. Everything is exported from `partial-json-repair`;
  whole-input async calls come from `partial-json-repair/async`.

### Known limitations

The README's [Limitations](README.md#limitations) section lists them.

## Rust crate (not part of the npm package)

The Rust implementation stays in this repository and is not published with 0.1.0. It returns as a
separate release once it meets the current recorded cases. These notes describe it, not the npm
package.

- **Native selection follows loader capabilities.** Bun FFI handles synchronous native work and
  N-API handles cancellable background work; the shared ladder advances without runtime-version
  exceptions while preserving native recovery and fallback.
- **Rust streams expose opt-in borrowed views.** `viewed()` retains only the current root or its
  selected matches; `view()` reports completeness and the unfinished path, while cloning makes an
  explicit detached copy. Refusals remain failures with available recovery, and `close()` releases
  parser-owned view state.
- **Rust drains borrow active chunks when no earlier input remains.** Manual values, selections,
  fragments and both transport adapters retain the supplied chunk through draining. Completed
  input needs no buffer copy; unfinished source is retained before releasing the chunk. Joining
  a new chunk to existing carry still uses the shared contiguous buffer.
- **Rust fragment feeds return lazy iterators with owned results.** They yield bounded ordinary
  string runs inside established containers before root completion and stop between roots;
  dropping an unfinished drain closes the parser and releases pending input and events. Callers
  that need an array can collect the iterator; simply discarding it now stops parsing.
- **Rust quoted strings resume across input chunks.** Completed keys wait for their colon without
  decoding again; decoding errors retain their key paths and are reported once. Delivered string
  fragments release their decoded prefix, and unchanged empty strings retain their input borrow.
- **Rust keeps string recovery decisions across escapes.** Raw controls before an escape are
  repaired or refused with recovered content; apparent wrong closers retain their disambiguation.
  Scalar fragments withhold undecided quote suffixes, and discarded array values still advance
  source indexes so selecting one element cannot deliver later elements as that index.
- **Rust drops nested members without leaving invalid JSON.** A removed member keeps its own
  separator position while its value is read; commas inside that value cannot replace it.
