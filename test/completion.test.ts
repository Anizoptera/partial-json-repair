// SPDX-License-Identifier: Apache-2.0

import { decodedFragments } from "../src/index";

/**
 * `complete` and `cut` must not depend on the route a caller took (HLD P3): a stream that has seen
 * the whole input reports, at `end()`, the root a whole-input `parse` returns, with the same value,
 * the same completion and the same cut, and a refusal names the same line and column. Compared at
 * `end()`, never mid-stream, because a snapshot withholds numbers and words still being read by
 * design. A stream may quote a shorter context and gives chunk-local offsets, so neither is compared.
 *
 * The stream is fed in chunks, because a chunk boundary is where its carried state (a token still
 * being read, a comment, a held root, a deferred error budget) can part from one whole read. Thirds
 * put two boundaries in every input, and a released prefix ahead of the second: one boundary missed
 * a fence whose indentation was split. Under `STRICT` a short whole input (a document, a mutation, a
 * hazard) goes one character at a time, a boundary at every position, which put one inside a string
 * a later refusal belonged to. Its stops decide where each route ends. Other profiles, long inputs
 * and sampled prefixes use thirds to bound repeated whole-source work; those cuts do not cover
 * every possible chunking.
 *
 * `cutSuffix` is the one option that writes into a cut value, so it is held to the same rule on
 * every route that can show one: `parse`, a stream's `end()`, a snapshot, and `repair()` text.
 */
import { describe, expect, it } from "vitest";

import { inspect } from "node:util";

import type { ParserOptions } from "../src/options";
import { COMPAT, createStreamParser, initParser, LLM_FULL, STRICT, select } from "../src/index";
import { differentialInputs, same, slices } from "./corpus-population";
import { parse as configuredParse, repair as configuredRepair } from "../src/index";
import { sharedView } from "../src/index";

type Facts = {
  ok: boolean;
  value?: unknown;
  complete?: boolean | undefined;
  cut?: unknown;
  kind?: unknown;
  /** Where a refusal points, as `kind@line:column`; the offset is chunk-local on a stream, the context shorter. */
  issue?: string;
};
type AnyOutcome = {
  ok: boolean;
  value?: unknown;
  complete?: boolean;
  cut?: unknown;
  failure?: unknown;
};

/** The fields a route must agree on, from either branch of an outcome. */
const factsOf = (outcome: AnyOutcome): Facts => {
  if (outcome.ok)
    return { ok: true, value: outcome.value, complete: outcome.complete, cut: outcome.cut };
  const failure = outcome.failure as
    | { kind?: unknown; recovered?: Facts; issue?: { kind: string; line: number; column: number } }
    | undefined;
  const r = failure?.recovered;
  const i = failure?.issue;
  return {
    ok: false,
    kind: failure?.kind,
    value: r?.value,
    complete: r?.complete,
    cut: r?.cut,
    ...(i === undefined ? {} : { issue: `${i.kind}@${i.line}:${i.column}` }),
  };
};

/**
 * Profiles that change what is cut or how a cut is recovered: refusals and budgets (`STRICT`), the
 * legacy readings (`COMPAT`), every repair on (`LLM_FULL`). The pre-scan differential covers the
 * narrower option switches against the same population.
 */
const PROFILES: readonly (readonly [string, ParserOptions])[] = [
  ["default", {}],
  ["STRICT", STRICT],
  ["COMPAT", COMPAT],
  ["LLM_FULL", LLM_FULL],
];

/**
 * Built once: reading and decoding the corpus costs more than one profile's comparisons. Split into
 * whole inputs and prefixes, so a failing case says which one diverged, and each into `slices` to
 * keep every case inside the per-case time budget.
 */
const ALL = differentialInputs();
const GROUPS = [
  ["whole inputs", ALL.filter(({ kind }) => !kind.endsWith("prefix"))],
  ["prefixes", ALL.filter(({ kind }) => kind.endsWith("prefix"))],
] as const;
const CASES = PROFILES.flatMap(([name, options]) =>
  GROUPS.flatMap(([group, inputs]) =>
    slices(inputs).map(
      (slice) => [`${name}, ${group} ${slice.range}`, name, options, slice.items] as const,
    ),
  ),
);

/**
 * Bound per-character feeding on large inputs; the differential population already includes their
 * sampled prefixes. Three chunks remain a sample, not proof of every possible boundary.
 */
const LONG = 4096;

/** Every character for a whole input under `STRICT`; thirds otherwise. */
const chunksOf = (text: string, kind: string, name: string): string[] => {
  if (name === "STRICT" && !kind.endsWith("prefix") && text.length <= LONG)
    // UTF-16 units, not code points: a boundary between the halves of a surrogate pair is a state too.
    return text.split("");
  const a = Math.floor(text.length / 3);
  const b = Math.floor((text.length * 2) / 3);
  return [text.slice(0, a), text.slice(a, b), text.slice(b)];
};

describe("a stream's end() gives the whole parse's value, complete and cut", () => {
  it.each(CASES)("%s", (_case, name, options, inputs) => {
    const divergences: string[] = [];
    let compared = 0;
    // The parser's own stream: options validated once, as a caller reusing a parser would.
    const parser = initParser(options);
    for (const { text, origin, kind } of inputs) {
      const whole = factsOf(configuredParse(text, parser));
      const stream = createStreamParser(parser);
      const chunks = chunksOf(text, kind, name);
      // Drain every delivery to reach the same terminal state, but retain only the whole-call oracle's first result.
      let first: AnyOutcome | undefined;
      for (const chunk of chunks) for (const outcome of stream.feed(chunk)) first ??= outcome;
      for (const outcome of stream.end()) first ??= outcome;
      if (first === undefined) {
        // EOF owes a typed no-json failure too; a missing refusal is not agreement with parse.
        divergences.push(`${origin} [${name}] stream delivered nothing`);
        continue;
      }
      compared++;
      const streamed = factsOf(first);
      if (
        whole.ok !== streamed.ok ||
        whole.kind !== streamed.kind ||
        whole.issue !== streamed.issue ||
        whole.complete !== streamed.complete ||
        !same(whole.value, streamed.value) ||
        !same(whole.cut, streamed.cut)
      ) {
        divergences.push(
          `${origin} [${name}] ${JSON.stringify(chunks)}\n  parse  ${inspect(whole)}\n  stream ${inspect(streamed)}`,
        );
      }
    }
    // An empty population would pass with no divergences.
    expect(compared).toBeGreaterThan(0);
    expect(divergences.slice(0, 20)).toEqual([]);
  });
});

/** The string a cut input ends in: the root itself, or the last member of its root container. */
const leaf = (v: unknown): unknown =>
  typeof v === "string" ? v : (Object.values(v as object).at(-1) as unknown);

describe("a token the end of input touched", () => {
  // The question a caller asks of `cut`: may this field still change? A string or number may grow;
  // a complete literal may not, since no JSON continuation extends `true`. A token the source
  // followed with a space was finished by the source.
  it.each([
    ['{"a":hel', { path: ["a"], kind: "string" }],
    ["[1, 01", { path: [1], kind: "string" }],
    ["[1, 12", { path: [1], kind: "number" }],
    ["[1, true", { path: [], kind: "between" }],
    ['{"a":null', { path: [], kind: "between" }],
    ["[1, hello ", { path: [], kind: "between" }],
  ] as const)("cuts %j as %j", (text, cut) => {
    expect(configuredParse(text, initParser({}))).toMatchObject({ ok: true, complete: false, cut });
  });
});

describe("cutSuffix", () => {
  // Inputs that cut a string in each way the reader distinguishes: plain, after an escape, single
  // quoted (rewritten whole by repair), at a half escape, at the root, inside an array, and the two
  // strings written without quotes: a bare word and a leading-zero number.
  const CUT = [
    '{"a":"hel',
    '["x\\"y',
    "{'a':'hi",
    '{"a":"x\\u00',
    '"root',
    '[1,"ab',
    '{"a":hel',
    "[1, 01",
  ];

  it.each([
    [true, "…"],
    ["~", "~"],
    // Characters JSON must escape, because `repair` and the built-in route write the suffix into JSON
    // text. Unescaped, the first would add a key `z`; the second would fall back to the scanner.
    ['","z":"', '","z":"'],
    ["\\\n", "\\\n"],
  ] as const)("appends %j the same way on every route", (cutSuffix, mark) => {
    const parser = initParser({ cutSuffix });
    for (const text of CUT) {
      const whole = configuredParse(text, parser);
      if (!whole.ok) throw new Error(`${text} did not parse`);
      const stream = createStreamParser(parser, { view: sharedView });
      const ended = [...stream.feed(text), ...stream.end()][0];
      const snapshot = stream.snapshot();
      const repaired = configuredRepair(text, parser);
      if (!repaired.ok || !snapshot.ok) throw new Error(`${text} did not repair or snapshot`);
      expect(String(leaf(whole.value)).endsWith(mark)).toBe(true);
      expect(ended?.ok === true ? ended.value : ended).toStrictEqual(whole.value);
      expect(snapshot.value?.value).toStrictEqual(whole.value);
      expect(JSON.parse(repaired.value)).toStrictEqual(whole.value);
      expect(whole.cut?.kind).toBe("string");
    }
  });

  it("marks only a cut string, never a cut number, a missing item or a cut key", () => {
    const parser = initParser({ cutSuffix: true });
    for (const text of ["[1, 12", "[1, tru", '{"a":1,"b":', '{"a":1,"ke', "[1, 2 "])
      expect(configuredParse(text, parser)).toStrictEqual(configuredParse(text, initParser({})));
  });

  it("shows on every snapshot without reaching the live tree", () => {
    const stream = createStreamParser(initParser({ cutSuffix: "~" }), { view: sharedView });
    const shown: unknown[] = [];
    for (const ch of '{"a":"hey') {
      for (const _ of stream.feed(ch));
      const snapshot = stream.snapshot();
      if (snapshot.ok) shown.push((snapshot.value?.value as { a?: unknown } | undefined)?.a);
    }
    // One mark per frame: a suffix grafted onto the live tree would pile up as `h~e~y~`.
    expect(shown.filter((a) => a !== undefined)).toStrictEqual(["~", "h~", "he~", "hey~"]);
  });

  it("puts the mark on the last fragment piece", () => {
    const stream = createStreamParser({
      cutSuffix: "~",
      select: select([["a"]], { fragments: decodedFragments }),
    });
    let text = "";
    const eat = (items: ReturnType<typeof stream.feed>): void => {
      for (const item of items) {
        expect(item.ok).toBe(true);
        if (item.ok && item.value.kind === "data") text += item.value.text;
      }
    };
    for (const ch of '{"a":"hey') eat(stream.feed(ch));
    eat(stream.end());
    expect(text).toBe("hey~");
  });

  it("refuses anything but a boolean or a string, naming the option", () => {
    expect(() => initParser({ cutSuffix: 1 } as never)).toThrow(
      expect.objectContaining({
        cause: { kind: "invalid-options", field: "cutSuffix", reason: "cut-suffix" },
      }),
    );
  });
});
