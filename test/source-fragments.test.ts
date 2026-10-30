// SPDX-License-Identifier: Apache-2.0

import { decodedFragments } from "../src/index";

import { describe, expect, it } from "vitest";
import { createStreamParser, select, sourceFragments, parseStream } from "../src/index";
import type { Result, SourceFragment, StreamFailure } from "../src/index";

const selection = select([["x"]], { fragments: sourceFragments });

const piecesOf = <Piece>(
  items: Iterable<Result<Piece, StreamFailure>>,
  context = "fragment delivery",
): Piece[] => {
  // Filtering to successes hides a failure emitted beside otherwise correct text and end markers.
  const pieces: Piece[] = [];
  for (const item of items) {
    if (!item.ok) throw new Error(`${context}: ${item.failure.kind}`, { cause: item.failure });
    pieces.push(item.value);
  }
  return pieces;
};

describe("source fragments", () => {
  it.each([
    ["0x100", "number"],
    ["1.5000", "number"],
    ["123oops", "string"],
    ["0x100oops", "string"],
    ["true", "literal"],
    ["undefined", "literal"],
    ["TRUE", "literal"],
    ["none", "literal"],
    ["hello   ", "string"],
    ['"a\\u0062\\n"', "string"],
    ["'a\\'b'", "string"],
    ['"a\uD800\uDC00b"', "string"],
  ] as const)("preserves %s at every caller split", (token, scalar) => {
    const input = `{"x":${token}}`;
    for (let split = 0; split <= input.length; split++) {
      const parser = createStreamParser({ select: selection });
      const items = [
        ...parser.feed(input.slice(0, split)),
        ...parser.feed(input.slice(split)),
        ...parser.end(),
      ];
      const pieces = piecesOf(items, `split ${split}`);
      expect(
        pieces
          .filter((piece) => piece.kind === "data")
          .map((piece) => piece.text)
          .join(""),
        `split ${split}`,
      ).toBe(token);
      expect(pieces.filter((piece) => piece.kind === "start")).toHaveLength(1);
      expect(pieces.at(-1)).toMatchObject({ kind: "end", scalar, complete: true });
      const reference = createStreamParser({
        select: select([["x"]], { fragments: decodedFragments }),
      });
      const matches = piecesOf(
        [
          ...reference.feed(input.slice(0, split)),
          ...reference.feed(input.slice(split)),
          ...reference.end(),
        ],
        `decoded reference split ${split}`,
      );
      expect(pieces.find((piece) => piece.kind === "end")?.span).toEqual(
        matches.find((piece) => piece.kind === "end")?.span,
      );
      reference.close();
      parser.close();
    }
  });

  it.each(["0x", "123", "1e", "tru", '"a\\u00', '"unfinished'])(
    "keeps unfinished source %s without generated suffix or replay",
    (token) => {
      const parser = createStreamParser({ select: selection, cutSuffix: "…" });
      const items = [...parser.feed(`{"x":${token}`), ...parser.end()];
      const pieces = piecesOf(items);
      expect(
        pieces
          .filter((piece) => piece.kind === "data")
          .map((piece) => piece.text)
          .join(""),
      ).toBe(token);
      expect(pieces.at(-1)).toMatchObject({ kind: "end", complete: false });
      parser.close();
    },
  );

  it.each(["7", "0xf", "token", '"a\\n'])(
    "delivers growing %s before its closer under a small retained budget",
    (prefix) => {
      const parser = createStreamParser({ select: selection, maxRetained: 128 });
      let received = "";
      let ended = false;
      const take = (items: ReturnType<typeof parser.feed>): void => {
        for (const item of items) {
          expect("ok" in item && item.ok).toBe(true);
          if (!("ok" in item) || !item.ok) continue;
          if (item.value.kind === "data") received += item.value.text;
          if (item.value.kind === "end") ended = true;
        }
      };
      take(parser.feed(`{"x":${prefix}`));
      const extension = prefix === "7" ? "7" : prefix === "0xf" ? "f" : "a";
      for (let index = 0; index < 32; index++) {
        take(parser.feed(extension.repeat(1024)));
        expect(received.length).toBe(prefix.length + (index + 1) * 1024);
        expect(ended).toBe(false);
      }
      take(parser.feed(prefix.startsWith('"') ? '"}' : "}"));
      take(parser.end());
      expect(ended).toBe(true);
      parser.close();
    },
  );

  it.each([
    ['{"x":"a\',b"}', '"a\',b"'],
    ['{"x":"a\', "y":1}', "\"a'"],
  ])("settles ambiguous quotes without publishing replay lookahead: %s", (input, expected) => {
    for (let split = 0; split <= input.length; split++) {
      const parser = createStreamParser({ select: selection });
      const pieces = piecesOf(
        [
          ...parser.feed(input.slice(0, split)),
          ...parser.feed(input.slice(split)),
          ...parser.end(),
        ],
        `split ${split}`,
      );
      expect(
        pieces
          .filter((piece) => piece.kind === "data")
          .map((piece) => piece.text)
          .join(""),
        `split ${split}`,
      ).toBe(expected);
      expect(pieces.filter((piece) => piece.kind === "end")).toHaveLength(1);
      parser.close();
    }
  });

  it.each(["7".repeat(16384), '"' + "x".repeat(16384) + '"'])(
    "bounds single-chunk delivery without retaining a complete scalar",
    (token) => {
      const parser = createStreamParser({ select: selection, maxRetained: 128 });
      const pieces = [...parser.feed(`{"x":${token}}`), ...parser.end()];
      expect(pieces.every((item) => "ok" in item && item.ok)).toBe(true);
      const data = pieces.flatMap((item) =>
        "ok" in item && item.ok && item.value.kind === "data" ? [item.value.text] : [],
      );
      expect(data.join("")).toBe(token);
      expect(data.every((text) => text.length <= 4096)).toBe(true);
      parser.close();
    },
  );

  it("refuses numeric policy without manufacturing a successful end", () => {
    const parser = createStreamParser({ select: selection, recover: { "hex-number": false } });
    const items = [...parser.feed('{"x":0x100}'), ...parser.end()];
    expect(
      items.some((item) => "ok" in item && !item.ok && item.failure.kind === "policy-refused"),
    ).toBe(true);
    expect(items.some((item) => "ok" in item && item.ok && item.value.kind === "end")).toBe(false);
    parser.close();
  });

  it.each(["true", "123", '"hello"'])("keeps selected root candidacy: %s", (token) => {
    const parser = createStreamParser({ select: select([[]], { fragments: sourceFragments }) });
    expect([...parser.feed(token)]).toEqual([]);
    const pieces = piecesOf(parser.end());
    expect(
      pieces
        .filter((piece) => piece.kind === "data")
        .map((piece) => piece.text)
        .join(""),
    ).toBe(token);
    expect(pieces.at(-1)).toMatchObject({ kind: "end", complete: true });
    parser.close();
  });

  it("does not publish source occurrences from a rejected prose root", () => {
    const parser = createStreamParser({ select: select([[]], { fragments: sourceFragments }) });
    const items = [...parser.feed('"hello" today'), ...parser.end()];
    expect(items).toEqual([{ ok: false, failure: { kind: "no-json-found" } }]);
    parser.close();
  });

  it("drops rejected scalar state before scanning a later object", () => {
    const parser = createStreamParser({ select: select([[]], { fragments: sourceFragments }) });
    const items = [...parser.feed('"hello" today {"x":1}'), ...parser.end()];
    const values = items.flatMap((item) => ("ok" in item && item.ok ? [item.value] : []));
    expect(values).toEqual([]);
    expect(
      items.some(
        (item) => "ok" in item && !item.ok && item.failure.kind === "non-scalar-selection",
      ),
    ).toBe(true);
    parser.close();
  });

  it("keeps trailing layout complete after the literal candidate is disproved", () => {
    const parser = createStreamParser({ select: selection });
    const items = [
      ...parser.feed('{"x":long ordinary text'),
      ...parser.feed("   "),
      ...parser.end(),
    ];
    const values = piecesOf(items);
    expect(
      values
        .filter((piece) => piece.kind === "data")
        .map((piece) => piece.text)
        .join(""),
    ).toBe("long ordinary text   ");
    expect(values.at(-1)).toMatchObject({ kind: "end", scalar: "string", complete: true });
    parser.close();
  });

  it("preserves decoded source and chunk units across split UTF-8 and text input", () => {
    const parser = createStreamParser({ select: selection });
    const chunks = [
      new TextEncoder().encode('{"x":"A'),
      new Uint8Array([0xe2, 0x82]),
      new Uint8Array([0xac]),
      '💩\\uD800"}',
    ];
    const pieces: SourceFragment[] = [];
    for (const chunk of chunks)
      for (const item of parser.feed(chunk)) {
        expect(item.ok).toBe(true);
        if (item.ok) pieces.push(item.value);
      }
    for (const item of parser.end()) {
      expect(item.ok).toBe(true);
      if (item.ok) pieces.push(item.value);
    }
    expect(
      pieces
        .filter((piece) => piece.kind === "data")
        .map((piece) => piece.text)
        .join(""),
    ).toBe('"A€💩\\uD800"');
    expect(pieces.at(-1)).toMatchObject({
      kind: "end",
      span: {
        start: { chunk: 0, offset: 5, unit: "byte" },
        end: { chunk: 3, offset: 9, unit: "utf16" },
      },
    });
    parser.close();
  });

  it("keeps distinct source occurrences when a duplicate ancestor replaces the first", () => {
    const parser = createStreamParser({
      select: select([["a", "x"]], { fragments: sourceFragments }),
    });
    const items = [...parser.feed('{"a":{"x":0x10},"a":{"x":"\\u0061"}}'), ...parser.end()];
    const text = new Map<number, string>();
    const ended: number[] = [];
    for (const item of items) {
      expect(item.ok).toBe(true);
      if (!item.ok) continue;
      if (item.value.kind === "data")
        text.set(item.value.id, (text.get(item.value.id) ?? "") + item.value.text);
      if (item.value.kind === "end") ended.push(item.value.id);
    }
    expect([...text]).toEqual([
      [0, "0x10"],
      [1, '"\\u0061"'],
    ]);
    expect(ended).toEqual([0, 1]);
    parser.close();
  });

  it("retains delivered pieces on producer failure without an end", async () => {
    const cause = new Error("source stopped");
    async function* source() {
      yield '{"x":123';
      throw cause;
    }
    const pieces: SourceFragment[] = [];
    const failures = [];
    for await (const item of parseStream(source(), { select: selection })) {
      if ("ok" in item) {
        if (item.ok) pieces.push(item.value);
        else failures.push(item.failure);
      }
    }
    expect(failures).toMatchObject([{ kind: "source-failed", cause }]);
    expect(
      pieces
        .filter((piece) => piece.kind === "data")
        .map((piece) => piece.text)
        .join(""),
    ).toBe("123");
    expect(pieces.some((piece) => piece.kind === "end")).toBe(false);
  });
});
