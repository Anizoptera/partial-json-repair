// SPDX-License-Identifier: Apache-2.0

import { decodedFragments } from "../src/index";

/**
 * Option objects are exact: a key the verb does not take fails to compile, whether it is written
 * inline beside a valid key or passed in a variable.
 *
 * Compiled by `bun run typecheck`, never executed. A generic options parameter skips TypeScript's
 * excess-property check, so before `Exact` these misspellings compiled and failed only at run time.
 * Every rejected call sits beside an accepted one, so the assertion fails if the types widen AND if
 * they tighten past what a caller may write.
 */
import type {
  ExactNumber,
  ParserOptions,
  StopSignal,
  SourceFragment,
  SourceFragmentsFeature,
} from "../src/index";
import { auto, initAsyncParser, parseAsync, cooperative } from "../src/async";
import { createMetrics } from "../src/metrics";
import {
  createStreamParser,
  findJsonSpan,
  initParser,
  parse,
  parseMany,
  diagnostics,
  locations,
  parseStream,
  repair,
  select,
  sourceFragments,
  skip,
  stringify,
  tryParsers,
} from "../src/index";
import { repairAsync as configuredRepairAsync } from "../src/async";
import { sharedView, ownedView } from "../src/index";

declare const text: string;
declare const chunks: AsyncIterable<string>;
declare const signal: StopSignal;
declare const dynamic: boolean;
declare const exactNumber: ExactNumber;

exactNumber.toNumber();
exactNumber.toNumber({ allowRounding: true });
declare const maybeRounding: { allowRounding?: boolean } | undefined;
exactNumber.toNumber(maybeRounding);
const misspeltRounding = { allowRounding: true, allowRoundng: true };
// @ts-expect-error -- conversion helpers reject unknown keys through variables too.
exactNumber.toNumber(misspeltRounding);
declare const unionRounding: { allowRounding: boolean } | typeof misspeltRounding;
// @ts-expect-error -- a wider branch cannot hide a misspelled conversion option.
exactNumber.toNumber(unionRounding);
exactNumber.toBigInt({ maxDigits: 100 });
const misspeltDigits = { maxDigits: 100, maxDgits: 100 };
// @ts-expect-error -- a misspelled expansion bound must not be ignored.
exactNumber.toBigInt(misspeltDigits);

const closing = parseStream(chunks);
void closing.close();
void closing.close({ signal });
const badClose = { signal, singal: signal };
// @ts-expect-error -- a misspelled close bound must not stop delivery.
void closing.close(badClose);
declare const unionClose: { signal: StopSignal } | typeof badClose;
// @ts-expect-error -- cancellation settings must keep every union member's keys.
void closing.close(unionClose);

stringify({}, { maxOutput: 10 });
const badEncoding = { maxOutput: 10, maxOuput: 5 };
// @ts-expect-error -- helper variables must reject misspelled options too.
stringify({}, badEncoding);
declare const unionEncoding: { maxOutput: number } | typeof badEncoding;
// @ts-expect-error -- encoding settings must keep every union member's keys.
stringify({}, unionEncoding);
tryParsers(text, [JSON.parse]);
tryParsers(text, [() => 1 as const], { isResult: (value) => value === 1 });
declare const maybeAcceptance: { isResult?: (value: 1) => boolean } | undefined;
tryParsers(text, [() => 1 as const], maybeAcceptance);
const badAcceptance = { isResult: (value: unknown) => value !== undefined, isResut: true };
// @ts-expect-error -- forwarded acceptance settings must reject misspelled keys too.
tryParsers(text, [JSON.parse], badAcceptance);
declare const unionAcceptance: { isResult: (value: unknown) => boolean } | typeof badAcceptance;
// @ts-expect-error -- a valid predicate branch cannot hide an unknown option in another branch.
tryParsers(text, [JSON.parse], unionAcceptance);
select([], { fragments: false });
// @ts-expect-error -- decoded delivery requires its imported implementation, never a Boolean switch.
select([], { fragments: true });
const badSelection = { fragments: false, occurrnces: true } as const;
// @ts-expect-error -- a misspelled setting must not be silently discarded.
select([], badSelection);
declare const unionSelectionSettings:
  | { fragments: false | typeof decodedFragments }
  | typeof badSelection;
// @ts-expect-error -- selection settings must inspect keys beyond the union's shared keys.
select([], unionSelectionSettings);
diagnostics({ maxEntries: 10 });
const badReport = { maxEntries: 10, maxEntris: 5 };
// @ts-expect-error -- report settings reject misspelled keys through variables too.
diagnostics(badReport);
declare const unionReport: { maxEntries: number } | typeof badReport;
// @ts-expect-error -- report settings must inspect every union member.
diagnostics(unionReport);
createStreamParser({ select: select([], { fragments: decodedFragments }) });
// @ts-expect-error -- fragments retain no value for a view.
createStreamParser({ select: select([], { fragments: decodedFragments }), view: sharedView });
const fragmentSelection = select([], { fragments: decodedFragments });
declare const unionFragmentView:
  | { select: typeof fragmentSelection }
  | { select: typeof fragmentSelection; view: typeof sharedView };
// @ts-expect-error -- an omitted-view branch cannot hide a branch requesting unavailable values.
createStreamParser(unionFragmentView);
const sourceParser = createStreamParser({ select: select([], { fragments: sourceFragments }) });
declare const selectionSettings:
  | { fragments: SourceFragmentsFeature | typeof decodedFragments }
  | { occurrences: true };
const unionSelection = select([], selectionSettings);
const sourceMode: typeof unionSelection.fragments = sourceFragments;
const matchMode: typeof unionSelection.fragments = false;
const decodedMode: typeof unionSelection.fragments = true;
void sourceMode;
void matchMode;
void decodedMode;
for (const item of sourceParser.feed(text))
  if (item.ok) {
    const fragment: SourceFragment = item.value;
    if (fragment.kind === "end") void fragment.scalar;
  }
// @ts-expect-error -- source fragments retain no recovered value for a view.
createStreamParser({ select: select([], { fragments: sourceFragments }), view: sharedView });
// @ts-expect-error -- source delivery is available only on stream verbs.
parse(text, { select: select([], { fragments: sourceFragments }) });
const maybeLocated = parse(text, { locations: dynamic ? locations : false });
if (maybeLocated.ok) {
  const span = maybeLocated.span;
  void span;
}

// Whole-input verbs: a valid key alone, a typo beside it, and the same typo through a variable.
parse(text, { maxDepth: 3 });
// @ts-expect-error -- `allowComent` is not an option.
parse(text, { allowComent: true, maxDepth: 3 });
const valid = { allowComments: true, maxDepth: 3 };
parse(text, valid);
const misspelt = { allowComent: true, maxDepth: 3 };
// @ts-expect-error -- the variable carries a key the verb does not take.
parse(text, misspelt);
// A variable sharing NO key with the options: inference falls back to the constraint, so only the
// weak-type check can refuse it.
const foreign = { allowComent: true };
// @ts-expect-error -- every key is foreign.
parse(text, foreign);
// @ts-expect-error -- the same through a parser.
initParser(foreign);
// @ts-expect-error -- `view` belongs to streams.
parse(text, { view: sharedView });
parseMany(text, { maxDepth: 3 });
// @ts-expect-error -- `allowComent` is not an option.
parseMany(text, { allowComent: true, maxDepth: 3 });
repair(text, { maxDepth: 3 });
// @ts-expect-error -- `allowComent` is not an option.
repair(text, { allowComent: true, maxDepth: 3 });
findJsonSpan(text, { maxDepth: 3 });
// @ts-expect-error -- `allowComent` is not an option.
findJsonSpan(text, { allowComent: true, maxDepth: 3 });
void parseAsync(text, { maxDepth: 3, execution: cooperative });
// @ts-expect-error -- `allowComent` is not an option.
void parseAsync(text, { execution: auto, allowComent: true, maxDepth: 3 });
// @ts-expect-error -- a recovery kind that does not exist.
parse(text, { recover: { "trailing-coma": false } });
// The `recover` map is exact too: a misspelt kind beside a valid one, inline and in a variable.
const recovered = { maxDepth: 3, recover: { "trailing-comma": false, "single-quote": true } };
parse(text, recovered);
parse(text, { recover: { "trailing-comma": false, "single-quote": true } });
// @ts-expect-error -- `trailing-coma` is not a recovery kind.
parse(text, { recover: { "trailing-coma": false, "single-quote": true } });
const misspeltKind = { maxDepth: 3, recover: { "trailing-coma": false, "single-quote": true } };
// @ts-expect-error -- the variable carries a kind that does not exist.
parse(text, misspeltKind);
declare const unionRecover:
  | { maxDepth: number; recover: { "single-quote": boolean } }
  | typeof misspeltKind;
// @ts-expect-error -- a valid recovery map must not hide another branch's misspelled kind.
parse(text, unionRecover);
declare const nestedRecover: { recover: typeof recovered.recover | typeof misspeltKind.recover };
// @ts-expect-error -- unions inside the recovery map obey the same closed vocabulary.
initParser(nestedRecover);

// Every whole-input verb accepts an options value that may be absent.
declare const maybe: ParserOptions | undefined;
parse(text, maybe);
parseMany(text, maybe);
repair(text, maybe);
findJsonSpan(text, maybe);

// Constructors.
const parser = initParser({ maxDepth: 3 });
// @ts-expect-error -- `allowComent` is not an option.
initParser({ allowComent: true, maxDepth: 3 });
createStreamParser({ view: sharedView, maxDepth: 3 });
// @ts-expect-error -- `veiw` is not an option.
createStreamParser({ veiw: "shared", maxDepth: 3 });
createMetrics({ maxDepth: 3 });
// @ts-expect-error -- `allowComent` is not an option.
createMetrics({ allowComent: true, maxDepth: 3 });

// Per-call overrides on a parser, including the omitted form.
parse(text, parser, undefined);
parse(text, parser, { maxDepth: 4 });
// @ts-expect-error -- `allowComent` is not an option.
parse(text, parser, { allowComent: true, maxDepth: 4 });

// The async parser holds the same line, at construction and per call.
const asyncParser = initAsyncParser({ ...valid, execution: auto });
// @ts-expect-error -- the variable carries a key the async parser does not take.
initAsyncParser(misspelt);
void parseAsync(text, asyncParser, undefined);
void parseAsync(text, asyncParser, { maxDepth: 4, execution: cooperative, signal });
// @ts-expect-error -- the variable carries a key the call does not take.
void parseAsync(text, asyncParser, misspelt);
void configuredRepairAsync(text, asyncParser, valid);
// @ts-expect-error -- `allowComent` is not an option.
void configuredRepairAsync(text, asyncParser, { allowComent: true, maxDepth: 4 });

// A parser's streams take the stream-only options, and `parseStream` a signal too.
createStreamParser(parser, { view: ownedView });
// @ts-expect-error -- parse options are fixed once the parser is built.
createStreamParser(parser, { view: ownedView, maxDepth: 4 });
parseStream(chunks, parser, { view: sharedView, signal });
// @ts-expect-error -- `veiw` is not an option.
parseStream(chunks, parser, { veiw: "shared", signal });
parseStream(chunks, { maxDepth: 3, signal });
// @ts-expect-error -- `allowComent` is not an option.
parseStream(chunks, { allowComent: true, signal });

// Optional features are imported values: each valid spelling beside the boolean it replaced.
parse(text, { diagnostics, locations, select: select([["a"]]), skip: skip([["b"]]) });
parse(text, { diagnostics: diagnostics({ maxEntries: 10, scope: "all" }) });
parse(text, { diagnostics: false, locations: false, select: false, skip: false });
// @ts-expect-error -- a feature is the imported value, never `true`.
parse(text, { diagnostics: true });
// @ts-expect-error -- a feature is the imported value, never `true`.
parse(text, { locations: true });
// @ts-expect-error -- a selection is `select(paths)`, never the bare path list.
parse(text, { select: [["a"]] });
// @ts-expect-error -- `occurrences` is a `select` setting now.
parse(text, { select: select([["a"]]), occurrences: true });
// A fragments selection is for the stream verbs only.
createStreamParser({ select: select([["a"]], { fragments: decodedFragments }) });
parseStream(chunks, { select: select([["a"]], { fragments: decodedFragments }) });
// @ts-expect-error -- whole-input verbs return whole results, never pieces.
parse(text, { select: select([["a"]], { fragments: decodedFragments }) });
// @ts-expect-error -- `fragments` is a `select` setting now.
createStreamParser({ select: select([["a"]]), fragments: true });
