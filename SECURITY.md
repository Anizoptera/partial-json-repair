# Security

Report vulnerabilities privately through the
[private advisory form](../../security/advisories/new); keep secrets and
working exploit details out of public issues.

## What this library is responsible for

This parser is built to be pointed at **untrusted text** — model output, log lines, whatever
arrived over the wire. That is the whole use case, so the security surface is the input itself.

**In scope, and worth reporting privately:**

- **Prototype pollution.** An input that changes any object's prototype, under any option
  combination. The six dangerous keys are `__proto__`, `constructor`, `__defineGetter__`,
  `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__`, plus anything in
  `customDangerousKeys`; a spelling that evades the check — escapes, normalisation, zero-width
  characters — is a report even if the resulting value looks harmless. `onDangerousKey: "keep"`
  keeps the key as **ordinary data** and must still not touch a prototype.
- **Resource exhaustion from bounded input.** `maxBuffer`, `maxDepth`, `maxErrors`, `maxScalar` and
  `maxRetained` bound their named work or storage, not total process memory or wall-clock time.
  Input that defeats a configured bound, causes superlinear processing or overflows the stack is
  a report. Whole-input calls already retain their input; callers must bound its size separately.
  `maxRetained` bounds what a stream HOLDS rather than what it has read: matches waiting for their
  ancestors to close, the arrived part of a string, and results the caller has not read yet with
  their reports; a result already delivered is the caller's. It defaults to `maxBuffer`, and like
  `maxBuffer` it binds streams only — a one-shot call already holds the whole input, so refusing to
  read the second half of it would be truncation dressed as a bound. `diagnostics({ maxEntries })`
  caps the entries each report retains, and `maxOutput` bounds what `stringify` writes. `ExactNumber.toBigInt` expands an exponent only up to the
  `maxDigits` the caller passes, so `1e999999999` costs a comparison.
- **A thrown exception.** This parser is contracted never to throw for anything the input did.
  Every failure is a value: `ok: false` with a `failure.kind`, carrying what was still recovered;
  a construct that was refused but read is a `diagnostics.errors` entry when a report is asked for.
  A stack trace escaping `parse`, `feed`, `end` or `repair` is a defect regardless of the input.
- **Silent byte corruption.** Malformed UTF-8 is replaced with U+FFFD; requested diagnostics report
  `invalid-utf8`. Genuine encoded U+FFFD is not an error. Dropped bytes, replacements missing from
  requested diagnostics, wrong decoded offsets, or chunk-dependent decoding are defects.
- **A successful `repair(text)` producing invalid JSON**, or text that parses to a different value
  than the recovered JSON-domain value. Non-JSON values must return a typed failure instead.

**Not in scope, because it is the product:**

- The parser accepting text that `JSON.parse` rejects. That is what it is for.
- Recovery producing a value you disagree with. Requested diagnostics report alterations in
  `repairs` with their paths; an alteration missing from a complete requested report is a defect.
- `confidence` being lower or higher than you expected. It is a documented function of the repair
  list, not a security control.

## Deliberate properties you can rely on

- **No regular expression is used anywhere in `src/`**, and a check in the lane fails the build if
  one appears. There is no ReDoS surface to report because there is no backtracking engine in the
  parse path.
- **Zero runtime dependencies**, so the supply chain is this package and the runtime.
- **No `node:` import in the root entry**, no filesystem, no network, no timeouts. `/async` imports
  `node:worker_threads` lazily, only to start a worker on Node, Bun and Deno. `parseStream` and async
  verbs yield between slices with `setImmediate`, else `scheduler.wait(0)`, else `MessageChannel`.
  Each waits for a host task, not a microtask, so the caller's queued timers still run.
- **No call sees another call's input or results.** Module state is limited to values built once on
  first use and never changed by input (the default parser, a `TextDecoder`, the `ExactNumber`
  brand), overflow counts held weakly against the report they belong to, scratch reset at the start
  of each use, and `/async`'s one worker per realm, reused by later calls. A parser holds frozen
  options; a stream parser holds its own scan state and is used once.
- **Nothing is executed from data.** Input is scanned as text or decoded bytes; it never becomes
  executable code, a pattern, or a constructed function.
