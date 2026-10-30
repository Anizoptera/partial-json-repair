/**
// test-scope: private-modules
 * The canonical serialiser is the comparison the entire conformance corpus is made of, so any two
 * values it renders identically are a behaviour change no corpus record can ever catch.
 *
 * Encode each table entry once and reject duplicate encodings: this detects exactly the same
 * collisions as comparing every pair. Assert distinctness, never a spelling, so the encoding can
 * change while the property the corpus depends on stays pinned.
 */
import { describe, expect, it } from "vitest";

import { canonical } from "../scripts/corpus/canonical";
import { observe, observeCase } from "../scripts/corpus/observe";

const cyclic: Record<string, unknown> = {};
cyclic["self"] = cyclic;
const sparse: number[] = [];
sparse.length = 1;

class Holder {
  declare private readonly x: number;
}

/**
 * Every entry must render differently from every other. Grouped by the reason each would collide:
 * `JSON.stringify` flattens the first group to `null`, cannot sign the second, and renders every
 * member of the fourth as `{}` because none has an own enumerable key.
 */
const DISTINCT: readonly (readonly [string, unknown])[] = [
  ["undefined", undefined],
  ["null", null],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],

  ["zero", 0],
  ["negative zero", -0],
  ["bigint", 10n],
  ["number that looks like the bigint", 10],

  // A string holding a marker's text is ordinary input; the quoting is what keeps it apart.
  ["string '#undef'", "#undef"],
  ["string '#nan'", "#nan"],
  ["string '#cycle'", "#cycle"],
  ["cycle", cyclic],

  ["empty object", {}],
  ["empty array", []],
  ["array with a missing element", sparse],
  ["array with undefined", [undefined]],
  ["array with null", [null]],
  ["array with hole-marker text", ["#hole"]],
  ["null-prototype object", Object.create(null) as object],
  ["Date", new Date(0)],
  ["Map", new Map([[1, 2]])],
  ["Set", new Set([1])],
  ["RegExp", /re/gu],
  ["class instance", new Holder()],

  // Key order is observable behaviour: the old implementation rebuilt every object during
  // sanitisation and changed it, which is one of the defects the corpus exists to detect.
  ["object a,b", { a: 1, b: 2 }],
  ["object b,a", { b: 2, a: 1 }],
  ["object with -0", { a: -0 }],
  ["object with 0", { a: 0 }],
];

describe("canonical", () => {
  it("counts contract events only from failures and diagnostics", () => {
    const lookalikes = observeCase({
      id: "payload-lookalikes",
      text: '{"kind":"limit-reached","resource":"depth","entriesComplete":false,"repair":{"kind":"single-quote"}}',
    }).covers;
    expect(lookalikes).not.toHaveProperty("limit:depth");
    expect(lookalikes).not.toHaveProperty("limit:diagnostics");
    expect(lookalikes).not.toHaveProperty("repair:single-quote");

    const events = observeCase({
      id: "contract-events",
      text: "['x',]",
      options: { diagnostics: true, maxDiagnostics: 1 },
    }).covers;
    expect(events).toHaveProperty("limit:diagnostics");
    expect(events).toHaveProperty("repair:single-quote");
  });

  it("retains empty chunks in fragment delivery observations", () => {
    const options = { select: [["a"]], fragments: true };
    const ready = observe({ id: "ready", chunks: ['{"a":"x"}', " "], options });
    const delayed = observe({ id: "delayed", chunks: ["", '{"a":"x"} '], options });
    // Positions also change here; both observations must retain the empty chunk's place.
    expect(ready["boundaries"]?.startsWith("[[{")).toBe(true);
    expect(delayed["boundaries"]?.startsWith("[[],[{")).toBe(true);
  });

  it("distinguishes fragment reports and summaries from identical scalar output", () => {
    const base = {
      id: "fragment-evidence",
      chunks: ['{a:"value"}'],
      options: { select: [["a"]], fragments: true },
    };
    const quiet = observe(base);
    const reported = observe({ ...base, options: { ...base.options, diagnostics: true } });
    const summary = observe({ ...base, options: { ...base.options, summary: true } });
    expect(reported["fed"]).not.toBe(quiet["fed"]);
    expect(summary["ended"]).not.toBe(quiet["ended"]);
    const refused = { ...base, options: { ...base.options, recover: { "unquoted-key": false } } };
    expect(
      observe({ ...refused, options: { ...refused.options, diagnostics: true } })["fed"],
    ).not.toBe(observe(refused)["fed"]);
  });

  it("distinguishes every collision candidate from the others", () => {
    const encodings = new Map<string, string>();
    for (const [name, value] of DISTINCT) {
      const encoded = canonical(value);
      expect(encodings.get(encoded), `canonical collision for ${name}`).toBeUndefined();
      encodings.set(encoded, name);
    }
  });

  it("does not mistake an inherited array entry for recovered data", () => {
    const missing: number[] = [];
    missing.length = 1;
    Object.setPrototypeOf(missing, { 0: 1 });
    expect(canonical(missing)).not.toBe(canonical([1]));
  });

  it("reports a cycle rather than throwing, and does not mistake sharing for one", () => {
    expect(canonical(cyclic)).toContain("#cycle");

    // The guard is scoped to the path being walked, so the same object twice in one value is a DAG
    // and must still serialise normally. A guard held for the whole traversal would call this a
    // cycle and silently lose the second branch.
    const shared = { a: 1 };
    expect(canonical({ x: shared, y: shared })).not.toContain("#cycle");
  });
});
