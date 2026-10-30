// SPDX-License-Identifier: Apache-2.0

/**
 * Every way a rival recovery library answers a corpus input differently from this package, grouped
 * by CAUSE, each with its verdict and the HLD priority that decides it. One cause gets one decision,
 * so a new pair that a cluster explains needs no new judgment, and a pair no cluster explains is a
 * new cause that someone must judge before it is accepted.
 *
 * Two owners read this file, and it imports nothing so both can:
 * - `test/rival-differences.test.ts` runs each cluster's `cases` through `parse` and fails, naming
 *   the cluster and its reason, when our answer moves. A move toward the rival's answer reverses a
 *   recorded decision; that needs a changed verdict here, not a changed expectation.
 * - `EMIT=differences bun bench/prior-art/compare.ts` classifies every live (input × rival) pair with
 *   `match`, the first match winning, and diffs the result against `bench/prior-art/differences.json`.
 *   Unmatched or newly matched pairs stop the run until reviewed and accepted. A predicate sees only
 *   the two rendered leaves, not which side moved, so a regression of ours can land in a cluster
 *   whose reason praises our answer; the review of each changed pair is what catches that.
 *
 * `rival` verdicts are causes where the rival does better; their cases pin today's answer so the fix
 * turns them red, which is the moment to flip the verdict to `ours`.
 */

export type Verdict = "ours" | "intended" | "rival";

/** One rival's departure from our answer on one input, as `compare.ts` renders it with `inspect`. */
export type Pair = {
  readonly lib: string;
  readonly text: string;
  /** `rival-throws`: we return a value; `ours-declines`: the rival does and we fail; `differs`: both return. */
  readonly kind: "rival-throws" | "ours-declines" | "differs";
  /** Path of the first difference, and both leaves there; present only for `differs`. */
  readonly at?: readonly (string | number)[];
  readonly ours?: string;
  readonly rival?: string;
  /** Both whole values; present only for `differs`. A cause can show only in the whole value. */
  readonly whole?: string;
  readonly got?: string;
};

/** Our expected answer: the recovered value, or the failure kind when we decline. */
export type Expect =
  | { readonly value: unknown; readonly complete?: false }
  | { readonly fails: string };

export type Cluster = {
  readonly id: string;
  readonly verdict: Verdict;
  /** Why the verdict follows from HLD, in one sentence a reviewer can check against the cases. */
  readonly reason: string;
  readonly match: (pair: Pair) => boolean;
  /** Inputs that show the cause, with our pinned answer. Every cluster keeps at least one. */
  readonly cases: readonly (readonly [input: string, ours: Expect])[];
};

// Parsers with no recovery mode: refusing damage is their whole contract.
const STRICT = new Set([
  "JSON.parse",
  "simdjson",
  "json5",
  "Bun.JSON5",
  "Bun.JSONL",
  "secure-json-parse",
  "json-bigint",
]);
const LITERALS = new Set(["NaN", "Infinity", "-Infinity", "undefined", "true", "false", "null"]);
const isContainer = (rendered: string): boolean =>
  rendered.startsWith("{") || rendered.startsWith("[");
const isString = (rendered: string): boolean => /^['"`]/u.test(rendered);
// A number, or a string holding only number spelling (`'0123'`, `'1e'`, `'-'`) we kept as text.
const isNumberSpelling = (rendered: string): boolean =>
  /^-?\d/u.test(rendered) || /^'[-+]?[\d_]*\.?\d*(?:[eE][-+]?)?\d*'$/u.test(rendered);

// Order matters: the first matching cluster owns a pair, so narrow causes precede broad ones.
export const CLUSTERS: readonly Cluster[] = [
  {
    id: "unclosed-single-quote-root",
    verdict: "ours",
    reason:
      "A root that opens with an apostrophe and never closes it shows no JSON evidence, like a lone word, so we refuse it with its text in `recovered` (P2: a wrong yes makes prose data); recovering rivals return it as a string.",
    match: (p) => {
      const t = p.text.trim();
      return t.startsWith("'") && !t.includes("'", 1);
    },
    cases: [
      ["'tis the season", { fails: "policy-refused" }],
      ["'; DROP TABLE users; --", { fails: "policy-refused" }],
    ],
  },
  {
    id: "held-last-line",
    verdict: "intended",
    reason:
      "Bun.JSONL holds an unfinished last line back for more input; we return the cut value marked complete: false (HLD Impact: every value says whether its source ended).",
    match: (p) =>
      p.lib === "Bun.JSONL" &&
      p.kind === "differs" &&
      p.at?.length === 0 &&
      p.rival === "undefined",
    cases: [
      ['{"a": [1, 2, 3', { value: { a: [1, 2, 3] }, complete: false }],
      ['{"a": 1,', { value: { a: 1 }, complete: false }],
    ],
  },
  {
    id: "exact-number",
    verdict: "ours",
    reason:
      "A double cannot hold the token exactly, so it stays an ExactNumber; a safe integer stays a number rather than a BigNumber (HLD Impact: unrepresentable numbers are exact, never rounded).",
    match: (p) =>
      p.ours?.startsWith("ExactNumber") === true || p.rival?.startsWith("BigNumber") === true,
    cases: [["9007199254740991", { value: 9007199254740991 }]],
  },
  {
    id: "strict-parser-refuses-damage",
    verdict: "intended",
    reason:
      "A strict parser refuses damaged input by contract; recovering it is this package's purpose (Purpose, P5).",
    match: (p) => p.kind === "rival-throws" && STRICT.has(p.lib),
    cases: [["{'a': 1,}", { value: { a: 1 } }]],
  },
  {
    id: "recovery-library-throws",
    verdict: "ours",
    reason:
      "A recovery library gives up on damage the source still lets us read; a value beats a failure the caller cannot act on (P5), and none of these values is invented (P1).",
    match: (p) => p.kind === "rival-throws",
    cases: [
      ["{bin: 0b1010}", { value: { bin: 10 } }],
      ['{"a": 1 "b": 2}', { value: { a: 1, b: 2 } }],
    ],
  },
  {
    id: "we-decline-text-without-json",
    verdict: "ours",
    reason:
      "Prose, placeholders and stray punctuation hold no JSON evidence, so we return no value where the rival manufactures one (P2: a wrong yes turns text into data).",
    match: (p) => p.kind === "ours-declines",
    cases: [
      ["not JSON", { fails: "no-json-found" }],
      ["{{invalid}}", { fails: "no-json-found" }],
      ['<script>alert("xss")</script>', { fails: "no-json-found" }],
      // One space-free word is a lone unquoted root: refused by default with its text recovered.
      ["invalid", { fails: "policy-refused" }],
    ],
  },
  {
    id: "rival-wraps-roots-in-array",
    verdict: "ours",
    reason:
      "Several roots wrapped into one array is structure the source never wrote; parse returns the first root and parseMany each one (P1). Our callers re-parse a growing reply and read fields off an object, which an array would fail silently; a report's laterValues names what parse left out. Revisit only if real single-object replies often carry several newline-separated objects.",
    // `inspect` lays long arrays out in rows whatever the break length, so compare without layout.
    match: (p) =>
      p.got !== undefined &&
      p.whole !== undefined &&
      p.got.replaceAll(/\s+/gu, " ").startsWith(`[ ${p.whole.replaceAll(/\s+/gu, " ")}`),
    cases: [['{"a": 1} {"b": 2}', { value: { a: 1 } }]],
  },
  {
    id: "rival-reads-wrong-candidate",
    verdict: "ours",
    reason:
      "The rival returns a prose word or the text itself instead of the JSON in it; we take the first value with JSON evidence (P2).",
    match: (p) =>
      p.kind === "differs" &&
      p.at?.length === 0 &&
      p.ours !== undefined &&
      p.rival !== undefined &&
      isContainer(p.ours) &&
      !isContainer(p.rival),
    cases: [
      ["prefix [1, 2, 3] suffix", { value: [1, 2, 3] }],
      ['Some text {"a": 1} more text', { value: { a: 1 } }],
    ],
  },
  {
    id: "rival-drops-written-member",
    verdict: "ours",
    reason:
      "The rival drops a member the source wrote, or empties a written container to '': single-quoted, unquoted, commented, missing a colon or comma, or named __proto__ (P1, D1).",
    match: (p) =>
      p.rival === "<absent>" ||
      (p.rival === "undefined" && p.ours !== "undefined") ||
      (p.rival === "''" && p.ours !== undefined && isContainer(p.ours)),
    cases: [
      ["{'key': 'value'}", { value: { key: "value" } }],
      ['{"name": "John"\n"age" 30}', { value: { name: "John", age: 30 } }],
    ],
  },
  {
    id: "rival-invents-value",
    verdict: "ours",
    reason:
      "The rival fills a place the source left empty (an empty slot, a key whose value never came) with '', null or undefined; we keep nothing there (P1).",
    match: (p) => p.ours === "<absent>",
    cases: [
      ["[1, 2,,]", { value: [1, 2] }],
      ['{"name": "John", "incomplete": ', { value: { name: "John" }, complete: false }],
    ],
  },
  {
    id: "js-literal-kept",
    verdict: "ours",
    reason:
      "A JavaScript or Python literal (NaN, Infinity, undefined, True, None) has one meaning, so it becomes that value rather than its text or null (P1); repair refuses what JSON cannot hold.",
    match: (p) => p.ours !== undefined && LITERALS.has(p.ours),
    cases: [
      ['{"value": NaN}', { value: { value: Number.NaN } }],
      ['{"a": True, "c": None}', { value: { a: true, c: null } }],
    ],
  },
  {
    id: "number-spelling",
    verdict: "ours",
    reason:
      "We read the number the source wrote: a spelling with one meaning (0xFF, 0b1010, 1_000) becomes that number, and an ambiguous or broken token (0123, 1e, -) keeps its text; the rival truncates, zeroes or guesses it (P1).",
    match: (p) => p.ours !== undefined && isNumberSpelling(p.ours),
    cases: [
      ["{hex: 0xFF}", { value: { hex: 255 } }],
      ['{"a": 1_000}', { value: { a: 1000 } }],
      ["{octal: 0123}", { value: { octal: "0123" } }],
      ['{"a": 1e}', { value: { a: "1e" } }],
    ],
  },
  {
    id: "unclosed-string-keeps-code-or-prose-line",
    verdict: "intended",
    reason:
      'A string still open at the end of the input ends at a raw line break by default when a quoted key follows the break, or only closers the string did not open (`missing-quote`, test/missing-quote.test.ts). It keeps the line after the break in two cases: closers that close a bracket the string opened, since a cut stream of code or a graph ends in `}` (P1: keep the text), and a bare word before a colon, which prose writes too (`Note: ...`). jsonrepair ends the string at the line break there as well, which `recover: { "guessed-string-end": true }` does here too.',
    // `inspect` escapes the raw line break, so ours is the rival's text plus `\n` and the kept tail.
    // Only whitespace and the closers the JSON kept may follow that tail in the input: a string its
    // own quote closed (`"a\n,b"` split by a rival at the line break) is a different cause.
    match: (p) => {
      if (p.ours === undefined || p.rival === undefined) return false;
      if (!isString(p.ours) || !isString(p.rival)) return false;
      const ours = p.ours.slice(1, -1);
      const rival = p.rival.slice(1, -1);
      const tail = ours
        .slice(rival.length)
        .replaceAll(String.raw`\n`, "\n")
        .trimEnd();
      const at = p.text.lastIndexOf(tail);
      return (
        ours.startsWith(rival) &&
        tail.startsWith("\n") &&
        at >= 0 &&
        /^[\s\]}]*$/u.test(p.text.slice(at + tail.length))
      );
    },
    cases: [
      [
        '{"code": "f() {\n  return 1;\n}',
        { value: { code: "f() {\n  return 1;\n}" }, complete: false },
      ],
      ["{a: 1, d: 'unclosed\n  b: 2\n}", { value: { a: 1, d: "unclosed\n  b: 2" } }],
    ],
  },
  {
    id: "string-delimiters",
    verdict: "ours",
    reason:
      "We end a string where its own quote closes it, decode its escapes and keep its spacing; the rival swallows the next member or the closers after a raw line break, leaves escapes raw, trims, or appends trailing punctuation (P1).",
    match: (p) => p.ours !== undefined && p.rival !== undefined && isString(p.ours),
    cases: [
      [
        '{"key1": "value1","key2": "value2\',\'key3": "value3"}',
        { value: { key1: "value1", key2: "value2", key3: "value3" } },
      ],
      [
        '{"long_string": "word after word ',
        { value: { long_string: "word after word " }, complete: false },
      ],
      ['{"bad": "\\u12G5"}', { value: { bad: "\\u12G5" } }],
    ],
  },
];

/** The cluster that owns a pair, or undefined when no recorded cause explains it. */
export const classify = (pair: Pair): Cluster | undefined => CLUSTERS.find((c) => c.match(pair));
