# partial-json-repair

[![npm version](https://img.shields.io/npm/v/partial-json-repair?label=npm)](https://www.npmjs.com/package/partial-json-repair) [![CI](https://github.com/Anizoptera/partial-json-repair/actions/workflows/check.yml/badge.svg?branch=main)](../../actions/workflows/check.yml) [![Runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)](package.json) [![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json) [![Bun](https://img.shields.io/badge/bun-latest-FBF0DF?logo=bun&logoColor=FBF0DF)](docs/PRIOR-ART.md) [![Deno](https://img.shields.io/badge/deno-latest-70FFAF?logo=deno&logoColor=white)](docs/PRIOR-ART.md) [![Browsers](https://img.shields.io/badge/browsers-WebKit_%C2%B7_Chromium-4285F4)](docs/PRIOR-ART.md) [![Cloudflare Workers](https://img.shields.io/badge/edge-workerd-F38020?logo=cloudflare&logoColor=white)](docs/PRIOR-ART.md) [![TypeScript 6 | 7](https://img.shields.io/badge/TypeScript-6_%7C_7-3178C6?logo=typescript&logoColor=white)](docs/PRIOR-ART.md) [![License](https://img.shields.io/github/license/Anizoptera/partial-json-repair)](LICENSE)

**The fastest and most efficient JSON repairer, and the only one with full streaming support.**

Get usable values out of broken, cut-off or streaming JSON from LLMs, and know exactly what was
fixed and where the reply was cut.

- **Fastest, lightest repairer.** On clean input it runs at two thirds of `JSON.parse`, 1.6 to 6
  times faster than the other repair libraries. On JSON with comments and trailing commas it beats
  every parser measured, the JSONC specialists included. It uses no more memory than `JSON.parse`;
  on Bun, `jsonrepair` and `repair-json-stream` use half as much again.
- **A cut reply never passes for a finished one.** Every value says whether it is `complete` and,
  if not, where it was `cut`. The six repair libraries compared in
  [docs/PRIOR-ART.md](docs/PRIOR-ART.md) return a half reply exactly as they return a whole one.
- **Reads what models write.** JSON inside prose or a code fence, cut off, with comments, single
  quotes, unquoted keys, trailing commas or `NaN`, while a sentence like `see [1]` is never taken
  for data. Of the 15 parsers in the capability table, it is the only one that handles every row.
  When the model sends a corrected answer below the first, the result says `more: true`.
- **Every repair is a switch.** Turn any repair on or off per call with `recover` (dangerous keys
  such as `__proto__` have `onDangerousKey`). The defaults are tuned for broken model output.
  Readings that can drop source text stay off until you ask: `guessed-string-end` can cut a `}` off
  a code value, and `leading-zero-number` turns `0123` into 123, losing the zero. See
  [Options and presets](#options-and-presets).
- **Reports what it changed, when you ask.** Every repair and loss with its path, plus a confidence
  score for deciding when to retry the model. A stray trailing comma costs no confidence; a
  missing ending does.
- **Full streaming support.** Show the value as it arrives, act on each value the moment it
  closes, or take a huge string in pieces without holding it. No other repair library hands you
  values from a stream; with them you re-parse the whole buffer on every chunk. At 16-character
  chunks this is 4 to 10 times faster than that re-parsing, which is what the OpenAI and Anthropic
  SDKs' partial parsers do.
- **The same value however it arrives.** Text or bytes, one chunk or any split, synchronous or
  async: you get what parsing the whole text at once gives.
- **Never throws for bad input.** Every failure is a typed value carrying whatever was recovered.

Zero runtime dependencies. One ESM build runs in browsers, Node, Bun, Deno and edge runtimes: the
root entry imports nothing platform-specific, and `/async` loads `node:worker_threads` only when it
starts a worker. You pay only for what you import: a bundle that uses just `parse` carries no
report, selector, streaming or live-view code. Types are checked against TypeScript 6 and 7 in CI.

## Install

```sh
bun add partial-json-repair     # or: npm i / pnpm add partial-json-repair, deno add npm:partial-json-repair
```

The same library is also published as
[`@anizoptera/recover-json`](https://www.npmjs.com/package/@anizoptera/recover-json), at the same
version and with both entries (`@anizoptera/recover-json` and `@anizoptera/recover-json/async`).
Install whichever name you prefer; the examples below use `partial-json-repair`.

Coding agents: read the [usage guide for agents](CONSUMER-AGENTS.md), installed with the package
as `dist/AGENTS.md`.

The repository also holds a Rust port; it is not in this package. The full API contract is in
`docs/API.md`.

## The problem

A model returns this, and the connection drops:

```
Here you go: {"name": "Ada", "tags": ["x", "y
```

`JSON.parse` throws. So do four of the six repair libraries compared in
[docs/PRIOR-ART.md](docs/PRIOR-ART.md), on the prose in front; a fifth returns `"Here"`. Strip the
prose and all six return `{ name: "Ada", tags: ["x", "y"] }` and nothing else, so a reply cut in
half looks exactly like a finished one. This package returns the value **and** says it was cut, and
where:

```ts
import { parse } from "partial-json-repair";

const r = parse('Here you go: {"name": "Ada", "tags": ["x", "y');
if (!r.ok) throw new Error(r.failure.kind); // ok: true here: a cut-off reply is still a value

r.value; // { name: "Ada", tags: ["x", "y"] }
r.complete; // false: the source ended before the value did
r.cut; // { path: ["tags", 1], kind: "string" }: the string at tags[1] was still arriving
```

Recovered values and repaired text carry `complete`, and `cut` whenever `complete` is false. The value
itself is never changed to show the cut: nothing is appended unless you ask for it with `cutSuffix`.

`parse`, `repair` and `findJsonSpan` return one value. When the text holds another after it, as when
a model sends a corrected version below its first answer, the result says so with `more: true`;
`parseMany` reads them all:

```ts
import { parse, parseMany } from "partial-json-repair";

const reply = '{"total": 12}\n\nSorry, that was wrong:\n\n{"total": 21}';
const first = parse(reply); // { ok: true, value: { total: 12 }, complete: true, more: true }
if (first.ok && first.more) for (const r of parseMany(reply)) if (r.ok) console.log(r.value);
```

Ask for a report and you also get every repair, with the path to where it happened:

```ts
import { diagnostics, parse } from "partial-json-repair";

const r = parse('{"name": "Ada", "tags": ["x", "y', { diagnostics });
r.diagnostics.confidence; // 0.729
r.diagnostics.repairs.map((x) => [x.kind, x.at.offset, x.path]);
// [ ["unclosed-string", 30, ["tags", 1]],
//   ["unclosed-array",  32, ["tags", 2]],
//   ["unclosed-object", 32, []] ]
```

The report lists every change and loss in `repairs`, each with its path. If a report limit leaves
entries out, `entriesComplete` is false. Without `diagnostics` nothing is collected, and the result
type has no `diagnostics` field.

## Jobs

### Parse one model reply

`parse(text)` returns the first value in the text: inside prose, inside a code fence, cut off, with
comments, single quotes, unquoted keys or trailing commas.

```ts
import { parse } from "partial-json-repair";

const r = parse(modelOutput);
if (!r.ok) {
  if (r.failure.recovered !== undefined) {
    useValue(r.failure.recovered.value); // inspect the prefix; failure still requires a decision
  }
  handleFailure(r.failure); // "no-json-found", "policy-refused", "limit-reached", ...
} else if (!r.complete) {
  // The reply was cut. r.value holds the available recovery;
  // r.cut names the item that was cut and what kind of thing it was.
  useValue(r.value);
} else {
  useValue(r.value);
}
```

`ok` says recovery succeeded; `complete` says the source finished that value. Neither checks your
application schema: validate or narrow `value` before passing it to code that expects your types.

What `cut.kind` tells you:

| `kind` | Meaning | Example source | `cut` |
| --- | --- | --- | --- |
| `string` | A string, quoted or bare, was still arriving; the value holds every character written so far | `{"msg": "hello wor` | `{ path: ["msg"], kind: "string" }` |
| `number` | A number was cut where it is already valid; it may be short | `[1, 12` | `{ path: [1], kind: "number" }` |
| `missing` | The item at `path` was started but is not in the value | `[1, tru` | `{ path: [1], kind: "missing", text: "tru" }` |
| `between` | The source ended between items of the container at `path`; nothing written was dropped. A complete literal (`[1, true`) counts as finished | `{"a":1,"ke` | `{ path: [], kind: "between", text: '"ke' }` |

`text` holds the unfinished token the value leaves out (a partial word or number, a half escape, a
partial key), and is absent when there is none. A key the source had not finished is never
invented: `{"a":1,"ke` gives `between` at the object, not a member called `ke`. A cut-off number,
`true` or escape is never placed in the value as something it is not: `[1, 1e` recovers `[1]` with
`kind: "missing"`, and `"x\u00` recovers `"x"` with the half escape in `cut.text`.

To show the cut in the text itself, opt into a suffix on cut strings. It is appended only to a
string whose `kind` is `string`, never to a number, and never to an item that is missing:

```ts
import { parse } from "partial-json-repair";

const r = parse('{"msg": "hello wor', { cutSuffix: true });
if (r.ok) r.value; // { msg: "hello wor…" }

const custom = parse('{"msg": "hello wor', { cutSuffix: " [cut]" });
if (custom.ok) custom.value; // { msg: "hello wor [cut]" }
```

`true` appends `…` (U+2026). The same suffix appears in `parse`, in a stream's final value, in a
snapshot and in `repair()` text, so every route shows the same thing.

### Repair JSON text

`repair(text)` applies the same repairs to the _text_, for JSON that has to be handed to
something else: a log, another service, a schema validator.

```ts
import { repair } from "partial-json-repair";

const fixed = repair("{'a': 1, // note\n b: 2,}");
if (fixed.ok) fixed.value; // '{"a": 1, \n "b": 2}'
```

It splices the repairs into your source rather than re-serialising the value, so **a value that
needed no repair comes back byte-identical**: key order, number formatting and whitespace intact.
`JSON.stringify(parse(t).value)` would quietly turn `1.50` into `1.5`. What comes back is the
**value**, not the document: repairing ` ```json\n{"a":1}\n``` ` produces `{"a":1}`, without the
fences. On success the output parses under strict `JSON.parse`. `repair` fails exactly when `parse`
fails. A recovered value JSON cannot spell (`NaN`, an infinity, `undefined`) is written as `null`,
keeping its key or array position, and reported as `js-literal`; `parse` returns the real value.
`repair` results carry `complete` and `cut` like `parse` results.

### Locate JSON in a reply

`findJsonSpan(text)` gives its extent in the source, and the `locations`
feature puts the same `span` on every successful `parse` and `repair` result, so
`text.slice(0, span.start.offset)` and `text.slice(span.end.offset)` are the prose around it:

```ts
import { findJsonSpan, locations, parse } from "partial-json-repair";

const span = findJsonSpan('here you go: {"a":1} hope that helps');
if (span.ok) span.value; // { start: { offset: 13, unit: "utf16" }, end: { offset: 20, unit: "utf16" } }

const located = parse('here you go: {"a":1} hope that helps', { locations });
if (located.ok) located.span.start.offset; // 13
```

Span results report source boundaries. Use `parse(text, { locations })` when you also need the
recovered value's `complete` and `cut`.

### Render a reply while it streams

Rendering a model's JSON as it arrives needs the stream and a **view** of the value still being
written. Declare the view when the stream is built, then pull a snapshot once per frame you draw:

```ts
import { parseStream, sharedView } from "partial-json-repair";

const stop = new AbortController();
const stream = parseStream(chunks, { view: sharedView, signal: stop.signal });
let frameFailure: { cause: unknown } | undefined;

let frame = requestAnimationFrame(function draw() {
  try {
    const seen = stream.snapshot(); // the root still arriving, or the one just finished
    if (seen.ok && seen.value !== undefined) render(seen.value.value);
    frame = requestAnimationFrame(draw);
  } catch (cause) {
    // A frame runs outside the consuming loop; stop its pending read too.
    frameFailure = { cause };
    stop.abort(cause);
  }
});

try {
  for await (const result of stream) {
    if (frameFailure !== undefined) throw frameFailure.cause;
    if (result.ok) render(result.value); // a finished root
    else {
      if (result.failure.recovered !== undefined) {
        render(result.failure.recovered.value);
      }
      handleFailure(result.failure);
    }
  }
} finally {
  cancelAnimationFrame(frame);
}
```

A snapshot is `{ value, valueIndex, complete, cut? }`. `complete` is the root's finality, not the
source's end: a finished root stays in the snapshot, with `complete: true`, until the next root
begins. `cut` names the point still being written, which is where a renderer puts its cursor. A
refused or stopped root is a failure with the view under `failure.recovered`.

**Pull per frame, never per chunk.** Each pull copies the containers still open, so pulling after
every chunk of a growing array costs quadratic time, while pulling per frame costs one copy per
frame however fast chunks arrive. Under `shared`, two pulls with no input
between them return the same object.

`shared` copies only the containers still open and shares every finished branch: **O(depth + width
of the open containers), not O(size)**. Finished branches are frozen because they are shared, and so
is every value such a stream delivers. Treat a `shared` snapshot as read-only: the copy of the open
containers is left unfrozen only because freezing it costs too much per frame, and a change you make
to it shows in every later pull until new input arrives, since those pulls return the same object.
Changed paths get fresh identity and untouched branches keep theirs, so a framework re-renders
exactly what moved. `owned` is a deep copy you may keep and modify, costing the whole tree each time.
The live tree is never handed out.

Both views include the **string still arriving**: after `{"key": "val` you get `{ key: "val" }`.
Numbers and bare words are not shown while they arrive, because `1` of `123` is a different number
and `tr` of `true` is not a value; a half-read key is left out for the same reason.

**Owning the chunks yourself**, for a WebSocket, an SDK callback or a test, is `createStreamParser`:

```ts
import { createStreamParser, ownedView } from "partial-json-repair";

const sp = createStreamParser({ view: ownedView });

for (const result of sp.feed('{"title": "Hel')) handleResult(result); // nothing finished yet
let seen = sp.snapshot();
if (seen.ok) seen.value?.value; // { title: "Hel" }; seen.value?.cut is { path: ["title"], kind: "string" }
for (const result of sp.feed('lo", "items": [1,2')) handleResult(result);
seen = sp.snapshot();
if (seen.ok) seen.value?.value; // { title: "Hello", items: [1] }: the 2 may still grow

for (const done of sp.end()) {
  if (done.ok) done.value; // { title: "Hello", items: [1, 2] }
  if (done.ok) done.cut; // { path: ["items", 1], kind: "number" }: the input ended inside the array
}
```

`feed` and `end` return lazy iterators: the chunk is taken at the call and scanned as you pull. Read
what they return: every completed value is delivered exactly once, by the first iteration after it
completes. A root completes when the character after it arrives, because a comma touching it
would make it the first item of a list (`{"a":1},{"b":2}` reads as one array): a root followed by
anything inside its chunk comes from that `feed()`, and one that ends the chunk comes from the next
`feed()` or from `end()`. End each document with a line break (as JSONL does) to have it delivered
at once by its own `feed()`. `end()` delivers only what the end of input finished, such as the
cut-off root above. If you skip reading one `feed()`, the next iteration you read delivers the
skipped values first. Held values count toward `maxRetained`; past it the stream ends with
`limit-reached` naming `unread`, so a caller that reads only the view gets an error, not a memory
leak.

### Stream an agent's tool call

A tool call arrives as JSON arguments in pieces. Preview closed arguments, or process a huge
argument (a file, a document) without holding it.

**Which argument is still arriving.** `cut.path` names the unfinished source occurrence; a closed
occurrence can still be replaced by a later duplicate key or ancestor. Use previews for display;
wait for the completed root before acting on final arguments:

```ts
import { createStreamParser, sharedView } from "partial-json-repair";

const args = createStreamParser({ view: sharedView });
for (const result of args.feed('{"city": "Paris", "units": "metr')) handleResult(result);

const seen = args.snapshot();
if (seen.ok && seen.value !== undefined) {
  const { value, cut } = seen.value;
  const cityClosed = cut === undefined || cut.path[0] !== "city"; // true: "Paris" is closed
  const unitsClosed = cut === undefined || cut.path[0] !== "units"; // false: still arriving
  if (cityClosed) render(value); // preview; a later "city" may replace "Paris"
  void unitsClosed;
}
```

The same test at any depth identifies the occurrence currently being extended, not final membership.
Paths hold array indexes as numbers, so `["items", 0]` matches and `["items", "0"]`
never does:

```ts
import type { Cut, SourcePath } from "partial-json-repair";

const isOpen = (path: SourcePath, cut: Cut | undefined): boolean =>
  cut !== undefined && path.length <= cut.path.length && path.every((k, i) => k === cut.path[i]);
```

To receive each closed source occurrence rather than test paths, select the items with
`select([["items", ANY]], { occurrences: true })`: each one is delivered once, when it closes.
Use default selection when later duplicate keys must settle before acting on final values.

**A reply the model's token limit cut off.** Do not call `end()`. Request the continuation and feed
it to the same parser: the stream resumes inside the open string, key or container as if the reply
had never paused.

**A huge text argument, in pieces.** Select the field and ask for `fragments`: quoted strings arrive as
`start`, `data` and `end` items without retaining the whole string. Unquoted strings also stream once
their text cannot become a literal; trailing whitespace stays pending. Numeric and literal candidates
buffer until their recovered type and spelling settle.

Fragments describe source occurrences, including ones a later duplicate key or ancestor replaces.
Use them for previews or processing that accepts every occurrence. For final tool arguments, use
default selection and validate the completed root before acting; a fragment's `end` does not
establish final membership.

```ts
import { createStreamParser, decodedFragments, select } from "partial-json-repair";

const call = createStreamParser({ select: select([["content"]], { fragments: decodedFragments }) });

const write = (items: ReturnType<typeof call.end>): void => {
  for (const item of items) {
    if (item.ok && item.value.kind === "data") process.stdout.write(item.value.text);
    else if (!item.ok) handleFailure(item.failure);
  }
};
write(call.feed('{"path": "a.txt", "content": "hello wo'));
write(call.feed('rld"}'));
write(call.end()); // a string the input cut off ends here, so read `data` from `end()` too
// writes "hello world"; `start` named path ["content"] and scalar "string", `end` its source span
```

`start` opens an occurrence and names its path and scalar kind, `data` carries a piece of the decoded
content, and `end` closes it with the source span and `complete`, which is `false` when the input cut
the value off. Where the pieces split is internal batching, not part of the contract. String pieces
join to the decoded content, number and literal pieces to their spelling; a surrogate pair is never
split between pieces. With `cutSuffix`, the last `data` piece of a string the input cut off carries
the suffix. Fragments cannot be combined with a view, since a view would be the whole value you
asked not to keep. Selecting a container in this mode fails that root with `non-scalar-selection`:
select its scalar children instead.

### Read JSONL and multi-document output

`parseMany(text)` yields every JSON value in the text, lazily: JSONL, several documents in one
reply, or values scattered through prose. It suspends after each value, so consuming only the first
parses only the first. `parse` returns the first value and sets `more: true` when another follows;
with `diagnostics`, its report's `laterValues` also holds the span of every later value.

```ts
import { parseMany } from "partial-json-repair";

for (const r of parseMany('{"a":1}\n{"b":2}\n{"c":3}')) {
  if (r.ok) useValue(r.value); // {a:1}, then {b:2}, then {c:3}
  else handleFailure(r.failure);
}
```

A value whose source shows no colon, no quoted string inside brackets and no second item (`1`, `"a"`,
`[1]`) counts as JSON only when it stands alone, fills a code fence, or sits in a run of values
separated by line breaks. Among other text it is declined, because prose cites `[1] [2]` and quotes
`"a"`: `parseMany("[1]\n[2]")` reads both arrays, while `parseMany("see [1] [2]")` answers
`no-json-found`. For JSONL whose lines may be cut off, parse each line:
`text.split("\n").filter(Boolean).map((line) => parse(line))`. The newline is JSONL's own record
boundary, so a line cut inside a string stays one damaged record; `parseMany` cannot know that
boundary and reads the next line as the string's continuation. A line that holds no JSON at all
(`not json`) is prose between values, so both verbs pass over it without an item, and a damaged line
is repaired like any other value. Over the network, `parseStream` recognises the same roots, but
chunk boundaries are not line boundaries: for cut-off JSONL, assemble complete lines and `parse`
each. For marked roots such as objects, `parseStream` yields each value as soon as it closes, and a
root the policy refuses (a single quote under `recover: { "single-quote": false }`, say) fails alone
while the next one parses. Under `STRICT` the first refusal ends the scan instead:

```ts
import { parseStream } from "partial-json-repair";

for await (const r of parseStream(response.body!, { objectOnly: true })) {
  if (r.ok) handle(r.value);
  else handleFailure(r.failure); // a refused line; limits and source failures end the stream
}
```

`objectOnly` skips roots that are not objects; `requiredKeys: ["id"]` also requires own keys.

### Recipes: AI SDK, OpenAI, Anthropic

Each recipe hands the SDK's text deltas to `parseStream` or `feed`. Its function types the SDK
object only by the fields it reads, so it accepts the SDK's own types; the SDK call that produces
that object follows it.

**AI SDK (`streamText`).** `textStream` is an async iterable of text deltas:

```ts
import { parseStream, sharedView } from "partial-json-repair";

export async function showReply(result: { textStream: AsyncIterable<string> }): Promise<unknown> {
  const stop = new AbortController();
  const stream = parseStream(result.textStream, { view: sharedView, signal: stop.signal });
  let frameFailure: { cause: unknown } | undefined;
  let frame = requestAnimationFrame(function draw() {
    try {
      const seen = stream.snapshot();
      if (seen.ok && seen.value !== undefined) render(seen.value.value);
      frame = requestAnimationFrame(draw);
    } catch (cause) {
      // Frame callbacks run outside the consuming loop; stop its pending read too.
      frameFailure = { cause };
      stop.abort(cause);
    }
  });
  let last: unknown;
  try {
    for await (const r of stream) {
      if (frameFailure !== undefined) throw frameFailure.cause;
      if (r.ok) {
        last = r.value;
        render(r.value); // completion may arrive before the next preview frame
      }
      else {
        // Earlier completed roots stay rendered, but do not make a failed stream successful.
        last = undefined;
        // The last recoverable prefix may arrive after the final preview frame.
        if (r.failure.recovered !== undefined) {
          render(r.failure.recovered.value);
        }
        handleFailure(r.failure);
      }
    }
  } finally {
    // Stop scheduled previews even when stream consumption or failure handling throws.
    cancelAnimationFrame(frame);
  }
  return last;
}
```

<!-- not-compiled -->
```ts
import { streamText } from "ai";
const result = streamText({ model, prompt: "Reply with a JSON object describing ..." });
await showReply(result);
```

Tool-call arguments in the AI SDK arrive on `fullStream` as `tool-input-delta` parts, one stream per
tool-call `id`. Pass that ID with every outcome so the handler can route interleaved calls:

```ts
import { createStreamParser } from "partial-json-repair";

/** What a recipe needs from a stream parser: `createStreamParser()` returns one. */
type Feedable = Pick<ReturnType<typeof createStreamParser>, "feed" | "end" | "close">;

export async function toolArguments(
  fullStream: AsyncIterable<{ type: string; id?: string; delta?: string }>,
): Promise<void> {
  const calls = new Map<string, Feedable>();
  try {
    for await (const part of fullStream) {
      if (part.type !== "tool-input-delta" || part.id === undefined || part.delta === undefined) continue;
      let call = calls.get(part.id);
      if (call === undefined) calls.set(part.id, (call = createStreamParser()));
      for (const r of call.feed(part.delta)) handleResult(r, part.id);
    }
    for (const [id, call] of calls) for (const r of call.end()) handleResult(r, id);
  } finally {
    // Handler and source failures must release unfinished parser buffers too.
    for (const call of calls.values()) call.close();
  }
}
```

**OpenAI (Chat Completions with `stream: true`).** Text is in `choices[0].delta.content`:

```ts
import { parseStream } from "partial-json-repair";

async function* deltas(
  chunks: AsyncIterable<{ choices: { delta: { content?: string | null } }[] }>,
): AsyncGenerator<string> {
  for await (const chunk of chunks) {
    const text = chunk.choices[0]?.delta.content;
    if (text) yield text;
  }
}

export async function readReply(
  completion: AsyncIterable<{ choices: { delta: { content?: string | null } }[] }>,
): Promise<void> {
  for await (const r of parseStream(deltas(completion))) {
    if (r.ok) useValue(r.value);
    else handleFailure(r.failure);
  }
}
```

<!-- not-compiled -->
```ts
import OpenAI from "openai";
const client = new OpenAI();
const completion = await client.chat.completions.create({ model, messages, stream: true });
await readReply(completion);
```

With the Responses API, the same text arrives as `response.output_text.delta` events (`event.delta`),
and tool-call arguments as `response.function_call_arguments.delta` events keyed by `item_id`.

**Anthropic (Messages streaming).** Text arrives as `content_block_delta` events with a `text_delta`;
a tool call's input arrives as `input_json_delta` pieces (`partial_json`), one content block per
`index`. Pass the block index with every outcome so the handler can identify its source:

```ts
import { createStreamParser } from "partial-json-repair";

/** What a recipe needs from a stream parser: `createStreamParser()` returns one. */
type Feedable = Pick<ReturnType<typeof createStreamParser>, "feed" | "end" | "close">;

export async function readMessage(
  events: AsyncIterable<{ type: string; index?: number; delta?: object }>,
): Promise<void> {
  const blocks = new Map<number, Feedable>();
  try {
    for await (const event of events) {
      if (event.type !== "content_block_delta" || event.index === undefined || !event.delta) continue;
      const piece =
        "text" in event.delta ? event.delta.text
        : "partial_json" in event.delta ? event.delta.partial_json
        : undefined;
      if (typeof piece !== "string") continue;
      let block = blocks.get(event.index);
      if (block === undefined) blocks.set(event.index, (block = createStreamParser()));
      for (const r of block.feed(piece)) handleResult(r, event.index);
    }
    for (const [index, block] of blocks) for (const r of block.end()) handleResult(r, index);
  } finally {
    // Handler and source failures must release unfinished parser buffers too.
    for (const block of blocks.values()) block.close();
  }
}
```

<!-- not-compiled -->
```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const stream = client.messages.stream({ model, max_tokens: maxTokens, messages, tools });
await readMessage(stream);
```

Without `eager_input_streaming: true` on the tool definition, the API buffers and validates each
parameter value before streaming it, so a large argument arrives only once it is finished. With it,
fragments arrive as Claude writes them, without server-side JSON validation (Anthropic, "Fine-grained
tool streaming", read 2026-10-04), which is why `complete` and `cut` matter here: run a tool only on
a completed root whose `complete` is true and whose arguments pass your application validation.

## Optional features are imports

Four features cost code that most calls do not need, so each is a value you import and pass under
its option key. What you do not import is not in your bundle.

| Feature | Pass | What it adds |
| --- | --- | --- |
| Report | `{ diagnostics }` or `{ diagnostics: diagnostics({ maxEntries, scope }) }` | `diagnostics` on every result: repairs, errors, counts, confidence |
| Source spans | `{ locations }` | `span` on every successful value |
| Selection | `{ select: select(paths, { occurrences, fragments }) }` | Matches instead of whole values; see Selection |
| Skipping | `{ skip: skip(paths) }` | Named object members are not built |

```ts
import { ANY, diagnostics, locations, parse, select, skip } from "partial-json-repair";

parse(text); // nothing optional in the bundle
parse(text, { diagnostics }); // report and confidence
parse(text, { diagnostics: diagnostics({ maxEntries: 100, scope: "all" }) });
parse(text, { locations }); // spans, no report
parse(text, { select: select([["items", ANY]], { occurrences: true }) });
parse(text, { skip: skip([["debug"]]) }); // works without select
```

Settings travel with their feature: `maxEntries` (default 1000) caps the entries one report retains,
and `scope: "all"` audits skipped and unselected content too. Passing `true` where a feature belongs
(`{ diagnostics: true }`) is a compile error, and at run time a `TypeError` whose message names the
import to use. Everything is exported from `partial-json-repair`, plus the async verbs from
`partial-json-repair/async`.

## What you get back

One shape, discriminated on `ok`. Status lives outside the data, so `{"ok":false}` parses to a
success holding that object, and a failure never has a `value` to mistake for one:

<!-- not-compiled -->
```ts
type Result<T, F> = { ok: true; value: T } | { ok: false; failure: F };

// Recovered values and repaired text also carry:
type Completion = {
  complete: boolean; // false when the source ended before the value did
  cut?: Cut; // present exactly when complete is false
};
type Cut = {
  path: readonly (string | number)[];
  kind: "string" | "number" | "missing" | "between";
  text?: string; // the unfinished token the value leaves out
};

// With the `diagnostics` feature, on BOTH branches; a failure still reports what it read.
type Diagnostics = {
  repairs: readonly Repair[]; // what was altered, and where
  errors: readonly ParseError[]; // what was refused, and where
  counts: { repairs: number; errors: number }; // totals, even past `maxEntries`
  entriesComplete: boolean; // false when the cap left some entries out
  scanComplete: boolean; // false when a limit stopped the scanner early
  scope: "all" | "selected"; // under `select`, what the entries cover
  confidence: number; // 0..1, from every repair, stored or not
  laterValues: readonly { start: Position; end: Position }[]; // values after the one returned
};

// Text input counts UTF-16 code units; byte input counts bytes. In a stream, `chunk` is the index
// of the chunk fed and `offset` counts from its start, in that chunk's unit.
type Position = { offset: number; unit: "utf16" | "byte"; chunk?: number };
```

When a refusal, resource limit, source failure or cancellation retains partial data,
`failure.recovered` carries its `value`, `complete` and any `cut`. The call remains failed;
inspect that recovery before deciding whether to retry.

If a single-result async operation succeeds and then fails to clean up, `failure.completed` holds
its successful outcome, including requested reports and locations. That is the verb's own output:
repaired text from `repair`, a span from `findJsonSpan`, not a recovered value. The call itself
remains failed.
An independent cleanup failure beside an earlier failure is `failure.cleanupFailure`; inspect the
primary failure and its recovery first.

**Branch on typed tags, never error messages.** Failures and report entries carry literal `kind`
tags. An exhaustive switch can detect an unhandled case at compile time.

The exported `RepairKind` and `ErrorKind` types describe report entries; each verb's result type
defines its failures and their fields. Read the [canonical type definitions](src/types.ts), rather
than copying a tag list into your application. For runtime repair names, use the keys of the
exported `REPAIR_PENALTY` table. Narrow a result on `ok`, then its failure on `kind`.

There is no `message` field to read. English is a formatter's job, at the edge of your application.

**Nothing throws for anything the input did.** Finding no JSON is a value, not an exception:

```ts
import { parse } from "partial-json-repair";

parse("no json here at all");
// { ok: false, failure: { kind: "no-json-found" } }
```

**Invalid options throw before input is read**, because they are a bug in the calling code, not
an outcome to handle. `initParser`, `createStreamParser` and every verb given options throw a
`TypeError` before reading any input; its `cause` is the typed reason
(`{ kind: "invalid-options", field, reason }`) for callers that load options at run time.
Promise-returning async verbs reject with it; `parseManyAsync` throws when the iterator is created,
before its first pull. The option types are exact: a misspelt key is a compile error, inline or in a
variable.

Normal iteration reports cleanup failures as `cleanup-failed` outcomes. Explicit iterator disposal
can reject with a cleanup cause; `iterator.throw(cause)` also rejects with the consumer's cause,
combined with any cleanup failure. Await those promises. `parseStream` provides `close()` when you
need a typed cleanup result instead.

The value is `unknown`. There is no `parse<T>()`: a type parameter there would be an assertion
dressed as a check, and real validation belongs to a validator you already have.

## Confidence

`confidence` scores every repair in the requested scope, including entries omitted by `maxEntries`:
`∏ (1 - penalty(kind))`. Many small repairs decay rather than clipping at zero.

It is a heuristic about recovery changes, not the probability that the data is correct. Successful
recovery does not validate an application schema; narrow or validate `value` before using it.

- **1.0**: nothing was guessed.
- **< 0.7**: consider retrying the model.
- **< 0.5**: likely garbled.

**Formatting repairs cost nothing.** A trailing comma, a single quote or a comment tells you the
model was sloppy, not that the data is uncertain. Closing an unfinished string or container lowers
the score because its ending was missing; recovery preserves the available content rather than
guessing the missing text or members.

```ts
import { diagnostics, parse } from "partial-json-repair";

const r = parse("{'a': 1, // note\n b: 2,}", { diagnostics });
r.diagnostics.repairs.map((x) => x.kind);
// ["single-quote", "comment-removed", "unquoted-key", "trailing-comma"]
r.diagnostics.confidence; // 0.97
```

The penalty table is exported as `REPAIR_PENALTY`, and `confidenceOf(repairs)` scores the repairs
you pass with it, so you can score a subset or explain a number to a user. It matches `confidence`
only while the report stored every repair: past `maxEntries` the report still scores the repairs it
does not store.

## Selection

`select` names the parts you want, `skip` names the parts you do not. Both take a list of paths, and
a path is a list of keys and indexes: nothing to escape, no query language to learn, and the compiler
checks it.

```ts
import { ANY, ANY_DEPTH, parse, select } from "partial-json-repair";

const doc = '{"items":[{"id":1,"name":"a"},{"id":2,"name":"b"}],"meta":{"id":9}}';

const names = parse(doc, { select: select([["items", ANY, "name"]]) });
if (names.ok) names.value.map((m) => [m.value, m.path]);
// [["a", ["items", 0, "name"]], ["b", ["items", 1, "name"]]]

const ids = parse(doc, { select: select([[ANY_DEPTH, "id"]]) });
if (ids.ok) ids.value.map((m) => m.path);
// [["items", 0, "id"], ["items", 1, "id"], ["meta", "id"]]
```

`ANY` matches one key or index and `ANY_DEPTH` matches zero or more, so `[[ANY_DEPTH, "id"]]` finds
every `id` wherever it turns up. `[]` as a path selects the root; `select([])` selects nothing.

**You get matches, not a trimmed document.** Each carries its `value`, the `path` it came from, its
source `span` and the indexes of the `selectors` that hit it. `repair` gives each match its own
repaired text, `findJsonSpan` its span, and `parseMany` and the streams deliver matches one at a time
with the root's `valueIndex`. Matches arrive in source order with an ancestor before its descendants;
with `occurrences: true` each arrives when it closes, so a descendant comes before its ancestor.

**`skip` is the one that trims**, because removing an object member invents no holes:

```ts
import { parse, skip } from "partial-json-repair";

const trimmed = parse('{"text":"hi","embedding":[0.1,0.2,0.3]}', { skip: skip([["embedding"]]) });
if (trimmed.ok) trimmed.value; // { text: "hi" }
```

A skip path may not end in a wildcard or an index, so it can never target an array element; that is
checked when `skip(...)` is called. Where `select` and `skip` overlap, **skip wins**.

**Selection omits unrelated branches from the recovered tree.** The scanner still reads excluded
content to enforce policies and find selected values. Token decoding and parser state can allocate
temporary storage; selection does not promise zero allocations for excluded content.

By default a match is the **final** value at its path: a later duplicate member replaces everything
matched beneath the earlier one, so matches are held until their ancestors close.
`select(paths, { occurrences: true })` delivers each source occurrence as it closes instead: earlier,
and worth it in a stream, at the price that an occurrence need not survive into the final object.
`fragments: decodedFragments` (streams only) implies occurrences. Import the delivery capability so
ordinary selection does not retain fragment delivery code.

Diagnostics follow the same scope. With `select`, a report covers the matches and the recovery it
took to find them, and says so in `scope: "selected"`; `diagnostics({ scope: "all" })` audits the
skipped content too. Skipping itself is never reported: you wrote the selector, and one entry per
skipped member would grow without bound on exactly the input skipping exists to make cheap.

## Streaming details

`parseStream` takes an async iterable, a plain iterable, or a web `ReadableStream`, of `string` or
`Uint8Array` chunks, and yields per-value results as they complete. It takes an abort signal:

```ts
import { parseStream } from "partial-json-repair";

for await (const result of parseStream(source, { signal: controller.signal })) {
  if (result.ok) render(result.value);
  else {
    if (result.failure.recovered !== undefined) {
      render(result.failure.recovered.value);
    }
    handleFailure(result.failure);
  }
}
```

Cancellation stops further reads and parsing of the chunk already in hand, and requests cancellation
of a pending web read. An `aborted` failure carries the signal's reason and available recovery;
an earlier source failure or terminal parser failure stays primary. With `summary: true`, the summary
follows the failure. A source that throws yields a `source-failed` item carrying the original cause
and any recoverable prefix in `recovered`, instead of throwing through the iterator.

**Node streams**: pass a `Readable` directly, or compose it through the platform's `Duplex.from`:

```ts
import { Duplex } from "node:stream";
import { parseStream } from "partial-json-repair";

res
  .pipe(Duplex.from((src: AsyncIterable<Buffer>) => parseStream(src)))
  .on("data", (result) => handleResult(result));
```

**Web streams**: where available, `ReadableStream.from(parseStream(source))` gives a stream of
items with the same values and cancellation. `parseStream` also reads native Web streams directly,
including `Response.body`, `Request.body`, `Bun.file(path).stream()` and `TransformStream.readable`;
no intermediate text decoder or Node/Web conversion is required.

**Older Bun compatibility:** on Bun 1.3.14, a native `Readable.toWeb()` → `Readable.fromWeb()`
round-trip reordered one-byte chunks with `highWaterMark: 1`, without this library involved.
Pass the Node `Readable` directly or use a native Web source on that release. It also lacks
`ReadableStream.from`; use the standard `ReadableStream` constructor when an output bridge is needed.
Its native full-duplex HTTP bridge also truncated an upload sent through repeated one-byte
`node:http` writes into a pull-based Web response, without this library involved. Sending the
remaining upload with `end(bytes)` preserved it; Bun 1.4.4 preserved both forms. Avoid that old
HTTP bridge pattern rather than adding a parser workaround.

**Leaving and closing.** A `break` out of the loop requests the source's cleanup and does not wait
for it, so a producer that never answers cannot hang you. When you need the acknowledgement,
`await stream.close()`: it stops delivery, shares one cleanup attempt across every call, and answers
`{ ok: true }` or a `cleanup-failed` failure carrying what the source threw. `close({ signal })`
bounds the wait, and an abandoned wait answers `aborted` rather than claiming the source released. A
source that finishes normally and then refuses to be released ends the stream with a
`cleanup-failed` item; one that fails mid-stream carries a later cleanup failure beside its own
cause as `cleanupFailure`, never instead of it. On a manual stream, leaving a `feed()` iteration
early with `break` closes the stream; `close()` is idempotent and always succeeds, since it holds no
source.

With `summary: true` the last item of the stream is `{ kind: "summary", complete, roots, matches,
unmatched }`: whether the whole source was examined, and how many roots were recognised, refused
ones included. A summary has `kind` and no `ok`, so `"kind" in item` tells it from a result.

**Feed bytes, not text.** `feed` and `parseStream` accept `Uint8Array` as well as `string`, and own
the incremental decode. Decoding each chunk independently can corrupt a multi-byte character split
across chunks. A stream may mix text and byte chunks, and every reported position names its `chunk`
and counts from that chunk's start in its own unit.

Every one-shot verb also takes a `Uint8Array`. Bytes are decoded once, inside the parser, and every
position then counts in bytes; a malformed sequence becomes U+FFFD and is reported as `invalid-utf8`
at its bytes. A UTF-8 byte-order mark is removed, with a `bom-removed` repair that costs no
confidence, and a UTF-16 or UTF-32 mark fails with `unsupported-encoding` naming the encoding.

## Reusing one configuration

Serving many calls or streams on one configuration? Validate it once:

```ts
import { createStreamParser, diagnostics, initParser, parseStream, sharedView } from "partial-json-repair";

const parser = initParser({ diagnostics }); // once, at startup; bad options throw here

for await (const result of parseStream(request.body!, parser)) {
  if (result.ok) handle(result.value);
  else handleFailure(result.failure);
}

const sp = createStreamParser(parser, { view: sharedView }); // per stream
for (const result of sp.feed('{"title": "Hel')) handleResult(result);
```

`parse(input, parser, options?)`, `parseMany`, `repair` and `findJsonSpan` accept per-call options.
Supplied fields replace the configured ones (a field set to `undefined` keeps the configured value),
and calls without overrides reuse the validated settings. `createStreamParser(parser, options?)` and
`parseStream(source, parser, options?)` take only the stream options (`view`, `summary`, and
`signal` on `parseStream`); a parse option there is refused, never ignored.
`close()` releases the parser; later calls answer `parser-closed`.

## Whole-input async work

Import whole-input async calls from `partial-json-repair/async` when the caller must stay responsive
or cancel work already in progress. The result shape matches the synchronous verb, including partial
recovery under an `aborted` failure. Features are passed the same way.

```ts
import { auto, parseAsync } from "partial-json-repair/async";

const result = await parseAsync(modelOutput, { execution: auto });
if (result.ok) useValue(result.value);
else {
  if (result.failure.recovered !== undefined) {
    useValue(result.failure.recovered.value);
  }
  handleFailure(result.failure);
}
```

Pass `{ signal: controller.signal }` when the caller can cancel the operation.

**Every async call names where it runs.** The strategy is a value imported from
`partial-json-repair/async`, and an app ships only the strategies it imports. A default would be
referenced by every call, so every app would carry its engine; that is why `execution` is required.

| Strategy | Runs | Use it when |
| --- | --- | --- |
| `auto` | On the calling thread. Small input finishes inline; larger input runs in bounded slices that yield to the host task queue | The usual choice: responsive, cancellable, works on every host |
| `cooperative` | On the calling thread, yielding between slices at every size | Even small calls must let timers and cancellation callbacks run |
| `worker` | In a lazily started background worker, reused on Node, Bun and Deno, ended when idle in browsers | The scan must leave the main thread entirely |

An app that imports only `worker` ships no same-thread engine, and one that never imports `worker`
contains no worker code. Pages without shared memory cancel through messages, so cross-origin
isolation is not required. Nothing moves work to a worker automatically: worker startup and transfer
costs per host and workload are not yet measured. The choice is fixed before any input is read.

```ts
import { parseAsync, worker } from "partial-json-repair/async";

const result = await parseAsync(modelOutput, { execution: worker });
if (!result.ok && result.failure.kind === "execution-unavailable") {
  console.warn(result.failure.message); // what failed, why, and what to do
}
```

A wrong strategy is a bug at the call site, so it throws a `TypeError` before reading input. Its
message names the fix:

```text
partial-json-repair: option `execution` is required and takes an imported strategy, never a string or a copy: `import { auto } from "partial-json-repair/async"` and pass `{ execution: auto }` to run on this thread, `cooperative` to yield at every size, or `worker` for a background worker.
```

A worker that cannot run is an outcome, not an exception: `execution-unavailable` with a typed
`reason` to branch on and a `message` for logs. `reason: "unsupported"` means the host has no
`Worker` or `MessageChannel` (an edge runtime such as workerd), so pass `auto` there. `reason:
"failed"` means the worker did not start or stopped answering, usually because the bundle does not
deploy its file (see below). Both arrive before input is read unless the worker fails mid-call, and
then any recovered prefix comes with them.

The entry also exports `parseManyAsync`, `repairAsync`, `findJsonSpanAsync` and `initAsyncParser`,
which returns the parser directly.

If host-task scheduling fails, the call returns `scheduling-failed` with the original `cause` and
any available `recovered` value. Inspect that prefix and restore host scheduling before retrying;
stopped work does not silently restart on another route.

For a request or batch, put its cancellation signal on the reusable parser. A per-call signal
cancels only that sibling; it cannot override task cancellation. Both signals are observed, with the
first reason preserved. If both were already aborted, the task reason wins:

```ts
import { auto, initAsyncParser, parseAsync, repairAsync } from "partial-json-repair/async";

const task = new AbortController();
const sibling = new AbortController();
using parser = initAsyncParser({ execution: auto, signal: task.signal });
const first = parseAsync(modelOutput, parser, { signal: sibling.signal });
const second = repairAsync(modelOutput, parser);
sibling.abort("preview no longer needed"); // first only
const results = await Promise.all([first, second]);
for (const result of results) {
  if (result.ok) useValue(result.value);
  else handleFailure(result.failure);
}
task.abort("request finished"); // current and future operations on this parser
```

Closing the parser prevents new calls. Cancel its task to stop running calls; closing it does not
terminate a worker used by another parser.

**The worker in a bundled app.** Node, Bun and Deno load it from the package. In a browser build:

| Bundler | Worker |
| --- | --- |
| Vite, webpack, Rspack | Emitted and run with no setup |
| esbuild, Rolldown, `Bun.build` | Add the recipe below; without it a forced worker fails with `execution-unavailable` |

The recipe emits the lazy receiver `worker-executor` with the app's chunks and builds `async-worker`
on its own into the same directory. Keep the worker a separate build: as an entry of the app's build,
its engine lands in a chunk the app loads at startup (esbuild: 105 KB of startup JavaScript instead
of 20 KB), and the worker thread shares no module instances with the page anyway.

<!-- not-compiled -->
```ts
// esbuild (Rolldown takes the same maps as `input`, with entryFileNames: "[name].js")
const shared = { bundle: true, splitting: true, format: "esm", outdir: "dist" } as const;
await esbuild.build({
  ...shared,
  entryPoints: {
    main: "src/main.ts",
    "worker-executor": "node_modules/partial-json-repair/dist/worker-executor.js",
  },
});
await esbuild.build({
  ...shared,
  entryPoints: { "async-worker": "node_modules/partial-json-repair/dist/async-worker.js" },
});
// Bun.build keeps the package files' basenames as entry names.
const options = { outdir: "dist", splitting: true, naming: { entry: "[name].[ext]" } } as const;
await Bun.build({
  ...options,
  entrypoints: ["src/main.ts", "node_modules/partial-json-repair/dist/worker-executor.js"],
});
await Bun.build({ ...options, entrypoints: ["node_modules/partial-json-repair/dist/async-worker.js"] });
```

Cooperative execution needs no worker at all, so an app that skips the recipe loses only the
option to move the scan off the main thread.

## Exact numbers

**A number a double cannot hold stays exact.** `12345678901234567890`, `1e400` and `1e-400` come back
as an `ExactNumber` holding the source token, not as a rounded `number`, `Infinity` or `0`, and
nothing is reported, because nothing was changed. Identity is `isExactNumber(v)`, never a field
shape. Every conversion is checked:

```ts
import { isExactNumber, parse, stringify } from "partial-json-repair";

const r = parse('{"id": 12345678901234567890, "tiny": 1e-400}');
const id = r.ok ? (r.value as { id: unknown }).id : undefined;
if (isExactNumber(id)) {
  id.text; // "12345678901234567890"
  id.toBigInt({ maxDigits: 30 }); // { ok: true, value: 12345678901234567890n }
  id.toNumber(); // { ok: false, failure: { kind: "inexact" } }
  id.toNumber({ allowRounding: true }); // { ok: true, value: 12345678901234567000 }
  `${id}`; // "12345678901234567890": string conversion gives the exact token
  // Number(id) and id * 2 throw a TypeError instead of rounding silently.
}
if (r.ok) stringify(r.value); // { ok: true, value: '{"id":12345678901234567890,"tiny":1e-400}' }
```

`exactNumbers: true` makes EVERY number one, `0.1` included. `stringify(value, { maxOutput? })`
writes them back unquoted and refuses what JSON cannot spell (`undefined`, `NaN`, a cycle, a getter)
with a typed failure naming the path; it never calls `toJSON`.

## More helpers

`tryParsers` tries several data formats in order:

```ts
import { parse, tryParsers } from "partial-json-repair";

const result = tryParsers(source, [
  parseYaml,
  (text) => {
    const parsed = parse(text);
    if (!parsed.ok) throw new Error(parsed.failure.kind);
    return parsed.value;
  },
]);
```

Parsers run synchronously in caller order. Thrown parser errors and rejected values advance to the
next parser; Promise results, predicate errors and exhaustion stop with typed failures. The default
predicate accepts non-null objects, including arrays; pass `isResult` to accept another domain.

`createMetrics` is a caller-owned counting scope, so ordinary parsing carries no counters:

```ts
import { createMetrics, parse } from "partial-json-repair";

const measured = createMetrics({ onDangerousKey: "drop" });
parse('{id: 1, "__proto__": 2}', measured);
const snapshot = measured.read();
snapshot.repairs["unquoted-key"]; // 1
snapshot.security.dangerousKeysBlocked; // 1
measured.reset();
```

Every verb accepts the scope where it accepts an `initParser` handle, and counts what it returns:
`parseMany` items as you read them, and `parseStream(source, measured)` or
`createStreamParser(measured)` items plus retained-input peaks, compactions and buffer refusals. A
handle rather than methods, so a bundle keeps only the verbs it imports. `read(true)` returns a
detached snapshot and resets the interval in one call.

## Options and presets

Four presets, exported as constants rather than looked up by name, so the compiler checks them and a
bundler can drop the ones you do not use.

| Preset | What it is for |
| --- | --- |
| `LLM_BALANCED` | **The default.** Comments, single quotes, trailing commas, unquoted keys, JS literals |
| `LLM_FULL` | Maximum recovery: dangerous keys dropped as well |
| `STRICT` | Every leniency off; the first refusal fails the value and stops the scan |
| `COMPAT` | Legacy readings for migrating callers: `0123` as 123, a lone bare word as a string (see `docs/MIGRATION.md`) |

```ts
import { parse, STRICT } from "partial-json-repair";

parse("{'a': 1}", STRICT);
// { ok: false, failure: { kind: "policy-refused", issue: { kind: "unparsable-span", ... },
//                         recovered: { value: {}, complete: false, cut: { path: ["a"], kind: "missing" } } } }
// STRICT stops at the first refusal, so the recovered value says where reading stopped.
```

A leniency flag being off does not mean the construct is unrecognised: it is still consumed, and
reported as a refusal instead of a repair. That keeps the tree stable across presets, so tightening
a flag changes the verdict and the report rather than the data, which is still there as `recovered`.

`recover` names one repair kind and wins over the flag that would decide it, in both directions:

```ts
import { parse } from "partial-json-repair";

// This model never writes single quotes, so reading one is a guess about damage that is not there.
parse(`{"a": {'b': 1}}`, { recover: { "single-quote": false } });
// { ok: false, failure: { kind: "policy-refused", issue: { path: ["a"], ... },
//                         recovered: { value: { a: { b: 1 } }, complete: true } } }

parse('{"a": NaN}', { recover: { "js-literal": true } });
// { ok: true, value: { a: NaN }, complete: true }: the value the source spelled, which `repair()` writes as `null` and reports

// By default, a string missing its closing quote ends at a line break when a quoted key follows,
// or when the rest of the input is only closers the string did not open:
parse('{"a": "x\n "b": 1}');
// { ok: true, value: { a: "x", b: 1 }, complete: true }
parse('{"d": "unclosed\n}');
// { ok: true, value: { d: "unclosed" }, complete: true }
// A `}` that closes a `{` opened inside the string stays in it: models write code with raw line
// breaks, so that `}` is code. This opt-in ends the string there anyway, and at a comma or a
// bare-word key line:
parse('{"code": "f() {\n}', { recover: { "guessed-string-end": true } });
// { ok: true, value: { code: "f() {" }, complete: true }
```

The individual options, all optional:

| Option | Default | What it does |
| --- | --- | --- |
| `allowComments`, `allowSingleQuotes`, `allowTrailingComma`, `allowUnquotedKeys` | `true` | The four leniencies models need most |
| `allowJavaScript` | `true` | `undefined`, `NaN`, `Infinity`, hex/octal/binary numbers, `1_000` digit separators |
| `repairBroken` | `true` | Recover broken syntax; off refuses it without changing data |
| `recover` | from the flags | Override one repair kind, on or off, past the flag that decides it |
| `cutSuffix` | absent | `true` appends `…` to a cut string; a string appends that text |
| `diagnostics`, `locations`, `select`, `skip` | absent | Imported features; see above |
| `exactNumbers` | `false` | Every number as an `ExactNumber`, fractions included; numbers a double cannot hold are exact even when off |
| `builtinParsers` | `true` | `false` never hands input to `JSON.parse`, clean or rewritten from a cut-off reply — see Performance |
| `maxErrors` | `1000` | Refusals a value may accumulate before the scan stops |
| `maxBuffer`, `maxDepth`, `maxScalar` | `10 MB`, `512`, `1 KB` | Retained stream source, nesting and bare-root-scalar bounds |
| `maxRetained` | `maxBuffer` | What a stream holds while waiting: pending matches, banked string parts, unread values |
| `objectOnly`, `requiredKeys` | `false`, `[]` | Accept only object roots, with these own keys |
| `onDangerousKey` | `"keep"` | `keep`, `drop` or `reject` for `__proto__` and friends |
| `nullPrototype`, `customDangerousKeys` | `false`, `[]` | `Object.create(null)` objects: no pollution possible, but no `hasOwnProperty` or `toString` either; more keys to treat as dangerous |

Stream-only: `view` (imported `sharedView` or `ownedView`), `summary`, and `signal` on `parseStream`.

`maxBuffer` and `maxRetained` bound the **stream** parser only. You already hold the whole string
when you call `parse(text)`, and refusing to read the second half of it would be truncation dressed
as a resource bound. Exceeding any bound returns a `limit-reached` failure naming the resource, with
whatever was read as `recovered`; a stream that hit one answers `stream-closed` from then on.

## Prototype pollution

The six dangerous keys (`__proto__`, `constructor`, `__defineGetter__`, `__defineSetter__`,
`__lookupGetter__`, `__lookupSetter__`) are handled at the one point where a key enters the tree,
with `Object.defineProperty` rather than assignment.

```ts
import { diagnostics, LLM_FULL, parse } from "partial-json-repair";

const r = parse('{"__proto__": {"x":1}, "safe": 2}');
if (r.ok) {
  Object.keys(r.value as object); // ["__proto__", "safe"]: an ORDINARY own property, defined not assigned
  Object.getPrototypeOf(r.value as object) === Object.prototype; // true: no prototype was touched
}

parse('{"__proto__": {"x":1}, "safe": 2}', { ...LLM_FULL, diagnostics });
// value: { safe: 2 } — dropped, and reported: diagnostics.repairs = ["dangerous-key"]
```

The default is `keep`, which stores the key as **data**. `drop` removes it and reports a repair;
`reject` refuses the whole object and reports an error. All three keep safe siblings.

See [SECURITY.md](SECURITY.md) for the full threat model and how to report a problem.

## Performance

Clean input uses `JSON.parse` when that route can preserve the requested outcome. So does a reply
cut off mid-stream, or one holding comments or trailing commas: one pass appends the missing closers
or deletes the comments and commas, and `JSON.parse` reads the result, several times faster than
the recovery scanner and with the same value, `complete` and `cut`. A report, a selection, exact
numbers, null-prototype objects and a refused `duplicate-key` repair select the scanner, because
`JSON.parse` would erase information those calls require; `drop` or `reject` for dangerous keys
costs one substring scan before the fast route.

[The measured comparison](docs/PRIOR-ART.md) covers every runtime the package ships to: Node, Bun,
Deno, WebKit, Chromium and workerd. `bun run bench:baseline` reproduces the throughput matrix.

## Limitations

- **Recovery invents structure, and says so.** An unclosed string or object is closed, and a member
  whose value never arrived is dropped. On retained values, `complete` and `cut` identify source
  truncation; requested `diagnostics` explain recovery changes with paths. If you cannot tolerate
  invention, check `complete`, read the report and reject, or use `STRICT`.
- **A number or word still being read is not in a view; a string is.** A snapshot after
  `{"n": 12` shows `{}`, because `1` of `123` is a different number rather than a partial one. At
  the end of input a valid number stays, marked `kind: "number"`, because it may be short.
- **Fractions are doubles unless you ask.** `0.1` is the double `0.1`, as from `JSON.parse`; only an
  integer past 2^53, an overflow or an underflow is kept exact by default.
- **Duplicate keys are reported only when you ask for a report.** Last wins either way, as
  `JSON.parse` does.
- **Brackets inside a sentence are not JSON.** `see [1] for the citation` returns `no-json-found`,
  deliberately. A container standing alone or filling a fenced block is always a candidate; inside
  prose it must carry a colon, a quoted string, or more than one value.
- **`{{name}}` at a candidate root is a template, not JSON.** An opener in the root object's first
  key position rejects that candidate; nested openers remain recoverable.
- **A bare scalar counts when it stands alone, fills a code fence, or has a line of its own among
  other values.** `42` alone and each line of `1\n2` parse; the `42` in `answer is
  42, data: {"a":1}` does not, and you get the object. A lone unquoted word, or a lone token that is
  no number (`1..5`), is refused with the text in `recovered`, and so is text opened by an
  apostrophe that never closes (`'tis the season`); `COMPAT` reads either as a string.
- **Nesting is bounded at 512 levels** by default. Past it the value fails with `limit-reached` for
  the `depth` resource and carries what was read as `recovered`, never a stack overflow.
- **`parse()` is synchronous and does not yield.** For large input on a thread that must stay
  responsive, use `parseAsync` from `partial-json-repair/async`.
- **Under Terser 5.51.2 (webpack's default minifier), never drain `feed()` with a discarded
  spread.** Terser rewrites `[...parser.feed(chunk)];` into a bare call that never iterates, for any
  generator, so the chunk is never parsed. Read the items, or drain with
  `for (const _ of parser.feed(chunk));`.

## How this differs from the neighbours

`partial-json` and `best-effort-json-parser` complete truncated JSON but do not tell you that they
did, or where. `jsonrepair` repairs the text but hands you no diagnostics, and `json-repair-js` logs
only a missing colon, without a path; neither gives streaming snapshots. This package marks every
cut value and, on request, reports every change with its path. None of them lets you turn off
one repair: `jsonrepair`, `untruncate-json` and `best-effort-json-parser` take no options,
`json-repair-js`'s options set output format and logging, `repair-json-stream` only reports its
repairs to a callback, and `partial-json`'s `Allow` flags choose which value types may be cut
short. Here each repair kind is a switch.

**[docs/PRIOR-ART.md](docs/PRIOR-ART.md)** measures every one of them against this one: capability,
agreement over the whole conformance corpus, JSONTestSuite strictness, speed, size and peak memory,
including the runtimes' own parsers, each figure with its runtime and the command that reproduces
it. Reach for `JSON.parse` when your input is supposed to be valid; reach for this when it is not,
and when you need to know what changed.

## Licence

Apache-2.0.
