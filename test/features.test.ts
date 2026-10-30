// SPDX-License-Identifier: Apache-2.0

/**
 * Optional features are imported values (HLD D5): the runtime half of the contract the types state
 * in `options.types.ts`, for JavaScript callers and options loaded at run time.
 */

import { describe, expect, it } from "vitest";
import { configurationCause, rejectedCause } from "./configuration-error";
import { decodedFragments, diagnostics, locations, parse, select, skip } from "../src/index";
import { parseAsync, worker } from "../src/async";

// What a JSON round trip of an options object leaves: the feature's tag and data, none of the
// methods the core calls. It once passed validation and crashed untyped mid-parse.
const copied = (value: object): object =>
  Object.fromEntries(Object.entries(value).filter(([, member]) => typeof member !== "function"));

describe("feature options", () => {
  it("refuses inherited feature identities while accepting the imported values", () => {
    const values = { diagnostics, locations, select: select([]), skip: skip([]) };
    for (const [field, value] of Object.entries(values)) {
      expect(parse("{}", { [field]: value } as never).ok).toBe(true);
      expect(
        configurationCause(() => parse("{}", { [field]: Object.create(value) as object } as never)),
      ).toEqual({ kind: "invalid-options", field, reason: "import-required" });
    }
  });

  it("rejects sparse policy arrays before capture and ignores inherited selection settings", () => {
    for (const field of ["requiredKeys", "customDangerousKeys"] as const) {
      const sparse: string[] = [];
      sparse.length = 1;
      expect(
        configurationCause(() =>
          parse(
            "{}",
            field === "requiredKeys" ? { requiredKeys: sparse } : { customDangerousKeys: sparse },
          ),
        ),
      ).toMatchObject({ field, reason: "string-array" });
    }
    const inherited = Object.defineProperty(Object.create(null) as object, "fragments", {
      value: true,
    });
    expect(select([], Object.create(inherited) as never).fragments).toBe(false);
  });
  it.each([
    ["diagnostics", "{ diagnostics }"],
    ["locations", "{ locations }"],
    ["select", "{ select: select(paths) }"],
    ["skip", "{ skip: skip(paths) }"],
  ])("refuses `%s: true` with a message naming the import", (key, use) => {
    const call = () => parse("{}", { [key]: true } as never);
    expect(configurationCause(call)).toEqual({
      kind: "invalid-options",
      field: key,
      reason: "import-required",
    });
    expect(call).toThrow(`import { ${key} } from "partial-json-repair"\` and pass \`${use}\``);
  });

  it("refuses the pre-import spellings, another feature's value, and a copy that lost its methods", () => {
    for (const options of [
      { select: [["a"]] },
      { diagnostics: "all" },
      { skip: locations },
      { diagnostics: copied(diagnostics({ maxEntries: 5 })) },
      { select: copied(select([["a"]])) },
      { skip: copied(skip([["a"]])) },
    ])
      expect(configurationCause(() => parse("{}", options as never))).toMatchObject({
        reason: "import-required",
      });
  });

  it("refuses a selection written by hand, typed, at every entry and on the worker route", async () => {
    // Each passes the tag check; the core then reads `compiled` (a crash) or finds none (a select
    // read as no selection, so whole values came back). A real value still passes, and its spread.
    const forged = [
      { skip: { feature: "skip", picks() {} } },
      { select: { feature: "select", picks() {} } },
      { select: { feature: "select", paths: [["a"]], occurrences: false, fragments: false } },
      { skip: { feature: "skip", picks() {}, wire: () => [], compiled: {} } },
      { select: { ...select([["a"]]), wire: undefined } },
    ];
    for (const options of forged)
      expect(configurationCause(() => parse("{}", options as never))).toMatchObject({
        reason: "import-required",
      });
    const viaWorker = forged.map((options) =>
      rejectedCause(parseAsync("{}", { ...options, execution: worker } as never)),
    );
    for (const cause of await Promise.all(viaWorker))
      expect(cause).toMatchObject({ reason: "import-required" });
    expect(parse('{"a":1,"b":2}', { skip: { ...skip([["a"]]) } })).toEqual({
      ok: true,
      complete: true,
      value: { b: 2 },
    });
  });

  it("layers settings, each call deriving a new frozen value from the one it was called on", () => {
    const capped = diagnostics({ maxEntries: 1 });
    const audited = capped({ scope: "all" });
    expect([audited.maxEntries, audited.scope]).toEqual([1, "all"]);
    expect([diagnostics.maxEntries, diagnostics.scope, capped.scope]).toEqual([
      1000,
      undefined,
      undefined,
    ]);
    expect(Object.isFrozen(audited) && Object.isFrozen(select([]))).toBe(true);
    // An own `undefined` resets a setting to its default, as in an options object.
    expect([
      audited({ maxEntries: undefined } as never).maxEntries,
      audited({ scope: undefined } as never).scope,
    ]).toEqual([1000, undefined]);
  });

  it("validates settings where they are written, naming the setting", () => {
    for (const maxEntries of [0, null])
      expect(configurationCause(() => diagnostics({ maxEntries } as never))).toEqual({
        kind: "invalid-options",
        field: "diagnostics.maxEntries",
        reason: "positive-integer",
      });
    expect(configurationCause(() => diagnostics({ scope: "some" } as never))).toMatchObject({
      field: "diagnostics.scope",
      reason: "scope",
    });
    expect(configurationCause(() => select([], { ocurrences: true } as never))).toMatchObject({
      field: "select.ocurrences",
      reason: "unknown",
    });
    expect(configurationCause(() => skip([["a", 0]]))).toMatchObject({ reason: "skip-tail" });
  });

  it("owns its paths: mutating the caller's array afterwards changes nothing", () => {
    const paths: string[][] = [["a"]];
    const picked = select(paths);
    paths[0]?.splice(0, 1, "b");
    expect(parse('{"a":1,"b":2}', { select: picked })).toMatchObject({
      ok: true,
      value: [{ path: ["a"], value: 1 }],
    });
  });

  it("captures each selection setting once before using it", () => {
    let fragmentReads = 0;
    let occurrenceReads = 0;
    const picked = select([], {
      get fragments() {
        return ++fragmentReads === 1 ? false : null;
      },
      get occurrences() {
        return ++occurrenceReads === 1;
      },
    } as never);
    expect([picked.fragments, picked.occurrences]).toEqual([false, true]);
    expect([fragmentReads, occurrenceReads]).toEqual([1, 1]);
  });

  it("validates nonenumerable selection settings before using them", () => {
    for (const [field, value, reason] of [
      ["fragments", null, "import-required"],
      ["occurrences", 1, "boolean"],
      ["ocurrences", true, "unknown"],
    ] as const) {
      const settings = Object.defineProperty({}, field, { value });
      expect(configurationCause(() => select([], settings))).toEqual({
        kind: "invalid-options",
        field: `select.${field}`,
        reason,
      });
    }
    const settings = Object.defineProperty({}, "fragments", { value: decodedFragments });
    expect(select([], settings).fragments).toBe(true);
  });

  it("caps the stored report without capping the counts", () => {
    const r = parse("[1,,2,,3,]", { diagnostics: diagnostics({ maxEntries: 1 }) });
    expect(r.diagnostics).toMatchObject({ counts: { repairs: 3 }, entriesComplete: false });
    expect(r.diagnostics.repairs).toHaveLength(1);
  });
});
