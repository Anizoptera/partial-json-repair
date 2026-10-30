// SPDX-License-Identifier: Apache-2.0

/** Drive the scalar WASM boundary through its real linear memory, including growth and teardown. */

import { file } from "bun";
import { decodeEngineResponse } from "../../src/engine-wire";
import { isExactNumber } from "../../src/exact-number";
import { WasmEngine } from "../../src/wasm-engine";
import { initialize } from "../../src/wasm-init";
import type { EngineStreamItem, EngineStreamOutcome } from "../../src/engine-wire";
import type { Match } from "../../src/types";

const isMatch = (value: unknown): value is Match =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  "value" in value &&
  "span" in value;
const isMatches = (value: unknown): value is readonly Match[] =>
  Array.isArray(value) && value.every((item) => isMatch(item));
const isOutcome = (value: EngineStreamItem | undefined): value is EngineStreamOutcome =>
  value !== undefined && "ok" in value;
const isSummary = (value: EngineStreamItem | undefined) =>
  value !== undefined && "kind" in value && value.kind === "summary" ? value : undefined;

const bytes = await file(
  "rust/target/wasm32-unknown-unknown/release/partial_json_repair_wasm.wasm",
).arrayBuffer();
const module = new WebAssembly.Module(bytes);
if (WebAssembly.Module.imports(module).length > 0) {
  throw new Error("portable scalar WASM must have no imports");
}
const loaded = await WasmEngine.load(bytes);
if (!loaded.ok)
  throw new Error(`WASM adapter rejected the portable module: ${loaded.failure.reason}`);
const publicParser = await initialize(bytes, { diagnostics: true }, () => Promise.resolve(bytes));
if (!publicParser.ok) throw new Error("WASM initialization rejected the portable module");
const refusedOverride = publicParser.value.parse("[1,]", {
  allowTrailingComma: false,
  diagnostics: false,
});
const unchangedBase = publicParser.value.parse("[1,]");
if (
  refusedOverride.ok ||
  refusedOverride.failure.kind !== "policy-refused" ||
  "diagnostics" in refusedOverride ||
  !unchangedBase.ok ||
  !Array.isArray(unchangedBase.value) ||
  unchangedBase.value[0] !== 1
)
  throw new Error("WASM per-call options changed or escaped the selected engine");
const large = `{"padding":"${"x".repeat(20_000)}","value":1,}`;
let timerFired = false;
setTimeout(() => {
  timerFired = true;
}, 0);
const publicItems = [];
for await (const item of publicParser.value.parseStream([large])) publicItems.push(item);
const publicItem = publicItems[0];
if (
  !timerFired ||
  publicItems.length !== 1 ||
  publicItem?.ok !== true ||
  publicItem.diagnostics?.repairs[0]?.at.chunk !== 0 ||
  publicItem.diagnostics.repairs[0].at.offset !== large.length - 2
)
  throw new Error(
    `WASM pull stream mismatch: timer=${timerFired}, items=${publicItems.length}, chunk=${publicItem?.ok === true ? publicItem.diagnostics?.repairs[0]?.at.chunk : "failure"}, offset=${publicItem?.ok === true ? publicItem.diagnostics?.repairs[0]?.at.offset : "failure"}`,
  );
publicParser.value.close();
const invalid = await WasmEngine.load(new Uint8Array([0]));
if (invalid.ok || invalid.failure.reason !== "compile")
  throw new Error("WASM adapter accepted malformed module bytes");
const importing = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 9, 1, 3, 101, 110, 118, 1, 102, 0, 0,
  ]),
);
const imported = await WasmEngine.load(importing);
if (imported.ok || imported.failure.reason !== "imports")
  throw new Error("WASM adapter accepted a module with host imports");
const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const missing = await WasmEngine.load(empty);
if (missing.ok || missing.failure.reason !== "exports")
  throw new Error("WASM adapter accepted a module without the boundary exports");

const instance = new WebAssembly.Instance(module);
const memory = instance.exports.memory;
if (!(memory instanceof WebAssembly.Memory)) throw new Error("WASM memory export is missing");

type Unary = (value: number) => number;
const unary = (name: string): Unary => {
  const value = instance.exports[name];
  if (typeof value !== "function") throw new Error(`WASM ${name} export is missing`);
  return value as Unary;
};
const allocate = unary("pjr_allocate");
const pointer = unary("pjr_pointer");
const length = unary("pjr_length");
const parse = unary("pjr_parse");
const release = unary("pjr_release");

const unknown = 0xffff_ffff;
if (
  allocate(unknown) !== 0 ||
  pointer(unknown) !== 0 ||
  length(unknown) !== 0 ||
  parse(unknown) !== 0 ||
  release(unknown) !== 0
)
  throw new Error("WASM accepted an oversized allocation or unknown handle");

const beforeGrowth = memory.buffer;
const growth = allocate(beforeGrowth.byteLength + 1);
if (growth === 0) throw new Error("WASM could not allocate the memory-growth control");
if (memory.buffer === beforeGrowth)
  throw new Error("WASM memory-growth control did not grow memory");
if (release(growth) !== 1) throw new Error("WASM could not release the memory-growth control");

const request = new Uint8Array([1, 0, 0, ...new TextEncoder().encode("[9007199254740993]")]);
const adapted = loaded.value.parse("[9007199254740993]");
if (!adapted.ok || !Array.isArray(adapted.value) || !isExactNumber(adapted.value[0]))
  throw new Error("WASM adapter lost the exact parsed value");
const many = loaded.value.parseMany('{"a":1}\n{"b":2}');
if (many.length !== 2 || many[0]?.ok !== true || many[1]?.ok !== true)
  throw new Error("WASM adapter did not return both roots from one call");
const repaired = loaded.value.repair('before {"a":1,} after');
if (!repaired.ok || repaired.value !== '{"a":1}')
  throw new Error("WASM adapter lost repaired text");
const span = loaded.value.findJsonSpan('before {"a":1} after');
if (
  !span.ok ||
  !("start" in span.value) ||
  span.value.start.offset !== 7 ||
  span.value.end.offset !== 14
)
  throw new Error("WASM adapter lost the source span");
const configured = loaded.value.configure({
  select: [["\uD800"]],
  locations: true,
  diagnostics: true,
  recover: { "single-quote": false },
});
if (!configured.ok)
  throw new Error(
    `WASM boundary rejected validated configuration: ${JSON.stringify(configured.failure)}`,
  );
const selected = configured.value.parse('{"\\ud800":1,"other":2,}');
const matches = selected.ok && isMatches(selected.value) ? selected.value : undefined;
if (
  matches === undefined ||
  matches.length !== 1 ||
  matches[0]?.path[0] !== "\uD800" ||
  matches[0]?.value !== 1 ||
  selected.span?.end.offset !== 23 ||
  selected.diagnostics?.repairs[0]?.kind !== "trailing-comma"
)
  throw new Error(
    `WASM configured parser lost selection, location, or diagnostics: ${JSON.stringify(selected)}`,
  );
const refused = configured.value.parse("{\"\\ud800\":'x'}");
if (
  refused.ok ||
  refused.failure.kind !== "policy-refused" ||
  refused.diagnostics?.errors[0]?.refused !== "single-quote"
)
  throw new Error("WASM configured parser lost refusal diagnostics");
const occurrenceParser = loaded.value.configure({ select: [["a", "x"]], occurrences: true });
if (!occurrenceParser.ok) throw new Error("WASM boundary rejected occurrence configuration");
const occurrenceStream = occurrenceParser.value.createStream();
if (!occurrenceStream.ok) throw new Error("WASM boundary could not allocate configured stream");
const firstOccurrence = occurrenceStream.value.feed('{"a":{"x":1},');
const secondOccurrence = occurrenceStream.value.feed('"a":{"x":2}}');
const firstOccurrenceItem = firstOccurrence[0];
const secondOccurrenceItem = secondOccurrence[0];
if (
  !isOutcome(firstOccurrenceItem) ||
  !firstOccurrenceItem.ok ||
  !isMatch(firstOccurrenceItem.value) ||
  firstOccurrenceItem.value.value !== 1 ||
  !isOutcome(secondOccurrenceItem) ||
  !secondOccurrenceItem.ok ||
  !isMatch(secondOccurrenceItem.value) ||
  secondOccurrenceItem.value.value !== 2
)
  throw new Error("WASM configured stream lost source occurrences");
if (!occurrenceStream.value.close()) throw new Error("WASM configured stream did not release");
const summaryStream = occurrenceParser.value.createStream({ summary: true });
if (!summaryStream.ok) throw new Error("WASM boundary could not allocate summary stream");
summaryStream.value.feed('{"a":{"x":3}}');
const pendingSummary = isSummary(summaryStream.value.summary?.());
if (
  pendingSummary === undefined ||
  pendingSummary.complete ||
  pendingSummary.roots !== 1 ||
  pendingSummary.matches !== 1
)
  throw new Error("WASM configured stream advanced while reading its current summary");
const summary = isSummary(summaryStream.value.end()[0]);
if (
  summary === undefined ||
  !summary.complete ||
  summary.roots !== 1 ||
  summary.matches !== 1 ||
  summary.unmatched.length > 0
)
  throw new Error("WASM configured stream lost its terminal summary");
if (!summaryStream.value.close()) throw new Error("WASM summary stream did not release");
const fragmentParser = loaded.value.configure({ select: [["a"]] });
if (!fragmentParser.ok) throw new Error("WASM boundary rejected fragment configuration");
const fragmentStream = fragmentParser.value.createStream({ fragments: true });
if (!fragmentStream.ok) throw new Error("WASM boundary could not allocate fragment stream");
const fragments = fragmentStream.value.feed('{"a":"hello"}');
const start = fragments[0];
const data = fragments[1];
const end = fragments[2];
if (
  fragments.length !== 3 ||
  !isOutcome(start) ||
  !start.ok ||
  typeof start.value !== "object" ||
  start.value === null ||
  !("kind" in start.value) ||
  start.value.kind !== "start" ||
  !isOutcome(data) ||
  !data.ok ||
  typeof data.value !== "object" ||
  data.value === null ||
  !("kind" in data.value) ||
  data.value.kind !== "data" ||
  !("text" in data.value) ||
  data.value.text !== "hello" ||
  !isOutcome(end) ||
  !end.ok ||
  typeof end.value !== "object" ||
  end.value === null ||
  !("kind" in end.value) ||
  end.value.kind !== "end"
)
  throw new Error("WASM configured stream lost scalar fragments");
if (!fragmentStream.value.close()) throw new Error("WASM fragment stream did not release");
const viewParser = loaded.value.configure({});
if (!viewParser.ok) throw new Error("WASM boundary rejected view configuration");
const viewStream = viewParser.value.createStream({ view: "owned" });
if (!viewStream.ok) throw new Error("WASM boundary could not allocate view stream");
viewStream.value.feed('{"a":"par');
const snapshot = viewStream.value.snapshot?.();
if (
  snapshot?.ok !== true ||
  typeof snapshot.value?.value !== "object" ||
  snapshot.value.value === null ||
  !("a" in snapshot.value.value) ||
  snapshot.value.value["a"] !== "par" ||
  snapshot.value.complete ||
  snapshot.value.partialPath?.[0] !== "a"
)
  throw new Error("WASM configured stream lost its owned snapshot");
if (!viewStream.value.close()) throw new Error("WASM view stream did not release");
const sharedStream = viewParser.value.createStream({ view: "shared", summary: true });
if (!sharedStream.ok) throw new Error("WASM boundary rejected shared summary view");
sharedStream.value.feed('{"stable":{"x":1},"open":[');
const sharedFirst = sharedStream.value.snapshot?.();
sharedStream.value.feed("2");
const sharedSecond = sharedStream.value.snapshot?.();
if (
  sharedFirst?.ok !== true ||
  sharedSecond?.ok !== true ||
  typeof sharedFirst.value?.value !== "object" ||
  sharedFirst.value.value === null ||
  !("stable" in sharedFirst.value.value) ||
  typeof sharedSecond.value?.value !== "object" ||
  sharedSecond.value.value === null ||
  !("stable" in sharedSecond.value.value) ||
  !Object.isFrozen(sharedSecond.value?.value) ||
  sharedFirst.value.value.stable !== sharedSecond.value.value.stable
)
  throw new Error("WASM shared snapshots lost protection or stable branch identity");
const sharedTail = sharedStream.value.end();
if (!isSummary(sharedTail.at(-1))) throw new Error("WASM view stream lost its terminal summary");
if (!sharedStream.value.close()) throw new Error("WASM shared view stream did not release");
const stoppedParser = loaded.value.configure({
  select: [["a"]],
  recover: { "unquoted-key": false },
});
if (!stoppedParser.ok) throw new Error("WASM boundary rejected stopped-view configuration");
const stoppedStream = stoppedParser.value.createStream({ view: "owned" });
if (!stoppedStream.ok) throw new Error("WASM boundary rejected stopped view");
stoppedStream.value.feed('{"a":1,b:2}');
const stoppedView = stoppedStream.value.snapshot?.();
if (
  stoppedView?.ok !== false ||
  stoppedView.failure.kind !== "policy-refused" ||
  !Array.isArray(stoppedView.failure.recovered?.value) ||
  !isMatch(stoppedView.failure.recovered.value[0]) ||
  stoppedView.failure.recovered.value[0].value !== 1
)
  throw new Error("WASM selected view lost recovery on terminal failure");
if (!stoppedStream.value.close()) throw new Error("WASM stopped view did not release");
const rawFragments = loaded.value.createStream({ fragments: true });
if (rawFragments.ok || rawFragments.failure.reason !== "requires-select")
  throw new Error("WASM raw stream hid an invalid fragment configuration");
const rawView = loaded.value.createStream({ view: "owned" });
if (!rawView.ok) throw new Error("WASM raw stream rejected its requested view");
rawView.value.feed('{"a":1');
if (rawView.value.snapshot?.().ok !== true)
  throw new Error("WASM raw stream ignored its requested view");
if (!rawView.value.close()) throw new Error("WASM raw view did not release");
if (!configured.value.close() || configured.value.close())
  throw new Error("WASM configured parser release was not exactly once");
const created = loaded.value.createStream();
if (!created.ok) throw new Error("WASM adapter could not allocate a stream");
if (created.value.feed('{"a":').length > 0)
  throw new Error("WASM stream completed a value before its chunk arrived");
const delta = created.value.feed("1}");
const deltaItem = delta[0];
if (
  delta.length !== 1 ||
  !isOutcome(deltaItem) ||
  !deltaItem.ok ||
  typeof deltaItem.value !== "object" ||
  deltaItem.value === null ||
  Array.isArray(deltaItem.value) ||
  !("a" in deltaItem.value) ||
  deltaItem.value["a"] !== 1
)
  throw new Error("WASM stream lost its completed chunk delta");
if (created.value.end().length > 0)
  throw new Error("WASM stream repeated an already delivered value at end");
const ended = created.value.end();
const endedItem = ended[0];
if (
  ended.length !== 1 ||
  !isOutcome(endedItem) ||
  endedItem.ok ||
  endedItem.failure.kind !== "stream-closed"
)
  throw new Error("WASM stream hid its terminal state");
if (!created.value.close() || created.value.close())
  throw new Error("WASM stream release was not exactly once");
const handle = allocate(request.byteLength);
if (handle === 0) throw new Error("WASM could not allocate a request");
new Uint8Array(memory.buffer, pointer(handle), length(handle)).set(request);
if (parse(handle) !== 1) throw new Error("WASM rejected a live request handle");
const response = decodeEngineResponse(
  new Uint8Array(memory.buffer, pointer(handle), length(handle)),
);
if (!response.ok || !Array.isArray(response.value) || !isExactNumber(response.value[0]))
  throw new Error("WASM lost the exact parsed value");
if (release(handle) !== 1) throw new Error("WASM could not release a live handle");
if (pointer(handle) !== 0 || length(handle) !== 0 || parse(handle) !== 0 || release(handle) !== 0) {
  throw new Error("WASM accepted a stale handle");
}

console.log("scalar WASM: empty imports, memory growth, parse and teardown passed");
