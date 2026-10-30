// SPDX-License-Identifier: Apache-2.0

/**
 * Records how JavaScript spells every double, for the Rust canonical writer to be held to.
 *
 * `bun scripts/rust/number-fixture.ts` rewrites the fixture. It exists as a script rather than as a
 * one-off because the alternative is a comment pointing at a shell snippet in the commit history,
 * and a procedure nobody can run is a procedure that rots.
 *
 * The rule has three independent parts — shortest round-tripping digits, the exponential window, and
 * the mantissa and exponent spelling — so the cases are boundary values around each, plus an LCG
 * over bit patterns. The LCG makes the set reproducible without storing a seed.
 */
import { writeFileSync } from "node:fs";

const buf = new ArrayBuffer(8);
const asDouble = new Float64Array(buf);
const asBits = new BigUint64Array(buf);
const lines: string[] = [];

const record = (n: number): void => {
  asDouble[0] = n;
  // Non-finite values are canonical MARKERS decided above the number writer, so recording one here
  // would test the wrong layer.
  if (!Number.isFinite(n)) return;
  lines.push(`${(asBits[0] ?? 0n).toString(16).padStart(16, "0")} ${String(n)}`);
};

const BOUNDARIES = [
  0,
  -0,
  1,
  -1,
  0.5,
  1 / 3,
  1e-6,
  9.999999e-7,
  1e-7,
  5e-324,
  1e20,
  1e21,
  1.1e21,
  1e308,
  1.7976931348623157e308,
  123456789,
  1234567890123456800,
  0.1,
  0.2,
  0.30000000000000004,
  100,
  1e15,
  1e16,
  2 ** 53,
  2 ** 53 + 2,
  -2.5e-8,
  6.02e23,
  1e-321,
];
for (const n of BOUNDARIES) record(n);

let state = 0x2545f4914f6cdd1dn;
for (let i = 0; i < 400; i++) {
  state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  asBits[0] = state;
  record(asDouble[0] ?? 0);
}

const target = new URL(
  "../../rust/crates/partial-json-repair/tests/js-number-spelling.txt",
  import.meta.url,
);
writeFileSync(target, `${lines.join("\n")}\n`);
console.log(`${lines.length} cases`);
