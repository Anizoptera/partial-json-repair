// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

/**
 * Every repair and error this package can report must be produced by a case the corpus holds.
 *
 * The corpus is the contract the Rust port is held to, so a kind with no case in it is a kind the
 * port is free to get wrong. A capability nothing exercises is indistinguishable from one that
 * never existed. Red here names the kinds to seed. If one is
 * genuinely unreachable, that is a capability this package does not have: say so out loud rather
 * than seeding around it.
 *
 * The vocabulary is read from the TYPE, never from a list kept here. A second enumeration is a
 * second thing to forget, and the failure it causes is silent: a kind absent from the check is a
 * kind whose absence from the corpus the check cannot report.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The classic compiler API (`createSourceFile`) exists only up to TypeScript 6; the 7.x package
// exports no such API, so AST tools read source through the `typescript-6` alias.
import ts from "typescript-6";

import type { ParserOptions } from "../src/options";
import { resolveOptions } from "../src/options";
import { COMPAT, LLM_BALANCED, LLM_FULL, STRICT } from "../src/presets";
import { scan } from "../src/scan-collect";
import { RECOVERY_FLAG } from "../src/options";
import { diagnostics } from "../src/index";

const TYPES = new URL("../src/types.ts", import.meta.url);

let typesSource: ts.SourceFile | undefined;

/** Every string-literal member of a named union in `src/types.ts`, in declaration order. */
const unionMembers = (name: string): string[] => {
  typesSource ??= ts.createSourceFile(
    "types.ts",
    readFileSync(TYPES, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const file = typesSource;
  const found: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
      found.push(node.literal.text);
    else node.forEachChild(collect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) collect(node.type);
    else node.forEachChild(visit);
  };
  visit(file);
  return found;
};

/**
 * Configurations the corpus is replayed under. The four presets are what a caller actually picks;
 * the rest exist because a kind is reachable ONLY under an option no preset sets — the key policies
 * and the two budgets that stop a scan. Each one names the kinds it is here for.
 */
const PROFILES: ParserOptions[] = [
  LLM_BALANCED,
  LLM_FULL,
  STRICT,
  COMPAT,
  { ...LLM_FULL, onDangerousKey: "drop" }, // dangerous-key repair
  { ...LLM_FULL, onDangerousKey: "reject" }, // dangerous-key error
  { ...LLM_FULL, maxDepth: 2 }, // depth-budget
  { ...LLM_FULL, maxScalar: 4 }, // unparsable-span from a stopped scalar
  { ...LLM_FULL, recover: { "guessed-string-end": true } }, // opt-in, on in no preset
];

const CORPUS = ["corpus.jsonl", "seeds.jsonl"]
  .flatMap((file) =>
    readFileSync(new URL(`../corpus/${file}`, import.meta.url), "utf8")
      .trim()
      .split("\n"),
  )
  .map((line) => JSON.parse(line) as { text?: unknown; chunks?: unknown })
  .map((r) =>
    typeof r.text === "string" ? r.text : Array.isArray(r.chunks) ? r.chunks.join("") : "",
  )
  .filter((t) => t !== "");

/** One input and the profile that produced a given repair, kept so it can be replayed switched off. */
type Witness = { text: string; profile: ParserOptions };

const produced = (): {
  repairs: Set<string>;
  errors: Set<string>;
  witness: Map<string, Witness>;
} => {
  const repairs = new Set<string>();
  const errors = new Set<string>();
  const witness = new Map<string, Witness>();
  for (const profile of PROFILES) {
    const options = resolveOptions({ ...profile, diagnostics });
    if ("kind" in options) throw new Error(`unusable profile: ${JSON.stringify(options)}`);
    for (const text of CORPUS) {
      const result = scan(text, options);
      for (const repair of result.repairs) {
        repairs.add(repair.kind);
        if (!witness.has(repair.kind)) witness.set(repair.kind, { text, profile });
      }
      for (const error of result.errors) errors.add(error.kind);
    }
  }
  return { repairs, errors, witness };
};

describe("every kind has a case", () => {
  const seen = produced();

  it("produces every RepairKind from a corpus input", () => {
    const kinds = unionMembers("RepairKind");
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((k) => !seen.repairs.has(k))).toEqual([]);
  });

  it("produces every ErrorKind from a corpus input", () => {
    // This scanner-only sweep reads text. The byte decoder's `invalid-utf8` cases are checked by
    // test/input.test.ts and corpus conformance, which consume raw byte records.
    const kinds = unionMembers("ErrorKind").filter((k) => k !== "invalid-utf8");
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((k) => !seen.errors.has(k))).toEqual([]);
  });

  it("names every repair the `JSON.parse` fast path could perform behind a caller's back", () => {
    // Built-in parsers may only change the ROUTE, never the answer. A repair reachable from text
    // `JSON.parse` accepts is one it performs silently, so refusing that repair must decline the
    // fast path or the caller gets `ok` for a document the scanner refuses. `duplicate-key` is the
    // only one today; this fails and names any other that qualifies, so the guard in
    // `builtinAllowed` (src/builtin-route.ts) cannot silently fall behind the scanner.
    const options = resolveOptions({ ...LLM_FULL, diagnostics });
    if ("kind" in options) throw new Error("unusable options");
    // Both input banks are included; the final assertion fails if no valid duplicate is exercised.
    const reachable = new Set<string>();
    for (const text of CORPUS) {
      try {
        JSON.parse(text);
      } catch {
        continue;
      }
      // `dangerous-key` is reachable here too and drops out on its own: it is absent from
      // `RECOVERY_FLAG` because `onDangerousKey` owns it, and the fast path already declines for
      // every policy of it that `JSON.parse` cannot honour.
      for (const repair of scan(text, options).repairs)
        if (repair.kind in RECOVERY_FLAG) reachable.add(repair.kind);
    }
    expect([...reachable].toSorted()).toEqual(["duplicate-key"]);
  });

  it("switching a kind off changes the verdict and the report, never the value", () => {
    // The invariant that makes `recover` safe to expose: the tree is a function of the BYTES, not of
    // the configuration, so a caller who declines a recovery gets the SAME value plus a failure
    // telling them their assumption about their input was wrong. Break it and tightening a switch
    // silently restructures a document. No type can catch it — every path here is `boolean` either
    // way — and the value half is live: deleting the `js-literal` exemption below fails this on
    // `expected [{ key: 'undefined' }] to deeply equal [{ key: undefined }]`.
    //
    // `maxErrors` is lifted on BOTH runs so the comparison is like for like: a refusal that stopped
    // the scan would truncate the value for a reason that has nothing to do with the kind.
    const budget = { diagnostics, maxErrors: 1_000_000 } as const;
    for (const kind of Object.keys(RECOVERY_FLAG)) {
      const seat = seen.witness.get(kind);
      expect(seat, `no corpus input produces ${kind}`).toBeDefined();
      if (seat === undefined) continue;
      const on = resolveOptions({ ...seat.profile, ...budget });
      const off = resolveOptions({ ...seat.profile, ...budget, recover: { [kind]: false } });
      if ("kind" in on || "kind" in off) throw new Error(`unusable options for ${kind}`);

      const before = scan(seat.text, on);
      const after = scan(seat.text, off);
      expect(
        before.repairs.some((r) => r.kind === kind),
        `witness lost ${kind}`,
      ).toBe(true);
      expect(
        after.repairs.some((r) => r.kind === kind),
        `${kind} survived being switched off`,
      ).toBe(false);
      // Naming the refused kind is what makes a switch actionable: every refusal reports as
      // `unparsable-span`, so a caller who declined two kinds otherwise learns only that something
      // somewhere was refused, never which of their assumptions about the input broke.
      const refused = after.errors.some((e) => e.kind === "unparsable-span" && e.refused === kind);
      // An opt-in kind (`RECOVERY_FLAG` false) may instead be off in favour of the other honest
      // reading (`0123` stays its text through `invalid-number`): off is its default, so a refusal
      // would fail every default parse. That reading adds no error, and it alone may change the value.
      const otherReading = !refused && RECOVERY_FLAG[kind as keyof typeof RECOVERY_FLAG] === false;
      if (otherReading)
        expect(after.errors, `opt-in ${kind} off added an error`).toEqual(before.errors);
      else expect(refused, `${kind} off reported no refusal naming it`).toBe(true);
      // The value half has exactly the exceptions `src/AGENTS.md` names, each a case where the two
      // values cannot both be produced: `js-literal` (off, `undefined` is the STRING the source
      // spelled rather than a JavaScript value) and an opt-in kind's other reading.
      if (kind !== "js-literal" && !otherReading)
        expect(after.values, `${kind} off changed the value`).toEqual(before.values);
    }
  });
});
