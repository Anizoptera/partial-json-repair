# Prior art

Other libraries parse or repair broken JSON, and the runtimes ship parsers of their own. This
document measures them against this one, so choosing is a matter of reading a table rather than
trying each.

The tables below cover JavaScript repair and dialect libraries, runtime parsers, and Rust parsers.
The `simdjson` row in them is its npm binding, which sends short input directly to the engine. The
streaming rivals, Python `json_repair`, the standalone C/C++ parsers and bundle size have their own
section: [Streaming, other languages and bundle size](#streaming-other-languages-and-bundle-size).

**The canonical parsers are rivals too.** Most JSON a consumer streams or parses is well-formed, so
on the ordinary path this package competes with `JSON.parse`, `Bun.JSONL`, `simdjson` and the dialect
parsers, not only with the repair libraries.

Everything here is measured, and you can run it yourself:

```sh
cd bench/prior-art && bun install     # the rivals, pinned, outside this package's lockfile
bun ../../bench/prior-art/fetch-suite.ts
cd ../.. && bun run build
bun bench/prior-art/compare.ts        # capability, coverage, strictness, memory
bun run bench:baseline                # speed, on every installed runtime AND the Rust subjects
```

`bench:baseline` builds and drives the Rust binary as one more runner, so a Rust regression arrives
in the same diff, at the same rounding, against the same documents as a JavaScript one. Adding an
implementation — a WASM rung, a native binding, a rival in another language — means making it print
the agreed shape on stdout and registering it; it does not mean a second report.

**Machine and versions.** Apple M4 Max, macOS 26.5.2. Rounding limits displayed precision; it does
not remove sampling variation or host-load effects. Each table's named run governs its figures.
`baseline.json` stores accepted speed estimates; `bench/prior-art/package.json` pins the current
comparison adapters.

Each library is driven through **its own best entry point** — `jsonrepair` repairs text, so it is
scored as repair-then-`JSON.parse`; `partial-json` gets its most permissive mask;
`best-effort-json-parser` has its console logging turned off first, or the numbers would price its
error reporting.

Two rules keep this from being marketing. The input set was fixed before the comparison ran — it is
the conformance corpus, recorded from a different implementation entirely. And where a rival wins,
the row says so.

## What each library can do

Every cell is decided by parsing a probe input and comparing the value, never by reading a README.
Each library is scored at its most permissive setting, so this compares capability rather than
defaults. The comparison is strict: `NaN` is not `null`, and a key holding `undefined` is not a
missing key. `best-effort-json-parser` fails the truncated object because `{"a":1,"b":` returns
`{ a: 1, b: undefined }`, a member the source never finished.

| Capability | partial-json-repair | JSON.parse | jsonrepair | partial-json | best-effort-json-parser | json-repair-js | untruncate-json | repair-json-stream | simdjson | json5 | jsonc-parser | secure-json-parse | json-bigint | Bun.JSON5 | Bun.JSONL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| truncated object | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| truncated string | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| truncated array | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| trailing comma | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| single quotes | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| unquoted keys | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| comments | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ |
| JS literals | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| JSON in prose | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| fenced block | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| prose is not JSON | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| `__proto__` survives as data | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ |

Two rows are worth more than the ticks suggest.

**"Prose is not JSON"** asks what `see [1] for the citation` returns. Every library marked `✗` on
that row answers `[1]`. Recovering JSON out of text and refusing to invent it out of punctuation pull
in opposite directions, and a library that only does the first will manufacture data from a citation
marker.

**`__proto__`** asks what `{"__proto__":{"x":1},"a":2}` returns. **Nothing here pollutes a
prototype on this input** — checked by parsing that document and reading `({}).x` for each library
in the table. The `✗` cells mean three different
safe things. `secure-json-parse` and `json-bigint` **reject** the document. `partial-json` and
`jsonc-parser` silently **drop** the key while keeping its siblings, so a document that used
`__proto__` as an ordinary name loses it with nothing said. Everything else keeps it as data, as
`JSON.parse` does. This package keeps it by default and offers `drop` and `reject` as policies, all
three keeping the key's siblings and all three saying which one applied.

Three other libraries in this table report part of what they did, none with a path.
`json-repair-js` called with `{ logging: true }` returns `[value, log]`, each entry a message and a
source excerpt of up to 20 characters around the repair; read from its source, the only repair that
writes an entry is a missing colon after a key, and input `JSON.parse` accepts returns the bare value
with no log. `best-effort-json-parser` sends messages to a logger set with `setErrorLogger` and keeps
the unparsed tail in `parse.lastParseReminding`, which reports dropped trailing content, not the
repairs that produced the value. `repair-json-stream` reports repairs through a callback (see
[below](#streaming-other-languages-and-bundle-size)). Of the other libraries in this table, two
accept bytes: `secure-json-parse` a Node `Buffer` (`types/index.d.ts`), and `Bun.JSONL.parse` a
typed array, `DataView` or `ArrayBuffer` (`bun-types`). Three do read more than one value from a
document: `Bun.JSONL`, which is built for exactly that and is far faster at it, and `jsonrepair` and
`repair-json-stream`, which get there by wrapping the values into a single array.

## Agreement over the corpus

Every recorded input — real malformed output captured from a different implementation before this
comparison was written — runs through each library.

| Library | agrees with us | differs | throws |
| --- | --- | --- | --- |
| partial-json-repair | 532 | 0 | 33 |
| JSON.parse | 207 | 2 | 356 |
| jsonrepair | 392 | 98 | 75 |
| partial-json | 317 | 193 | 55 |
| best-effort-json-parser | 368 | 189 | 8 |
| json-repair-js | 387 | 178 | 0 |
| untruncate-json | 270 | 15 | 280 |
| repair-json-stream | 345 | 43 | 177 |
| simdjson | 207 | 2 | 356 |
| json5 | 300 | 2 | 263 |
| jsonc-parser | 358 | 207 | 0 |
| secure-json-parse | 194 | 2 | 369 |
| json-bigint | 184 | 12 | 369 |
| Bun.JSON5 | 300 | 2 | 263 |
| Bun.JSONL | 223 | 118 | 224 |

Read this as a map of disagreement, not a scoreboard: the corpus is what THIS package targets, so
"agrees with us" is not a measure of correctness. **Our own row uses default settings.** Its declines
are inputs with no candidate value (prose, empty input, whitespace, template placeholders such as
`{{name}}`) and the lone unquoted words or non-number tokens it refuses by default, which `COMPAT`
reads as strings.

Every rival's count is measured against our output, so a change on our side can move every row. This
column is the comparison that detects that movement; the capability and strictness tables answer
different questions.

The two inputs where `JSON.parse` differs from us are one document recorded twice, `{"num":1e308}`:
the double cannot hold that integer exactly, so we return an `ExactNumber` carrying the source token
and the comparison sees `1e308` against `1e+308`. That is the exact-number contract working, not a
disagreement about the value.

Every column here is read against our own output, so a change in THIS package moves every rival's
numbers without any rival changing. Nothing else watches that: the corpus gate compares the corpus
to the implementation it was recorded from, never to this one.

`json-repair-js` and `jsonc-parser` never throw at all, and `best-effort-json-parser` almost never.
All three achieve that partly by returning a value for text that holds none — `jsonc-parser` differs
from us on more inputs than any other library here, and it is the one that never fails.

`Bun.JSON5` and `json5` return identical verdicts on the recorded corpus. `simdjson` matches
`JSON.parse` exactly there.

The figures above are Bun's. `Bun.JSON5` and `Bun.JSONL` are built into that runtime and have no
Node row at all — a capability difference, not a gap in the measurement.

Coverage is otherwise behaviour and should not depend on the runtime. `untruncate-json` ships a
CommonJS build under `main` and an ES module under `module`: Bun loads the module, while Node and
Deno load the CommonJS build, whose default import is the `exports` object rather than the
function. `libs.ts` unwraps that object, so a Node or Deno `untruncate-json` dash in this
document is a harness gap rather than a library failure, and filling it needs a re-run of
`compare.ts` and `bench:baseline`.

## Where we differ, and why

`test/rival-differences.ts` records every cause of disagreement, each with its verdict, the priority
that decides it and pinned example inputs that `test/rival-differences.test.ts` runs, so a
change that reverses a verdict fails the suite. Most causes favour our answer: a rival drops written
members, invents values for empty places, truncates number spellings, splits or merges strings, reads
a prose word instead of the JSON in it, or wraps several roots in one array. Strict parsers refusing
damage and `Bun.JSONL` holding back an unfinished last line are intended differences. A root opened
by an apostrophe that never closes (`'tis the season`) shows no JSON evidence, so we refuse it with
its text in `recovered` where the recovering rivals return a string. When a string is still open at
the end of input and only closers follow its raw line break, we end the string before them, as
jsonrepair does, unless the string itself opened what they close: cut code keeps its `}`. A
bare-word key line (`b: 2`) stays in the string, because prose writes `Note: ...` lines the same
way. jsonrepair ends the string at the line break in both cases;
`recover: { "guessed-string-end": true }` does the same here. No recorded cause favours a rival.

`EMIT=differences bun bench/prior-art/compare.ts` classifies every place where a rival's answer
differs from ours, input by input, and fails on any difference no cause explains or whose cause moved
since `differences.json` was accepted. One input can differ from one rival in several places for
unrelated causes, so each place gets its own verdict. Judge each such pair, add or widen a cause with a pinned case, then rerun with `ACCEPT=1`.

## Strictness

`STRICT` sets every leniency off and stops at the first error, and is scored against
[nst/JSONTestSuite](https://github.com/nst/JSONTestSuite) — 95 documents that must be accepted and
188 that must be rejected. Two lenient rivals have a strict configuration, scored the same way:
`jsonc-parser` with comments, trailing commas and empty content disallowed, refusing on any
collected error, and `partial-json` with an `Allow` mask of `0`.

| Library | accepts valid | rejects invalid | wrong |
| --- | --- | --- | --- |
| partial-json-repair (`STRICT`) | 95/95 | 176/188 | 12 |
| `JSON.parse` | 95/95 | 188/188 | **0** |
| `jsonc-parser` (strict options) | 95/95 | 188/188 | **0** |
| `partial-json` (`Allow` 0) | 95/95 | 154/188 | 34 |

**`JSON.parse` and strict `jsonc-parser` win this outright; use one when it fits.** The twelve we get wrong are all
the same case: a valid value followed by trailing content — `{"a": true} "x"`, stray closers
(`1]`, `{}}`, `[1]]`, `["x"]]`), `[""],`, and six variants ending in a comment or a `#`. This package is defined
to return the FIRST value in a text and to ignore what surrounds it — that is what makes recovery
from prose possible at all — so it accepts those twelve by design rather than by oversight. If your
input is supposed to be strictly valid JSON and nothing else, `JSON.parse` is the right tool, and
`STRICT` exists for the case where you want strict diagnostics while retaining first-value
extraction. Use `JSON.parse` when the whole input must satisfy RFC 8259.

## Speed

Five documents carrying the SAME 400 records, one per dialect this package reads: 32 KB of plain
JSON, the same records with their keys unquoted and the tail cut off, 8.6 KB of JSONL rows, a JSONC
form with a comment on every row and a trailing comma, and a JSON5 form that additionally unquotes
every key and single-quotes every string. One value across every column, so a cell compares parsers
rather than documents — and a dialect parser is measured on its own dialect rather than on plain
JSON, which is only its fallback path.

**Relative to each runtime's own `JSON.parse`**. Cells are Bun 1.4.4 / Node 24.22.1, measured
2026-10-28 from source `e608afe` on the machine above; [Browsers and workerd](#browsers-and-workerd) gives those hosts.
Ratios reduce shared slowdown but do not remove host effects. A blank cell means the library did not
produce the correct value. `bun run bench:baseline` regenerates the complete matrix.

**Figures are rounded to five rungs per decade, roughly 1.6× apart.** Rounding hides small
differences; sampling and machine state add uncertainty. Cells on the same rung are not
distinguishable here. Read `0.25` and `0.40` as different rounded estimates, never a third digit into
either. A one-rung move alone does not establish a regression; check the process spread and remeasure.

| Library | clean | malformed | JSONL | JSONC | JSON5 |
| --- | --- | --- | --- | --- | --- |
| `JSON.parse` | 1.0 / 1.0 | — | — | — | — |
| json-repair-js | 1.0 / 1.0 | — | — | — | — |
| simdjson | 1.0 / 1.0 | — | — | — | — |
| secure-json-parse | 1.0 / 1.0 | — | — | — | — |
| `Bun.JSONL` | 1.0 / — | — | 1.0 / — | — | — |
| partial-json-repair | 0.63 / 0.63 | 0.10 / 0.16 | 0.063 / 0.10 | 0.40 / 0.63 | 0.063 / 0.16 |
| json-bigint | 0.40 / 0.63 | — | — | — | — |
| repair-json-stream | 0.16 / 0.25 | 0.16 / 0.16 | 0.16 / 0.25 | 0.25 / 0.25 | 0.16 / 0.16 |
| partial-json | 0.25 / 0.40 | — | — | — | — |
| best-effort-json-parser | 0.25 / 0.16 | 0.10 / 0.10 | — | 0.10 / 0.10 | 0.10 / 0.16 |
| untruncate-json | 0.25 / 0.40 | — | — | — | — |
| jsonc-parser | 0.25 / 0.40 | — | — | 0.25 / 0.40 | — |
| `Bun.JSON5` | 0.25 / — | — | — | 0.25 / — | 0.25 / — |
| jsonrepair | 0.10 / 0.16 | 0.10 / 0.16 | 0.040 / 0.10 | 0.10 / 0.16 | 0.063 / 0.10 |
| json5 | 0.10 / 0.063 | — | — | 0.10 / 0.063 | 0.10 / 0.063 |

**`Bun.JSONL` beats this package more than tenfold on valid JSONL, and that is the honest headline.** If your newline-delimited input is well-formed and you are on Bun, use it. This
package exists for the case where it is not, and reports what it had to repair; `Bun.JSONL` throws.

**`json-repair-js` and `simdjson` sitting level with `JSON.parse` is not a win over it.** Read from
source, `json-repair-js` calls `JSON.parse` first and returns that result untouched, so on clean
input it _is_ `JSON.parse` plus a `try`/`catch`. The `simdjson` binding likewise hands short input
straight to the engine.

This package runs at about two thirds of `JSON.parse` on clean input, and that gap is bought
deliberately: it screens the source before handing it over, which is what lets it report a number
losing digits instead of returning a quietly rounded one.

**On malformed input — the case this library exists for — `repair-json-stream` is faster on Bun
(0.16 against 0.10) and level on Node, and on JSONL it is faster on both.** Four libraries
survive that document at all. What this package buys with the difference is the account of the
damage: each repair with its path and source position, and a cut that says where the value stopped.
`repair-json-stream` reports actions through a callback, without paths and at positions in its
preprocessed text, and over the corpus it differs from us on 43 inputs and throws on 177 (see
[Where we differ](#where-we-differ-and-why)).

**On JSONC this package leads every library measured, the dialect specialists included:** with no
report asked for, input whose only damage is comments and trailing commas goes to a built-in parser
once the pre-scan proves it gives the scanner's answer. **On JSON5 it trails `Bun.JSON5` by three
rungs, and `repair-json-stream` by two on Bun; they share a rung on Node.** Treat the JSON5 cell as soft: it is the
noisiest in the whole matrix, and two back-to-back runs put it a rung apart. The document is a worst
case by construction — every key unquoted and every string single-quoted, so nearly every token is a
repair. `Bun.JSON5` is several times faster there and gives no repair report. If you want a JSON5 parser, use
a JSON5 parser; this package is for input whose deviations you need enumerated.

These speed rows use default calls without reports (`libs.ts`). They do not measure the cost of
requesting `diagnostics`; measure that separately when the application needs repair reports.

Node's column flatters every lenient parser, this one included, because V8's `JSON.parse` is slower
than JavaScriptCore's — the ratio rises while the absolute rate falls. Read the two columns as two
separate races, never as one.

**Engine versions move individual libraries independently.** The supported-release rows in
`baseline.json` keep that engine effect visible instead of presenting one runtime as a property of
the library.

### Browsers and workerd

`bench/prior-art/web.ts` bundles the same five documents and adapters, minified, and runs them in
WebKit through `Bun.WebView`, Chromium through Playwright, both on a cross-origin isolated page, and workerd through
miniflare. Each is one more `bench:baseline` member. Measured 2026-10-28 from source `e608afe` on the machine above,
using Bun 1.4.4's system WebKit, Chromium 156.0.8078.4 and workerd 1.20261026.1.
Cells: WebKit / Chromium / workerd.

| Library | clean | malformed | JSONL | JSONC | JSON5 |
| --- | --- | --- | --- | --- | --- |
| `JSON.parse` | 1.0 / 1.0 / 1.0 | — | — | — | — |
| json-repair-js | 1.0 / 1.0 / 1.0 | — | — | — | — |
| secure-json-parse | 1.0 / 1.0 / 1.0 | — | — | — | — |
| partial-json-repair | 0.63 / 0.63 / 0.63 | 0.10 / 0.10 / 0.16 | 0.063 / 0.10 / 0.10 | 0.63 / 0.63 / 0.63 | 0.063 / 0.10 / 0.10 |
| json-bigint | 0.40 / 0.40 / 0.63 | — | — | — | — |
| repair-json-stream | 0.25 / 0.25 / 0.25 | 0.25 / 0.25 / 0.25 | 0.16 / 0.25 / 0.25 | 0.25 / 0.25 / 0.25 | 0.25 / 0.25 / 0.25 |
| partial-json | 0.25 / 0.25 / 0.25 | — | — | — | — |
| best-effort-json-parser | 0.25 / 0.25 / 0.25 | 0.10 / 0.10 / 0.10 | — | 0.10 / 0.10 / 0.10 | 0.10 / 0.16 / 0.16 |
| untruncate-json | 0.25 / 0.40 / 0.40 | — | — | — | — |
| jsonc-parser | 0.25 / 0.25 / 0.25 | — | — | 0.25 / 0.25 / 0.40 | — |
| jsonrepair | 0.10 / 0.10 / 0.16 | 0.10 / 0.10 / 0.10 | 0.040 / 0.063 / 0.10 | 0.10 / 0.10 / 0.16 | 0.063 / 0.063 / 0.10 |
| json5 | 0.040 / 0.063 / 0.10 | — | — | 0.040 / 0.063 / 0.063 | 0.040 / 0.063 / 0.063 |

Clean input and JSONC read at 0.63 on all three hosts. `repair-json-stream` is faster on malformed
input and JSONL in each displayed host; the recovery contracts differ as described above.

**Allow for workerd's coarse clock.** Its `performance.now()` moves in 1 ms steps, so timed
batches last at least 25 ms. This reduces clock rounding but leaves fewer samples within the
budget. Read process spread before ranking close estimates; rounding does not remove uncertainty.

### JavaScript engine routes

The release ships the TypeScript implementation only; native and WASM builds come later, so
every JavaScript figure here is the TypeScript route. `bench:baseline` has no native or WASM member;
their harness is parked with the adapters in `rust/js-adapters/bench/` until those builds return by
meeting the current recorded cases.

## Memory

Sampled peak RSS while one adapter parses the clean document 400 times. Each process loads the
shared comparison adapters and corpus; this is not a standalone consumer's footprint.

Measured 2026-10-17 on Apple M4 Max with the result-validating harness at `cae496f`; each cell uses five fresh processes.
Medians round to whole MiB; reported range ends round outward. An em dash marks Bun-only built-ins.
Build first with `bun run build`, then set `ONLY=<library>` and run `bench/prior-art/compare.ts` with the named runtime. Deno uses `run --cached-only --allow-read --allow-env --allow-sys --allow-ffi`.

| Library | Bun 1.4.3, MiB | Bun 1.3.14, MiB | Node 22.23.3, MiB | Node 24.22.0, MiB | Node 26.12.0, MiB | Deno 2.9.7, MiB |
| --- | --- | --- | --- | --- | --- | --- |
| simdjson | 38 (37–38) | 101 (100–105) | 92 (91–97) | 106 (104–107) | 110 (107–113) | 78 (77–80) |
| `Bun.JSONL` | 39 (38–39) | 104 (101–105) | — | — | — | — |
| json-repair-js | 38 (38–39) | 106 (103–108) | 93 (92–93) | 105 (104–109) | 109 (108–112) | 78 (76–78) |
| `JSON.parse` | 36 (34–38) | 105 (104–106) | 91 (90–92) | 106 (102–110) | 108 (106–114) | 78 (77–79) |
| secure-json-parse | 38 (38–39) | 104 (102–104) | 93 (92–95) | 107 (104–108) | 108 (106–112) | 78 (77–80) |
| partial-json | 41 (40–43) | 112 (111–114) | 92 (90–97) | 112 (111–114) | 110 (108–112) | 78 (77–80) |
| partial-json-repair | 38 (29–38) | 107 (103–109) | 93 (92–94) | 106 (106–114) | 110 (108–113) | 78 (76–79) |
| untruncate-json | 43 (41–44) | 111 (109–113) | 93 (91–94) | 106 (100–108) | 110 (107–112) | 78 (77–80) |
| jsonc-parser | 45 (43–46) | 114 (111–117) | 101 (99–103) | 114 (113–116) | 120 (116–121) | 87 (86–88) |
| json-bigint | 47 (46–48) | 122 (115–123) | 102 (99–104) | 115 (112–116) | 116 (115–118) | 86 (85–88) |
| best-effort-json-parser | 49 (46–50) | 126 (123–128) | 133 (131–143) | 144 (141–146) | 148 (126–150) | 97 (95–99) |
| `Bun.JSON5` | 48 (47–51) | 131 (129–132) | — | — | — | — |
| json5 | 52 (47–55) | 123 (121–126) | 100 (99–101) | 114 (113–115) | 119 (117–131) | 87 (86–87) |
| jsonrepair | 57 (52–59) | 141 (138–144) | 116 (116–121) | 131 (127–134) | 134 (133–139) | 104 (103–106) |
| repair-json-stream | 60 (60–63) | 129 (126–130) | 93 (92–95) | 109 (104–111) | 132 (125–157) | 103 (101–105) |

Observed ranges are not confidence bounds and do not support small memory rankings. RSS sampling
can miss peaks between samples, and resident memory is not a heap-retention bound.

Compare rows only within the same runtime and harness. The common imports, corpus, allocator and
runtime contribute to every cell; a difference does not by itself identify an allocation owner.

`compare.ts` samples `memoryUsage().rss` in bytes and converts to MiB. Collected heap deltas answer
a different question; they do not replace the resident working-set measurement above.

### Browser and edge processes

The portable adapters and speed documents share one bundle and the native table's clean document,
parse count and sampling interval. Each adapter uses five fresh owned hosts; final values are
checked after the last sample, and each counter detects a deliberately retained control.
WebKit measures one renderer. Chromium sums its owned renderers, including idle ones; shared pages
can count more than once. Both exclude UI/network processes. Workerd measures its owned subprocess,
excluding the controller. Compare only within a column, not across these scopes or the native table.

Measured 2026-10-17 on Apple M4 Max: WebKit recovery source `ab9b54d`, Chromium/workerd harness `7733126`.
Build first. For WebKit, set `DYLD_FRAMEWORK_PATH` and `DYLD_LIBRARY_PATH` to the managed engine
directory and run `bun bench/prior-art/webkit-memory.ts`. For Chromium, set `BUN_CHROME_PATH` to
the measured isolated binary and run `bun bench/prior-art/host-memory.ts chromium`; for workerd,
run `bun bench/prior-art/host-memory.ts workerd`. These macOS counters read
`proc_taskinfo.pti_resident_size`; a missing owned process or failed sample fails the measurement.
Cells show whole-MiB medians and outward-rounded observed ranges, not confidence bounds.
Sampling can miss intervening peaks; differences do not identify allocation owners.

| Library | WebKit webkit-2370 renderer, MiB | Chromium 156.0.8078.36 renderer sum, MiB | workerd 2026-10-16 process, MiB |
| --- | --- | --- | --- |
| partial-json-repair | 143 (142–144) | 431 (424–436) | 74 (69–86) |
| JSON.parse | 142 (140–151) | 429 (424–439) | 73 (71–81) |
| jsonrepair | 171 (169–191) | 449 (441–451) | 96 (86–97) |
| partial-json | 148 (147–155) | 430 (425–446) | 78 (74–85) |
| best-effort-json-parser | 154 (152–166) | 448 (437–452) | 88 (84–97) |
| json-repair-js | 141 (140–145) | 433 (429–435) | 74 (71–83) |
| untruncate-json | 144 (141–153) | 432 (431–433) | 74 (69–80) |
| repair-json-stream | 177 (175–188) | 445 (438–453) | 93 (83–101) |
| json5 | 197 (189–238) | 446 (445–453) | 90 (86–94) |
| jsonc-parser | 156 (150–178) | 440 (437–444) | 80 (77–86) |
| secure-json-parse | 142 (138–149) | 434 (428–446) | 80 (74–83) |
| json-bigint | 163 (156–169) | 439 (433–452) | 91 (85–93) |

## Streaming, other languages and bundle size

These members are registered in `bench/prior-art/baseline.ts` and measured by the same
`bun run bench:baseline` run as the speed table, on the same fixed rungs (Apple M4 Max, 2026-10-28, source `e608afe`).

```sh
bun run bench:baseline:routes                     # every member: ok, fail, or unavailable with the reason
EMIT=cases bun bench/prior-art/compare.ts > cases.json
bun bench/prior-art/stream.ts < cases.json   # one process, no error bar; the baseline forks it
bun bench/prior-art/native.ts                     # builds the C/C++ runner from pinned sources
bun bench/prior-art/bundle-size.ts                # minified and gzip bytes per import
```

**Streaming** (`stream.ts`, one row per JavaScript runtime). Each document arrives in chunks of 16,
256 or 4096 characters, at three sizes built from the shared clean records, and a renderer reads the
value being built 60 times per document whatever the chunk size. Each library uses its own API. This
package feeds `createStreamParser({ view: "shared" })` and reads `snapshot()`. `jsonriver` consumes an
async iterable and yields the value so far. `@streamparser/json` delivers only finished values at the
root, so its frames read nothing and its cell prices feeding alone. The AI SDK's `parsePartialJson`,
the OpenAI and Anthropic SDKs' vendored `partialParse`, and `partial-json` re-parse the whole buffer
at every frame. A cell is rejected unless the final value equals the one-shot oracle under a strict
structural comparison. The input is valid JSON arriving in pieces; this workload does not damage it.

Each figure is the session's throughput divided by the same process's `JSON.parse` throughput on
the shared clean document, on the same five-rung ladder as the speed table. Cells: 34 KB in
16-character chunks / 34 KB in 4096 / 1 MB in 16. The committed baseline keeps accepted estimates;
these tables identify their own measuring run.

| Member | Entry measured | Bun 1.4.4 | Node 24.22.1 |
| --- | --- | --- | --- |
| partial-json-repair | `createStreamParser`, `feed`, `snapshot()` per frame | 0.040 / 0.063 / 0.025 | 0.063 / 0.10 / 0.063 |
| `jsonriver` | `parse(asyncIterable)` | 0.063 / 0.16 / 0.063 | 0.16 / 0.40 / 0.10 |
| `@streamparser/json` | `new JSONParser({ paths: ["$"] })`, `write` | 0.10 / 0.16 / 0.10 | 0.16 / 0.25 / 0.16 |
| AI SDK (`ai`) | `parsePartialJson(text)` per frame | 0.0063 / 0.063 / 0.0063 | 0.010 / 0.063 / 0.010 |
| OpenAI SDK (`openai`) | `openai/_vendor/partial-json-parser/parser` `partialParse` per frame | 0.0063 / 0.025 / 0.0063 | 0.0063 / 0.040 / 0.0063 |
| Anthropic SDK (`@anthropic-ai/sdk`) | `@anthropic-ai/sdk/_vendor/partial-json-parser/parser` `partialParse` per frame | 0.0040 / 0.025 / 0.0040 | 0.0063 / 0.040 / 0.0040 |
| `partial-json` | `parse(text, ALL)` per frame | 0.0063 / 0.040 / 0.0063 | 0.010 / 0.063 / 0.010 |

**At 16-character chunks the displayed estimates put this package four to ten times faster than
the libraries that re-parse the buffer each frame.** At 4096-character chunks some estimates tie.
`jsonriver` is faster in every displayed cell, but its README says it mutates the
array or object it already yielded as more input arrives. A snapshot you hold here never changes
under you, so this package copies the open path per snapshot instead. `@streamparser/json` reads nothing
per frame, so its row prices feeding alone and it never shows a partial value.

**`repair-json-stream`** repairs text, and `repairJson(input, onRepair)` passes each repair to the
callback as an action, a position and a message. Its types declare ten actions; read from its
`dist/index.js`, seven are ever reported (`closed_array`, `closed_object`, `inserted_value`,
`missing_comma`, `inserted_quote`, `fixed_literal`, `synthetic_key`), and `closed_string`,
`removed_comma` and `unescaped_char` never are. `repairJson` runs `preprocessJson` (fences, JSONP,
escaped JSON) first and repairs its output, so a reported position counts characters of the
preprocessed text, which can differ from the caller's input. Its capability, coverage, disagreement,
memory and speed figures sit in the tables above.

**Python** (`python/runner.py`, run through `uv` with the interpreter minor and `json_repair` pinned).
The denominator is the standard library's `json.loads`. Every cell is checked against the shared
expected values with a type-strict comparison, so on the damaged case it measures agreement with this
package. Python 3.14, `json_repair` 0.63.5: clean 1.0, the same rung as `json.loads`; JSONC 0.025.

**C and C++** (`native/runner.cpp`): yyjson, RapidJSON and simdjson as direct native code, built from
sources pinned by commit into the gitignored `bench/prior-art/.native-build/`, never through npm
bindings. Clean document only; a rate counts only when the library's DOM serialises back to the exact
input bytes. C++ has no standard parser, so the row divides by RapidJSON and its cells compare the
three with each other only. yyjson 0.13.0 and simdjson 5.0.1 both read at 4.0 against RapidJSON
1.1.0's 1.0.

**Bundle size** (`bundle-size.ts`, Bun 1.4.3, 2026-10-16, source `0d08152`): `Bun.build` with minification bundles exactly
the import each row needs from the pinned rivals, then gzips it at level 9. Size is deterministic.

| Import | minified bytes | gzip bytes |
| --- | --- | --- |
| partial-json-repair (parse) | 92958 | 28604 |
| partial-json-repair (createStreamParser) | 90862 | 28062 |
| jsonrepair | 7982 | 2907 |
| partial-json | 4539 | 1804 |
| best-effort-json-parser | 5328 | 2142 |
| json-repair-js | 5069 | 1910 |
| repair-json-stream | 6682 | 2259 |
| untruncate-json | 2372 | 777 |
| jsonriver | 13184 | 3125 |
| @streamparser/json | 23952 | 6008 |
| ai parsePartialJson | 156596 | 42123 |
| openai partialParse | 2736 | 1129 |
| anthropic partialParse | 2221 | 880 |
| json5 | 32744 | 9972 |
| jsonc-parser | 9951 | 3293 |

**The parse import is substantially larger than the small repair libraries.** The packed-package
`size:check` matrix on source `0d08152` measures 26753–28801 bytes gzip across Vite, webpack, Rspack,
esbuild, Rolldown and `Bun.build`; the export-only comparison above measures a different consumer.
The small repair, partial-JSON and JSONC rivals above use 777–3293 bytes gzip. Our core includes
prose and fence candidacy that declines `see [1]`, `complete` and `cut` on every result,
refusals with line, column and context when no report was asked for, dangerous-key policy, exact
numbers, every spelling repair, and the pre-scan that sends clean, cut-off and comment-only input to
`JSON.parse`. The packed matrix verifies that unused report, span and selector implementations are
absent. These capabilities do not justify every byte. Judge per-import growth against the chosen
recovery and ownership contract in `DESIGN-REVIEW.md`; a size reference does not waive later
regressions, unused feature retention, memory costs or responsiveness failures.

## The Rust engine question

This study concerns the deferred Rust implementation, not a shipped engine. Its named probes and
versions must be rerun before adopting a parser; the observations below do not exclude future adapters.

Should the Rust half build on an existing parser instead of its own? The honest answer needs three
different measurements, and only the first one is about speed.

The standing speed numbers come from `bun run bench:baseline`, which drives the Rust subjects as one
more runner. The three diagnostics below are separate because they answer questions a fixed-case
table cannot: `bun scripts/rust/cargo.ts run --release --manifest-path rust/bench/Cargo.toml` takes `walked` for the traversal control,
`conformance` and `healing` for the two correctness probes, and `dump:<dir>` to write the ladder
documents out for `rust/js-adapters/bench/engine-ladder.ts <dir>` (parked with the native adapters)
under each runtime.

**The instrument, and what it cannot see.** Apple M4 Max, arm64, load 4-7 of 16 cores; five
processes per subject, minimum within a process and median across them. The process spread reaches
16% on the slowest cells, which is why the figures sit on the same five-rung ladder as everything
else here: one rung, 1.6×, is the smallest real difference, and equal cells mean "cannot tell apart". **Every figure is arm64 only
and says nothing about x86 consumers** — which matters most for `simd-json`, whose runtime dispatch
is x86-only while NEON is unconditional here. Release builds at the shipping profile, NOT
`target-cpu=native`, so `sonic-rs` is measured below what its own documentation asks for. The
documents come from one generator; a test corpus is evidence about the tests, never about traffic.

**Why a size ladder rather than the usual corpus.** Every published JSON benchmark measures the same
three large files, so they answer "how fast is a megabyte". This package's inputs are model output
and damaged fragments — the recorded corpus has a median of 25 bytes and 97.7% of it under 1 KB —
and a two-stage SIMD parser amortises a per-block cost over length. A ladder finds where the
crossover is instead of assuming one.

Speed, as a ratio to `serde_json`; above 1.0 is faster than it. The ladder rows come from the
generated documents; the last row is the accepted `rust 1.97.1` row of
`bench/prior-art/baseline.json` (five processes, Apple M4 Max), on the shared 32 KB clean document.
This package's scanner has no ladder figure: the ladder run gave it 1.0 while the baseline row gives
0.25, so its ladder column waits for a five-process re-run.

| bytes | serde_json | simd-json | sonic-rs | JSC | V8 | ours (rs) |
| --- | --- | --- | --- | --- | --- | --- |
| 111 | 1.0 | 1.0 | 2.5 | 2.5 | 1.6 | not published |
| 1 026 | 1.0 | 1.6 | 4.0 | 2.5 | 1.6 | not published |
| 16 447 | 1.0 | 2.5 | 4.0 | 2.5 | 1.6 | not published |
| 1 048 620 | 1.0 | 2.5 | 4.0 | 2.5 | 1.6 | not published |
| 32 KB baseline | 1.0 | 1.6 | 4.0 | — | — | 0.25 |

`JSON.parse` under bun is JavaScriptCore's C++, not Bun's own code. Bun's own parsers, `Bun.JSONL`
and `Bun.JSON5`, are in the Speed table above rather than repeated here; measured on this ladder they
track JSC within its noise, so Bun's parser and the engine's land in the same place.

The rig reproduces the published aarch64 figure — `simd-json` is 1.99x `serde_json` at 1 MB against
a published 1.96x — so the rest is readable. Three findings, none of them the expected one:

- **There is no crossover.** `sonic-rs` is already 2.5x faster at 111 bytes, and 4x at a megabyte —
  it never has a size where it is slow. It does not use simdjson's two-stage algorithm, so it has no
  stage-1 setup to amortise and no size floor. A prediction built on simdjson's architecture does
  not transfer to every SIMD parser. `simd-json` itself does show the floor: level with `serde_json`
  at 111 bytes, 1.6x by a kilobyte.
- **`JSON.parse` under JavaScriptCore ties `sonic-rs`** at 2.5x `serde_json`, with V8 a rung
  behind at 1.6x. This package's Rust scanner sits at 0.25 of `serde_json` in the baseline row, so
  on clean input its TypeScript fast path, which hands clean input to `JSON.parse`, is faster than
  its Rust scanner; the size of that gap needs both measured on one rig.
  **The Rust port cannot be justified by clean-path speed** — it must be justified by healing throughput, by
  deployment without a JavaScript runtime, and by WASM and native embedding.
- **Our Rust scanner is slower than every conformant rival in the baseline row** — at 0.25 of
  `serde_json`, behind `simd-json`, `sonic-rs`, `jiter`, `tinyjson` and `struson`; only the JSON5
  crate is slower. Why is not recorded, because naming a
  cost takes a profiler and no profile has been taken. Two known differences are that it borrows
  from the source rather than copying, and that it detects exact numbers and duplicate keys while
  the conformant rivals do not — capability that has to be either justified or made cheaper, not
  assumed to explain the gap.

**These direct parser calls do not meet the recovery contract on every probe.** The differences
exclude an unchecked replacement; an adapter or a checked fast path needs its own proof:

| input | this package | serde_json | simd-json | sonic-rs |
| --- | --- | --- | --- | --- |
| `1e400` | exact `1e400` | error | error | error |
| `-0` | `-0` | `-0.0` | `0` — sign lost | `0.0` — sign lost |
| `{"a":1,"a":2}` | `{"a":2}` | `{"a":2}` | two `a` entries | two `a` entries |
| `{"2":"b","1":"a"}` | source order | reordered | source order | source order |
| `"\ud800"` | preserved | error | `"\0"` — corrupted | error |

An error is a safe answer, because a fast path can fall back on it. A wrong answer is not.
`simd-json` turns a lone surrogate into a NUL byte with no diagnostic, and both SIMD parsers hand
back an object with two members under one key, which a consumer indexing the map cannot detect.
`serde_json` is the only candidate whose failures are all errors — its key reordering is fixable with
`preserve_order` and its number handling with `arbitrary_precision` — and it is still about four
times faster than this package's Rust scanner (0.25 in the baseline row).

A fast path needs an eligibility check or adapter that handles each disagreement, with its coverage
and cost measured. TypeScript's pre-scan checks the source for numeric fidelity; options exclude
requests such as reports and selection that `JSON.parse` cannot serve. These probes do not rule out
a similar Rust design.

**The tested `jiter` partial mode disagrees on these recovery cases.**
`{"a":1 "b":2}` gives `{"a":1}` with no error, `[1,2,{"x":` gives `[1,2,{}]`, and `{"a":0x1F}` gives
`{"a":0}` — a value the source never wrote, delivered as success. Fenced blocks and prose-wrapped
JSON are refused in those probes. `biome_json_parser` has no rate in this study. Recheck the
reported `SyntaxKind` mismatch between `biome_rowan` 0.5.7/0.5.8 and `biome_parser` 0.5.8 before
treating compatibility as an exclusion; this is not proof that no compatible versions exist.

**What that means for depending on upstream.** These measurements do not establish a drop-in
replacement. Composition, an adapter or a fork need separate coverage and complete-route costs;
the direct-call results do not decide which would be worthwhile.

## Where this leaves the choice

- Input is supposed to be valid JSON → **`JSON.parse`**, and this document is why.
- You want the fastest lenient parse and nothing else → **`json-repair-js`**.
- You only ever need to close a truncated document → **`untruncate-json`** is one
  dependency-free function and does that.
- You need repaired **text** and nothing more → **`jsonrepair`** is the established choice, and its
  repair-to-text behaviour differs from ours in ways that may suit you better.
- You need a report of **what was changed and lost, with the path of each change**, or a
  prototype-pollution policy on input that also needs repair → this package. `json-repair-js` and
  `repair-json-stream` report some repairs without paths, and `secure-json-parse` offers
  `protoAction: "error" | "remove" | "ignore"` on input `JSON.parse` accepts.
- Your JSONL is **valid** and you are on Bun → **`Bun.JSONL`**, by more than tenfold.
- You need to read **damaged JSONL** → this package has the only multi-value API built for it, though
  `jsonrepair` reaches the same values on that document by repairing it into one array, at a
  comparable speed.

## On attribution

The parser this package was extracted from carried a one-line JSDoc credit saying an idea had been
taken from [json24](https://github.com/yeargun/json24). No code came with it — measured, the two
parsers share zero source lines, even though json24 has a file of the same name. The tests did:
the inherited suite is json24's own cases, and the corpus recorded from that suite holds 17 of its
41 inputs. json24 is MIT, © 2024 yeargun; its notice sits beside those inputs in
`corpus/NOTICE.md`.

None of it reaches this package. Checked against the packed tarball rather than the source tree, the
package contains no json24-derived string, so a third-party notice shipped with it would claim
material that is not there.

The two parsers share no implementation, so a credit line suggesting otherwise would mislead. What
somebody choosing between these libraries needs is a measured comparison, which is the rest of this
document.
