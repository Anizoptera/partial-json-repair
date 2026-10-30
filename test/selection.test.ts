// SPDX-License-Identifier: Apache-2.0

import { decodedFragments } from "../src/index";

/**
 * Selection must preserve source order, duplicate replacement, independent views and incremental
 * scalar delivery. These runtime properties cannot follow from the result types alone.
 */
import { describe, expect, it } from "vitest";
import { configurationCause } from "./configuration-error";
import { costRatio } from "./cost-ratio";

import type { Fragment, Match, Result, StreamSummary } from "../src/types";
import type { Exact, StreamParserOptions } from "../src/options";
import {
  ANY,
  ANY_DEPTH,
  createStreamParser,
  findJsonSpan,
  initParser,
  parse,
  parseMany,
  repair,
  diagnostics,
  select,
  skip,
} from "../src/index";
import { ownedView, sharedView } from "../src/index";

const DOC =
  '{"items":[{"id":1,"name":"a","emb":[0.1,0.2]},{"id":2,"name":"b","emb":[0.3]}],"meta":{"id":9}}';

/** Matches reduced to what a caller reads: the value and where it came from. */
const at = <T>(r: Result<readonly Match<T>[], unknown>): readonly (readonly [T, unknown])[] =>
  r.ok ? r.value.map((m) => [m.value, m.path] as const) : [];

const stream = <O extends StreamParserOptions>(options: Exact<O, StreamParserOptions>) =>
  createStreamParser<O>(options);

/** Successful drains must not discard failures; deliberate terminal tails are asserted separately. */
const values = <T>(items: Iterable<Result<T, unknown> | StreamSummary>): T[] =>
  [...items].map((item) => {
    if (!("ok" in item) || !item.ok)
      throw new Error("Unexpected selection outcome", { cause: item });
    return item.value;
  });

/** The view's matches as [value, path], after feeding `text`. */
const viewed = (
  sp: {
    feed(text: string): Iterable<unknown>;
    snapshot(): Result<{ readonly value: readonly Match[] } | undefined, unknown>;
  },
  text: string,
): unknown => {
  Array.from(sp.feed(text));
  const seen = sp.snapshot();
  return seen.ok ? seen.value?.value.map((m) => [m.value, m.path]) : seen.failure;
};

/** The text a run of fragments delivers, joined. */
const fragmentText = (fragments: readonly Fragment[]): string =>
  fragments.map((f) => (f.kind === "data" ? f.text : "")).join("");

/** The repair kinds every item in a drain reports, in order. */
const kinds = (items: Iterable<unknown>): unknown =>
  [...items].flatMap(
    (i) =>
      (i as { diagnostics?: { repairs: { kind: string }[] } }).diagnostics?.repairs.map(
        (r) => r.kind,
      ) ?? [],
  );

describe("select", () => {
  it("deduplicates overlapping recursive paths across nested nodes and streamed roots", () => {
    const text = '{"a":{"a":{"a":1},"b":2},"c":{"a":3}}';
    const options = {
      select: select([
        [ANY_DEPTH, "a", ANY_DEPTH],
        [ANY_DEPTH, "a"],
      ]),
    };
    const expected = [[0, 1], [0, 1], [0, 1], [0], [0, 1]];
    const result = parse(text, options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((match) => match.selectors)).toEqual(expected);
    const parser = createStreamParser(options);
    try {
      for (let root = 0; root < 3; root++) {
        const matches = text.split("").flatMap((chunk) => values(parser.feed(chunk)));
        expect(matches.map((match) => match.selectors)).toEqual(expected);
      }
      expect([...parser.end()]).toEqual([]);
    } finally {
      parser.close();
    }
  });

  it("shares immutable singleton selectors without merging different match sets", () => {
    const result = parse('{"rows":[{"a":1,"b":2},{"a":3,"b":4},{"a":5,"b":6}]}', {
      select: select([
        ["rows", ANY, "a"],
        ["rows", 0, ANY],
        ["rows", ANY, "b"],
      ]),
    });
    if (!result.ok) throw new Error("selector allocation control refused");
    const indices = result.value.map((match) => match.selectors);
    expect(indices).toEqual([[0, 1], [1, 2], [0], [2], [0], [2]]);
    // Immutable selector membership can be shared; source positions and mutable values cannot.
    expect(indices[2]).toBe(indices[4]);
    expect(indices[3]).toBe(indices[5]);
    expect(indices[2]).not.toBe(indices[3]);
    expect(indices.every((membership) => Object.isFrozen(membership))).toBe(true);
  });

  it("delivers wide final selection without a host argument-count limit", () => {
    // Final membership arrives as one batch; its width must not become function arguments.
    const count = 131072;
    const result = parse(`{"items":[${"0,".repeat(count - 1)}1]}`, {
      select: select([["items", ANY]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(count);
    expect(result.value[0]?.value).toBe(0);
    expect(result.value[count - 1]?.value).toBe(1);
    expect(result.value[count - 1]?.path).toEqual(["items", count - 1]);
  });

  it("repairs selected UTF-8 text using decoded ranges while retaining byte locations", () => {
    for (const text of ['{"é":1,"x":2}', '{"😀":1,"x":{"y":2,}}', '{"é":1,"x":{"y":2']) {
      const selection = select([["x"], ["x", "y"]]);
      const decoded = repair(text, { select: selection });
      const bytes = repair(new TextEncoder().encode(text), { select: selection });
      expect(bytes.ok).toBe(true);
      expect(decoded.ok).toBe(true);
      if (!bytes.ok || !decoded.ok) return;
      expect(bytes.value.map((match) => match.value)).toEqual(
        decoded.value.map((match) => match.value),
      );
      for (const match of bytes.value)
        expect(() => JSON.parse(match.value) as unknown).not.toThrow();
      expect(bytes.value[0]?.span.start.offset).toBeGreaterThan(
        decoded.value[0]?.span.start.offset ?? Infinity,
      );
    }
  });

  it("returns matches with their paths, not a trimmed copy of the document", () => {
    // The path is the whole reason matches are not a subtree: two selectors that both hit `id`
    // are otherwise indistinguishable in the result.
    expect(at(parse(DOC, { select: select([["items", ANY, "name"]]) }))).toEqual([
      ["a", ["items", 0, "name"]],
      ["b", ["items", 1, "name"]],
    ]);
  });

  it("finds a field at any depth with ANY_DEPTH, in source order", () => {
    expect(at(parse(DOC, { select: select([[ANY_DEPTH, "id"]]) }))).toEqual([
      [1, ["items", 0, "id"]],
      [2, ["items", 1, "id"]],
      [9, ["meta", "id"]],
    ]);
  });

  it("orders an ancestor before its descendant", () => {
    // Held from the OPENER, not emitted at close: closing order is innermost-first, which would put
    // the descendant before the container it sits in and break the documented order.
    expect(at(parse('{"a":{"b":1}}', { select: select([["a"], ["a", "b"]]) }))).toEqual([
      [{ b: 1 }, ["a"]],
      [1, ["a", "b"]],
    ]);
  });

  it("delivers a selected container whole, however deep it goes", () => {
    // Below a match no selector state is alive, which is exactly what `dead` reports — but `dead` is
    // a reason to decline BUILDING only where nothing was selected. Inside a match the contents ARE
    // the match, so the builder must keep building them. The test above hides this by pairing the
    // container selector with a descendant one, which keeps the subtree reachable: alone, `["a"]`
    // came back `{}` from the second level down, and `[]` — the root — came back `{}` for any
    // nested document, both at confidence 1.0 with nothing reported.
    expect(at(parse('{"a":{"b":{"c":[1,{"d":2}]}}}', { select: select([["a"]]) }))).toEqual([
      [{ b: { c: [1, { d: 2 }] } }, ["a"]],
    ]);
    expect(at(parse(DOC, { select: select([[]]) }))).toEqual([[JSON.parse(DOC), []]]);
  });

  it("merges selectors that hit the same occurrence into one match", () => {
    const r = parse('{"a":1}', { select: select([["a"], [ANY]]) });
    expect(r.ok ? r.value.map((m) => m.selectors) : r.failure).toEqual([[0, 1]]);
  });

  it("keeps the LAST duplicate by default and every occurrence on request", () => {
    // A later duplicate member replaces everything matched beneath the earlier one, so retracting a
    // superseded match has to take its descendants with it.
    const dup = '{"a":{"x":1},"a":{"x":2}}';
    expect(at(parse(dup, { select: select([["a", "x"]]) }))).toEqual([[2, ["a", "x"]]]);
    expect(at(parse(dup, { select: select([["a", "x"]], { occurrences: true }) }))).toEqual([
      [1, ["a", "x"]],
      [2, ["a", "x"]],
    ]);
  });

  it("replaces selected branches after several distinct keys, including an empty key", () => {
    const input = '{"":{"x":1},"a":{"x":2},"":{"x":3},"b":{"x":4},"a":{"x":5}}';
    expect(at(parse(input, { select: select([[ANY, "x"]]) }))).toEqual([
      [3, ["", "x"]],
      [4, ["b", "x"]],
      [5, ["a", "x"]],
    ]);
    expect(at(parse('{"":{"x":1},"":{"x":2}}', { select: select([["", "x"]]) }))).toEqual([
      [2, ["", "x"]],
    ]);
  });

  it("succeeds with an empty array when a root exists but nothing matches", () => {
    // Distinct from `no-json-found`: the caller's selector missed, the input was not unreadable.
    expect(parse(DOC, { select: select([["nope"]]) })).toEqual({
      ok: true,
      complete: true,
      value: [],
    });
    expect(parse("hello there", { select: select([["a"]]) }).ok).toBe(false);
  });

  it("gives a repaired match the match's own text, not the document's", () => {
    // The edit log changes the whole source, so a match closing at the same
    // offset as its ancestors takes their closers too unless the splice is bounded at its own close.
    expect(at(repair('{"a":[1,2', { select: select([["a"]]) }))).toEqual([["[1,2]", ["a"]]]);
  });

  it("repairs selected ranges from the first root that passes required keys", () => {
    // A rejected root can deliver just as many matches; a count check cannot detect stale ranges.
    const result = repair('{"miss":{a:1}} {"need":{b:2,}}', {
      requiredKeys: ["need"],
      select: select([[ANY]]),
    });
    expect(at(result)).toEqual([['{"b":2}', ["need"]]]);
    expect(result.ok && result.value[0]?.valueIndex).toBe(1);
  });

  it.each([1, 128])("keeps selected closers after %s edited and retracted members", (count) => {
    // Small and wide selections exercise both span-shifting routes at shared closing offsets.
    // Compare usable JSON, not scanner metadata, so a misplaced delta cannot pass by agreement.
    for (const bytes of [false, true]) {
      const body = "{name:'café',__proto__:1,v:[1,2,]},".repeat(count);
      const text = `\uFEFF{"items":[${body}{name:'fin',__proto__:1,v:[1,2`;
      const result = repair(bytes ? new TextEncoder().encode(text) : text, {
        onDangerousKey: "drop",
        select: select([
          ["items", ANY],
          ["items", ANY, "v"],
        ]),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.length).toBe((count + 1) * 2);
      for (const match of result.value) {
        const index = match.path[1];
        expect(JSON.parse(match.value)).toEqual(
          match.path.length === 2 ? { name: index === count ? "fin" : "café", v: [1, 2] } : [1, 2],
        );
      }
    }
  });

  it("reports each match's source span through findJsonSpan", () => {
    const r = findJsonSpan(DOC, { select: select([["meta"]]) });
    expect(r.ok && r.value.map((m) => DOC.slice(m.value.start.offset, m.value.end.offset))).toEqual(
      ['{"id":9}'],
    );
  });

  it("carries the root index on matches from parseMany", () => {
    const got = [...parseMany('{"id":1} {"id":2}', { select: select([["id"]]) })];
    expect(values(got).map((m) => [m.value, m.valueIndex])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });
});

describe("skip", () => {
  it("removes the named member and leaves the rest of the document whole", () => {
    // `skip` trims because removing an object member invents no holes; that is why its paths may
    // not end in an index or a wildcard.
    expect(parse(DOC, { skip: skip([["items", ANY, "emb"]]) })).toEqual({
      ok: true,
      complete: true,
      value: {
        items: [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
        meta: { id: 9 },
      },
    });
  });

  it("wins over select where the two overlap", () => {
    expect(
      at(parse('{"a":{"b":1,"c":2}}', { select: select([["a", ANY]]), skip: skip([["a", "b"]]) })),
    ).toEqual([[2, ["a", "c"]]]);
  });

  it("refuses a path that could target an array element, when the parser is built", () => {
    expect(configurationCause(() => initParser({ skip: skip([["a", ANY]]) }))).toEqual({
      kind: "invalid-options",
      field: "skip",
      reason: "skip-tail",
    });
  });
});

/** The matches a call ended with, delivered or recovered from its failure. */
const ended = (r: Result<readonly Match[], unknown>): unknown =>
  (r.ok ? r.value : (r.failure as { recovered?: { value: Match[] } }).recovered?.value)?.map(
    (m) => [m.value, m.path],
  );

describe("key policy under selection", () => {
  it("refuses what the whole candidate refuses, built or not", () => {
    // API.md: a selection changes what is built and reported, never whether a policy violation in
    // unselected content is accepted. The builder once applied key policy only to built objects.
    const cases = [
      ['{"k":{"__proto__":{"x":1}},"y":2}', { onDangerousKey: "reject" }],
      ['{"k":{"a":1,"a":2},"y":2}', { recover: { "duplicate-key": false } }],
    ] as const;
    for (const [text, policy] of cases) {
      expect(parse(text, policy)).toMatchObject({ ok: false, failure: { kind: "policy-refused" } });
      for (const selection of [{ select: select([["y"]]) }, { skip: skip([["k"]]) }]) {
        expect(parse(text, { ...policy, ...selection })).toMatchObject({
          ok: false,
          failure: { kind: "policy-refused" },
        });
      }
    }
  });

  it("keeps a dropped or refused member out of the matches", () => {
    expect(
      ended(
        parse('{"__proto__":{"x":1},"y":2}', { onDangerousKey: "drop", select: select([[ANY]]) }),
      ),
    ).toEqual([[2, ["y"]]]);
    // Members after the refused key are refused with the object, whether or not it is built.
    const refused = parse('{"k":{"__proto__":2,"a":1,"b":{"c":3}}}', {
      onDangerousKey: "reject",
      select: select([["k", ANY]]),
    });
    expect(refused).toMatchObject({ ok: false, failure: { kind: "policy-refused" } });
    expect(ended(refused)).toEqual([]);
  });
});

describe("selection diagnostics", () => {
  it("covers the selected results by default and the skipped content on request", () => {
    // `scope` is the promise: the default report explains the recovery that found what you asked
    // for, so a repair inside an unselected sibling is not counted until `diagnostics: diagnostics({ scope: "all" })`.
    const text = '{"a":[1,2,],"b":{\'x\':1}}';
    const scoped = parse(text, { select: select([["a"]]), diagnostics });
    expect(scoped.diagnostics.scope).toBe("selected");
    expect(scoped.diagnostics.counts.repairs).toBe(1);
    expect(
      parse(text, { select: select([["a"]]), diagnostics: diagnostics({ scope: "all" }) })
        .diagnostics.counts.repairs,
    ).toBe(2);
    // `skip` alone narrows the report the same way, so it must not claim `"all"`.
    const skipped = parse(text, { skip: skip([["b"]]), diagnostics });
    expect(skipped.diagnostics).toMatchObject({ scope: "selected", counts: { repairs: 1 } });
  });
});

describe("selection over a stream", () => {
  it("isolates owned selected prefixes after closing the stream", () => {
    for (const text of ['{"content":"hel', '{"content":{"text":"hel']) {
      const sp = stream({ select: select([["content"]]), view: ownedView });
      Array.from(sp.feed(text));
      sp.close();
      const first = sp.snapshot();
      const match = first.ok ? first.value?.value[0] : undefined;
      expect(match).toBeDefined();
      if (match === undefined) throw new Error("missing selected prefix");
      const offset = match.span.start.offset;
      const cut = first.ok ? first.value?.cut : undefined;
      if (cut === undefined) throw new Error("missing prefix cut");
      Reflect.set(cut, "kind", "number");
      Reflect.set(match, "value", "caller replacement");
      Reflect.set(match.span, "start", { ...match.span.start, offset: -1 });
      const next = sp.snapshot();
      const later = next.ok ? next.value?.value[0] : undefined;
      expect(later?.value).toEqual(text.includes('{"text"') ? { text: "hel" } : "hel");
      expect(later?.span.start.offset).toBe(offset);
      expect(next.ok && next.value?.cut?.kind).toBe("string");
    }
  });

  it("delivers each match as its chunk completes it, and names the unmatched selectors", () => {
    const sp = stream({
      select: select([["items", ANY], ["nope"]], { occurrences: true }),
      summary: true,
    });
    expect(values([...sp.feed('{"items":[{"id":1},{"id"')]).map((m) => m.value)).toEqual([
      { id: 1 },
    ]);
    expect(values([...sp.feed(":2}]}")]).map((m) => m.value)).toEqual([{ id: 2 }]);
    expect([...sp.end()]).toEqual([
      { kind: "summary", complete: true, roots: 1, matches: 2, unmatched: [1] },
    ]);
  });

  it("shows the matches so far plus the one still open in a view", () => {
    // The open match is held, not delivered, so a view that took both the held list and the open
    // frame reported it twice.
    const sp = stream({ select: select([["a"]]), view: sharedView });
    expect(values([...sp.feed('{"z":0,"a":{"b":"par')])).toEqual([]); // still open, nothing delivered
    const seen = sp.snapshot();
    expect(seen.ok && seen.value?.value.map((m) => m.value)).toEqual([{ b: "par" }]);
    expect(seen.ok && seen.value?.cut).toEqual({ path: ["a", "b"], kind: "string" });
  });

  it("keeps a caller's write to a view's match out of the match it delivers", () => {
    // Every record of one match shared its `selectors` array, so a push on a view's copy changed
    // the item `end()` delivered.
    for (const view of [sharedView, ownedView]) {
      const sp = stream({ select: select([["items", ANY]]), view });
      Array.from(sp.feed('{"items":[{"a":1},{"b":'));
      const seen = sp.snapshot();
      const held = (seen.ok ? seen.value?.value[0]?.selectors : undefined) as number[];
      expect(held).toEqual([0]);
      try {
        held.push(9);
      } catch {
        // A frozen array refuses the write, which is the other acceptable outcome.
      }
      const delivered = values([...sp.feed("2}]}"), ...sp.end()]);
      expect(
        delivered.map((m) => m.selectors),
        view.mode,
      ).toEqual([[0], [0]]);
    }
  });

  it("shows a selected string while it is still being written", () => {
    // A tool call's `content` argument is a string. A view that showed only open selected
    // CONTAINERS left that field blank until its closing quote, while the same view's `cut`
    // already named it: the one part the caller asked to watch was the part never shown.
    const text = '{"path":"a.txt","content":"hel';
    for (const view of [sharedView, ownedView]) {
      const sp = stream({ select: select([["content"]]), view });
      Array.from(sp.feed(text));
      const seen = sp.snapshot();
      const match = seen.ok ? seen.value?.value[0] : undefined;
      expect(match?.value, view.mode).toBe("hel");
      expect(match?.path, view.mode).toEqual(["content"]);
      // Its end is not known yet, so the span ends where it starts: at the opening quote.
      expect(match?.span.start.offset, view.mode).toBe(text.indexOf('"hel'));
      expect(match?.span.end.offset, view.mode).toBe(text.indexOf('"hel'));
      expect(seen.ok && seen.value?.cut, view.mode).toEqual({ path: ["content"], kind: "string" });
    }
  });

  it("shows a selected array element still being written after the held ones", () => {
    const text = '{"tags":["a","bc';
    expect(viewed(stream({ select: select([["tags", ANY]]), view: sharedView }), text)).toEqual([
      ["a", ["tags", 0]],
      ["bc", ["tags", 1]],
    ]);
    // Under `occurrences` the finished element already left through `feed`; the view holds the rest.
    expect(
      viewed(
        stream({ select: select([["tags", ANY]], { occurrences: true }), view: ownedView }),
        text,
      ),
    ).toEqual([["bc", ["tags", 1]]]);
  });

  it("keeps skip, cutSuffix and duplicate keys in a string still being written", () => {
    expect(
      viewed(
        stream({ select: select([["a", ANY]]), skip: skip([["a", "b"]]), view: sharedView }),
        '{"a":{"c":"1","b":"x',
      ),
    ).toEqual([["1", ["a", "c"]]]);
    expect(
      viewed(stream({ select: select([["a"]]), cutSuffix: true, view: ownedView }), '{"a":"x'),
    ).toEqual([["x…", ["a"]]]);
    // The later duplicate replaces the earlier member, so the view must not show both.
    expect(
      viewed(stream({ select: select([["a"]]), view: sharedView }), '{"a":"x","a":"y'),
    ).toEqual([["y", ["a"]]]);
    // A key still being read names no member yet.
    expect(viewed(stream({ select: select([["a"]]), view: sharedView }), '{"z":"1","a')).toEqual(
      [],
    );
  });

  it("grows each selected string through a per-character stream and ends equal to parse", () => {
    const text = '{"path":"a","content":"h\\u00e9 \\"q\\"","tags":["x","yz"],"n":1}';
    const options = { select: select([["content"], ["tags", ANY]]) } as const;
    const finals = new Map<string, unknown>();
    const whole = parse(text, options);
    for (const m of whole.ok ? whole.value : []) finals.set(JSON.stringify(m.path), m.value);
    const sp = stream({ ...options, view: sharedView });
    let partialSeen = false;
    const delivered: Match[] = [];
    for (const char of text) {
      for (const v of values([...sp.feed(char)])) delivered.push(v);
      const seen = sp.snapshot();
      for (const m of seen.ok ? (seen.value?.value ?? []) : []) {
        const final = finals.get(JSON.stringify(m.path)) as string;
        expect(final.startsWith(m.value as string), JSON.stringify(m)).toBe(true);
        if (m.value !== final) partialSeen = true;
      }
    }
    expect(partialSeen).toBe(true);
    for (const v of values([...sp.end()])) delivered.push(v);
    expect(delivered.map((m) => [m.value, m.path])).toEqual(
      whole.ok ? whole.value.map((m) => [m.value, m.path]) : [],
    );
  });

  it.each(["x", "\\n", "\\u0061", "\\q"])(
    "does not retain an ignored string while selecting a small value: %s",
    (spelling) => {
      for (const width of [7, 1048576]) {
        const source = '{"a":1,"b":"' + spelling.repeat(8192);
        const sp = stream({
          select: select([["a"], ["c"]]),
          view: ownedView,
          maxRetained: 16,
          maxBuffer: 128,
        });
        const items = [...sp.feed(source.slice(0, width))];
        for (let offset = width; offset < source.length; offset += width)
          for (const item of sp.feed(source.slice(offset, offset + width))) items.push(item);
        expect(sp.snapshot()).toMatchObject({
          ok: true,
          value: { value: [{ value: 1, path: ["a"] }] },
        });
        for (const item of sp.feed('","c":2}')) items.push(item);
        for (const item of sp.end()) items.push(item);
        expect(values(items).map((match) => match.value)).toEqual([1, 2]);
        sp.close();
      }
    },
  );

  it.each(["x".repeat(64), "2".repeat(64) + "e+"])(
    "preserves withheld unselected token text in snapshots: %s",
    (token) => {
      // Selection removes values, not the source text callers inspect through a cut.
      const source = '{"a":1,"b":' + token;
      for (const width of [1, 7, source.length]) {
        const sp = stream({ select: select([["a"]]), view: ownedView, maxRetained: 256 });
        try {
          for (let offset = 0; offset < source.length; offset += width)
            Array.from(sp.feed(source.slice(offset, offset + width)));
          const pending = sp.snapshot();
          expect(pending).toMatchObject({ ok: true, value: { cut: { text: token } } });
          Array.from(sp.end());
          const oracle = parse(source, { select: select([["a"]]) });
          if (!oracle.ok || oracle.complete) throw new Error("expected incomplete recovery");
          expect(sp.snapshot()).toMatchObject({ ok: true, value: { cut: oracle.cut } });
        } finally {
          sp.close();
        }
      }
    },
  );

  it("still refuses an invalid escape in an ignored string", () => {
    const sp = stream({ select: select([["a"]]), recover: { "invalid-escape": false } });
    const items = [...sp.feed('{"a":1,"b":"\\q"}'), ...sp.end()];
    expect(items.find((item) => "ok" in item && !item.ok)).toMatchObject({
      ok: false,
      failure: { kind: "policy-refused", issue: { refused: "invalid-escape" } },
    });
    sp.close();
  });

  it("refuses a stream that would retain more than maxRetained", () => {
    // Bounds what the parser holds while waiting, which a one-shot parse does not do: there the
    // whole input is already in hand and charging it would refuse documents `JSON.parse` accepts.
    const sp = stream({ maxRetained: 8 });
    // The limit is terminal, so the stream is over: `end()` after it would only answer
    // `stream-closed`, which says nothing about the bound.
    const items = [...sp.feed(`{"a":"${"x".repeat(64)}"}`)];
    const failed = items.flatMap((i) => ("ok" in i && !i.ok ? [i.failure] : []));
    expect(failed.map((f) => (f.kind === "limit-reached" ? f.resource : f.kind))).toEqual([
      "retained",
    ]);
    const retained = failed[0];
    if (retained?.kind !== "limit-reached") throw new Error("expected retained limit failure");
    expect(retained.at).toEqual({ offset: 12, unit: "utf16", chunk: 0 });
  });

  it("releases a delivered occurrence from maxRetained", () => {
    // A delivered scalar is the consumer's; still charging it refused long streams the bound fits.
    const sp = stream({ select: select([[ANY]], { occurrences: true }), maxRetained: 60 });
    const text = `[${Array.from({ length: 200 }, () => '"xxxxxxxxxx"').join(",")}]`;
    expect(values([...sp.feed(text), ...sp.end()])).toHaveLength(200);
  });
});

describe("scalar fragments", () => {
  it("keeps a withheld whitespace refusal in its original byte chunk", () => {
    const parser = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      recover: { "non-json-whitespace": false },
    });
    try {
      Array.from(parser.feed("{"));
      expect(fragmentText(values(parser.feed(new TextEncoder().encode('"a":hello'))))).toBe(
        "hello",
      );
      Array.from(parser.feed(new TextEncoder().encode("\u00A0")));
      for (let i = 0; i < 10; i++) Array.from(parser.feed(" "));
      const stopped = [...parser.feed("}"), ...parser.end()];
      expect(stopped.at(-1)).toMatchObject({
        failure: {
          kind: "policy-refused",
          issue: {
            refused: "non-json-whitespace",
            at: { chunk: 2, offset: 0, unit: "byte" },
          },
        },
      });
    } finally {
      parser.close();
    }
  });

  it.each([true, false])("keeps an old byte position after mixed chunks (closed: %s)", (closed) => {
    const parser = stream({
      select: select([["é"]], { fragments: decodedFragments }),
      diagnostics,
      recover: { "unclosed-string": false },
    });
    const items: (Result<Fragment, unknown> | StreamSummary)[] = [];
    const feed = (chunk: string | Uint8Array): void => {
      for (const item of parser.feed(chunk)) items.push(item);
    };
    try {
      feed("{");
      feed(new TextEncoder().encode('"é":"'));
      for (let i = 0; i < 12; i++) feed(i % 2 === 0 ? "tail" : new TextEncoder().encode("é"));
      if (closed) feed('"}');
      for (const item of parser.end()) items.push(item);
      expect(fragmentText(values(closed ? items : items.slice(0, -1)))).toBe("tailé".repeat(6));
      const opening = { chunk: 1, offset: 5, unit: "byte" };
      if (closed) {
        expect(values(items).at(-1)).toMatchObject({
          kind: "end",
          span: {
            start: opening,
            end: { chunk: 14, offset: 1, unit: "utf16" },
          },
        });
      } else
        expect(items.at(-1)).toMatchObject({
          failure: {
            kind: "policy-refused",
            issue: { at: opening, refused: "unclosed-string" },
          },
        });
    } finally {
      parser.close();
    }
  });

  it.each(["hello", "tru"])(
    "preserves pending whitespace after %s becomes string content",
    (head) => {
      const parser = stream({ select: select([["a"]], { fragments: decodedFragments }) });
      const padding = " ".repeat(1024);
      try {
        const first = values([...parser.feed('{"a":' + head)]);
        expect(fragmentText(first)).toBe(head === "hello" ? head : "");
        for (let i = 0; i < 8; i++)
          expect(fragmentText(values([...parser.feed(padding)]))).toBe("");
        const last = [...parser.feed("e}"), ...parser.end()];
        const fragments = [...first, ...values(last)];
        expect(fragmentText(fragments)).toBe(head + padding.repeat(8) + "e");
        expect(fragments.filter((fragment) => fragment.kind === "end")).toHaveLength(1);
        expect(fragments.at(-1)).toMatchObject({ kind: "end", complete: true });
        for (const fragment of fragments)
          if (fragment.kind === "data") expect(fragment.text.length).toBeLessThanOrEqual(4096);
      } finally {
        parser.close();
      }
    },
  );

  it("keeps unselected word work near ordinary selection", () => {
    const source = '{"skip":' + "x".repeat(1048576) + ',"tail":"ready"}';
    const readTail = (fragments: boolean): string => {
      const parser = stream({
        select: fragments
          ? select([["tail"]], { fragments: decodedFragments })
          : select([["tail"]]),
        maxRetained: source.length * 2,
        maxBuffer: source.length * 2,
        maxScalar: source.length,
      });
      let text = "";
      try {
        const items = function* () {
          yield* parser.feed(source);
          yield* parser.end();
        };
        for (const item of items()) {
          if (!item.ok) throw new Error(item.failure.kind);
          if ("kind" in item.value) {
            if (item.value.kind === "data") text += item.value.text;
          } else if (typeof item.value.value === "string") text += item.value.value;
          else throw new Error("Selected tail is not a string");
        }
        return text;
      } finally {
        parser.close();
      }
    };
    expect(readTail(true)).toBe("ready");
    expect(readTail(false)).toBe("ready");
    // The eager-folding reader also passes this bound on V8; JSC is the discriminating run.
    if (process.versions.bun !== undefined)
      expect(
        costRatio(
          () => readTail(true),
          () => readTail(false),
        ),
      ).toBeLessThan(10);
  });

  it("bounds withheld unquoted layout after delivery without a successful end", () => {
    const parser = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      maxRetained: 32,
    });
    try {
      expect(fragmentText(values([...parser.feed('{"a":hello')]))).toBe("hello");
      const stopped = [...parser.feed(" ".repeat(1000))];
      expect(values(stopped.slice(0, -1)).some((fragment) => fragment.kind === "end")).toBe(false);
      expect(stopped.at(-1)).toMatchObject({
        failure: {
          kind: "limit-reached",
          resource: "retained",
          recovered: { cut: { kind: "string", path: ["a"], text: " ".repeat(32) } },
        },
      });
    } finally {
      parser.close();
    }
  });

  it("withholds an unquoted string under a disabled recovery policy until completion", () => {
    const parser = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      recover: { "unquoted-string": false },
    });
    try {
      expect([...parser.feed('{"a":hello')]).toEqual([]);
      const items = [...parser.feed("}"), ...parser.end()];
      expect(items.at(-1)).toMatchObject({
        failure: { kind: "policy-refused", issue: { refused: "unquoted-string" } },
      });
      expect(fragmentText(values(items.slice(0, -1)))).toBe("hello");
    } finally {
      parser.close();
    }
  });

  it("keeps interior whitespace and a split surrogate pair while dropping trailing layout", () => {
    const parser = stream({ select: select([["a"]], { fragments: decodedFragments }) });
    try {
      const first = values([...parser.feed('{"a":hello ')]);
      expect(fragmentText(first)).toBe("hello");
      const second = values([...parser.feed("world\uD83D")]);
      expect(fragmentText(second)).toBe(" world");
      const third = values([...parser.feed("\uDE00  ")]);
      expect(fragmentText(third)).toBe("😀");
      const last = [...parser.feed("}"), ...parser.end()];
      expect(fragmentText(values(last))).toBe("");
      expect(values(last).at(-1)).toMatchObject({ kind: "end", complete: true });
    } finally {
      parser.close();
    }
  });

  it("drains a caller-sized unquoted string without banking the whole value", () => {
    const parser = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      maxRetained: 256,
      diagnostics,
    });
    const text = "hello ".repeat(10000) + "done";
    try {
      const items = [...parser.feed('{"a":' + text + "\u00A0}"), ...parser.end()];
      expect(fragmentText(values(items))).toBe(text);
      expect(values(items).at(-1)).toMatchObject({ kind: "end", complete: true });
      const repairs = items.flatMap((item) => item.diagnostics?.repairs ?? []);
      expect(repairs.map((entry) => [entry.kind, entry.at.offset])).toEqual([
        ["non-json-whitespace", 5 + text.length],
        ["unquoted-string", 5],
      ]);
      expect(values(items).at(-1)).toMatchObject({
        span: { start: { offset: 5 }, end: { offset: 6 + text.length } },
      });
    } finally {
      parser.close();
    }
  });

  it.each(["true", "FALSE", "null", "None", "undefined", "NaN", "Infinity", "-Infinity"])(
    "withholds the literal candidate %s until its delimiter",
    (literal) => {
      const parser = stream({ select: select([["a"]], { fragments: decodedFragments }) });
      try {
        expect([...parser.feed('{"a":')]).toEqual([]);
        for (const unit of literal) expect([...parser.feed(unit)]).toEqual([]);
        const items = [...parser.feed("}"), ...parser.end()];
        const oracle = parse('{"a":' + literal + "}");
        if (!oracle.ok) throw new Error("Literal oracle refused");
        const expected = (oracle.value as { a: unknown }).a;
        expect(fragmentText(values(items))).toBe(String(expected));
        expect(values(items)[0]).toMatchObject({
          kind: "start",
          scalar: typeof expected === "number" ? "number" : "literal",
        });
      } finally {
        parser.close();
      }
    },
  );

  it.each([false, true])(
    "streams a proven unquoted string within retained bounds (cut: %s)",
    (cut) => {
      const parser = stream({
        select: select([["a"]], { fragments: decodedFragments }),
        maxRetained: 256,
        cutSuffix: "…",
      });
      const piece = "hello".repeat(25);
      const fragments: Fragment[] = [];
      try {
        expect([...parser.feed('{"a":')]).toEqual([]);
        for (let index = 0; index < 8; index++) {
          const items = [...parser.feed(piece)];
          const delivered = values(items);
          expect(fragmentText(delivered)).toBe(piece);
          for (const fragment of delivered) fragments.push(fragment);
        }
        const final = cut ? [...parser.end()] : [...parser.feed("}"), ...parser.end()];
        for (const fragment of values(final)) fragments.push(fragment);
        expect(fragmentText(fragments)).toBe(piece.repeat(8) + (cut ? "…" : ""));
        expect(fragments[0]).toMatchObject({ kind: "start", scalar: "string", path: ["a"] });
        expect(fragments.at(-1)).toMatchObject({ kind: "end", complete: !cut });
        expect(fragments.filter((fragment) => fragment.kind === "end")).toHaveLength(1);
      } finally {
        parser.close();
      }
    },
  );

  it.each([
    ["plain", "body", "body"],
    ["decoded escapes", "\\n\\u0061", "\na"],
    ["surrogate pair", "\\uD83D\\uDE00", "\uD83D\uDE00"],
  ])("delivers the common prefix before quote ambiguity settles (%s)", (_name, source, decoded) => {
    for (const tail of [undefined, 'tail"}', 'tail"x}']) {
      const parser = stream({
        select: select([["a"]], { fragments: decodedFragments }),
        diagnostics,
      });
      try {
        const first = [...parser.feed('{"a":"' + source + "',")];
        expect(fragmentText(values(first))).toBe(decoded);
        expect(values(first).some((fragment) => fragment.kind === "end")).toBe(false);
        const rest =
          tail === undefined ? [...parser.end()] : [...parser.feed(tail), ...parser.end()];
        const items = [...first, ...rest];
        expect(fragmentText(values(items))).toBe(tail === 'tail"}' ? decoded + "',tail" : decoded);
        expect(values(items).filter((fragment) => fragment.kind === "end")).toHaveLength(1);
        if (tail === 'tail"}') expect(kinds(items)).toEqual([]);
        else expect(kinds(items)).toContain("quote-mismatch");
      } finally {
        parser.close();
      }
    }
  });

  it("keeps queued fragments, their stop marker and summary after scanner disposal", () => {
    const parser = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      summary: true,
      maxBuffer: 128,
      maxRetained: 1024,
    });
    try {
      parser.feed('{"a":"small"}{"a":"body\',' + "x".repeat(32768));
      const items = [...parser.feed("{}")];
      const fragments = values(items.slice(0, -2));
      expect(fragmentText(fragments)).toBe("smallbody");
      expect(fragments.filter((fragment) => fragment.kind === "end")).toHaveLength(1);
      expect(items.find((item) => "ok" in item && !item.ok)).toMatchObject({
        failure: {
          kind: "limit-reached",
          resource: "retained",
          recovered: { cut: { path: ["a"], kind: "string" } },
        },
      });
      expect(items.at(-1)).toEqual({
        kind: "summary",
        complete: false,
        roots: 2,
        matches: 2,
        unmatched: [],
      });
    } finally {
      parser.close();
    }
  });

  it("keeps a terminal summary when the next feed settles a paused failure", () => {
    const parser = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      summary: true,
      maxBuffer: 128,
      maxRetained: 1024,
    });
    try {
      const drain = parser.feed('{"a":"body\',' + "x".repeat(32768));
      let stopped = false;
      for (let next = drain.next(); next.done !== true; next = drain.next()) {
        if ("ok" in next.value && !next.value.ok) {
          stopped = true;
          break;
        }
      }
      expect(stopped).toBe(true);
      expect([...parser.feed("{}")]).toEqual([
        { kind: "summary", complete: false, roots: 1, matches: 1, unmatched: [] },
      ]);
      expect([...drain]).toEqual([]);
    } finally {
      parser.close();
    }
  });

  it.each([false, true])(
    "counts released quote-replay source under maxBuffer (fragments: %s)",
    (fragments) => {
      const run = (ambiguous: boolean) => {
        const parser = fragments
          ? stream({
              select: select([["a"]], { fragments: decodedFragments }),
              maxBuffer: 128,
              maxRetained: 65536,
            })
          : stream({ maxBuffer: 128, maxRetained: 65536 });
        try {
          const items = [...parser.feed('{"kept":1,"a":"body' + (ambiguous ? "'," : ""))];
          let stopped = false;
          for (let chunk = 0; chunk < 100 && !stopped; chunk++) {
            for (const item of parser.feed("\\u0061")) {
              items.push(item);
              stopped ||= !item.ok;
            }
          }
          if (!stopped) {
            for (const item of parser.feed('"}')) items.push(item);
            for (const item of parser.end()) items.push(item);
          }
          return items;
        } finally {
          parser.close();
        }
      };
      const failed = run(true).find((item) => !item.ok);
      expect(failed).toMatchObject({
        ok: false,
        failure: {
          kind: "limit-reached",
          resource: "buffer",
          limit: 128,
          recovered: { complete: false },
        },
      });
      if (!fragments)
        expect(failed).toMatchObject({ failure: { recovered: { value: { kept: 1 } } } });
      const control = run(false);
      expect(control.some((item) => !item.ok)).toBe(false);
      expect(control.at(-1)).toMatchObject({
        ok: true,
        value: fragments
          ? { kind: "end", complete: true }
          : { kept: 1, a: "body" + "a".repeat(100) },
      });
    },
  );

  it.each(["}", ',"b":2}', ":3}", "oops}", ""])(
    "settles a waiting quote follower without changing recovered text or span (%s)",
    (suffix) => {
      const prefix = '{"a":"body\',suffix"';
      const parser = stream({ select: select([["a"]], { fragments: decodedFragments }) });
      try {
        const items = Array.from(parser.feed(prefix));
        for (let chunk = 0; chunk < 8; chunk++)
          for (const item of parser.feed(" \t\n".repeat(16))) items.push(item);
        expect(values(items).some((fragment) => fragment.kind === "end")).toBe(false);
        for (const item of parser.feed(suffix)) items.push(item);
        for (const item of parser.end()) items.push(item);
        const fits = suffix === "}" || suffix.startsWith(",") || suffix === "";
        const fragments = values(items);
        expect(fragmentText(fragments)).toBe(fits ? "body',suffix" : "body");
        expect(fragments.filter((fragment) => fragment.kind === "end")).toEqual([
          expect.objectContaining({
            complete: true,
            span: {
              start: { chunk: 0, offset: 5, unit: "utf16" },
              end: { chunk: fits ? 1 : 0, offset: fits ? 0 : 11, unit: "utf16" },
            },
          }),
        ]);
      } finally {
        parser.close();
      }
    },
  );

  it("does not rescan a quote follower's growing whitespace prefix", () => {
    // Both public routes consume the same whitespace chunks; only mismatch lookahead differs.
    const whitespace = " ".repeat(65536);
    const run = (ambiguous: boolean): string => {
      const middle = ambiguous ? "'," : ",";
      const parser = stream({ select: select([["a"]], { fragments: decodedFragments }) });
      let text = "";
      let completions = 0;
      const consume = (items: ReturnType<typeof parser.feed>): void => {
        for (const item of items) {
          if (!item.ok) throw new Error(item.failure.kind);
          if (item.value.kind === "data") text += item.value.text;
          if (item.value.kind === "end") completions++;
        }
      };
      try {
        consume(parser.feed('{"a":"body' + middle + 'suffix"'));
        for (let offset = 0; offset < whitespace.length; offset += 128)
          consume(parser.feed(whitespace.slice(offset, offset + 128)));
        consume(parser.feed("}"));
        consume(parser.end());
        if (completions !== 1) throw new Error("quote lookahead changed occurrence completion");
        return text;
      } finally {
        parser.close();
      }
    };
    const measured = (ambiguous: boolean) => {
      // Count source reads: elapsed ratios can fail from scheduling instead of repeated lookahead.
      // eslint-disable-next-line typescript/unbound-method -- The counter preserves the native receiver.
      const nativeRead = String.prototype.charCodeAt;
      let reads = 0;
      try {
        // eslint-disable-next-line no-extend-native -- Observe the synchronous public call, then restore.
        String.prototype.charCodeAt = function (this: string, index: number): number {
          reads++;
          return nativeRead.call(this, index);
        };
        return { text: run(ambiguous), reads };
      } finally {
        // eslint-disable-next-line no-extend-native -- No counter escapes into another test.
        String.prototype.charCodeAt = nativeRead;
      }
    };
    const plain = measured(false);
    const ambiguous = measured(true);
    expect(ambiguous.text).toBe("body',suffix");
    expect(plain.text).toBe("body,suffix");
    expect(plain.reads).toBeGreaterThan(whitespace.length);
    // One lookahead pass plus normal whitespace consumption; restarting each chunk is quadratic.
    expect(ambiguous.reads).toBeLessThan(plain.reads * 3);
  });

  it("stops large EOF fragment delivery when the consumer returns", () => {
    const sp = stream({ select: select([[]], { fragments: decodedFragments }) });
    try {
      Array.from(sp.feed(JSON.stringify("x".repeat(32768))));
      const output = sp.end();
      expect(output.next()).toMatchObject({
        done: false,
        value: { ok: true, value: { kind: "start" } },
      });
      expect(output.next()).toMatchObject({
        done: false,
        value: { ok: true, value: { kind: "data" } },
      });
      output.return?.();
      expect(output.next()).toEqual({ done: true, value: undefined });
      expect([...sp.feed("{}")]).toMatchObject([{ ok: false, failure: { kind: "stream-closed" } }]);
    } finally {
      sp.close();
    }
  });

  it("bounds an unread completed scalar by pieces while retaining the first excess item", () => {
    const digits = "1" + "0".repeat(32768);
    const sp = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      maxRetained: 9000,
    });
    try {
      sp.feed('{"a":' + digits + "}");
      const items = [...sp.feed('{"a":2}')];
      const fragments = values(items.slice(0, -1));
      const text = fragmentText(fragments);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(9000 + 8192);
      expect(text).toBe(digits.slice(0, text.length));
      expect(fragments.some((fragment) => fragment.kind === "end")).toBe(false);
      expect(items.at(-1)).toMatchObject({
        ok: false,
        failure: { kind: "limit-reached", resource: "unread", limit: 9000 },
      });
    } finally {
      sp.close();
    }
  });

  it.each(["settled ambiguity", "root string", "cut suffix", "closed exact number"])(
    "bounds final data pieces without changing scalar content (%s)",
    (route) => {
      const payload = "x\uD83D\uDE00".repeat(12000);
      const root = route === "root string";
      const cut = route === "cut suffix";
      const numeric = route === "closed exact number";
      const expected = numeric ? "1" + "0".repeat(32768) : cut ? "body" + payload : payload;
      const source = root
        ? JSON.stringify(payload)
        : cut
          ? '{"a":"body'
          : numeric
            ? '{"a":' + expected + "}"
            : '{"a":"' + payload.slice(0, 1000) + "'," + payload.slice(1000) + '"}';
      const recovered =
        route === "settled ambiguity"
          ? payload.slice(0, 1000) + "'," + payload.slice(1000)
          : expected;
      const sp = stream({
        select: select([root ? [] : ["a"]], { fragments: decodedFragments }),
        cutSuffix: cut ? payload : "",
        diagnostics,
      });
      try {
        const items = [...sp.feed(source), ...sp.end()];
        const fragments = values(items);
        expect(fragmentText(fragments)).toBe(recovered);
        expect(fragments[0]).toMatchObject({
          kind: "start",
          scalar: numeric ? "number" : "string",
        });
        expect(fragments.filter((fragment) => fragment.kind === "start")).toHaveLength(1);
        expect(fragments.filter((fragment) => fragment.kind === "end")).toHaveLength(1);
        expect(fragments.at(-1)).toMatchObject({ kind: "end", complete: !cut });
        if (cut)
          expect(kinds(items)).toEqual([
            "unclosed-string",
            "unclosed-object",
            "unclosed-string",
            "unclosed-object",
          ]);
        const pieces = fragments.filter((fragment) => fragment.kind === "data");
        expect(pieces.length).toBeGreaterThan(2);
        for (const piece of pieces) {
          expect(piece.text.length).toBeLessThan(16384);
          const last = piece.text.charCodeAt(piece.text.length - 1);
          expect(last >= 0xd8_00 && last <= 0xdb_ff).toBe(false);
        }
      } finally {
        sp.close();
      }
    },
  );

  it("keeps source positions after an ambiguous quote replays compacted input", () => {
    const sp = stream({ select: select([["a"]], { fragments: decodedFragments }) });
    try {
      Array.from(sp.feed('{"a":"body'));
      Array.from(sp.feed("',not-a-member"));
      const replayedEnd = values(sp.end()).find((fragment) => fragment.kind === "end");
      expect(replayedEnd).toMatchObject({
        span: {
          start: { chunk: 0, offset: 5, unit: "utf16" },
          end: { chunk: 1, offset: 1, unit: "utf16" },
        },
      });
    } finally {
      sp.close();
    }
  });

  it("withholds an ambiguous quote suffix instead of duplicating it at EOF", () => {
    const expected = "x".repeat(6000);
    const input = '{"a":"' + expected + "',not-a-member";
    for (const size of [input.length, 127]) {
      const sp = stream({ select: select([["a"]], { fragments: decodedFragments }), diagnostics });
      const items: (Result<Fragment, unknown> | StreamSummary)[] = [];
      try {
        for (let offset = 0; offset < input.length; offset += size)
          for (const item of sp.feed(input.slice(offset, offset + size))) items.push(item);
        for (const item of sp.end()) items.push(item);
        expect(fragmentText(values(items))).toBe(expected);
        expect(kinds(items)).toContain("quote-mismatch");
      } finally {
        sp.close();
      }
    }
  });

  it("charges an unpublished ambiguous suffix against maxRetained", () => {
    const sp = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      maxRetained: 32,
    });
    try {
      const items = [...sp.feed('{"a":"a\',' + "x".repeat(10000))];
      expect(items.find((item) => "ok" in item && !item.ok)).toMatchObject({
        ok: false,
        failure: { kind: "limit-reached", resource: "retained", limit: 32 },
      });
    } finally {
      sp.close();
    }
  });

  it.each([
    ["plain", "x", "x"],
    ["escaped", "\\n\\uD83D\\uDE00\\q", "\n\uD83D\uDE00\\q"],
    ["literal pair", "x\uD83D\uDE00", "x\uD83D\uDE00"],
  ])("delivers bounded pieces from a large caller chunk (%s)", (_name, source, decoded) => {
    const body = source.repeat(32768);
    for (const complete of [true, false]) {
      const text = '{"a":"' + body + (complete ? '"}' : "");
      const read = (size: number) => {
        const sp = stream({
          select: select([["a"]], { fragments: decodedFragments }),
          diagnostics,
          maxRetained: 256,
        });
        const items: (Result<Fragment, unknown> | StreamSummary)[] = [];
        try {
          for (let offset = 0; offset < text.length; offset += size)
            for (const item of sp.feed(text.slice(offset, offset + size))) items.push(item);
          for (const item of sp.end()) items.push(item);
          return items;
        } finally {
          sp.close();
        }
      };
      const items = read(text.length);
      const fragments = values(items);
      expect(fragmentText(fragments)).toBe(decoded.repeat(32768));
      expect(fragments.at(-1)).toMatchObject({ kind: "end", complete });
      const pieces = fragments.filter((fragment) => fragment.kind === "data");
      // A whole-token decoder produces one large piece even though its final text is correct.
      expect(pieces.length).toBeGreaterThan(1);
      for (const piece of pieces) {
        expect(piece.text.length).toBeLessThan(16384);
        const last = piece.text.charCodeAt(piece.text.length - 1);
        expect(last >= 0xd8_00 && last <= 0xdb_ff).toBe(false);
      }
      const small = read(127);
      expect(kinds(items)).toEqual(kinds(small));
      // Public spans use caller-chunk coordinates; compare the same absolute source locations.
      const events = (drainItems: typeof small, size: number) =>
        values(drainItems)
          .filter((fragment) => fragment.kind !== "data")
          .map((fragment) =>
            fragment.kind === "start"
              ? fragment
              : {
                  kind: fragment.kind,
                  id: fragment.id,
                  complete: fragment.complete,
                  span: {
                    start: (fragment.span.start.chunk ?? 0) * size + fragment.span.start.offset,
                    end: (fragment.span.end.chunk ?? 0) * size + fragment.span.end.offset,
                  },
                },
          );
      expect(events(items, text.length)).toEqual(events(small, 127));
    }
  });

  it.each([
    ["ASCII", "x", "y", "xy"],
    ["literal pair", "\uD83D", "\uDE00", "\uD83D\uDE00"],
    ["escaped pair", "\\uD83D", "\\uDE00", "\uD83D\uDE00"],
    ["lone high surrogate", "\uD83D", "", "\uD83D"],
  ])("keeps retained bounds after fragment decoder tails (%s)", (_name, first, second, decoded) => {
    const sp = stream({ select: select([[ANY]], { fragments: decodedFragments }), maxRetained: 8 });
    let text = "";
    const consume = (items: ReturnType<typeof sp.feed>): void => {
      for (const item of items) {
        if (!("ok" in item) || !item.ok) throw new Error("fragment failed before the retained key");
        if (item.value.kind === "data") text += item.value.text;
      }
    };
    try {
      consume(sp.feed("{"));
      // Source occurrences may leave under duplicate keys; they must not grant storage credit.
      for (let index = 0; index < 20; index++) {
        consume(sp.feed(`"a":"${first}`));
        consume(sp.feed(`${second}",`));
      }
      expect(text).toBe(decoded.repeat(20));
      const items = [...sp.feed(`"${"k".repeat(16)}`)];
      expect(items.find((item) => "ok" in item && !item.ok)).toMatchObject({
        ok: false,
        failure: { kind: "limit-reached", resource: "retained", limit: 8 },
      });
    } finally {
      sp.close();
    }
  });

  it("bounds unread fragment text without dropping queued pieces", () => {
    const piece = "x".repeat(128);
    const sp = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      maxRetained: 256,
    });
    try {
      // Ignored feeds remain parser-owned; counting records alone misses their string payloads.
      sp.feed('{"a":"');
      for (let index = 0; index < 4; index++) sp.feed(piece);
      const items = [...sp.end()];
      const fragments = values(items.slice(0, -1));
      expect(fragmentText(fragments)).toBe(piece.repeat(2));
      expect(fragments.filter((fragment) => fragment.kind === "start")).toHaveLength(1);
      const failure = items.find((item) => "ok" in item && !item.ok);
      if (failure === undefined || !("ok" in failure) || failure.ok)
        throw new Error("unread fragment text escaped its retained bound");
      expect(failure.failure.kind).toBe("limit-reached");
      if (failure.failure.kind === "limit-reached") expect(failure.failure.resource).toBe("unread");
    } finally {
      sp.close();
    }
  });

  it("releases delivered string fragments from the retained budget", () => {
    const piece = "x".repeat(128);
    const sp = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      maxRetained: 256,
    });
    let delivered = 0,
      ends = 0,
      starts = 0;
    const consume = (items: ReturnType<typeof sp.feed>): void => {
      for (const item of items) {
        if (!("ok" in item)) throw new Error("unexpected summary");
        if (!item.ok) throw new Error(`fragment delivery failed: ${item.failure.kind}`);
        const fragment = item.value;
        if (fragment.kind === "start") starts++;
        else if (fragment.kind === "end") {
          expect(fragment.complete).toBe(true);
          ends++;
        } else {
          expect(fragment.text).toBe(piece);
          delivered += fragment.text.length;
        }
      }
    };
    try {
      consume(sp.feed('{"a":"'));
      // One open scalar exceeds the bound many times; only undecided text may stay parser-owned.
      for (let index = 0; index < 1024; index++) consume(sp.feed(piece));
      consume(sp.feed('"}'));
      consume(sp.end());
      expect({ starts, ends, delivered }).toEqual({ starts: 1, ends: 1, delivered: 131072 });
    } finally {
      sp.close();
    }

    const whole = stream({ select: select([["a"]]), maxRetained: 256 });
    try {
      const failure = [...whole.feed('{"a":"' + piece.repeat(4) + '"}')].find(
        (item) => "ok" in item && !item.ok,
      );
      if (failure === undefined || !("ok" in failure) || failure.ok)
        throw new Error("whole-value selection ignored its retained bound");
      expect(failure.failure.kind).toBe("limit-reached");
      if (failure.failure.kind === "limit-reached")
        expect(failure.failure.resource).toBe("retained");
    } finally {
      whole.close();
    }
  });

  it("follows the input by at most one character", () => {
    // A renderer streaming a field shows what arrived, not what arrived six characters ago. Only
    // the OTHER quote kind is held: whether it ends the string depends on the character after it.
    const sp = stream({ select: select([["a"]], { fragments: decodedFragments }) });
    Array.from(sp.feed('{"a":"'));
    const body = "it's one two three";
    let shown = "";
    for (let typed = 1; typed <= body.length; typed++) {
      for (const f of values(sp.feed(body.charAt(typed - 1))))
        if (f.kind === "data") shown += f.text;
      const held = body.charAt(typed - 1) === "'" ? 1 : 0;
      expect(shown, body.slice(0, typed)).toBe(body.slice(0, typed - held));
    }
  });

  it("delivers nothing from a top-level string that prose then follows", () => {
    // A root string stands alone only once the input ends; `"hello" today` is a sentence. A
    // fragment or an occurrence cannot be taken back, so neither may leave while the root is held.
    const text = '"hello world" today';
    for (const settings of [{ fragments: decodedFragments }, { occurrences: true }] as const) {
      for (const size of [1, 3, 14]) {
        const sp = stream({ select: select([[]], settings) });
        const items: unknown[] = [];
        for (let i = 0; i < text.length; i += size) items.push(...sp.feed(text.slice(i, i + size)));
        items.push(...sp.end());
        expect(items, `${JSON.stringify(settings)} by ${size}`).toEqual([
          { ok: false, failure: { kind: "no-json-found" } },
        ]);
      }
    }
  });

  it("names a selected root container it cannot stream with the root path", () => {
    const sp = stream({ select: select([[]], { fragments: decodedFragments }) });
    expect([...sp.feed('{"a":1}'), ...sp.end()]).toEqual([
      {
        ok: false,
        failure: { kind: "non-scalar-selection", path: [] },
      },
    ]);
  });

  it("keeps the invalid-escape repair of a string read across chunks", () => {
    const text = '{"bad": "\\u12G5 and a tail long enough to be banked"}';
    const outcome = parse(text, { diagnostics });
    expect(outcome.ok).toBe(true);
    const whole = kinds([outcome]);
    expect(whole).toEqual(["invalid-escape"]);
    for (const size of [1, 3, 5]) {
      const sp = stream({ diagnostics });
      const items: unknown[] = [];
      for (let i = 0; i < text.length; i += size) items.push(...sp.feed(text.slice(i, i + size)));
      items.push(...sp.end());
      expect(items).toMatchObject([{ ok: true }]);
      expect(kinds(items), `by ${size}`).toEqual(whole);
    }
  });

  it("finishes a short string drain without restarting the same occurrence", () => {
    const sp = stream({
      select: select([["a"]], { fragments: decodedFragments }),
      diagnostics,
      summary: true,
    });
    const drain = sp.feed('{a:"ab');
    try {
      expect(drain.next()).toMatchObject({
        done: false,
        value: { ok: true, value: { kind: "start", id: 0 } },
      });
      // The decided text leaves at once; the drain then ENDS. Pull explicitly: collecting a broken
      // drain would allocate forever instead of failing here.
      expect(drain.next()).toMatchObject({
        done: false,
        value: { ok: true, value: { kind: "data", id: 0, text: "ab" } },
      });
      expect(drain.next()).toEqual({ done: true, value: undefined });
    } finally {
      drain.return?.();
    }
    const tail = values(sp.feed('cd"} {a:"next"}'));
    expect(tail.filter((f) => f.kind === "data").map((f) => [f.id, f.text])).toEqual([
      [0, "cd"],
      [1, "next"],
    ]);
    expect(tail.filter((f) => f.kind === "end").map((f) => f.id)).toEqual([0, 1]);
    expect([...sp.end()]).toContainEqual({
      kind: "summary",
      complete: true,
      roots: 2,
      matches: 2,
      unmatched: [],
    });
  });

  it("streams a selected string without ever holding it whole", () => {
    const sp = stream({
      select: select([["msg"]], { fragments: decodedFragments }),
      summary: true,
    });
    const first = values([...sp.feed('{"msg":"hello wo')]);
    // The text read so far leaves before the string closes; a reader that buffers it whole fails here.
    expect(fragmentText(first)).toBe("hello wo");
    const got: readonly Fragment[] = [...first, ...values([...sp.feed('rld", "n": 1}')])];
    expect(got[0]).toMatchObject({ kind: "start", path: ["msg"], scalar: "string" });
    // Where the pieces are cut is internal batching; that they concatenate to the source is not.
    expect(fragmentText(got)).toBe("hello world");
    expect(got.at(-1)?.kind).toBe("end");
    expect([...sp.end()]).toEqual([
      { kind: "summary", complete: true, roots: 1, matches: 1, unmatched: [] },
    ]);
  });

  it("says on `end` whether the source finished the value or ran out inside it", () => {
    // Without it a consumer cannot tell `"hel` from `"hel"`: both arrive as `hel` and an `end`.
    const endsComplete = (path: string[], text: string, size: number): boolean[] => {
      const sp = stream({ select: select([path], { fragments: decodedFragments }) });
      const items: (Result<Fragment, unknown> | StreamSummary)[] = [];
      for (let i = 0; i < text.length; i += size) items.push(...sp.feed(text.slice(i, i + size)));
      items.push(...sp.end());
      return values(items)
        .filter((f) => f.kind === "end")
        .map((f) => f.complete);
    };
    const long = "a string long enough to be streamed in pieces";
    const cases: [string[], string, boolean][] = [
      [["a"], '{"a":"hel', false],
      [["a"], `{"a":"${long}`, false],
      [["a"], '{"a":"hel"', true],
      // A number the end touched may be the start of a longer one; a literal cannot grow.
      [["a"], '{"a":12', false],
      [["a"], '{"a":12,', true],
      [["a"], '{"a":true', true],
      [[], '"hel', false],
      [[], '"hel"', true],
    ];
    for (const [path, text, complete] of cases)
      for (const size of [1, 4, text.length])
        expect(endsComplete(path, text, size), `${text} by ${size}`).toEqual([complete]);
  });

  it("fails the root when a selected value turns out to be a container", () => {
    const sp = stream({ select: select([["a"]], { fragments: decodedFragments }) });
    const items = [...sp.feed('{"a":[1]}'), ...sp.end()];
    expect(items.map((i) => ("ok" in i && !i.ok ? i.failure.kind : i))).toEqual([
      "non-scalar-selection",
    ]);
  });

  it("refuses fragments outside a stream and refuses to pair them with a view", () => {
    expect(configurationCause(() => select([], { fragments: true } as never))).toMatchObject({
      field: "select.fragments",
      reason: "import-required",
    });
    // Fragments are a `select` setting, so "fragments without a selection" cannot be written; what
    // remains is a fragments selection handed to a verb that returns whole results.
    const fragments = select([["a"]], { fragments: decodedFragments });
    expect(configurationCause(() => parse("{}", { select: fragments } as never))).toEqual({
      kind: "invalid-options",
      field: "select",
      reason: "fragments-stream",
    });
    expect(
      configurationCause(() =>
        createStreamParser({
          select: select([["a"]], { fragments: decodedFragments }),
          view: ownedView,
        } as never),
      ),
    ).toEqual({
      // Names `view` rather than `fragments`: fragments are what the caller asked the parser to
      // do, the view is the incompatible extra, and the reason code names the pair either way.
      kind: "invalid-options",
      field: "view",
      reason: "fragments-view",
    });
  });
});
