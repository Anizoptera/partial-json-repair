# Changelog

Notable user-visible changes, newest first.
Revise unpublished sections when behaviour changes; keep released notes unchanged and write later changes under Unreleased.

## 0.1.1 — 2026-10-31

Faster parsing; values, reports and the API are unchanged.

### Changed

- **Long strings no longer slow `parse` down.** Clean or cut-off input whose strings run to
  kilobytes was up to ~8x slower than `JSON.parse`; it now runs at about `JSON.parse` speed
  (measured on Bun 1.4.4).
- **Streams are about 4x faster on records of short fields.** `parseStream` and
  `createStreamParser` hand each container that closed undamaged to `JSON.parse` instead of reading
  it character by character (Bun 1.4.4, 4096-character chunks). Streams with `diagnostics`,
  `select` or `sharedView` still read every character. Stream bundles grow by about 0.9 KB gzip.

## 0.1.0 — 2026-10-30

First release. `partial-json-repair` recovers values from damaged or still-streaming JSON, such as
model output, truncated logs and JSON inside prose, and tells you what it changed. The npm package
contains the TypeScript implementation, with zero runtime dependencies; one ESM build runs in Node,
Bun, Deno, browsers and edge runtimes.

### What you get

- **`parse(text)`** returns the first value in the text. It recovers truncated strings, unclosed
  containers, single quotes, comments, unquoted keys, trailing commas, missing commas and quotes,
  values inside prose or code fences, and common JavaScript and Python spellings. Clean input is
  handed to `JSON.parse` wherever that gives the same answer.
- **`parseMany`** returns every value in a text (JSONL, multi-document replies); **`repair`**
  returns the repaired JSON text, splicing your source so untouched parts stay byte-identical;
  **`findJsonSpan`** says where the value sits.
- **Honest results.** Every call returns `{ ok: true, value }` or `{ ok: false, failure }` with
  literal-tagged kinds; nothing throws for anything the input did. Each value carries `complete`,
  and `cut` says where the source stopped. `more: true` warns that another value follows. A failure
  still carries what was recovered.
- **Reports on request.** `diagnostics` lists every repair and refusal with its path and source
  position, plus a `confidence` score; `locations` adds source spans. Optional features are imports,
  so an app that does not use them does not ship them.
- **Streaming.** `parseStream` consumes any async source and honours an abort signal;
  `createStreamParser` gives manual `feed()`/`end()`. Each completed value is delivered exactly
  once, `snapshot()` shows the value being built, and `select` delivers only the paths you name,
  optionally as string fragments while they arrive.
- **Async whole-input calls** from `partial-json-repair/async` run inline, cooperatively or in a
  worker, chosen by an imported `execution` strategy, and can be cancelled.
- **Bytes as input** everywhere, with correct handling of characters split across chunks and of
  malformed UTF-8.
- **Exact numbers.** Integers past 2^53, overflow and underflow come back as `ExactNumber` rather
  than a rounded value; `stringify` writes them back.
- **Control and safety.** Presets (`LLM_BALANCED` default, `LLM_FULL`, `STRICT`, `COMPAT`), per-kind
  `recover` switches, a prototype-pollution policy (`onDangerousKey`), and resource limits
  (`maxBuffer`, `maxDepth`, `maxErrors`, `maxScalar`, `maxRetained`) that fail with
  `limit-reached` instead of crashing.

The same library is also published as `@anizoptera/recover-json`, at the same version. See the
[README](https://github.com/Anizoptera/partial-json-repair#readme) for usage and limitations, and
[docs/API.md](https://github.com/Anizoptera/partial-json-repair/blob/main/docs/API.md) for the full
contract.

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
