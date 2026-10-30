# partial-json-repair: guide for coding agents

Use this package to read JSON that may be broken, cut off, wrapped in prose or still streaming,
typically model output. It returns the value plus whether it is complete and where it was cut. It
never throws for bad input. Full docs: `README.md` in this package.

## Pick the call

| Job | Call |
| --- | --- |
| One model reply, whole text | `parse(text)` |
| Several values or JSONL | `parseMany(text)` (lazy iterator) |
| Repaired JSON text for another system | `repair(text)` |
| Where the JSON sits in the text | `findJsonSpan(text)` |
| A stream (`ReadableStream`, async iterable, Node `Readable`) | `parseStream(source)` |
| You push chunks yourself (WebSocket, SDK callback) | `createStreamParser()`, then `feed(chunk)` and `end()` |
| Big input, UI thread must stay responsive | `parseAsync(text, { execution: auto })` etc. from `partial-json-repair/async`; `worker` instead of `auto` moves the scan off the thread |

All imports come from `partial-json-repair`, except the async verbs from `partial-json-repair/async`.

## Read the result

Every result is `{ ok: true, value, complete, cut? }` or `{ ok: false, failure }`. Branch on `ok`,
then on `failure.kind`. Never parse message text: only `execution-unavailable` carries a `message`,
for logs, and its `reason` is what to branch on.

```ts
import { parse } from "partial-json-repair";

const r = parse(modelOutput);
if (!r.ok) {
  // failure.recovered, when present, holds the partial value read before the failure.
  handleFailure(r.failure);
} else if (!r.complete) {
  // The reply was cut. r.cut.path names where; r.value holds everything that arrived.
  useValue(r.value);
} else {
  useValue(r.value);
}
```

- `value` is `unknown`. Validate it with your schema before use; recovery does not check your types.
- `complete: false` means the source ended before the value did. Do not act on cut tool arguments.
- `more: true` on success means another value follows the returned one, for example a corrected
  answer below the first. Use `parseMany` to read them all.

## Streaming

- Read a value per completed root: `for await (const r of parseStream(source)) { ... }`.
- For a live preview, pass `{ view: sharedView }` and call `stream.snapshot()` once per animation
  frame, never per chunk: each snapshot copies the open containers.
- A `sharedView` snapshot is read-only. Use `ownedView` if you need to modify it.
- With `createStreamParser`, always read what `feed()` returns. Unread values pile up and the
  stream ends with `limit-reached` once `maxRetained` is exceeded.
- End each streamed document with a line break, or a value that ends a chunk arrives only with the
  next `feed()` or `end()`.
- On a model's token-limit cut, do not call `end()`: feed the continuation to the same parser.
- In `try`/`finally`, call `close()` on parsers you created so unfinished buffers are released.

## Options you are most likely to need

- `diagnostics` (import it, pass `{ diagnostics }`): the result gains `diagnostics` with every
  repair and its path, plus `confidence` (1.0 nothing guessed, below 0.7 consider retrying the
  model, below 0.5 likely garbled).
- `recover: { "<repair-kind>": true | false }`: turn one repair on or off. Defaults suit model
  output. `guessed-string-end` and `leading-zero-number` are off because they can drop source text.
- Presets: `LLM_BALANCED` (default), `LLM_FULL`, `STRICT` (first refusal fails), `COMPAT`.
- `select([["items", ANY, "name"]])` returns matches instead of the whole value; `skip([["debug"]])`
  drops members.
- `initParser(options)` validates options once for reuse; pass the result where options go.
- Invalid options throw a `TypeError` before any input is read. Passing `true` where a feature
  import belongs (`{ diagnostics: true }`) is a compile error.

## Mistakes to avoid

- Do not `JSON.stringify` a recovered value to inspect it: `NaN` becomes `null` and `undefined`
  members vanish.
- Do not assume a number: a number a double cannot hold comes back as an `ExactNumber`
  (`isExactNumber(v)`; convert with `toBigInt` or `toNumber`). Use `stringify` from this package
  to write such values back.
- Do not expect `parse<T>()`: there is no type parameter by design.
- Do not drain `feed()` with a discarded spread (`[...p.feed(c)];`): webpack's minifier drops it.
  Use `for (const _ of p.feed(c));`.
- `__proto__` and other dangerous keys are kept as plain data by default. Set
  `onDangerousKey: "drop"` or `"reject"` if your code merges results into other objects.
