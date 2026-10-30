// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createStreamParser, select, skip } from "../src/index";
import type { StreamItem, StreamParserOptions } from "../src/index";

// Drain every chunk so only the unfinished root, not unread results, owns the budget.
const consume = (text: string, options: StreamParserOptions, split: boolean) => {
  const stream = createStreamParser(options);
  const items: StreamItem[] = [];
  try {
    for (const chunk of split ? text : [text]) {
      for (const item of stream.feed(chunk)) {
        items.push(item);
        if ("ok" in item && !item.ok) return items;
      }
    }
    for (const item of stream.end()) items.push(item);
    return items;
  } finally {
    stream.close();
  }
};

describe.each([false, true])("retained ownership with split input %s", (split) => {
  it.each([
    ['"a":1', { a: 1 }],
    ['"a":{"b":[1,2]}', { a: { b: [1, 2] } }],
  ] as const)("releases the previous member in %s", (member, value) => {
    const text = `{${Array.from({ length: 20 }, () => member).join(",")}}`;
    expect(consume(text, { maxRetained: 16 }, split)).toEqual([
      { ok: true, value, complete: true },
    ]);
  });

  it("releases final matches when a duplicate ancestor replaces them", () => {
    const text = `{${Array.from({ length: 20 }, () => '"a":{"b":[1,2]}').join(",")}}`;
    expect(consume(text, { maxRetained: 16, select: select([["a", "b"]]) }, split)).toMatchObject([
      {
        ok: true,
        value: { path: ["a", "b"], value: [1, 2] },
      },
    ]);
  });

  it("releases skipped member keys", () => {
    const text = `{${Array.from({ length: 20 }, () => '"skip":1').join(",")},"ok":2}`;
    expect(consume(text, { maxRetained: 16, skip: skip([["skip"]]) }, split)).toEqual([
      { ok: true, value: { ok: 2 }, complete: true },
    ]);
  });

  it("releases dangling keys when their containers close", () => {
    const items = consume('{"a":{"discard":},"b":[1,2,3,4,5,6,7,8,9]}', { maxRetained: 16 }, split);
    expect(items).toEqual([
      { ok: true, value: { a: {}, b: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, complete: true },
    ]);
  });

  it("releases discarded keys when their replacements arrive", () => {
    // The budget holds both the old reporting context and the incoming key, but not their history.
    expect(
      consume('{"a":1,"discard","discard","discard","b":2}', { maxRetained: 24 }, split),
    ).toEqual([{ ok: true, value: { a: 1, b: 2 }, complete: true }]);
  });

  it.each(['"__proto__":1', '"__proto__":{"a":[1,2]}'])(
    "releases dropped members in %s",
    (member) => {
      const text = `{${Array.from({ length: 20 }, () => member).join(",")},"ok":2}`;
      expect(consume(text, { maxRetained: 16, onDangerousKey: "drop" }, split)).toEqual([
        { ok: true, value: { ok: 2 }, complete: true },
      ]);
    },
  );

  it("keeps live content charged after overlapping selected matches are replaced", () => {
    const repeated = Array.from({ length: 20 }, () => '"a":{"b":[1,2]}').join(",");
    const text = `{${repeated},"a":{"b":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]}}`;
    const items = consume(text, { maxRetained: 16, select: select([["a"], ["a", "b"]]) }, split);
    expect(items).toMatchObject([
      {
        ok: false,
        failure: { kind: "limit-reached", resource: "retained" },
      },
    ]);
    const failure = items[0];
    if (failure === undefined || !("ok" in failure) || failure.ok) throw new Error("missing limit");
    // The oversized final member must be the cause; old history must not stop earlier input.
    if (failure.failure.kind !== "limit-reached") throw new Error("wrong failure");
    const at = failure.failure.at;
    expect(at === undefined ? -1 : split ? at.chunk : at.offset).toBeGreaterThan(repeated.length);
  });

  it("counts both the old value and an unfinished replacement", () => {
    const items = consume('{"a":"12345678","a":"12345678"}', { maxRetained: 16 }, split);
    expect(items).toMatchObject([
      {
        ok: false,
        failure: { kind: "limit-reached", resource: "retained" },
      },
    ]);
  });

  it.each([false, skip([["a", "__proto__"]])] as const)(
    "releases a refused object's contents even when its dangerous key is skipped: %s",
    (skipping) => {
      const text = '{"a":{"b":[1,2,3,4,5],"__proto__":0},"c":[1,2,3,4,5]}';
      const items = consume(
        text,
        { maxRetained: 24, onDangerousKey: "reject", skip: skipping },
        split,
      );
      expect(items).toMatchObject([
        {
          ok: false,
          failure: {
            kind: "policy-refused",
            recovered: { value: { a: {}, c: [1, 2, 3, 4, 5] } },
          },
        },
      ]);
    },
  );
});
