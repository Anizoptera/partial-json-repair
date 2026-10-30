// SPDX-License-Identifier: Apache-2.0

import { heapCollection } from "./worker-iterator-memory-probe";

// Keep the real reader reachable across close, as native GC roots can; public handles cannot force that lifetime.
// Use a static JSC import on Bun: its process heap counter can lag collection.
export const closedReaderMemoryProbe = (
  moduleDirectory: string,
  runtime: "node" | "bun" | "deno",
): string => `
import { strict as assert } from 'node:assert';
${runtime === "bun" ? "import { heapSize as used } from 'bun:jsc';" : "const used=()=>process.memoryUsage().heapUsed;"}
import { createWholeInputReader, readFirst, WHOLE_INPUT_SLICE } from ${JSON.stringify(`${moduleDirectory}/whole-reader.js`)};
import { wholeInputSource, wholeInputScanSource, wholeInputSourceSteps } from ${JSON.stringify(`${moduleDirectory}/whole-source.js`)};
import { resolveOptions } from ${JSON.stringify(`${moduleDirectory}/options.js`)};
import { select } from ${JSON.stringify(`${moduleDirectory}/index.js`)};
${heapCollection}
const options=resolveOptions({select:select([["a"]]),builtinParsers:false,maxErrors:Number.MAX_SAFE_INTEGER});
const task=callback=>new Promise(resolve=>turn(()=>resolve(callback())));
const heap=async()=>{
  if(globalThis.Bun){await collectHeap();return used();}
  if(globalThis.Deno){
    await task(()=>gc());return task(()=>{gc();return used();});
  }
  const collected=gc({type:'major',execution:'async',flavor:'last-resort'});
  assert.equal(typeof collected?.then,'function','Reader ownership requires asynchronous Node GC');
  await collected;return task(used);
};
const decoders={
  materialized:wholeInputSource,
  incremental:input=>wholeInputScanSource(input,WHOLE_INPUT_SLICE),
  resumed:input=>{
    const steps=wholeInputSourceSteps(input,WHOLE_INPUT_SLICE);
    let step=steps.next();while(!step.done)step=steps.next();return step.value;
  },
};
// Valid UTF-8 keeps one position anchor, so storage that grows with the input needs malformed
// bytes: each 0xff becomes a one-byte replacement the decoded text cannot predict, one anchor each.
function owner(width,decode){
  const head=new TextEncoder().encode('{"padding":"'),tail=new TextEncoder().encode('","a":7}');
  const input=new Uint8Array(head.length+width*2+tail.length);
  input.set(head,0);
  for(let i=0;i<width;i++){input[head.length+i*2]=0x61;input[head.length+i*2+1]=0xff;}
  input.set(tail,head.length+width*2);
  const source=decode(input);
  assert(!('kind' in source),'Byte fixture was refused');
  const reader=createWholeInputReader(source,options);
  return {reader,result:readFirst(reader).outcome,length:input.length};
}
async function sample(width,decode){
  const held=await task(()=>owner(width,decode));
  try{
    const open=await heap();
    await task(()=>held.reader.close());
    const closed=await heap();
    assert(held.result.ok,'Selected byte recovery failed');
    assert.equal(held.result.value.length,1);
    const match=held.result.value[0];
    assert.equal(match.value,7);
    assert.deepEqual(match.span,{start:{offset:held.length-2,unit:'byte'},end:{offset:held.length-1,unit:'byte'}});
    return {open,closed};
  }finally{
    held.reader.close();held.reader=undefined;held.result=undefined;
  }
}
for(const [decoding,decode] of Object.entries(decoders)){
  await sample(128,decode);
  const small=await sample(128,decode),large=await sample(262144,decode);
  console.log(JSON.stringify({decoding,small,large}));
  assert(large.open-small.open>3000000,'Held byte-position control missed: '+decoding);
  assert(large.closed-small.closed<1000000,'Closed reader retained byte-position storage: '+decoding);
}
console.log('closed-reader byte-position ownership passed');
`;
