// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createStreamParser,
  diagnostics,
  findJsonSpan,
  initParser as parser,
  parse,
  parseMany,
  parseStream as configuredParseStream,
  repair,
  sharedView,
} from "../src/index";
import { configurationCause } from "./configuration-error";

const REPORT = { diagnostics } as const;
const failed = <F>(result: { ok: true } | { ok: false; failure: F }): F | undefined =>
  result.ok ? undefined : result.failure;

describe("a parser is configuration, a stream parser is state", () => {
  it("keeps two streams from one parser independent", () => {
    // Unrepresentable now, and the defect it prevents was real: one object held both, so a per-call
    // option merged permanently into the shared configuration.
    const p = parser();
    const a = createStreamParser(p);
    const b = createStreamParser(p);
    void Array.from(a.feed('{"x":1'));
    void Array.from(b.feed("[9,8"));
    expect([...a.end()]).toMatchObject([{ ok: true, value: { x: 1 } }]);
    expect([...b.end()]).toMatchObject([{ ok: true, value: [9, 8] }]);
  });

  it("carries the parser's own options into the stream, not the defaults", () => {
    // The failure this catches is a `stream()` that mints state from a fresh resolve instead of the
    // parser's: every value still arrives, so only an option whose absence is VISIBLE can see it.
    const sp = createStreamParser(parser(REPORT));
    // The line break settles the root: a comma touching it would have begun a list.
    const items = Array.from(sp.feed('{"a":1,}\n'));
    const first = items[0];
    if (first === undefined || "kind" in first) throw new Error("expected a value item");
    expect(first.diagnostics.repairs.map((r) => r.kind)).toEqual(["trailing-comma"]);
  });

  it("lets an amortised caller ask for a view, which the parser form could not express", () => {
    // The gap this closes: `view` is a stream option, so when a stream could only be built from
    // `Parser | options` there was no argument in which to name it. Nothing was broken — it was
    // unreachable, which is worse, because there was no call to get wrong.
    const sp = createStreamParser(parser({ maxDepth: 16 }), { view: sharedView });
    void Array.from(sp.feed('{"a":{"b":1}'));
    const snap = sp.snapshot();
    expect(snap.ok).toBe(true);
    // `value` is optional because a snapshot taken before any root exists is `undefined`; here a
    // root is open, so `?.` failing to resolve is itself the defect this asserts against.
    if (snap.ok) expect(snap.value?.value).toEqual({ a: { b: 1 } });
  });

  it("refuses a parse option on a stream instead of ignoring it", () => {
    // Silently dropping it would run the stream under settings the caller did not choose, and the
    // result would look fine — `diagnostics` would simply be absent from a result they asked to
    // have it. The field is named because "invalid options" alone does not say which one.
    const p = parser();
    expect(configurationCause(() => createStreamParser(p, { diagnostics } as never))).toEqual({
      kind: "invalid-options",
      field: "diagnostics",
      reason: "parse-option-on-stream",
    });
  });

  it("keeps recovery and reports independent across repeated configured calls", () => {
    // Shared configuration must not accumulate recovery or reports across calls.
    const p = parser(REPORT);
    for (let call = 0; call < 2; call++) {
      const outcome = parse('{"a":[1,2', p);
      expect(outcome).toMatchObject({ ok: true, value: { a: [1, 2] }, complete: false });
      expect(outcome.diagnostics.repairs.map((entry) => entry.kind)).toEqual([
        "unclosed-array",
        "unclosed-object",
      ]);
    }
  });

  it("refuses every operation after idempotent configured-parser cleanup", async () => {
    const p = parser(REPORT);
    // Cleanup callbacks may outlive the binding expression; they must not require a receiver.
    const close = p.close;
    expect(close()).toEqual({ ok: true, value: undefined });
    expect(close()).toEqual({ ok: true, value: undefined });

    const refusal = { kind: "parser-closed" };
    expect(failed(parse("[]", p))).toEqual(refusal);
    const many = [...parseMany("[]", p)][0];
    expect(many === undefined ? undefined : failed(many)).toEqual(refusal);
    expect(failed(repair("[]", p))).toEqual(refusal);
    expect(failed(findJsonSpan("[]", p))).toEqual(refusal);
    // A refusal reads nothing, so the configured report is present and empty.
    expect(parse("[]", p).diagnostics).toMatchObject({ repairs: [], errors: [] });
    expect(parse("[]", p, { diagnostics: false })).not.toHaveProperty("diagnostics");
    const closedStream = createStreamParser(p);
    expect([...closedStream.feed("[]"), ...closedStream.end()].map((item) => failed(item))).toEqual(
      [refusal, refusal],
    );

    const streamed = [];
    for await (const item of configuredParseStream(["[]"], p)) streamed.push(item);
    expect(streamed.map((item) => ("kind" in item ? item : failed(item)))).toEqual([refusal]);

    // A bad option is the caller's bug whether or not the parser is open; `parser-closed` would
    // hide it until the same call reached an open parser.
    const badDepth = { kind: "invalid-options", field: "maxDepth", reason: "positive-integer" };
    expect(configurationCause(() => parse("[]", p, { maxDepth: 0 }))).toEqual(badDepth);
    expect(configurationCause(() => parseMany("[]", p, { maxDepth: 0 }))).toEqual(badDepth);
    expect(configurationCause(() => createStreamParser(p, { view: "x" as never }))).toEqual({
      kind: "invalid-options",
      field: "view",
      reason: "view",
    });
    const notObject = { kind: "invalid-options", field: "options", reason: "object" };
    expect(configurationCause(() => configuredParseStream(["[]"], p, 5 as never))).toEqual(
      notObject,
    );
    expect(
      configurationCause(() => configuredParseStream(["[]"], parser(), null as never)),
    ).toEqual(notObject);
    // The controller passed for its signal would have been ignored, leaving the stream uncancellable.
    const controller = { signal: new AbortController() as never };
    expect(configurationCause(() => configuredParseStream(["[]"], parser(), controller))).toEqual({
      kind: "invalid-options",
      field: "signal",
      reason: "signal",
    });

    const disposed = parser();
    disposed[Symbol.dispose]();
    expect(failed(parse("[]", disposed))).toEqual(refusal);
  });
});
