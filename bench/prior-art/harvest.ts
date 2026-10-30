// SPDX-License-Identifier: Apache-2.0

/**
 * Check bounded, static test literals from pinned rival suites against our recovery contract.
 * Interpolated templates and generated inputs require separate coverage.
 *
 *     bun bench/prior-art/harvest.ts            # triage report
 *
 * **Their inputs are the asset; their assertions are not.** A rival's expectation encodes a rival's
 * semantics — `jsonrepair` deletes backslashes from unknown escapes, `partial-json` drops
 * `__proto__` — so importing assertions would import behaviour this package has ruled against.
 * What years of bug reports produced is the INPUT set: the malformed shapes real users actually hit.
 * So extraction is mechanical and every judgement below is made by OUR contract.
 *
 * Literals are taken from the syntax tree rather than by matching quotes, because a test file is
 * full of escaped quotes inside JSON strings and no pattern survives them. Expected-output literals
 * and test descriptions come along too, and are deliberately not filtered: a rival's expected output
 * is itself valid JSON worth parsing, and a description is a text with no JSON in it, which is a
 * case this package must also answer correctly.
 *
 * The checks are FALSIFIERS, never confirmations — each one is a promise this package makes that a
 * hostile input could break:
 *   - the exercised parse, parseMany and repair calls do not throw;
 *   - `repair(text)` succeeds whenever `parse(text)` does, parses under strict `JSON.parse`, and means
 *     the same as `parse(text)` with NaN, infinities and undefined written as null;
 *   - a value fed one character at a time equals the same value fed whole.
 * The rival-comparison section is separate and reports capability gaps, which are judgement calls
 * for a human rather than defects.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import bestEffort from "best-effort-json-parser";
import { loads as jsonRepairJsLoads } from "json-repair-js";
import { jsonrepair } from "jsonrepair";
import { ALL, parse as partialParse } from "partial-json";
// The classic compiler API (`createSourceFile`) exists only up to TypeScript 6; the 7.x package
// exports no such API, so AST tools read source through the `typescript-6` alias.
import ts from "typescript-6";

import { canonical } from "../../scripts/corpus/canonical";
import { initParser, isExactNumber, LLM_FULL, repair, STRICT } from "../../src/index";
import type { Parser } from "../../src/index";
import { acquireSuite, REPAIR_SUITES } from "./suites";
import {
  createStreamParser as configuredCreateStreamParser,
  parse as configuredParse,
  parseMany as configuredParseMany,
} from "../../src/index";

// Its recovery path prints to the console on every recovered input; left on, a harvest of a few
// thousand malformed literals is mostly terminal I/O.
(bestEffort as { disableErrorLogging?: () => void }).disableErrorLogging?.();

/** Extract static literals without executing upstream code or guessing escaped quote boundaries. */
const literals = (path: string): { text: string; line: number }[] => {
  const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: { text: string; line: number }[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      found.push({
        text: node.text,
        line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
      });
    ts.forEachChild(node, walk);
  };
  walk(src);
  return found;
};

const inputs = new Map<string, string>(); // text -> immutable source location
let excluded = 0;
const suites = await Promise.all(REPAIR_SUITES.map((suite) => acquireSuite(suite)));
for (const { repo, revision, root, files } of suites) {
  const tests = files.filter((file) => /\.(test|spec)\.[cm]?[jt]s$/u.test(file));
  if (tests.length === 0) throw new Error(`${repo}: no tracked test files acquired.`);
  for (const file of tests) {
    for (const { text, line } of literals(join(root, file))) {
      // Bound this triage pass; excluded literals are not evidence of coverage.
      if (text.length === 0 || text.length > 2048) {
        excluded++;
        continue;
      }
      if (!inputs.has(text))
        inputs.set(text, `https://github.com/${repo}/blob/${revision}/${file}#L${line}`);
    }
  }
}

type Finding = { check: string; text: string; from: string; detail: string };
const findings: Finding[] = [];
const note = (check: string, text: string, from: string, detail: string): void => {
  findings.push({ check, text, from, detail });
};

/**
 * `initParser` reports rejected options as a VALUE rather than throwing, which is right for a
 * library and wrong to propagate here: these are the package's own literal presets, so a failure is
 * a defect in this script and has to stop it instead of surfacing as a union at every call site.
 */
const parserFor = (options: Parameters<typeof initParser>[0]): Parser => {
  return initParser(options);
};

/** What repaired text can carry: JSON has no NaN, infinity or undefined, so repair writes null. */
const writtenAsJson = (value: unknown): unknown => {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return null;
  if (Array.isArray(value)) return value.map((item) => writtenAsJson(item));
  if (typeof value !== "object" || value === null || isExactNumber(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, writtenAsJson(v)]));
};

const strict = parserFor(STRICT);
const full = parserFor(LLM_FULL);

/**
 * Compare chunked and whole values. Short inputs use every character boundary; longer inputs
 * sample cuts. This does not cover every long-input split or buffer-compaction boundary.
 */
const chunked = (text: string, cuts: number[]): unknown[] => {
  const sp = configuredCreateStreamParser(full);
  // Each `feed` yields the outcomes that chunk completed and `end` the tail, so the stream is the
  // concatenation. Unwrapped to values because the comparison downstream is against `parse`.
  const out: unknown[] = [];
  let last = 0;
  for (const cut of [...cuts, text.length]) {
    for (const r of sp.feed(text.slice(last, cut))) out.push(r.ok ? r.value : undefined);
    last = cut;
  }
  for (const r of sp.end()) out.push(r.ok ? r.value : undefined);
  return out;
};

for (const [text, from] of inputs) {
  // ── Nothing throws, ever. The package's whole error model is that failure is a value.
  let value: unknown;
  let ok = false;
  try {
    const r = configuredParse(text, full);
    ok = r.ok;
    value = r.ok ? r.value : undefined;
  } catch (e) {
    note("throws:parse", text, from, String(e));
    continue;
  }
  try {
    // Drained, not merely constructed: `parseMany` is a generator, so nothing runs until it is
    // consumed and an unconsumed one would prove only that calling it does not throw.
    void [...configuredParseMany(text, full)].length;
  } catch (e) {
    note("throws:parseMany", text, from, String(e));
  }
  try {
    configuredParse(text, strict);
  } catch (e) {
    note("throws:STRICT", text, from, String(e));
  }

  // ── `repair` must produce text that is strictly valid and means what `parse` said it means.
  let repaired: string | undefined;
  try {
    const result = repair(text, LLM_FULL);
    if (result.ok) repaired = result.value;
    // repair fails exactly when parse fails, so any failure after a successful parse is a defect.
    else if (ok) {
      note(`repair:${result.failure.kind}`, text, from, JSON.stringify(result.failure));
    }
  } catch (e) {
    note("throws:repair", text, from, String(e));
  }
  if (ok && repaired !== undefined) {
    let valid = false;
    try {
      JSON.parse(repaired);
      valid = true;
    } catch (e) {
      note("repair:invalid", text, from, `${String(e)} — produced ${JSON.stringify(repaired)}`);
    }
    if (valid) {
      // JSON.parse proves syntax, but rounds large numbers. Compare meaning through the same
      // exact-number contract as the original call, after the independent syntax check.
      const reparsed = configuredParse(repaired, full);
      const a = canonical(writtenAsJson(value));
      const b = canonical(reparsed.ok ? reparsed.value : reparsed.failure);
      if (!reparsed.ok || a !== b) {
        note("repair:diverges", text, from, `parse ${a} vs repair ${b}`);
      }
    }
  }

  // ── A chunked read is the same read. This is the property the streaming core exists to hold.
  if (ok) {
    const cuts =
      text.length <= 160
        ? Array.from({ length: text.length - 1 }, (_, i) => i + 1)
        : Array.from({ length: 16 }, (_, i) => Math.floor(((i + 1) * text.length) / 17));
    for (const cut of cuts) {
      let streamed: unknown[];
      try {
        streamed = chunked(text, [cut]);
      } catch (e) {
        note("throws:feed", text, from, `cut ${cut}: ${String(e)}`);
        break;
      }
      if (canonical(streamed[0]) !== canonical(value)) {
        note(
          "stream:diverges",
          text,
          from,
          `cut ${cut}: ${canonical(streamed[0])} vs ${canonical(value)}`,
        );
        break;
      }
    }
  }
}

// ── Capability gaps: inputs every rival reads and we refuse. Judgement, not defect.
const rivalValue = (text: string): string | undefined => {
  const attempts: Array<() => unknown> = [
    () => JSON.parse(jsonrepair(text)),
    () => partialParse(text, ALL),
    () => (bestEffort as { parse: (t: string) => unknown }).parse(text),
    () => jsonRepairJsLoads(text),
  ];
  const values = new Set<string>();
  for (const attempt of attempts) {
    try {
      const v = attempt();
      if (v === undefined) return undefined;
      values.add(canonical(v));
    } catch {
      return undefined; // Unanimity needs an answer from every rival, not only the ones that accept.
    }
  }
  return values.size === 1 ? [...values][0] : undefined;
};

const gaps: Finding[] = [];
for (const [text, from] of inputs) {
  const r = configuredParse(text, full);
  if (r.ok) continue;
  const agreed = rivalValue(text);
  // `null`, `{}`, `[]` and `""` are what a rival returns when it gives up, so unanimity on them is
  // not evidence that the text held a value. `""` earns its place here: on a document that is only
  // whitespace or only a comment, every alternative agrees on the empty STRING — a value none of
  // them read, invented out of an empty document. `no-json-found` is the answer, and the rule that
  // absence and a value must stay distinguishable is why.
  if (agreed !== undefined && !["null", "{}", "[]", '""'].includes(agreed)) {
    gaps.push({ check: "gap", text, from, detail: `every rival reads ${agreed}` });
  }
}

const show = (list: Finding[], title: string): void => {
  console.log(`\n## ${title} — ${list.length}\n`);
  const byCheck = new Map<string, Finding[]>();
  for (const f of list) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
  for (const [check, items] of byCheck) {
    console.log(`### ${check} — ${items.length}`);
    for (const f of items.slice(0, 40)) {
      console.log(`  ${f.from}: ${JSON.stringify(f.text).slice(0, 160)}`);
      console.log(`      ${f.detail.slice(0, 220)}`);
    }
    if (items.length > 40) console.log(`  … and ${items.length - 40} more`);
  }
};

console.log(`harvested ${inputs.size} distinct literals from ${suites.length} verified suites`);
console.log(
  `excluded ${excluded} empty or over-2048-code-unit literals; generated inputs were not evaluated`,
);
show(findings, "Invariant violations");
show(gaps, "Capability gaps (judgement, not defects)");
