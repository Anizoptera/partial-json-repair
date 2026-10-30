// SPDX-License-Identifier: Apache-2.0

import { assertInputRetention, completedScalarLimitProgram } from "./pending-token-memory-probe";
import { heapCounter } from "./worker-iterator-memory-probe";

// Resource refusals must preserve bounded recovery and detached views after processing stops.
export const resourceRecoveryProgram = (): string => `
const completedScalars = async () => {
  // Browser and edge fixtures share native assertions without importing a Node-only module.
  const assert = {
    equal(actual, expected, message) {
      if (!Object.is(actual, expected)) throw new Error(message || "Completed-scalar limit changed");
    },
    deepEqual(actual, expected) {
      const where = firstDifference(actual, expected);
      if (where !== undefined) throw new Error("Completed-scalar recovery changed at " + where);
    },
  };
  ${completedScalarLimitProgram()}
  return true;
};
const stoppedViews = async () => {
  // A limit ends input ownership; detached recovery must still support reads and owned-copy edits.
  const out = [];
  for (const view of ["shared", "owned"]) for (const selected of [false, true]) {
    const parser = createStreamParser({ view: view === "owned" ? ownedView : sharedView, select: selected ? select([["a"], ["b"]]) : false, maxRetained: 16, maxBuffer: 128, summary: true });
    const check = snapshot => {
      const recovered = !snapshot.ok && snapshot.failure.kind === "limit-reached" && snapshot.failure.recovered;
      if (!recovered || recovered.complete || recovered.cut.kind !== "string" || recovered.cut.path.length !== 1 || recovered.cut.path[0] !== "b") throw new Error("stopped snapshot lost failure or cut");
      const value = recovered.value;
      const prefix = "body" + String.fromCharCode(39) + "," + "x".repeat(selected ? 9 : 6);
      if (selected ? value.length !== 2 || value[0].value !== 1 || value[0].path.length !== 1 || value[0].path[0] !== "a" || value[1].value !== prefix || value[1].path[0] !== "b" : value.a !== 1 || value.b !== prefix) throw new Error("stopped snapshot lost bounded content");
    };
    try {
      const drain = parser.feed('{"a":1,"b":"body' + String.fromCharCode(39) + "," + "x".repeat(64));
      const failure = drain.next().value;
      if (failure?.ok !== false || failure.failure.kind !== "limit-reached" || failure.failure.resource !== "retained") throw new Error("missing retained-content stop");
      const before = parser.snapshot(); check(before);
      const summary = drain.next().value;
      if (summary?.kind !== "summary" || summary.complete || summary.roots !== 1 || !drain.next().done) throw new Error("stopped snapshot lost queued summary");
      parser.close();
      const next = parser.snapshot(); check(next);
      if (view === "shared") { if (next !== before) throw new Error("shared stopped view lost identity"); }
      else {
        const recovered = next.failure.recovered;
        Reflect.set(recovered.cut, "path", []);
        if (selected) recovered.value.length = 0; else recovered.value.a = "caller";
        check(parser.snapshot());
      }
      out.push({ view, selected, summary });
    } finally { parser.close(); }
  }
  return out;
};
`;

// Use the platform's existing externally collected input-retention probe for stopped views too.
export const stoppedViewMemoryProgram = (): string => `
globalThis.__useStoppedViewMemory = () => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  let owners = [];
  const owner = (width, retain, view, paused, summary, index) => {
    const input = '{"a":1,"b":"body' + String.fromCharCode(39) + ',' + "x".repeat(width * 8 + index);
    const parser = createStreamParser({ view: view === "owned" ? ownedView : sharedView, select: select([["a"], ["b"]]), maxBuffer: 128, maxRetained: 16, summary });
    const drain = parser.feed(input);
    let failed = 0, summaries = 0;
    const read = item => {
      if (item.kind === "summary") {
        check(summary && !item.complete && item.roots === 1, "Stopped view summary changed");
        summaries++;
      } else {
        check(item.ok === false && item.failure.kind === "limit-reached" && item.failure.resource === "retained", "Stopped view lost its retained-content refusal");
        failed++;
      }
    };
    for (let step = drain.next(); !step.done; step = drain.next()) {
      read(step.value);
      if (paused && failed) break;
    }
    check(failed === 1, "Stopped view did not fail exactly once");
    const snapshot = parser.snapshot();
    return { parser, drain, snapshot, input: retain ? input : undefined, summary,
      advance() {
        for (let step = drain.next(); !step.done; step = drain.next()) read(step.value);
        check(failed === 1 && summaries === (summary ? 1 : 0), "Stopped view replayed a refusal or lost its summary");
        check(parser.close().ok, "Stopped view cleanup failed");
      },
    };
  };
  globalThis.__start = async (width, retain) => {
    check(owners.length === 0, "Previous stopped-view cohort is still held");
    for (const view of ["shared", "owned"]) for (const paused of [false, true])
      for (const summary of [false, true]) for (let index = 0; index < 8; index++)
        owners.push(owner(width, retain, view, paused, summary, owners.length));
    check(owners.length > 0, "Stopped-view ownership cohort is empty");
    return true;
  };
  globalThis.__advance = () => { for (const held of owners) held.advance(); return true; };
  globalThis.__validate = () => {
    for (const held of owners) {
      const snapshot = held.parser.snapshot();
      check(firstDifference(snapshot, held.snapshot) === undefined, "Stopped view changed after close");
      const recovery = snapshot.ok === false && snapshot.failure.recovered;
      check(recovery && !recovery.complete && recovery.cut.kind === "string" && recovery.cut.path[0] === "b", "Stopped view lost its cut");
      check(recovery.value.length === 2 && recovery.value[0].value === 1 && recovery.value[0].path[0] === "a" && recovery.value[1].value === "body" + String.fromCharCode(39) + "," + "x".repeat(9), "Stopped view lost its bounded selected values");
      if (held.input !== undefined) check(held.input.length > 0, "Retained stopped-view control changed");
    }
    return true;
  };
  globalThis.__clear = () => {
    for (const held of owners) held.parser.close();
    owners = [];
    return true;
  };
  return true;
};
`;

export const stoppedViewMemoryProbe = (module: string): string => `
import { createStreamParser, ownedView, sharedView, select } from ${JSON.stringify(module)};
import { isDeepStrictEqual } from 'node:util';
import { setImmediate as turn } from 'node:timers/promises';
const firstDifference = (left, right) => isDeepStrictEqual(left, right) ? undefined : 'snapshot';
${heapCounter}
${stoppedViewMemoryProgram()}
globalThis.__useStoppedViewMemory();
async function heap() {
  await turn();
  if (globalThis.Bun) { Bun.gc(true); Bun.gc(true); } else { gc(); gc(); }
  const used = usedHeap();
  if (!Number.isFinite(used) || used < 0) throw new Error('Invalid stopped-view heap counter');
  return used;
}
async function sample(width, retain) {
  await heap();
  try {
    await globalThis.__start(width, retain);
    const suspended = await heap();
    await globalThis.__advance();
    const ended = await heap();
    globalThis.__validate();
    return { suspended, ended };
  } finally { globalThis.__clear(); }
}
await sample(100, false);
const small = await sample(100, false);
const control = await sample(100000, true);
const large = await sample(100000, false);
console.log(JSON.stringify({kind:'stopped-views', small, control, large}));
(${assertInputRetention.toString()})(small, control, large, 'stopped view');
`;
