// SPDX-License-Identifier: Apache-2.0

import { decodedFragments } from "../src/index";

/**
 * Calls a consumer must NOT be able to write, held by the compiler rather than by a runtime test.
 *
 * Compile against source and packed declarations; never execute this fixture. Each expected-error
 * directive requires a compiler diagnostic; valid neighbors constrain accidental rejection too.
 * Runtime behavior needs separate execution. These cases constrain requested reports, locations
 * and outcome narrowing.
 */
import type { StreamParser, Match, SelectFeature } from "../src/index";
import type { AbortedFailure, SchedulingFailure } from "../src/async";
import {
  auto,
  initAsyncParser,
  parseAsync,
  parseManyAsync,
  repairAsync,
  findJsonSpanAsync,
} from "../src/async";
import {
  createStreamParser,
  createMetrics,
  initParser,
  parse,
  parseStream,
  repair,
  tryParsers,
  diagnostics,
  locations,
  select,
} from "../src/index";
import {
  findJsonSpan as configuredFindJsonSpan,
  parseMany as configuredParseMany,
} from "../src/index";
import { ownedView, sharedView } from "../src/index";

declare const text: string;
declare const dynamic: boolean;

// Different option keys in each union member still change the runtime result shape.
declare const unionOptions:
  | { select: SelectFeature<false>; diagnostics: typeof diagnostics; locations: typeof locations }
  | { maxDepth: number };
const unionRepaired = repair(text, unionOptions);
const unionOverride = repair(text, initParser(unionOptions), { maxScalar: 10 });
for (const outcome of [unionRepaired, unionOverride]) {
  void outcome.diagnostics?.repairs;
  if (outcome.ok) {
    void outcome.span?.start;
    const possible: string | readonly Match<string>[] = outcome.value;
    void possible;
  }
}
if (unionRepaired.ok) {
  // @ts-expect-error -- one branch selects matches rather than returning whole text.
  const textOnly: string = unionRepaired.value;
  void textOnly;
}
if (unionOverride.ok) {
  // @ts-expect-error -- overriding an unrelated option preserves the selected branch.
  const textOnly: string = unionOverride.value;
  void textOnly;
}
declare const unionStream: { summary: true; view: typeof ownedView } | { maxDepth: number };
const conditionalStream = createStreamParser(unionStream);
void conditionalStream.snapshot?.();
for (const item of conditionalStream.feed(text)) {
  // @ts-expect-error -- the configured union may request a terminal summary.
  void item.ok;
  if ("kind" in item) void item.roots;
}
declare const unionControls: { summary: true } | { view: typeof ownedView };
void parseStream([text], unionStream).snapshot?.();
void createStreamParser(initParser(), unionControls).snapshot?.();
void parseStream([text], initParser(), unionControls).snapshot?.();
declare const unionMetrics: { select: SelectFeature<false> } | { maxDepth: number };
void createMetrics(unionMetrics);
void createStreamParser(createMetrics(), unionControls).snapshot?.();
void parseStream([text], createMetrics(), unionControls).snapshot?.();
void initAsyncParser({ ...unionOptions, execution: auto });
void parseAsync(text, initAsyncParser({ execution: auto }), unionOptions);
void parseManyAsync(text, initAsyncParser({ execution: auto }), unionOptions);
void repairAsync(text, initAsyncParser({ execution: auto }), unionOptions);
void findJsonSpanAsync(text, initAsyncParser({ execution: auto }), unionOptions);
declare const maybeUnion: typeof unionOptions | undefined;
declare const maybeStream: typeof unionStream | undefined;
void parse(text, initParser(maybeUnion)).diagnostics?.repairs;
// @ts-expect-error -- an async parser names its execution strategy; omitting the options omits it.
void initAsyncParser(maybeUnion);
void createStreamParser(maybeStream).snapshot?.();
void parseStream([text], maybeStream).snapshot?.();
for (const item of createStreamParser(undefined).feed(text)) void item.ok;
declare const invalidUnion: { maxDepth: number } | { maxScalar: number; maxDepht: number };
// @ts-expect-error -- a valid branch cannot hide a misspelling in another branch.
void initParser(invalidUnion);
// @ts-expect-error -- the same constraint applies to the stream constructor.
void createStreamParser(invalidUnion);
declare const overlappingInvalidUnion:
  | { maxDepth: number }
  | { maxDepth: number; maxDepht: number };
// @ts-expect-error -- a broader valid branch cannot erase a narrower branch's unknown key.
void initParser(overlappingInvalidUnion);
// @ts-expect-error -- stream construction must inspect every union member too.
void createStreamParser(overlappingInvalidUnion);
// @ts-expect-error -- pull streams must not infer away the unknown key.
void parseStream([text], overlappingInvalidUnion);
// @ts-expect-error -- metric scopes validate the same option vocabulary.
void createMetrics(overlappingInvalidUnion);
// @ts-expect-error -- async configuration keeps the same rejection.
void initAsyncParser(overlappingInvalidUnion);
// @ts-expect-error -- required whole-input options reject overlapping invalid unions.
void parse(text, overlappingInvalidUnion);
// @ts-expect-error -- configured overrides must preserve every invalid union branch.
void parse(text, initParser(), overlappingInvalidUnion);
// @ts-expect-error -- repair uses the same exact configured-override contract.
void repair(text, initParser(), overlappingInvalidUnion);
// @ts-expect-error -- configured calls must not fall back to optional-overload inference.
void parseAsync(text, initAsyncParser({ execution: auto }), overlappingInvalidUnion);
// @ts-expect-error -- free async parsing must not infer away an invalid branch.
void parseAsync(text, overlappingInvalidUnion);
// @ts-expect-error -- lazy async parsing validates the same options before returning its iterator.
void parseManyAsync(text, overlappingInvalidUnion);
// @ts-expect-error -- repair must preserve the same option rejection.
void repairAsync(text, overlappingInvalidUnion);
// @ts-expect-error -- span search must preserve the same option rejection.
void findJsonSpanAsync(text, overlappingInvalidUnion);
declare const invalidStreamUnion: { summary: true } | { summary: true; summray: true };
// @ts-expect-error -- reusable parser stream settings keep every supplied key.
void createStreamParser(initParser(), invalidStreamUnion);
// @ts-expect-error -- the pull variant enforces the same stream setting keys.
void parseStream([text], initParser(), invalidStreamUnion);
// @ts-expect-error -- metrics' manual stream wrapper must preserve the rejection.
void createStreamParser(createMetrics(), invalidStreamUnion);
// @ts-expect-error -- metrics' pull stream wrapper must preserve the rejection.
void parseStream([text], createMetrics(), invalidStreamUnion);

// Check both directions: Promise results stay excluded, and valid synchronous literals stay usable.
declare const expectedFallback: 1 | "value";
const fallback = tryParsers(text, [
  () => 1 as const,
  () => "value" as const,
  async () => 2 as const,
]);
if (fallback.ok) {
  const value: typeof expectedFallback = fallback.value;
  const accepted: typeof fallback.value = expectedFallback;
  void value;
  void accepted;
}

// Overrides replace literals rather than intersecting true with false. The same configured parser
// keeps its original shape on the next call.
const configured = initParser({ diagnostics, locations, select: select([["a"]]) });
{
  const plainReport = parse(text, configured, { diagnostics: false, locations: false });
  // @ts-expect-error -- this call explicitly disabled reports.
  void plainReport.diagnostics;
  if (plainReport.ok) {
    void plainReport.value[0]?.path;
    // @ts-expect-error -- this call explicitly disabled locations.
    void plainReport.span;
  }
  void parse(text, configured).diagnostics.repairs;
  void parse(text, configured, undefined).diagnostics.repairs;
  void repair(text, configured, { maxDepth: 0 }).diagnostics.repairs;
  void configuredFindJsonSpan(text, configured, { maxDepth: 0 }).diagnostics.repairs;
  for (const item of configuredParseMany(text, configured, { maxDepth: 0 })) {
    void item.diagnostics.repairs;
    if (item.ok) void item.value.path;
  }
  const optional: { diagnostics?: false } = {};
  // @ts-expect-error -- an optional override can retain the base report or disable it.
  void parse(text, configured, optional).diagnostics.repairs;
  // @ts-expect-error -- this runtime choice can disable the base report.
  void parse(text, configured, { diagnostics: dynamic ? diagnostics : false }).diagnostics.repairs;
}
const unconfigured = initParser();
{
  void parse(text, unconfigured, { diagnostics }).diagnostics.repairs;
  const selectedCall = repair(text, unconfigured, { select: select([["a"]]) });
  if (selectedCall.ok) void selectedCall.value[0]?.path;
  const locatedCall = parse(text, unconfigured, { locations });
  if (locatedCall.ok) void locatedCall.span.start.offset;
  // @ts-expect-error -- invalid option type, even on a reusable parser.
  void parse(text, unconfigured, { maxDepth: "one" });
}

// The async parser types its results from its own options, like `initParser`.
const configuredAsync = initAsyncParser({ execution: auto, diagnostics, select: select([["a"]]) });
void (async () => {
  const found = await parseAsync(text, configuredAsync);
  void found.diagnostics.repairs;
  if (found.ok) void found.value[0]?.path;
  const plain = await parseAsync(text, configuredAsync, { diagnostics: false });
  // @ts-expect-error -- this call explicitly disabled reports.
  void plain.diagnostics;
  const bare = await parseAsync(text, initAsyncParser({ execution: auto }));
  for (const item of await Promise.all([
    parseManyAsync(text, { execution: auto }).next(),
    parseManyAsync(text, configuredAsync).next(),
  ])) {
    if (item.done !== true && !item.value.ok && item.value.failure.kind === "cleanup-failed") {
      void item.value.failure.cause;
      // @ts-expect-error -- delivered values are not repeated inside terminal cleanup.
      void item.value.failure.completed;
    }
  }
  const completedParse = await parseAsync(text, {
    execution: auto,
    diagnostics,
    locations,
    select: select([["a"]]),
  });
  if (!completedParse.ok && completedParse.failure.kind === "cleanup-failed") {
    void completedParse.failure.completed.value[0]?.path;
    void completedParse.failure.completed.span.start.offset;
    void completedParse.failure.completed.diagnostics.repairs;
    // @ts-expect-error -- a completed operation is successful, never a second failure.
    void completedParse.failure.completed.failure;
  }
  for (const result of [
    await repairAsync(text, { execution: auto }),
    await repairAsync(text, configuredAsync, { select: false }),
  ]) {
    if (!result.ok && result.failure.kind === "cleanup-failed") {
      const repaired: string = result.failure.completed.value;
      void repaired;
    }
  }
  const completedSpan = await findJsonSpanAsync(text, { execution: auto });
  if (!completedSpan.ok && completedSpan.failure.kind === "cleanup-failed") {
    void completedSpan.failure.completed.value.start.offset;
    // @ts-expect-error -- a located span is not a recovered value with completion facts.
    void completedSpan.failure.completed.complete;
  }
  // @ts-expect-error -- `diagnostics` is absent from the type without the feature.
  void bare.diagnostics;
  if (!bare.ok && bare.failure.kind === "aborted") {
    const stopped: AbortedFailure = bare.failure;
    void stopped.recovered;
    void bare.failure.cleanupFailure;
  }
  if (!bare.ok && bare.failure.kind === "scheduling-failed") {
    const stopped: SchedulingFailure = bare.failure;
    void stopped.cause;
    void stopped.recovered;
    void bare.failure.cleanupFailure;
  }
  // A stopped stream exposes the same useful recovery as a stopped whole-input call.
  for await (const item of parseStream([text])) {
    if (!item.ok && item.failure.kind === "aborted") {
      const recovered: AbortedFailure["recovered"] = item.failure.recovered;
      void recovered;
      void item.failure.cleanupFailure;
    }
  }
})();

// Without the option there is no report: reading one is a compile error, not `undefined`.
// @ts-expect-error -- `diagnostics` is absent from the type, not optional.
void parse(text).diagnostics;
// @ts-expect-error -- `span` needs `locations`.
void parse(text, { diagnostics }).span;

// Requesting diagnostics makes the report required on every outcome.
void parse(text, { diagnostics }).diagnostics.repairs;
void repair(text, { diagnostics }).diagnostics.confidence;

// A value only known at run time makes the report optional, so an unguarded read is an error.
// @ts-expect-error -- possibly `undefined`.
void parse(text, { diagnostics: dynamic ? diagnostics : false }).diagnostics.repairs;

// Data lives on one branch and the reason on the other; neither is reachable without `ok`.
const r = parse(text, { locations });
// @ts-expect-error -- `value` exists only when `ok` is `true`.
void r.value;
// @ts-expect-error -- `failure` exists only when `ok` is `false`.
void r.failure;
if (r.ok) void r.span.start.offset;
else void r.failure.kind;

// Constructors return the object itself; invalid options throw (HLD), so there is no envelope.
const built = createStreamParser();
// @ts-expect-error -- a constructor result is not a `Result`.
void built.ok;
// @ts-expect-error -- nor for a parser.
void initParser().ok;
{
  const sp: StreamParser = built;
  for (const item of sp.feed(text)) if (!("kind" in item) && item.ok) void item.value;
  // Without `summary: true` no item is a summary, so `ok` needs no guard.
  for (const item of built.feed(text)) void item.ok;
  // @ts-expect-error -- no `view`, no `snapshot`.
  void built.snapshot;
}

// A view is declared when the stream is built, and only then is there a `snapshot` to call.
const viewed = createStreamParser({ view: sharedView });
{
  const seen = viewed.snapshot();
  if (seen.ok) {
    // `cut` exists exactly when `complete` is false, so narrowing on `complete` reaches it.
    if (seen.value?.complete === false) void seen.value.cut.path;
  } else void seen.failure.recovered;
}

// With `summary: true` an item may be the summary, so `ok` must wait for the `kind` check.
const summarised = createStreamParser({ summary: true });
{
  for (const item of summarised.feed(text)) {
    // @ts-expect-error -- a summary has no `ok`.
    void item.ok;
    if ("kind" in item) void item.roots;
  }
}

// Selection switches the VALUE, so a caller who passed `select` gets matches and cannot read the
// document off the result — the thing the runtime cannot tell them until it is too late.
const selected = parse(text, { select: select([["a"]]) });
if (selected.ok) {
  void selected.value[0]?.path;
  // @ts-expect-error -- matches are an array; there is no whole document to read.
  void selected.value.a;
}

// `fragments` changes what the stream yields, and forbids the view in the type as well as at run
// time, so the incompatible pair cannot be written at all.
const fragmented = createStreamParser({ select: select([["a"]], { fragments: decodedFragments }) });
{
  for (const item of fragmented.feed(text)) if (item.ok) void item.value.kind;
  // @ts-expect-error -- no `view`, no `snapshot`, fragments or not.
  void fragmented.snapshot;
}

// Every failure union admits `failure.recovered?.value` without an `in` guard: members that never
// recover declare `recovered?: undefined`, so the read is total and narrows to `Recovery`.
async function recoveredReads(source: AsyncIterable<string>): Promise<unknown[]> {
  const read: unknown[] = [];
  const whole = parse(text);
  if (!whole.ok) read.push(whole.failure.recovered?.value);
  const repaired = repair(text);
  if (!repaired.ok) read.push(repaired.failure.recovered?.value);
  const many = configuredParseMany(text);
  for (const item of many) if (!item.ok) read.push(item.failure.recovered?.value);
  const stream = parseStream(source);
  for await (const item of stream) if (!item.ok) read.push(item.failure.recovered?.value);
  const asyncWhole = await parseAsync(text, { execution: auto });
  if (!asyncWhole.ok) read.push(asyncWhole.failure.recovered?.value);
  const asyncRepair = await repairAsync(text, { execution: auto });
  if (!asyncRepair.ok) read.push(asyncRepair.failure.recovered?.value);
  const asyncSpan = await findJsonSpanAsync(text, { execution: auto });
  if (!asyncSpan.ok) read.push(asyncSpan.failure.recovered?.value);
  const span = configuredFindJsonSpan(text);
  if (!span.ok) read.push(span.failure.recovered?.value);
  return read;
}
void recoveredReads;

// HLD P4: only single-value verbs say a later value exists; `parseMany` delivers every value.
async function laterValueFlag(input: string): Promise<(true | undefined)[]> {
  const flags: (true | undefined)[] = [];
  const parsed = parse(input);
  if (parsed.ok) flags.push(parsed.more);
  const repaired = repair(input);
  if (repaired.ok) flags.push(repaired.more);
  const span = configuredFindJsonSpan(input);
  if (span.ok) flags.push(span.more);
  const asyncParsed = await parseAsync(input, { execution: auto });
  if (asyncParsed.ok) flags.push(asyncParsed.more);
  for (const item of configuredParseMany(input))
    // @ts-expect-error -- parseMany delivers every value, so no item has a later one to announce.
    if (item.ok) void item.more;
  if (parsed.ok) {
    // @ts-expect-error -- the flag is present only as `true`; absence means no later value.
    const never: false | undefined = parsed.more;
    void never;
  }
  return flags;
}
void laterValueFlag;
