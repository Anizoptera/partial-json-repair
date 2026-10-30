// SPDX-License-Identifier: Apache-2.0

import { heapCollection, heapCounter } from "./worker-iterator-memory-probe";

// A fresh process and a held-stream control separate scope ownership from suite GC roots.
export const metricsMemoryProbe = (module: string): string => `
import { strict as assert } from 'node:assert';
import { createMetrics, createStreamParser } from ${JSON.stringify(module)};
${heapCollection}
${heapCounter}
const count=100,prefix='{"a":"';
function owner(width,retain) {
  const measured=createMetrics(),streams=[];
  // Shared source text would stay alive through other owners and conceal abandoned-stream storage.
  for(let i=0;i<count;i++) {
    const stream=createStreamParser(measured);
    for(const item of stream.feed(prefix+'x'.repeat(width)))
      assert.fail('An unfinished string must not deliver a completed root');
    if(retain)streams.push(stream);
  }
  return {measured,streams,width};
}
async function sample(held,kind,baseline) {
  try {
    await collectHeap();
    const used=usedHeap();
    // Record before validation or cleanup, while the measured scope is still reachable.
    console.log(JSON.stringify({kind,used:String(used),baseline:baseline===undefined?undefined:String(baseline)}));
    assert(Number.isFinite(used)&&used>=0,'Invalid metrics heap counter');
    assert.equal(held.measured.read().memory.maxBufferSize,held.width+prefix.length);
    assert.equal(held.streams.length,kind==='control'?count:0);
    if(kind==='control')assert(used-baseline>3000000,'Metrics retained-stream control missed');
    if(kind==='released')assert(used-baseline<2000000,'Metrics scope retained abandoned stream input');
    return used;
  } finally {
    for(const stream of held.streams)assert.equal(stream.close().ok,true);
    held.streams.length=0;
    held.measured=undefined;
  }
}
await sample(owner(100,false),'warm');
const baseline=await sample(owner(100,false),'small');
await sample(owner(50000,true),'control',baseline);
// Collect the released control before constructing the subject: a later collection
// must not hide subject storage by reclaiming an earlier population at the same time.
await collectHeap();
await sample(owner(50000,false),'released',baseline);
console.log('metrics stream ownership: retained and abandoned controls passed');
`;
