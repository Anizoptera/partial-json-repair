// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { StreamItem } from "../src/index";
import { COMPAT, createStreamParser, parse, repair, diagnostics } from "../src/index";

/**
 * A whole input that is one unquoted word (`Sorry`, `hello`, `id-123`) holds no JSON evidence: the
 * word is a value only if a repair says so. Reading it as a successful string at confidence 0.97
 * told callers a one-word refusal from a model was near-clean data. By default it is now a policy
 * refusal that still carries the word in `recovered`; `unquoted-root-string` turns the old reading
 * back on, and `COMPAT` does, because the legacy `parseJsonCompat` returned such words as strings.
 *
 * Candidacy does not move: the word is consumed exactly as before and only the verdict changes, so
 * the value is the same under both settings (`src/AGENTS.md`, "A leniency flag OFF").
 */
const value = (text: string): unknown => {
  const r = parse(text);
  return r.ok ? r.value : `failed: ${r.failure.kind}`;
};

const LONE = ["hello", "invalid", "Sorry", "id-123", "123abc", "0_1", "\u0001", "  word  "];

describe("a lone unquoted word at the root", () => {
  it("is refused by default, naming the switch, with the word recovered", () => {
    for (const text of LONE) {
      for (const report of [false, diagnostics] as const) {
        const r = parse(text, { diagnostics: report });
        expect(r.ok, text).toBe(false);
        if (r.ok || r.failure.kind !== "policy-refused") {
          expect.unreachable(`${JSON.stringify(text)} was not policy-refused`);
          continue;
        }
        expect(r.failure.issue.refused, text).toBe("unquoted-root-string");
        expect(r.failure.recovered?.value, text).toBe(text.trim());
      }
    }
  });

  // A finished token that is no number (`1..5`, a lone `-` a closer ended) is kept as its source text,
  // which at the root is the same unquoted string a word is: no JSON evidence either. A cut token
  // there (`...` at the end) is already `no-json-found`; this keeps a stray closer from flipping that.
  it("treats a lone invalid number the same way, but keeps it inside a container", () => {
    for (const [text, token] of [
      ["...]", "..."],
      ["-]", "-"],
      ["1..5", "1..5"],
      ["1-2", "1-2"],
      ["0123", "0123"],
    ] as const) {
      const r = parse(text);
      if (r.ok || r.failure.kind !== "policy-refused") {
        expect.unreachable(`${text} was not policy-refused`);
        continue;
      }
      expect(r.failure.issue.refused, text).toBe("unquoted-root-string");
      expect(r.failure.recovered?.value, text).toBe(token);
      expect(value(`[${token}]`), text).toEqual([token]);
    }
    const compat = parse("1..5", { ...COMPAT, diagnostics });
    expect(compat.ok && compat.value).toBe("1..5");
  });

  it("is refused inside a code fence as well", () => {
    const r = parse("```\nhello\n```");
    expect(!r.ok && r.failure.kind).toBe("policy-refused");
  });

  it("reads as the string under COMPAT or the named switch", () => {
    for (const options of [COMPAT, { recover: { "unquoted-root-string": true } }] as const) {
      const r = parse("hello", { ...options, diagnostics });
      expect(r.ok && r.value).toBe("hello");
      expect(r.ok && r.diagnostics.repairs.map((x) => x.kind)).toEqual(["unquoted-root-string"]);
    }
  });

  it("refuses through repair too, and repairs it under the switch", () => {
    expect(repair("hello").ok).toBe(false);
    const r = repair("hello", { recover: { "unquoted-root-string": true } });
    expect(r.ok && (JSON.parse(r.value) as unknown)).toBe("hello");
  });

  it("leaves words inside containers and recognised literals as they were", () => {
    expect(value("[hello]")).toEqual(["hello"]);
    expect(value("{a: hello}")).toEqual({ a: "hello" });
    expect(value("True")).toBe(true);
    expect(value("None")).toBe(null);
    expect(Object.is(value("NaN"), Number.NaN)).toBe(true);
    expect(value("tru")).toBe("failed: no-json-found");
    expect(value("hello world")).toBe("failed: no-json-found");
  });

  // Prose writes apostrophes (`'tis`, `'em`), so one that never closes is no more evidence of JSON
  // than the bare word after it. A closed one, or one inside a container, is a single-quoted string.
  it("refuses a root an apostrophe opens and never closes, whole and per character", () => {
    for (const text of ["'tis the season", "'unclosed", "  'a b  "]) {
      const r = parse(text);
      if (r.ok || r.failure.kind !== "policy-refused") {
        expect.unreachable(`${JSON.stringify(text)} was not policy-refused`);
        continue;
      }
      expect(r.failure.issue.refused, text).toBe("unquoted-root-string");
      expect(r.failure.recovered?.value, text).toBe(text.trimStart().slice(1));
      const sp = createStreamParser();
      const items: StreamItem[] = [];
      for (const ch of text) items.push(...sp.feed(ch));
      items.push(...sp.end());
      const last = items.at(-1);
      expect(last !== undefined && "ok" in last && !last.ok && last.failure.kind, text).toBe(
        "policy-refused",
      );
      const on = parse(text, { recover: { "unquoted-root-string": true } });
      expect(on.ok && on.value, text).toBe(text.trimStart().slice(1));
      expect(on.ok && on.complete, text).toBe(false);
    }
    expect(value("'abc'")).toBe("abc");
    expect(value("['abc")).toEqual(["abc"]);
    expect(value("{'a': 'x")).toEqual({ a: "x" });
    expect(value('"abc')).toBe("abc");
    const fixed = repair("'tis", COMPAT);
    expect(fixed.ok && (JSON.parse(fixed.value) as unknown)).toBe("tis");
  });

  it("reads a long word in linear time when the scan resumes inside it", () => {
    // Each malformed byte ends a decoded piece, so the root word pauses at every byte. A pause that
    // kept the word's source but not its resume point re-read the whole word each time. Compare the
    // same bytes inside a quoted string, which pause the same way without that re-read. Both must
    // finish: the default error budget stops the quoted control early but defers the root refusal.
    const word = new Uint8Array(4096).fill(0xff);
    const quoted = new Uint8Array(word.length + 4).fill(0xff);
    quoted.set([0x5b, 0x22], 0);
    quoted.set([0x22, 0x5d], word.length + 2);
    const options = { maxScalar: 65_536, maxErrors: 65_536 };
    // Count real character reads rather than elapsed time; preemption cannot hide a repeated scan.
    const measured = (input: Uint8Array) => {
      // eslint-disable-next-line typescript/unbound-method -- The counter supplies the original receiver.
      const nativeRead = String.prototype.charCodeAt;
      let reads = 0;
      try {
        // eslint-disable-next-line no-extend-native -- Count native reads synchronously, then restore in finally.
        String.prototype.charCodeAt = function (this: string, index: number): number {
          reads++;
          return nativeRead.call(this, index);
        };
        return { result: parse(input, options), reads };
      } finally {
        // eslint-disable-next-line no-extend-native -- Release the counter before another test can run.
        String.prototype.charCodeAt = nativeRead;
      }
    };
    const plain = measured(word);
    const wrapped = measured(quoted);
    const refused = plain.result;
    expect(!refused.ok && refused.failure.kind).toBe("policy-refused");
    expect(
      !refused.ok && refused.failure.kind === "policy-refused" && refused.failure.recovered?.value,
    ).toBe("\uFFFD".repeat(word.length));
    const complete = wrapped.result;
    expect(complete.ok && complete.value).toEqual(["\uFFFD".repeat(word.length)]);
    expect(wrapped.reads).toBeGreaterThan(word.length);
    expect(plain.reads).toBeLessThan(wrapped.reads * 50);
  });
});
