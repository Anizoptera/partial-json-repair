// SPDX-License-Identifier: Apache-2.0

// Text-retention bounds need a heap counter that detects deliberately held caller storage.
export const wholeTextMemoryProbe = (
  module: string,
  asyncModule: string,
  operation: "parse" | "repair" | "findJsonSpan" = "parse",
): string => `
  import { createHash } from "node:crypto";
  import { createStreamParser, decodedFragments, parseStream, isExactNumber, ${operation}, select, sourceFragments } from ${JSON.stringify(module)};
  import { ${operation}Async, cooperative } from ${JSON.stringify(asyncModule)};
  const jsc = globalThis.Bun ? await import("bun:jsc") : undefined;
  // Message events give a collection boundary without delays; close ports before measuring.
  function hostTask(callback) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close(); channel.port2.close(); callback();
    };
    channel.port2.postMessage(null);
  }
  const text = "needle".repeat(12);
  // Construct lone units in the child; UTF-8 process arguments cannot carry them in program text.
  // Cross the tiny-token shortcut so this fixture exercises bounded short copying too.
  const short = String.fromCharCode(0xd800, 97, 0xdfff, 98).repeat(8);
  const digits = "123456789".repeat(8);
  const fragmentKinds = ["fragment", "bare-fragment", "source-fragment"];
  // Enough scattered matches make per-result source blocks exceed the retention bound.
  const sparseCount = 512;
  console.log(JSON.stringify({operation: ${JSON.stringify(operation)}, runtime: globalThis.Bun ? "bun " + Bun.version : globalThis.Deno ? "deno " + Deno.version.deno : process.version}));
  const heap = jsc === undefined
    ? globalThis.Deno === undefined
      ? async () => {
        if (!globalThis.gc) throw Error("Whole-text retention requires --expose-gc");
        // Await deferred collection so its requesting task can release temporary input roots.
        const completion = gc({type: "major", execution: "async", flavor: "last-resort"});
        if (typeof completion?.then !== "function")
          throw Error("Whole-text retention requires asynchronous gc completion; use a declared Node runtime with --expose-gc");
        await completion;
        return await new Promise(resolve => hostTask(() => resolve(process.memoryUsage().heapUsed)));
      }
      // Deno collection and sampling must settle with the probe's ordinary handles closed.
      : () => new Promise(resolve => hostTask(() => {
        if (!globalThis.gc) throw Error("Whole-text retention requires --expose-gc");
        gc({type: "major", execution: "sync", flavor: "last-resort"});
        hostTask(() => {
          gc({type: "major", execution: "sync", flavor: "last-resort"});
          resolve(process.memoryUsage().heapUsed);
        });
      }))
    // Bun's MessagePort sample differs with identical ownership; collect in an immediate.
    : () => new Promise(resolve => setImmediate(() => {
      // A collection or sweep alone misses held strings; collect again after sweeping.
      jsc.gcAndSweep();
      jsc.fullGC();
      resolve(jsc.heapSize());
    }));
  function fragment(input, options, cooperative) {
    // Keep a bounded prefix after consumer exit; piece boundaries depend on the execution route.
    let kept = "";
    if (cooperative) return (async () => {
      for await (const item of parseStream([input], options)) {
        if (!item.ok) throw Error("Fragment recovery failed: " + item.failure.kind);
        if (item.value.kind === "data") kept += item.value.text;
        if (kept.length >= 4096) return kept.slice(0, 4096);
      }
      throw Error("Root emitted no fragment");
    })();
    const parser = createStreamParser(options);
    try {
      function* items() { yield* parser.feed(input); yield* parser.end(); }
      for (const item of items()) {
        if (!item.ok) throw Error("Fragment recovery failed: " + item.failure.kind);
        if (item.value.kind === "data") kept += item.value.text;
        if (kept.length >= 4096) return kept.slice(0, 4096);
      }
      throw Error("Root emitted no fragment");
    } finally { parser.close(); }
  }
  function owner(kind, scheduled, selected = true) {
    // Keep binary fixture scratch small: its native storage is unrelated to returned text.
    let bytes = Buffer.allocUnsafe(65536);
    let seed = 1729, padding = "";
    for (let block = 0; block < 32; block++) {
      for (let offset = 0; offset < bytes.length; offset += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        bytes.writeUInt32LE(seed, offset);
      }
      padding += bytes.toString("hex");
    }
    const token = kind === "exact" ? digits : kind === "bare" ? text : JSON.stringify(text);
    const tail = " ".repeat(4096) + '{"a":' + token + '}';
    const width = padding.length / sparseCount;
    const fragmented = fragmentKinds.includes(kind);
    let full = kind === "bare-fragment" ? '{"a":word' + padding + '}'
      : kind === "source-fragment" ? '{"a":0x' + padding + '}'
      : kind === "fragment" ? JSON.stringify(padding) : kind === "borrowed" ? padding + tail
      : kind === "sparse" ? '{' + Array.from({length: sparseCount}, (_,index) =>
        '"skip' + index + '":"' + padding.slice(index * width, (index + 1) * width)
        + '","a' + index + '":' + JSON.stringify(text + index)).join(',') + '}'
      : '{"padding":"' + padding + '","a":' + token
        + (kind === "quoted" ? ',"short":"' + short + '"' : '') + '}';
    let input = kind === "borrowed" ? full.slice(padding.length) : full;
    const options = fragmented ? { select: select(kind === "fragment" ? [[]] : [["a"]], {fragments: kind === "source-fragment" ? sourceFragments : decodedFragments}),
      maxScalar: full.length, maxBuffer: full.length + 128, maxRetained: kind === "fragment" ? full.length * 4 : 256 } : selected ? { select: select(kind === "sparse"
      ? Array.from({length: sparseCount}, (_,index) => ["a" + index])
      : kind === "quoted" ? [["a"], ["short"]] : [["a"]]) } : undefined;
    // Hash before collection so the observer does not read caller-sized text between heap samples.
    // A host may copy a short source slice; retain its parent explicitly for the control.
    const held = { input, selected, backing: kind === "borrowed" ? full : undefined,
      ${operation === "findJsonSpan" ? "sourceLength: input.length," : ""}
      digest: createHash("sha256").update(input).digest("hex"),
      fragmentDigest: fragmented ? createHash("sha256").update((kind === "bare-fragment" ? "word" + padding : kind === "source-fragment" ? "0x" + padding : padding).slice(0, 4096)).digest("hex") : undefined,
      result: fragmented ? fragment(input, options, scheduled) : scheduled
        ? ${operation}Async(input, { execution: cooperative, ...options })
        : ${operation}(input, options),
    };
    // Only the explicit owner should retain input during collection, not fixture-building aliases.
    bytes = padding = full = input = undefined;
    return held;
  }
  function validate(result, kind, selected, fragmentDigest${operation === "findJsonSpan" ? ", sourceLength" : ""}) {
    if (fragmentKinds.includes(kind)) {
      if (typeof result !== "string" || result.length !== 4096
        || createHash("sha256").update(result).digest("hex") !== fragmentDigest)
        throw Error("Retained scalar fragment changed");
      return;
    }
    if (!result.ok) throw Error("Recovery failed");
    ${
      operation === "findJsonSpan"
        ? `
    // Derive exact source boundaries from fixture suffixes without rereading retained strings.
    const spans = selected ? result.value.map(match => match.value) : [result.value];
    const shortEnd = sourceLength - 1, shortStart = shortEnd - short.length - 2;
    const aEnd = shortStart - ',"short":'.length;
    const expected = selected ? [[aEnd - JSON.stringify(text).length, aEnd], [shortStart, shortEnd]]
      : [[sourceLength - JSON.stringify({a: text}).length, sourceLength]];
    if (spans.length !== expected.length || spans.some((span, index) =>
      span.start.unit !== "utf16" || span.end.unit !== "utf16"
      || span.start.offset !== expected[index][0] || span.end.offset !== expected[index][1]))
      throw Error("Returned source spans changed");
    return;
    `
        : ""
    }
    if (!selected) {
      // Only the borrowed-input shape has a small whole result; other shapes request the padding.
      if (kind !== "borrowed") throw Error("Whole-result control must exclude padding");
      const value = result.value;
      if (${operation === "parse" ? '!Object.hasOwn(value, "a") || value.a !== text' : "value !== JSON.stringify({ a: text })"})
        throw Error("Whole returned text changed");
      return;
    }
    if (kind === "sparse") {
      if (result.value.length !== sparseCount) throw Error("Sparse selection lost matches");
      for (let index = 0; index < sparseCount; index++)
        if (result.value[index].value !== ${operation === "parse" ? "text + index" : "JSON.stringify(text + index)"}) throw Error("Sparse selected text changed");
      return;
    }
    const value = result.value[0]?.value;
    if (kind === "quoted" && result.value[1]?.value !== ${operation === "parse" ? "short" : "'\"' + short + '\"'"})
      throw Error("Short selected text changed its UTF-16 units");
    if (kind === "exact" ? ${operation === "parse" ? "!isExactNumber(value) || value.text !== digits" : "value !== digits"} : value !== ${operation === "parse" ? "text" : "JSON.stringify(text)"})
      throw Error("Selected text changed");
  }
  async function measure(held, kind, cooperative, baseline) {
    held.result = await held.result;
    const before = await heap();
    // Read the control after collection, then release caller text while keeping the same result.
    if (typeof held.input !== "string" || (kind === "borrowed" && held.backing.length <= held.input.length))
      throw Error("Caller-held text control changed");
    console.log(JSON.stringify({kind, cooperative,
      retainedInputDigest: held.digest}));
    held.input = undefined;
    held.backing = undefined;
    const after = await heap();
    const control = before - baseline, subject = after - baseline;
    console.log(JSON.stringify({kind, selected: held.selected, cooperative, control, subject}));
    // Diagnose a failed bound while the result is held; clearing it first loses its retaining path.
    // A misspelled counter field becomes NaN; require evidence that each bound passed.
    if (!(control >= 2000000)) throw Error("Heap control did not detect caller storage: "
      + control + "; check the heap counter field and retained-input fixture");
    if (!(subject <= 1000000)) {
      throw Error("Returned ${operation} text retained unrelated input: "
        + kind + " (" + (held.selected ? "selected" : "whole")
        + ", " + (cooperative ? "cooperative" : "sync") + ")");
    }
    // Preserve failing backing representations for diagnosis before reads can materialize them.
    validate(held.result, kind, held.selected, held.fragmentDigest${operation === "findJsonSpan" ? ", held.sourceLength" : ""});
    held.result = undefined;
  }
  // Initialize both routes so the retained-source bound excludes fixed VM and parser setup.
  {
    const options = {select: select([["a"], ["short"]])}, source = '{"a":' + JSON.stringify(text) + ',"short":"' + short + '"}';
    validate(${operation}(source, options), "quoted", true${operation === "findJsonSpan" ? ", undefined, source.length" : ""});
    validate(await ${operation}Async(source, {...options, execution: cooperative}), "quoted", true${operation === "findJsonSpan" ? ", undefined, source.length" : ""});
  }
  // The many-path selector's one-time setup survives release and lands near the bound when the
  // first measured sparse case pays it, so warm that route the same way.
  if (${operation === "findJsonSpan" ? "false" : "true"}) {
    const options = {select: select(Array.from({length: sparseCount}, (_,index) => ["a" + index]))};
    const source = '{' + Array.from({length: sparseCount}, (_,index) =>
      '"a' + index + '":' + JSON.stringify(text + index)).join(',') + '}';
    validate(${operation}(source, options), "sparse", true);
    validate(await ${operation}Async(source, {...options, execution: cooperative}), "sparse", true);
  }
  await heap();
  const cases = [
    ...(${JSON.stringify(operation)} === "parse" ? fragmentKinds.map(kind => ({kind, selected: true})) : []),
    ...${operation === "findJsonSpan" ? '["quoted"]' : '["quoted", "borrowed", "bare", "exact", "sparse"]'}.map(kind => ({kind, selected: true})),
    {kind: "borrowed", selected: false},
  ];
  for (const {kind, selected} of cases) {
    for (const cooperative of [false, true]) {
      const baseline = await heap();
      // Finish fixture construction in its own host task before observing ownership.
      const held = await new Promise(resolve =>
        hostTask(() => resolve(owner(kind, cooperative, selected))));
      await measure(held, kind, cooperative, baseline);
    }
  }
  for (const fragments of ${JSON.stringify(operation)} === "parse" ? [decodedFragments, sourceFragments] : []) {
    // Delivered scalar contents must not leave one position entry per historical input chunk.
    const parser = createStreamParser({select: select([["a"]], {fragments}),
      maxBuffer: 4096, maxRetained: 256});
    let units = 0, ends = 0, span;
    const read = items => { for (const item of items) {
      if (!item.ok) throw Error("Chunked fragment failed: " + item.failure.kind);
      if (item.value.kind === "data") units += item.value.text.length;
      else if (item.value.kind === "end") { ends++; span = item.value.span; }
    }};
    try {
      const chunks = ["x", "x".repeat(17), "x".repeat(64), "x".repeat(127)];
      let expected = fragments === decodedFragments ? 0 : 1;
      const feed = index => { const chunk = chunks[index % chunks.length];
        read(parser.feed(chunk)); expected += chunk.length; };
      read(parser.feed('{"a":"'));
      for (let i = 0; i < 1000; i++) feed(i);
      const baseline = await heap();
      for (let i = 1000; i < 50000; i++) feed(i);
      if (units !== expected) throw Error("Chunked fragment contents were not delivered");
      const selected = (await heap()) - baseline;
      // A delivered match must not keep later unselected source history in the same root either.
      read(parser.feed('","ignored":"'));
      if (fragments !== decodedFragments) expected++;
      for (let i = 0; i < 1000; i++) read(parser.feed(chunks[i % chunks.length]));
      const ignoredBaseline = await heap();
      for (let i = 1000; i < 50000; i++) read(parser.feed(chunks[i % chunks.length]));
      const subject = Math.max(selected, (await heap()) - ignoredBaseline);
      if (units !== expected) throw Error("Ignored text entered selected fragments");
      read(parser.feed('"}')); read(parser.end());
      if (ends !== 1 || span.start.chunk !== 0 || span.start.offset !== 5
        || span.end.chunk !== 50001 || span.end.offset !== 1)
        throw Error("Chunked fragment lost its original start or final source position");
      // The counter must also detect retained objects of the mapping's shape on this host.
      const retained = {value: Array.from({length: 50000}, (_,start) =>
        ({start, chunk: start, unit: "utf16", source: 0, width: 1}))};
      const control = (await heap()) - baseline;
      console.log(JSON.stringify({kind: "fragment-chunks", source: fragments !== decodedFragments, control, subject}));
      if (retained.value.at(-1).chunk !== 49999 || !(control >= 2000000))
        throw Error("Position-history control was not detected; check the host heap counter");
      if (!(subject <= 1000000)) throw Error("Open fragment retained delivered chunk history: "
        + subject + "; release obsolete PositionMap entries while preserving live spans and replay; do not raise this bound");
      // Remove this control before another baseline; its later collection would cancel new storage.
      retained.value = undefined;
      await heap();
    } finally { parser.close(); }
  }
`;
