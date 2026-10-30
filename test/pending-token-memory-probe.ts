// SPDX-License-Identifier: Apache-2.0

import { heapCounter } from "./worker-iterator-memory-probe";

type InputHeaps = { suspended: number; ended: number };

export function assertInputRetention(
  small: InputHeaps,
  control: InputHeaps,
  large: InputHeaps,
  owner: string,
): void {
  // A release delta misses input retained in both states; bound each against the small cohort.
  // Keep this assertion self-contained: native probes inline its compiled function source so
  // every host uses the same bounds without importing repository files into the packed caller.
  // Preserve all compared readings on failure; the difference cannot identify a surviving control.
  for (const phase of ["suspended", "ended"] as const) {
    if (control[phase] - small[phase] <= 3_000_000)
      throw new Error(
        `${owner} memory counter missed the retained caller-input control: ${phase}; cohorts: ${JSON.stringify({ small, control, large })}`,
      );
    const retained = large[phase] - small[phase];
    if (retained >= 1_000_000)
      throw new Error(
        `${owner} heap grew by ${retained} bytes with caller input while ${phase}; inspect input ownership after processing stops; cohorts: ${JSON.stringify({ small, control, large })}`,
      );
  }
}

// One reachable cohort and the same collection boundaries serve native, browser and edge hosts.
export const pendingTokenMemoryProgram = (): string => `
globalThis.__usePendingTokenMemory = () => {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const cases = [
    ['word', '{"a":1,"b":'+'x'.repeat(64), 'x'.repeat(64), false],
    ['number', '{"a":1,"b":'+'2'.repeat(64)+'e+', '2'.repeat(64)+'e+', false],
    ['number continued as text', '{"a":1,"b":'+'2'.repeat(64)+'oops', '2'.repeat(64)+'oops', false],
    ['quoted value', '{"a":1,"b":"'+'x'.repeat(64), undefined, false],
    ['quoted key', '{"a":1,"'+'k'.repeat(64), '"'+'k'.repeat(64), false],
    ['sliced word', '{"a":1,"b":'+'x'.repeat(64), 'x'.repeat(64), true],
  ];
  const views = ['shared','owned'];
  let owners = [];
  const owner = (width, retain, view, spec, index) => {
    const [name, source, cut, sliced] = spec;
    const padding = width * 16 + index;
    const input = ' '.repeat(padding) + source;
    // Flatten every control's source before a slice can hide its original backing store.
    check(input.charCodeAt(padding) === 123, 'Pending-token source changed: '+name);
    const parser = createStreamParser({
      select: select(cut === undefined ? [['a'],['b']] : [['a']]),
      view: view === 'owned' ? ownedView : sharedView, maxRetained: 256,
    });
    try {
      check([...parser.feed(sliced ? input.slice(padding) : input)].length === 0,
        'Pending token escaped before root completion: '+name);
      return { parser, input: retain ? input : undefined, name, cut };
    } catch (cause) { parser.close(); throw cause; }
  };
  globalThis.__start = (width, retain) => {
    check(owners.length === 0, 'Previous pending-token cohort is still held');
    // A single retained large input must trip the bound; repeated owners add no distinct state.
    for (const spec of cases) for (const view of views)
      owners.push(owner(width, retain, view, spec, owners.length));
    check(owners.length === cases.length * views.length, 'Pending-token ownership matrix omitted a member');
    return true;
  };
  globalThis.__advance = () => {
    for (const held of owners) check(held.parser.close().ok, 'Pending-token cleanup failed');
    return true;
  };
  globalThis.__validate = () => {
    for (const held of owners) {
      const snapshot = held.parser.snapshot();
      check(snapshot.ok && snapshot.value !== undefined, 'Pending-token snapshot lost: '+held.name);
      if (held.cut === undefined) {
        const matches = snapshot.value.value;
        check(matches.length === 2 && matches[0].value === 1 && matches[1].value === 'x'.repeat(64) &&
          matches[1].path.length === 1 && matches[1].path[0] === 'b', 'Quoted prefix changed');
      } else check(snapshot.value.cut?.text === held.cut, 'Pending-token cut changed: '+held.name);
      if (held.input !== undefined) check(held.input.length > 0, 'Pending-token retained control changed');
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

// Share the same storage refusals across native callers and browser/edge consumers.
export const completedScalarLimitProgram = (): string => `
function completedLimits() {
  // Stop before insertion; a readable bounded prefix must never become a successful value.
  for (const kind of ['word', 'number', 'number-word']) {
    const token = (kind === 'word' ? 'w' : '2').repeat(8192);
    const source = '{"a":1,"b":' + token + (kind === 'number-word' ? 'oops' : '') + '}';
    for (const view of [undefined, 'shared', 'owned']) for (const route of ['plain', 'final', 'occurrences']) {
      const parser = createStreamParser({view: view === undefined ? undefined : view === 'owned' ? ownedView : sharedView,
        select: route === 'plain' ? false : select([['a'],['b']], {occurrences: route === 'occurrences'}),
        maxRetained: 16,
      });
      try {
        const items = [...parser.feed(source)];
        assert.equal(items.length, route === 'occurrences' ? 2 : 1);
        const failed = items.at(-1)?.failure;
        assert.equal(failed?.kind, 'limit-reached', kind+' '+route+' missing storage refusal');
        assert.equal(failed.resource, 'retained');
        const recovered = failed.recovered;
        const prefix = token.slice(0, route === 'plain' ? 12 : route === 'final' ? 15 : 16);
        if (route === 'plain') assert.deepEqual(recovered.value, kind === 'number' ? {a:1} : {a:1,b:prefix});
        else {
          const matches = recovered.value.map(match => ({path:match.path, value:match.value}));
          assert.deepEqual(matches, [
            ...(route === 'occurrences' ? [] : [{path:['a'],value:1}]),
            ...(kind === 'number' ? [] : [{path:['b'],value:prefix}]),
          ]);
        }
        assert.deepEqual(recovered.cut.path, ['b']);
        assert.equal(recovered.cut.kind, kind === 'number' ? 'missing' : 'string');
        if (kind === 'number') assert.equal(recovered.cut.text, prefix);
        assert.equal(items[0].ok, route === 'occurrences');
      } finally {parser.close();}
    }
  }
  const key = createStreamParser({view:ownedView,maxRetained:16});
  try {
    const items = [...key.feed('{"a":1,'+'w'.repeat(8192)+':2}')];
    assert.equal(items.length, 1);
    const failed = items[0];
    assert.equal(failed.ok, false);
    assert.equal(failed.failure.kind, 'limit-reached');
    assert.equal(failed.failure.resource, 'retained');
    assert.deepEqual(failed.failure.recovered.value, {a:1});
    assert.deepEqual(failed.failure.recovered.cut, {path:[],kind:'between',text:'w'.repeat(13)});
  } finally {key.close();}
  // Long numeric spelling is not retained decoded content when its recovered value is small.
  const numeric = createStreamParser({maxRetained:16});
  try {
    // The line break settles the root inside this feed; a root ending the chunk waits for a comma.
    assert.deepEqual([...numeric.feed('{"a":1,"b":1.5'+'0'.repeat(8192)+'}\\n')],
      [{ok:true,value:{a:1,b:1.5},complete:true}]);
  } finally {numeric.close();}
}
completedLimits();
`;

// Installed callers must keep pending tokens and closed views without retaining unrelated input.
export const pendingTokenMemoryProbe = (module: string): string => `
import { strict as assert } from 'node:assert';
import { setImmediate as turn } from 'node:timers';
import { createStreamParser, ownedView, sharedView, select } from ${JSON.stringify(module)};
${heapCounter}
${completedScalarLimitProgram()}
${pendingTokenMemoryProgram()}
globalThis.__usePendingTokenMemory();
async function heap(collections = 2) {
  return new Promise((resolve, reject) => turn(() => {
    try {
      for (let pass = 0; pass < collections; pass++) {
        if (globalThis.Bun) Bun.gc(true); else gc();
      }
      const used = usedHeap();
      assert(Number.isFinite(used) && used >= 0, 'Invalid pending-token heap counter');
      resolve(used);
    } catch (cause) { reject(cause); }
  }));
}
async function sample(width, retain) {
  await heap();
  try {
    globalThis.__start(width, retain);
    const suspended = await heap();
    globalThis.__advance();
    const ended = await heap();
    globalThis.__validate();
    return {suspended, ended};
  } finally { globalThis.__clear(); }
}
await sample(100, false);
const small = await sample(100, false);
const control = await sample(100000, true);
const large = await sample(100000, false);
console.log(JSON.stringify({kind:'pending-tokens', small, control, large}));
(${assertInputRetention.toString()})(small, control, large, 'pending token');
// A completed small number must release its long spelling while its stream and view stay held.
// Keep this in the fresh native process: a shared test VM adds unrelated heap and collection cost.
{
  // Use two collections on Bun so the held-input control clears its floor.
  const numberCollections = globalThis.Bun ? 2 : 1;
  function numberOwner(width, view, finished) {
    const input = '{"a":1,"b":1.5' + '0'.repeat(width) + (finished ? '}\\n' : ',"c":');
    const parser = createStreamParser({view: view === 'owned' ? ownedView : sharedView, maxRetained:16});
    try {
      assert.deepEqual([...parser.feed(input)],
        finished ? [{ok:true,value:{a:1,b:1.5},complete:true}] : []);
      return {parser, input};
    } catch (cause) { parser.close(); throw cause; }
  }
  async function numbers(width, view, finished) {
    await heap(numberCollections);
    // Construction ends before measurement; only these mutable owners retain caller input.
    const owners = await new Promise((resolve, reject) => turn(() => {
      const cohort = [];
      try {
        for (let index = 0; index < 6; index++)
          cohort.push(numberOwner(width + index, view, finished));
        resolve(cohort);
      } catch (cause) {
        for (const owner of cohort) owner.parser.close();
        reject(cause);
      }
    }));
    let held, detached;
    try {
      held = await heap(numberCollections);
      // Input checks can leave native-frame temporaries; finish their callback before collecting.
      await new Promise((resolve, reject) => turn(() => {
        try {
          for (const owner of owners) {
            assert.equal(typeof owner.input, 'string');
            owner.input = undefined;
          }
          resolve();
        } catch (cause) { reject(cause); }
      }));
      detached = await heap(numberCollections);
    } finally {
      for (const owner of owners) { owner.parser.close(); owner.input = undefined; }
    }
    const released = await heap(numberCollections);
    for (const owner of owners) {
      const snapshot = owner.parser.snapshot();
      assert.equal(snapshot.ok, true);
      assert.notEqual(snapshot.value, undefined);
      assert.deepEqual(snapshot.value.value, {a:1,b:1.5});
    }
    return {held, detached, released};
  }
  for (const view of ['shared', 'owned']) for (const finished of [false, true]) {
    const small = await numbers(100, view, finished);
    const large = await numbers(1048576, view, finished);
    console.log(JSON.stringify({kind:'completed-number', view, finished, small, large}));
    assert(large.held - large.released > 3000000, 'Completed-number caller control was missed');
    assert(large.detached - small.detached < 1000000, 'Completed number retained source before close');
    assert(large.released - small.released < 1000000, 'Closed number view retained source');
    assert(large.detached - large.released < 1000000, 'Explicit close released completed numeric source');
  }
}
`;
