#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/** Every recorded whole-input case must keep the same outcome under cooperative scheduling. */

import {
  cooperative,
  findJsonSpanAsync,
  parseAsync,
  parseManyAsync,
  repairAsync,
  type AsyncOptions,
} from "../src/async";
import { findJsonSpan, parse, parseMany, repair } from "../src/index";
import type { ParserOptions } from "../src/options";
import { canonical } from "./corpus/canonical";
import type { Case } from "./corpus/observe";
import { wholeInputOf } from "./corpus/observe";
import type { CorpusOptions } from "./corpus/profile";
import { featuresOf } from "./corpus/profile";
import { contract } from "./corpus/record";
import { decodeWildcards } from "./corpus/selectors";

type Row = Omit<Case, "options"> & { readonly p: number };

// The recorder's cases, recorded in memory; Git keeps only their hash (scripts/corpus/record.ts).
const lines = contract.split("\n").filter((line) => line !== "");
const header = lines[0];
if (header === undefined) throw new Error("the recorded contract is empty");
const { profiles } = JSON.parse(header, decodeWildcards) as { readonly profiles: CorpusOptions[] };

const same = (id: string, verb: string, expected: unknown, actual: unknown): void => {
  const left = canonical(expected);
  const right = canonical(actual);
  if (left !== right)
    throw new Error(`${id} ${verb}\n  synchronous: ${left}\n  cooperative: ${right}`);
};

let rows = 0;
for (const line of lines.slice(1)) {
  const row = JSON.parse(line) as Row;
  const input = wholeInputOf(row);
  if (input === undefined) continue;
  const profile = profiles[row.p];
  if (profile === undefined) throw new Error(`${row.id}: profile ${row.p} is not in the header`);
  const options = featuresOf(profile) as ParserOptions;
  const scheduled: AsyncOptions = { ...options, execution: cooperative };

  // Rows stay sequential so the conformance check retains one operation's state at a time.
  // oxlint-disable-next-line eslint/no-await-in-loop
  same(row.id, "parse", parse(input, options), await parseAsync(input, scheduled));
  // oxlint-disable-next-line eslint/no-await-in-loop
  same(row.id, "repair", repair(input, options), await repairAsync(input, scheduled));
  same(
    row.id,
    "findJsonSpan",
    findJsonSpan(input, options),
    // oxlint-disable-next-line eslint/no-await-in-loop
    await findJsonSpanAsync(input, scheduled),
  );

  const synchronous = parseMany(input, options);
  const sequence = parseManyAsync(input, scheduled);
  let item = 0;
  while (true) {
    const expected = synchronous.next();
    // Comparing one pull at a time keeps lazy delivery part of the contract.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const actual = await sequence.next();
    same(row.id, `parseMany[${String(item)}]`, expected, actual);
    if (expected.done === true) break;
    item++;
  }
  rows++;
}

if (rows === 0) throw new Error("async conformance reached no whole-input corpus rows");
console.log(`async contract: ${String(rows)} whole-input rows match all four cooperative verbs`);
