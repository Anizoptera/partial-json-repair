// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * The proof a built-in parser needs before it may answer for the scanner (`src/AGENTS.md`): public
 * `parse`, which hands whole text to `JSON.parse` directly or through the pre-scan gate's routes,
 * `repair`, which hands it valid JSON, and the scanner's own per-member slices (`native-slice.ts`)
 * must return exactly what the scanner alone returns
 * (`builtinParsers: false`) for the same input and options, as text and as UTF-8 bytes. Compared
 * through the public verbs, so the order `builtinRead` picks, the `cutSuffix` hand-off and the
 * outcome shaping are judged too, not only the gate's verdicts. The async verbs run these same
 * routes and are held to the synchronous answers by `async:conform`.
 *
 * The population includes corpus and generated documents, sampled prefixes and seeded mutations.
 * The shared sampler considers character boundaries for short documents and structural boundaries
 * for long ones, retaining witnesses by approximate lexical keys. Omitted prefixes are unproved.
 * Prefixes reach truncation; the gate's hazards (escaped dangerous keys, `\u` tricks, duplicate keys, big
 * numbers, comments beside a cut) need corrupted MIDDLES, which is what the mutations are for. A
 * failure prints its seed, so `PRESCAN_SEED=<seed>` replays the same mutations.
 *
 * Compared: the whole outcome, structurally (`Object.is` at the leaves, prototypes and own-key
 * order included), so value, failure, `complete` and `cut` all count. A profile that never routes
 * proves nothing, so each case requires its profile served and the default to reach every route.
 */

import { describe, expect, it } from "vitest";

import { inspect } from "node:util";

import type { ParserOptions } from "../src/options";
import { COMPAT, initParser, LLM_FULL, locations, STRICT } from "../src/index";
import { resolveOptions } from "../src/options";
import { builtinRead } from "../src/builtin-route";
import { preScan, routeText } from "../src/pre-scan";
import { differentialInputs, same, slices } from "./corpus-population";
import { parse as configuredParse, repair as configuredRepair } from "../src/index";

const encoder = new TextEncoder();
const isAscii = (text: string): boolean => {
  for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) > 0x7f) return false;
  return true;
};
const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** Option profiles that move the gate's decision, the attempt's guard, or the scanner's answer. */
const PROFILES: readonly (readonly [string, ParserOptions])[] = [
  ["default", {}],
  ["STRICT", STRICT],
  ["COMPAT", COMPAT],
  ["LLM_FULL", LLM_FULL],
  ["drop", { onDangerousKey: "drop" }],
  ["reject+custom", { onDangerousKey: "reject", customDangerousKeys: ["id", "a"] }],
  ["maxDepth 3", { maxDepth: 3 }],
  ["maxScalar 4", { maxScalar: 4 }],
  ["no trailing-comma", { recover: { "trailing-comma": false } }],
  ["no comments", { recover: { "comment-removed": false } }],
  ["no dropped-member", { recover: { "dropped-member": false } }],
  ["no duplicate-key", { recover: { "duplicate-key": false } }],
  ["objectOnly", { objectOnly: true }],
  ["requiredKeys", { requiredKeys: ["a"] }],
  ["cutSuffix", { cutSuffix: "~" }],
  ["locations", { locations }],
];

describe("built-in parsers against the scanner", () => {
  const profiles = PROFILES.map(([name, options]) => ({
    name,
    resolved: resolveOptions(options),
    wired: initParser(options),
    scanner: initParser({ ...options, builtinParsers: false }),
  }));

  // One case per profile and population slice, so each stays inside the per-case time budget and a
  // divergence names its profile and range. No case reads state another case left behind, so the
  // reach of each profile is its own case below.
  // JSON validity and ASCII spelling depend on source bytes, not on the option profile.
  const inputs = differentialInputs().map(({ text, origin, kind }, index) => ({
    index,
    text,
    origin,
    kind,
    json: isJson(text),
    ascii: isAscii(text),
  }));
  // Classification is pure for these fixed inputs and settings; share it without depending on test order.
  const classified = profiles.map((p) => {
    const routes = new Set<string>();
    let served = 0;
    for (const { text } of inputs) {
      if (builtinRead(text, p.resolved) === undefined) continue;
      served++;
      routes.add(preScan(text, p.resolved).route);
    }
    return { name: p.name, wired: p.wired, scanner: p.scanner, routes, served };
  });
  // A route whose text `JSON.parse` rejects falls back to the scanner, so its answer stays right and
  // the differential test above cannot see it; only the speed is silently lost. Hold that here.
  it("hands JSON.parse text it accepts on every built-in verdict", () => {
    const rejected: string[] = [];
    for (const p of profiles)
      for (const { text } of inputs) {
        const verdict = preScan(text, p.resolved);
        if (verdict.route === "scanner") continue;
        try {
          JSON.parse(routeText(text, verdict));
        } catch {
          rejected.push(`[${p.name}] ${verdict.route} ${JSON.stringify(text)}`);
        }
      }
    expect(rejected).toStrictEqual([]);
  });
  // Profiles read the same immutable population; partition arrays need only one owner.
  const populationSlices = slices(inputs);
  const cases = classified.flatMap((p) =>
    populationSlices.map((slice) => [`${p.name} ${slice.range}`, p, slice.items] as const),
  );

  it.each(cases)("public parse and repair return the scanner's outcome: %s", (_case, p, items) => {
    const divergences: string[] = [];
    const compare = (verb: string, input: string, wired: unknown, scanned: unknown): void => {
      if (!same(wired, scanned))
        divergences.push(
          `${verb} [${p.name}] ${JSON.stringify(input)}\n  wired   ${inspect(wired)}\n  scanner ${inspect(scanned)}`,
        );
    };
    for (const { text, origin, json, ascii } of items) {
      // Every input, not only those a whole-text route serves: the scanner hands members that closed
      // undamaged to `JSON.parse` (`native-slice.ts`), which matters exactly where those routes decline.
      compare(
        `${origin} parse`,
        text,
        configuredParse(text, p.wired),
        configuredParse(text, p.scanner),
      );
      // Bytes take the same route after decoding; only their byte-unit positions differ, and
      // those differ from text positions only past a non-ASCII character.
      if (!ascii) {
        const bytes = encoder.encode(text);
        compare(
          `${origin} bytes`,
          text,
          configuredParse(bytes, p.wired),
          configuredParse(bytes, p.scanner),
        );
      }
      // `repair` hands only valid JSON to `JSON.parse`, so only that can diverge.
      if (json)
        compare(
          `${origin} repair`,
          text,
          configuredRepair(text, p.wired),
          configuredRepair(text, p.scanner),
        );
    }
    expect(divergences.slice(0, 20)).toEqual([]);
  });

  it.each(classified)("the comparison reaches every built-in route it should: $name", (p) => {
    // A profile no built-in parser served compared nothing. The one profile `builtinAllowed`
    // declines must stay at zero: that is the decline the fast path owes a refused duplicate key.
    if (p.name === "no duplicate-key") expect(p.served).toBe(0);
    else expect(p.served).toBeGreaterThan(0);
    if (p.name === "default")
      expect([...p.routes]).toEqual(expect.arrayContaining(["strict", "lenient", "cut-off"]));
  });

  // Shapes the population never produces, each found diverging by a fuzzer: a word ending in a
  // comment with no space before it (the scanner keeps `//c` in the word), and a cut key whose source
  // spelling differs from its decoded text (an escape, a lone surrogate).
  it.each(["[true//c\n]", "[null/*c*/]", '{"a":false//c\n}', '{"\\/', '{"\\u005f_', '{"a\uDC00'])(
    "public parse returns the scanner's outcome for %j",
    (text) => {
      const wired = configuredParse(text, initParser({}));
      const scanned = configuredParse(text, initParser({ builtinParsers: false }));
      expect(same(wired, scanned), `wired ${inspect(wired)}\nscanner ${inspect(scanned)}`).toBe(
        true,
      );
    },
  );

  /**
   * What the cut record means, pinned by example; the differential test above holds the scanner to
   * the same records. `text` is the unfinished token the value leaves out.
   */
  it("records where the source was cut and what kind of thing was cut", () => {
    const opts = resolveOptions({});
    const cutOf = (text: string) => {
      const verdict = preScan(text, opts);
      return verdict.route === "cut-off" ? verdict.cut : verdict.route;
    };
    expect(cutOf("[1, tru")).toStrictEqual({ path: [1], kind: "missing", text: "tru" });
    expect(cutOf('{"a":1,"b":')).toStrictEqual({ path: ["b"], kind: "missing" });
    expect(cutOf('{"a":1,"b"')).toStrictEqual({ path: ["b"], kind: "missing" });
    expect(cutOf('{"a":1,"ke')).toStrictEqual({ path: [], kind: "between", text: '"ke' });
    expect(cutOf("[1, 12")).toStrictEqual({ path: [1], kind: "number" });
    expect(cutOf("[1, 1e")).toStrictEqual({ path: [1], kind: "missing", text: "1e" });
    expect(cutOf("[1, 2 ")).toStrictEqual({ path: [], kind: "between" });
    expect(cutOf('{"a":"hel\\u00')).toStrictEqual({ path: ["a"], kind: "string", text: "\\u00" });
    expect(cutOf('{"a":[1,{"b":"x')).toStrictEqual({ path: ["a", 1, "b"], kind: "string" });
    expect(cutOf('"abc')).toStrictEqual({ path: [], kind: "string" });
    expect(cutOf('{"a\\"b":{"c')).toStrictEqual({ path: ['a"b'], kind: "between", text: '"c' });
    // A complete document is not cut, and a lone cut token at the root is the scanner's to refuse.
    expect(cutOf("[1, 12]")).toBe("strict");
    expect(cutOf("tru")).toBe("scanner");
  });
});
