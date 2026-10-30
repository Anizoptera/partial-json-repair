// SPDX-License-Identifier: Apache-2.0
// test-scope: private-modules

import { describe, expect, it } from "vitest";
import { ANY, select } from "../src/index";
import { MODE_VALUE } from "../src/builder";
import { MODE_EDITS } from "../src/edit-log";
import { resolveOptions } from "../src/options";
import { repairOutcomeSteps } from "../src/repair-operation";
import { firstSteps, readFirst, createBoundedWholeInputReader } from "../src/whole-reader";
import type { WholeInputReader } from "../src/whole-reader";
import { wholeInputSource } from "../src/whole-source";
import { stopReader, wholeOperation } from "../src/whole-operation";
import type { stoppedOutcome } from "../src/whole-operation";
import type { AbortedFailure, Match, SchedulingFailure } from "../src/types";

// Drain the production checkpointed stop for assertions that need its final recovery synchronously.
const stop = (
  reader: WholeInputReader,
  failure: AbortedFailure | SchedulingFailure,
): ReturnType<typeof stoppedOutcome> => {
  const operation = stopReader(reader, failure, 8);
  let step = operation.next();
  while (step.done !== true) step = operation.next();
  return step.value as ReturnType<typeof stoppedOutcome>;
};

const readerFor = (text: string) => {
  const source = wholeInputSource(text);
  if ("kind" in source) throw new Error("text source refused");
  return createBoundedWholeInputReader(
    source,
    resolveOptions({ select: select([["items", ANY]]) }),
    MODE_VALUE,
    8,
  );
};

describe("final selection preparation", () => {
  it.each(['"abcdefghijklmnopqrstuvwxyz"', '["abcdefghijklmnopqrstuvwxyz"]'])(
    "preserves a stopped root or array string in %s",
    (text) => {
      const source = wholeInputSource(text);
      if ("kind" in source) throw new Error("text source refused");
      const reader = createBoundedWholeInputReader(source, resolveOptions({}), MODE_VALUE, 8);
      expect(firstSteps(reader).next().done).toBe(false);
      const prefix = reader.scanner.scalars.pending;
      expect(prefix).toBeDefined();
      const outcome = stop(reader, { kind: "aborted", reason: "stop" });
      if (outcome.ok) throw new Error("stop succeeded");
      expect(outcome.failure.recovered?.value).toEqual(text.startsWith("[") ? [prefix] : prefix);
      expect(outcome.failure.recovered?.cut?.kind).toBe("string");
    },
  );

  it.each(['{"safe":1,"abcdefghijklmnopqrstuvwxyz":2}', '{"safe":1,"n":12345678901234567890}'])(
    "does not turn an unfinished key or number into a stopped value in %s",
    (text) => {
      const source = wholeInputSource(text);
      if ("kind" in source) throw new Error("text source refused");
      const reader = createBoundedWholeInputReader(source, resolveOptions({}), MODE_VALUE, 16);
      expect(firstSteps(reader).next().done).toBe(false);
      const outcome = stop(reader, { kind: "aborted", reason: "stop" });
      if (outcome.ok) throw new Error("stop succeeded");
      expect(outcome.failure.recovered?.value).toEqual({ safe: 1 });
      expect(outcome.failure.recovered?.cut?.kind).not.toBe("string");
    },
  );

  it.each(["keep", "drop", "reject"] as const)(
    "applies dangerous-key %s policy to a stopped string prefix",
    (onDangerousKey) => {
      const source = wholeInputSource('{"safe":1,"__proto__":"abcdefghijklmnopqrstuvwxyz"}');
      if ("kind" in source) throw new Error("text source refused");
      const reader = createBoundedWholeInputReader(
        source,
        resolveOptions({ onDangerousKey }),
        MODE_VALUE,
        8,
      );
      const steps = firstSteps(reader);
      while (reader.scanner.cut()?.kind !== "string") {
        if (steps.next().done === true) throw new Error("string checkpoint missing");
      }
      const prefix = reader.scanner.scalars.pending;
      const outcome = stop(reader, { kind: "aborted", reason: "stop" });
      if (outcome.ok) throw new Error("stop succeeded");
      const value = outcome.failure.recovered?.value;
      expect(value).toMatchObject(onDangerousKey === "reject" ? {} : { safe: 1 });
      if (typeof value !== "object" || value === null) throw new Error("missing recovery");
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.hasOwn(value, "__proto__")).toBe(onDangerousKey === "keep");
      if (onDangerousKey === "keep") expect(Reflect.get(value, "__proto__")).toBe(prefix);
      if (onDangerousKey === "reject") expect(Reflect.ownKeys(value)).toEqual([]);
    },
  );

  it("keeps stopped parent and string selections with independent recovery", () => {
    const source = wholeInputSource('{"outer":{"tail":"abcdefghijklmnopqrstuvwxyz"}}');
    if ("kind" in source) throw new Error("text source refused");
    const reader = createBoundedWholeInputReader(
      source,
      resolveOptions({
        select: select([["outer"], ["outer", "tail"]]),
        cutSuffix: "…",
      }),
      MODE_VALUE,
      8,
    );
    const steps = firstSteps(reader);
    while (reader.scanner.cut()?.kind !== "string") {
      if (steps.next().done === true) throw new Error("string checkpoint missing");
    }
    const outcome = stop(reader, { kind: "aborted", reason: "stop" });
    if (outcome.ok) throw new Error("stop succeeded");
    const matches = outcome.failure.recovered?.value as Match[];
    expect(matches.map((match) => match.path)).toEqual([["outer"], ["outer", "tail"]]);
    const parent = matches[0]?.value as { tail: string };
    const tail = matches[1]?.value;
    expect(parent.tail).toBe(tail);
    expect(parent.tail).toMatch(/^abc.*…$/u);
    parent.tail = "changed";
    expect(matches[1]?.value).toBe(tail);
    expect(outcome.failure.recovered?.cut?.path).toEqual(["outer", "tail"]);
  });

  it("isolates overlapping mutable matches in stopped recovery", () => {
    const source = wholeInputSource(
      `{"outer":{"child":{"n":1,"values":[${Array.from({ length: 96 }, (_, i) => i).join(",")}] }},"tail":"${"x".repeat(1024)}"}`,
    );
    if ("kind" in source) throw new Error("text source refused");
    const reader = createBoundedWholeInputReader(
      source,
      resolveOptions({ select: select([["outer"], ["outer", "child"]]) }),
      MODE_VALUE,
      8,
    );
    const reading = firstSteps(reader);
    try {
      while (
        (reader.scanner.build.picks?.delivery?.heldOccurrences.filter(
          (held) => typeof held !== "function" && !held.open,
        ).length ?? 0) < 2
      )
        if (reading.next().done === true) throw new Error("root closed before stop");
      const outcome = stop(reader, { kind: "aborted", reason: "stop" });
      if (outcome.ok) throw new Error("abort succeeded");
      const matches = outcome.failure.recovered?.value as Match[];
      expect(matches.map((match) => match.path)).toEqual([["outer"], ["outer", "child"]]);
      const parent = matches[0]?.value as { child: { n: number } };
      const child = matches[1]?.value as { n: number };
      parent.child.n = 2;
      expect(child.n).toBe(1);
    } finally {
      reading.return(undefined as never);
      reader.close();
    }
  });
  it("does not splice unselected text when repair has no matches", () => {
    const source = wholeInputSource(
      `{items:[${Array.from({ length: 96 }, (_, id) => `{id:${id}}`).join(",")}]}`,
    );
    if ("kind" in source) throw new Error("text source refused");
    const reader = createBoundedWholeInputReader(
      source,
      resolveOptions({ select: select([["missing"]]) }),
      MODE_EDITS,
      8,
    );
    const result = readFirst(reader);
    const steps = repairOutcomeSteps(source, result, 8);
    try {
      expect(result.outcome.ok).toBe(true);
      expect(result.outcome.ok && result.outcome.value).toEqual([]);
      expect(reader.scanner.edits.length).toBeGreaterThan(8);
      const projected = steps.next();
      expect(projected.done).toBe(true);
      expect(projected.value).toBe(result.outcome);
    } finally {
      steps.return(undefined as never);
      reader.close();
    }
  });

  it("preserves accumulated occurrences when a first-result call stops", () => {
    const text = `{"items":[${Array.from({ length: 96 }, (_, id) => `{"id":${id}}`).join(",")}]}`;
    const options = resolveOptions({ select: select([["items", ANY]], { occurrences: true }) });
    const source = wholeInputSource(text);
    if ("kind" in source) throw new Error("text source refused");
    const reader = createBoundedWholeInputReader(source, options, MODE_VALUE, 8);
    const reading = firstSteps(reader);
    let stopped = false;
    const operation = wholeOperation(
      "parse",
      text,
      options,
      {
        get aborted() {
          return stopped;
        },
        reason: "occurrence-stop",
      },
      8,
    );
    try {
      let checkpoints = 0;
      while (reader.scanner.delivered() < 3) {
        if (reading.next().done === true) throw new Error("root closed before stop");
        checkpoints++;
      }
      const count = reader.scanner.delivered();
      for (let i = 0; i < checkpoints; i++) operation.next();
      stopped = true;
      let result = operation.next();
      while (result.done !== true) result = operation.next();
      const outcome = result.value as ReturnType<typeof stoppedOutcome>;
      if (outcome.ok) throw new Error("abort succeeded");
      const matches = outcome.failure.recovered?.value as Match[] | undefined;
      expect(matches?.slice(0, count).map((match) => match.path)).toEqual(
        Array.from({ length: count }, (_, index) => ["items", index]),
      );
      expect(outcome.failure.recovered?.complete).toBe(false);
    } finally {
      operation.return(undefined);
      reading.return(undefined as never);
      reader.close();
    }
  });

  it("yields while materializing selected recovery before the root closes", () => {
    const text = `{"items":[${Array.from({ length: 96 }, (_, id) => `{"id":${id}}`).join(",")},{"tail":"${"x".repeat(1024)}"}]}`;
    const options = resolveOptions({ select: select([["items", ANY]]) });
    const source = wholeInputSource(text);
    if ("kind" in source) throw new Error("text source refused");
    const reader = createBoundedWholeInputReader(source, options, MODE_VALUE, 8);
    const reading = firstSteps(reader);
    let stopped = false;
    const operation = wholeOperation(
      "parse",
      text,
      options,
      {
        get aborted() {
          return stopped;
        },
        reason: "open-stop",
      },
      8,
    );
    try {
      let scanningCheckpoints = 0;
      while (
        (reader.scanner.build.picks?.delivery?.heldOccurrences.filter(
          (held) => typeof held !== "function" && !held.open,
        ).length ?? 0) < 96
      ) {
        if (reading.next().done === true) throw new Error("root closed before stop");
        scanningCheckpoints++;
      }
      const expected = stop(reader, { kind: "aborted", reason: "open-stop" });
      if (expected.ok) throw new Error("abort succeeded");
      expect(expected.failure.recovered?.complete).toBe(false);
      for (let i = 0; i < scanningCheckpoints; i++) {
        expect(operation.next().done).toBe(false);
      }
      stopped = true;
      let recoveryCheckpoints = 0;
      while (true) {
        const step = operation.next();
        if (step.done !== true) {
          recoveryCheckpoints++;
          continue;
        }
        expect(recoveryCheckpoints).toBeGreaterThan(1);
        expect(step.value).toEqual(expected);
        break;
      }
    } finally {
      operation.return(undefined);
      reading.return(undefined as never);
      reader.close();
    }
  });

  it("yields while preserving prepared overlapping selections after cancellation", () => {
    const values = Array.from({ length: 96 }, (_, i) => i);
    const source = wholeInputSource(`{"items":[[${values.join(",")}]]}`);
    if ("kind" in source) throw new Error("text source refused");
    const reader = createBoundedWholeInputReader(
      source,
      resolveOptions({ select: select([["items"], ["items", ANY]]) }),
      MODE_VALUE,
      8,
    );
    const reading = firstSteps(reader);
    try {
      let scanningCheckpoints = 0;
      while (reader.scanner.delivered() === 0) {
        if (reading.next().done === true) throw new Error("copy never yielded");
        scanningCheckpoints++;
      }
      let stopped = false;
      const stopping = wholeOperation(
        "parse",
        source.text,
        resolveOptions({ select: select([["items"], ["items", ANY]]) }),
        {
          get aborted() {
            return stopped;
          },
          reason: "stop",
        },
        8,
      );
      // Land the stop at the same prepared-copy boundary through the executor's actual operation.
      for (let i = 0; i < scanningCheckpoints; i++) {
        expect(stopping.next().done).toBe(false);
      }
      stopped = true;
      let checkpoints = 0;
      while (true) {
        const step = stopping.next();
        if (step.done !== true) {
          checkpoints++;
          continue;
        }
        expect(checkpoints).toBeGreaterThan(1);
        const outcome = step.value as ReturnType<typeof stoppedOutcome>;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("abort succeeded");
        expect(outcome.failure.kind).toBe("aborted");
        if (outcome.failure.kind !== "aborted") throw new Error("unexpected stop cause");
        expect(outcome.failure.reason).toBe("stop");
        expect(outcome.failure.recovered?.value).toMatchObject([
          { path: ["items"], value: [values] },
          { path: ["items", 0], value: values },
        ]);
        break;
      }
    } finally {
      reading.return(undefined as never);
      reader.close();
    }
  });

  for (const [children, width] of [
    [1, 96],
    [16, 7],
  ] as const) {
    it(`shares the copy budget across ${children} overlapping containers and keeps results independent`, () => {
      const values = Array.from({ length: children }, () =>
        Array.from({ length: width }, (_, i) => i),
      );
      const source = wholeInputSource(
        `{"items":[${values.map((value) => `[${value.join(",")}]`).join(",")}]}`,
      );
      if ("kind" in source) throw new Error("text source refused");
      const reader = createBoundedWholeInputReader(
        source,
        resolveOptions({ select: select([["items"], ["items", ANY]]) }),
        MODE_VALUE,
        8,
      );
      const steps = firstSteps(reader);
      let copyCheckpoints = 0;
      try {
        while (true) {
          const step = steps.next();
          if (step.done !== true) {
            if (reader.scanner.delivered() > 0) copyCheckpoints++;
            continue;
          }
          // Every member and completed frame consumes work; record construction adds to that budget.
          expect(copyCheckpoints).toBeGreaterThanOrEqual(
            Math.floor((children * (width + 1)) / 8) - 1,
          );
          expect(step.value.outcome.ok).toBe(true);
          if (!step.value.outcome.ok) throw new Error("selection failed");
          expect(step.value.outcome.value).toMatchObject([
            { path: ["items"], value: values },
            ...values.map((value, index) => ({ path: ["items", index], value })),
          ]);
          const matches = step.value.outcome.value as { value: number[][] | number[] }[];
          const parent = matches[0]?.value as number[][];
          parent[0]?.splice(0, 1, -1);
          expect(parent[0]?.[0]).toBe(-1);
          expect(matches[1]?.value).toEqual(values[0]);
          break;
        }
      } finally {
        steps.return(undefined as never);
        reader.close();
      }
    });
  }

  it("keeps a partially copied selection on abort with safe keys and exact leaf identity", () => {
    const numbers = Array.from({ length: 96 }, (_, i) => i);
    const source = wholeInputSource(
      `{"items":[{"__proto__":4,"constructor":5,"n":9007199254740993,"a":[${numbers.join(",")}]}]}`,
    );
    if ("kind" in source) throw new Error("text source refused");
    const reader = createBoundedWholeInputReader(
      source,
      resolveOptions({ select: select([["items"], ["items", ANY]]) }),
      MODE_VALUE,
      8,
    );
    const steps = firstSteps(reader);
    try {
      while (reader.scanner.delivered() === 0) {
        if (steps.next().done === true) throw new Error("copy never yielded");
      }
      expect(reader.scanner.delivered()).toBe(1);
      const stopped = stop(reader, { kind: "aborted", reason: "stop" });
      if (stopped.ok) throw new Error("abort succeeded");
      expect(stopped.failure.recovered?.complete).toBe(true);
      const matches = stopped.failure.recovered?.value as Match[];
      expect(matches).toHaveLength(2);
      const parentMatch = matches[0];
      const childMatch = matches[1];
      if (parentMatch === undefined || childMatch === undefined)
        throw new Error("recovery lost a match");
      const parent = (parentMatch.value as Record<string, unknown>[])[0] as Record<string, unknown>;
      const child = childMatch.value as Record<string, unknown>;
      expect(Object.getPrototypeOf(child)).toBe(Object.getPrototypeOf(parent));
      expect(Object.hasOwn(child, "__proto__")).toBe(true);
      expect(child.__proto__).toBe(4);
      expect(Object.hasOwn(child, "constructor")).toBe(true);
      expect(child.constructor).toBe(5);
      expect(child.n).toBe(parent.n);
      (parent.a as number[]).splice(0, 1, -1);
      expect(child.a).toEqual(numbers);
    } finally {
      steps.return(undefined as never);
      reader.close();
    }
  });

  it.each(['{"items":[{"v":0}]}', "{items:[{v:0,}],}"])(
    "repairs JSON-only matches without rereading their values in %s",
    (input) => {
      const source = wholeInputSource(input);
      if ("kind" in source) throw new Error("text source refused");
      const reader = createBoundedWholeInputReader(
        source,
        resolveOptions({ allowJavaScript: true, select: select([["items", 0]]) }),
        MODE_EDITS,
        8,
      );
      const result = readFirst(reader);
      if (!result.outcome.ok) throw new Error("JSON input refused");
      const matches = result.outcome.value as Match[];
      let reads = 0;
      Object.defineProperty(matches[0]?.value, "v", {
        enumerable: true,
        get: () => {
          reads++;
          return 0;
        },
      });
      const steps = repairOutcomeSteps(source, result, 8);
      try {
        let step = steps.next();
        while (step.done !== true) step = steps.next();
        expect(step.value).toMatchObject({ ok: true, value: [{ value: '{"v":0}' }] });
        expect(reads).toBe(0);
      } finally {
        steps.return(undefined as never);
        reader.close();
      }
    },
  );

  for (const cut of [false, true]) {
    it(`bounds prepared matches between checkpoints for ${cut ? "cut" : "closed"} roots`, () => {
      // Source quanta alone cannot bound a wide root's final match preparation. Count the real
      // scanner deliveries per reader step so this catches an indivisible flush without timers.
      const body = Array.from({ length: 96 }, (_, index) => String(index)).join(",");
      const reader = readerFor(`{"items":[${body}${cut ? "" : "]}"}`);
      const steps = firstSteps(reader);
      let prior = 0;
      try {
        while (true) {
          const step = steps.next();
          const prepared = reader.scanner.delivered();
          expect(prepared - prior).toBeLessThanOrEqual(8);
          prior = prepared;
          if (step.done !== true) continue;
          expect(step.value.outcome.ok).toBe(true);
          if (!step.value.outcome.ok) throw new Error("selection failed");
          const matches = step.value.outcome.value;
          expect(Array.isArray(matches)).toBe(true);
          expect(matches).toHaveLength(96);
          expect(matches).toMatchObject(
            Array.from({ length: 96 }, (_, index) => ({ value: index, path: ["items", index] })),
          );
          expect(step.value.outcome.complete).toBe(!cut);
          break;
        }
      } finally {
        steps.return(undefined as never);
        reader.close();
      }
    });

    it(`preserves prepared and pending recovery when stopped during ${cut ? "cut" : "closed"} finalization`, () => {
      const body = Array.from({ length: 96 }, (_, index) => String(index)).join(",");
      const reader = readerFor(`{"items":[${body}${cut ? "" : "]}"}`);
      const steps = firstSteps(reader);
      try {
        while (reader.scanner.delivered() === 0) {
          if (steps.next().done === true) throw new Error("finalization never yielded");
        }
        const stopped = stop(reader, { kind: "aborted", reason: "stop" });
        expect(stopped.ok).toBe(false);
        if (stopped.ok) throw new Error("abort succeeded");
        expect(stopped.failure.kind).toBe("aborted");
        expect(stopped.failure.recovered?.value).toHaveLength(96);
        expect(stopped.failure.recovered?.value).toMatchObject(
          Array.from({ length: 96 }, (_, index) => ({ value: index, path: ["items", index] })),
        );
        expect(stopped.failure.recovered?.complete).toBe(!cut);
      } finally {
        steps.return(undefined as never);
        reader.close();
      }
    });
  }
});
