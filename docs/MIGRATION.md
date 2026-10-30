# Migration

Map each old spelling to the 0.1.0 one before changing a call site. The first section covers the
pre-release API of this package; the rest maps the legacy package this one replaces.

## Pre-release API to 0.1.0

Optional features are now values imported from `partial-json-repair` and passed under the same
option key, so an app that never imports one never bundles its code. Passing `true` where a
feature belongs is a compile error, and at run time a `TypeError` naming the import.

| Before | 0.1.0 |
| --- | --- |
| `{ diagnostics: true }` | `import { diagnostics }`, then `{ diagnostics }` |
| `{ diagnostics: "all" }` | `{ diagnostics: diagnostics({ scope: "all" }) }` |
| `{ diagnostics: true, maxDiagnostics: n }` | `{ diagnostics: diagnostics({ maxEntries: n }) }` |
| `false` for any feature key | `false`, unchanged: it turns a parser's default off for one call |
| `{ locations: true }` | `import { locations }`, then `{ locations }` |
| `{ select: paths }` | `{ select: select(paths) }` |
| `{ select: paths, occurrences: true }` | `{ select: select(paths, { occurrences: true }) }` |
| `{ select: paths, fragments: true }` (streams) | Import `decodedFragments`, then `{ select: select(paths, { fragments: decodedFragments }) }` on the free stream verbs only: `initParser(...).createStreamParser({ fragments: true })` becomes `createStreamParser({ ...options, select: select(paths, { fragments: decodedFragments }) })`. |
| `{ skip: paths }` | `{ skip: skip(paths) }` |
| `{ engine: "typescript" }` | `{ builtinParsers: false }` |
| `{ engine: "auto" }` | Omit the key; `builtinParsers` defaults to `true` |
| `snapshot.value.partialPath` | `snapshot.value.cut?.path`, with `cut.kind` saying what was cut (see below) |
| No completion field on `parse`, `repair`, `parseMany`, stream items or `failure.recovered` | `complete`, and `cut` whenever `complete` is false |
| — | `cutSuffix: true` (appends `…`) or `cutSuffix: "text"` to mark a cut string in the value |
| `initParser(o)`, `createStreamParser(o)` returning a result: `.value`, `if (!x.ok)` | The object itself; invalid options throw a `TypeError` whose `cause` is the `invalid-options` reason |
| `await initAsyncParser(o)` | `initAsyncParser(o)`: synchronous |
| `ConfigurationFailure` in a verb's failure union | Never returned; it is the thrown `TypeError`'s `cause`. Async verbs reject with that `TypeError` |
| Option objects with an unknown key, passed through a variable | A compile error naming the key |
| `createMetrics` counts per repair kind and blocked key stopped at the report cap (`maxDiagnostics`, default 1000) | Exact past the cap; the report itself still keeps at most `maxEntries` entries |
| An async call without `execution`, or with a string such as `"worker"` | `{ execution: auto }`, `cooperative` or `worker`, imported from `partial-json-repair/async`; anything else throws a `TypeError` naming the import |
| `{ execution: worker }` (formerly the string `"worker"`) in a bundled browser app: no bundler emitted the worker, and webpack or Rspack builds importing `/async` failed | Vite, webpack and Rspack emit and run the worker; esbuild, Rolldown and `Bun.build` do with the README recipe, and otherwise return `execution-unavailable` before reading input |

**`partialPath` and `cut.path` name different points.** `partialPath` named the slot of a string still
arriving, else the deepest open container. `cut.path` names the item that was cut when the source
made it addressable (an array index or a complete key), with `kind` `string`, `number` or `missing`;
when the source ended between items or inside a key, it names the container with `kind: "between"`.
A renderer that put its cursor at `partialPath` puts it at `cut.path`.

**Default results that changed.** Where the old reading was a meaning rather than a defect, it stays
reachable through `recover`, and `COMPAT` sets it.

| Input | Before | 0.1.0 default | Old reading |
| --- | --- | --- | --- |
| `{"a": tru`, `[1, 1e`, `[1, -` at end of input | The strings `"tru"`, `"1e"`, `"-"` | The item is dropped: `kind: "missing"` and a `dropped-member` repair | None: a string there invented a type |
| `"x\u00` at end of input | The raw half escape in the string | `"x"`, with `\u00` in `cut.text` | None |
| `0o17`, `1_000` | The strings `"0o17"`, `"1_000"` | `15`, `1000` (`octal-number`, `numeric-separator`) | None; `recover: { "numeric-separator": false }` or `allowJavaScript: false` refuses the spelling and keeps the value |
| `0123` | `123` | The string `"0123"` with `invalid-number` | `recover: { "leading-zero-number": true }` |
| A lone unquoted word (`Sorry`) or non-number token (`1..5`) as the whole input | A string success | `policy-refused`, the word in `recovered` | `recover: { "unquoted-root-string": true }` |
| Prose before JSON under `STRICT` (`Here: {"a": 1}`) | `no-json-found` | The object is found | None: the old answer was a defect |
| A `feed()` whose iterator was never read | The next `feed` answered `stream-busy` and dropped its chunk | Delivered first by the next iteration read; held values count toward `maxRetained`, past which the stream ends with `limit-reached` naming `unread` | None: the old behaviour lost data. `stream-busy` is gone from `StreamFailure` |

## Legacy package

Read the old source with `git show 3bf7ad8^:legacy/src/<file>`; that revision precedes removal of
`legacy/`. Its `index.ts` defines root exports, `FuzzyJsonParser.ts` defines the public class,
`types.ts` defines options and reports, and `presets.ts` defines actual preset values.
The mappings below identify the destination; they do not prove complete behavioral parity.

### Calls and configuration

| Old surface | Destination and required behavior |
| --- | --- |
| `parse`, `parseJsonCompat`, `parseJsonSafe` | `parse` returns typed success or failure instead of bare values, null sentinels and thrown recovery failures. |
| `parseWithErrors`, report fields in `parseWithMetrics` | `parse` with the imported `{ diagnostics }`; repairs, errors and confidence stay outside parsed data. |
| `extract` | `parseMany` supplies candidate iteration; preserve the object/array filtering specified below. |
| `doSkipAroundJson` | `findJsonSpan`, then slice the source. It takes a bracket as JSON only with evidence of data, instead of selecting the first brace. Multiple candidates use `parseMany`. |
| `createStream`, `FuzzyJsonParser` | `createStreamParser` for manual `feed`/`end`; `parseStream` for source iteration, backpressure and cleanup. Node Transform inheritance is not the new transport interface. |
| `getOptions`, per-call options | Configured parser `options`; `parse`, `parseMany`, `repair` and `findJsonSpan` accept overrides without changing shared settings. Supplied fields replace configured fields. |
| `getMetrics(reset)`, `parseWithMetrics`, `ParseMetrics` | `createMetrics(options)` owns cumulative counters outside shared parsers. Pass it to `parse` or any other verb, then `read(reset?)`; manual streams use `createStreamParser(scope)`. Repair counters use current `RepairKind` names, duration describes the last consumed call, and engine identity is intentionally absent. |
| `getState`, `loadState`, `StreamState` | Not available: the public API does not export parser state for restoring after a process restart. Pausing a live stream remains supported. |
| `createOptions`, `getPreset` | `createOptions` was only object spread: use `{ ...preset, ...overrides }`. `getPreset` returned a constant or threw for an unknown name; import the constant directly. Validate runtime names at the caller boundary; `initParser` validates actual options. |
| `LLM_BALANCED`, `LLM_FULL_FEATURED`, `MINIMAL_FAST` | Inspect every flag when moving to `LLM_BALANCED`, `LLM_FULL` or `STRICT`; names do not establish equivalent settings. |
| `LLM_STREAMING_FAST` | Disabled comments, JavaScript, single quotes, unquoted keys, extraction, string repair and diagnostics; forced fuzzy parsing, object-only results and mutable reuse. It is not merely diagnostics-off. |

### Option meanings

| Old option | Current destination or replacement |
| --- | --- |
| `allowComments`, `allowJavaScript`, `allowSingleQuotes`, `allowTrailingComma`, `allowUnquotedKeys` | Same independent families, plus individual `recover` switches. Check refused outcomes as well as recovered values. |
| `repairStrings` | `repairBroken` and individual recovery kinds; refusing a recognized repair must not silently select a different value. |
| `appendStrOnEnd` | `cutSuffix: "..."` reproduces the legacy marker; `cutSuffix: true` appends `…`. Off by default, because text the caller did not ask for is never appended, and only a cut string receives it. `complete` and `cut` mark every cut value whether or not a suffix is set. |
| `bypassNativeParser`, compatibility `expectFuzzy` | `builtinParsers: false` forces the scanner; automatic routing must preserve the same result. |
| `collectErrors` | The `diagnostics` feature; reports are opt-in. |
| `extractFromMarkdown`, `markdownExtractionMode`, compatibility `skipBeforeJsonStart` | Finding JSON works the same whatever produced the text. Verify each old wrapper input; vendor-named modes are not proof of distinct recovery needs. |
| Legacy `0123` read as `123` (reported as `octal-number`) | `recover: { "leading-zero-number": true }`, set by `COMPAT`. By default the text `"0123"` is kept, and `octal-number` now means a `0o` literal only. |
| Legacy `parseJsonCompat("invalid")` returning `"invalid"` | `recover: { "unquoted-root-string": true }`, set by `COMPAT`. By default a lone unquoted word is `policy-refused`, with the word in `recovered`. |
| `hasExplicitUndefined` | An explicitly enabled `undefined` is preserved; `repair` refuses values JSON cannot represent. |
| `maxBuffer`, `maxErrors` | Compare the resource each bounds, not just its number; stopped recovery must carry a typed failure and available partial data. |
| `unsafeMode` | Removed: a snapshot you hold never changes, and a live view rejects caller writes. |
| Compatibility `silent`, `debug` | Typed outcomes and requested diagnostics; caller logging must not be required for recovery. |

### Implemented capability mappings

These legacy capabilities remain available, now with typed outcomes.

- `objectMode`, `requireKeys` and `requiredKeys` map to `objectOnly` and `requiredKeys`:
  `{"other":1} {"id":2}` selects the later root for required `id`. Kind and own-key filters apply
  to plain, fenced and streaming input. Single-result calls choose the first matching root;
  multi-result calls deliver all matching roots. If exhaustion finds none, return a typed no-match
  failure retaining the first kind-compatible root, if any. Source order follows `parse`'s first-root
  contract; counting matching keys cannot establish intended identity, and the legacy last-root
  fallback overwrote candidates without a quality comparison. Never merge roots or mask a prior
  refusal, source failure or limit with no-match; retained candidates remain subject to resource bounds.
- `tryParsers`, `CustomParser`, `TryParsersOptions` supply an ordered caller-parser fallback with an
  acceptance predicate. The built-in-parser attempt does not replace fallback to another data format.
  Parser exceptions and rejected results advance; predicate exceptions, Promise results and unsafe
  result inspection stop. The first accepted value retains its identity, and every stop or exhaustion
  is a typed outcome rather than legacy throw/undefined control flow.

### Recovery evidence

Use inherited `corpus/corpus.jsonl` inputs and archived tests read with `git show 3bf7ad8^:legacy/test/<file>`, not old expected values,
to check current public calls. Include every recovery counter family from old `ParseMetrics`, each
markdown mode, numeric dialect, string escape, unsafe-key path and streaming boundary. Test one-shot
and chunked behavior, reports on and off, refusal and resource exhaustion. Current conformance proves
only its recorded observations; omitted legacy options still need their own contract evidence.

Metrics collect per-kind repair counts. `JSON.parse` loses duplicate-key evidence, so those calls use the scanner; the old native/fuzzy split would repeat call totals. Outcome, repair, blocked-key and buffer counters preserve the monitoring jobs without a second recognizer or misleading routing counters.
