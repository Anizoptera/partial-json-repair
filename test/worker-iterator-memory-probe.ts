// SPDX-License-Identifier: Apache-2.0

export const terminalInputBrowserProgram = (module?: string, traceInputs = false): string => {
  // Separate delivery from advancement so the host can collect while failures remain held.
  const imports =
    module === undefined
      ? ""
      : `import {auto,cooperative,initAsyncParser,parseManyAsync,worker} from ${JSON.stringify(module)};\n`;
  return (
    imports +
    `globalThis.__useTerminalInputMemory=() => {
const check=(value,message)=>{if(!value)throw Error(message)};
// Labels name each route in messages; only option objects carry the imported strategy.
const strategies={auto:{execution:auto},cooperative:{execution:cooperative},worker:{execution:worker}};
const same=(a,b)=>{if(Object.is(a,b))return true;if(typeof a!=='object'||a===null||typeof b!=='object'||b===null)return false;const keys=Reflect.ownKeys(a);return keys.length===Reflect.ownKeys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(Reflect.get(a,key),Reflect.get(b,key)))};
let serial=0;
${
  traceInputs
    ? `const references=[];
// Observe only after heap collection; dereferencing earlier would keep the targets alive.
globalThis.__inputReachability=()=>JSON.stringify(references.map(group=>({input:group.filter(pair=>pair[0].deref()!==undefined).length,caller:group.filter(pair=>pair[1].deref()!==undefined).length})));`
    : ""
}
function owner(width,retain,execution,exit,route){
 const bytes=exit==='encoding'?new Uint8Array([255,254,123,0]):new TextEncoder().encode(exit==='missing'?'plain prose':'{"a":1} {"b":{"c":2}}');
 // A flat string marker keeps the caller-array control observable when a counter omits its backing bytes.
 const caller=new Array(width).fill(17);
 caller[width-1]='x'.repeat(width)+':'+serial++;
 check(caller[width-1].charCodeAt(width)===58,'Caller marker changed');
 const input=Object.assign(bytes,{caller});
${traceInputs ? " references[references.length-1].push([new WeakRef(input),new WeakRef(caller)]);" : ""}
 const local=new AbortController(),task=new AbortController();
 const options={...strategies[execution],...(exit==='limit'?{maxDepth:1}:{})};
 const parser=route==='free'?undefined:initAsyncParser({...options,...(route==='task'||route==='joined'?{signal:task.signal}:{})});
 const iterator=parser===undefined?parseManyAsync(input,{...options,signal:local.signal}):parseManyAsync(input,parser,route==='local'||route==='joined'?{signal:local.signal}:undefined);
 parser?.close();return {iterator,controller:route==='task'?task:local,exit,input:retain?input:undefined};
}
globalThis.__start=async(width,retain)=>{
${traceInputs ? " references.push([]);" : ""}
 const executions=['auto','cooperative'];
 const probe=parseManyAsync('{"ready":1}',{execution: worker});
 const unavailable=globalThis.__workerUnavailable??'unsupported',workerReady=globalThis.__workerUnavailable===null;
 try{const first=await probe.next();if(workerReady){check(first.done===false&&first.value?.ok===true,'Worker availability probe failed');executions.push('worker')}else check(first.done===false&&first.value?.failure.kind==='execution-unavailable'&&first.value.failure.reason===unavailable,'Wrong worker unavailability')}finally{await probe.return()}
 const owners=[];
 for(const execution of executions)for(const exit of ['aborted','limit','encoding','missing'])for(const route of ['free','task','local','joined'])for(let i=0;i<8;i++)owners.push(owner(width,retain,execution,exit,route));
 globalThis.__owners=owners;
 globalThis.__failures=await Promise.all(owners.map(async held=>{
  if(held.exit==='aborted'||held.exit==='limit'){const first=await held.iterator.next();check(first.done===false&&first.value.ok===true&&same(first.value.value,{a:1}),'First root changed')}
  if(held.exit==='aborted')held.controller.abort('stop');
  const failed=await held.iterator.next();
  check(failed.done===false&&failed.value.ok===false,'Missing failed outcome');
  check(failed.value.failure.kind===({aborted:'aborted',limit:'limit-reached',encoding:'unsupported-encoding',missing:'no-json-found'})[held.exit],'Wrong failure');
  if(held.exit==='limit')check(same(failed.value.failure.recovered,{value:{b:{}},complete:true}),'Lost limit recovery');
  if(held.exit==='aborted')check(failed.value.failure.reason==='stop','Lost abort reason');
  return failed.value;
 }));
 globalThis.__snapshots=globalThis.__failures.map(value=>structuredClone(value));
 globalThis.__caseCount=executions.length*16;
 check(globalThis.__caseCount===(workerReady?48:32)&&owners.length===globalThis.__caseCount*8,'Missing ownership matrix member');return true;
};
globalThis.__advance=async()=>{for(const held of globalThis.__owners)check(same(await held.iterator.next(),{done:true,value:undefined}),'Replayed terminal outcome');return true};
globalThis.__validate=()=>{check(same(globalThis.__failures,globalThis.__snapshots),'Held failure changed');for(const held of globalThis.__owners){check(held.input?.caller[0]===(held.input?17:undefined),'Retained control changed');if(held.input){const caller=held.input.caller;check(caller[caller.length-1].charCodeAt(caller.length)===58,'Retained caller marker changed')}}return true};
// A native frame may still hold a previous owner; release its caller control through that owner.
globalThis.__clear=async()=>{
 const owners=globalThis.__owners??[];
 for(const held of owners)held.input=undefined;
 globalThis.__owners=undefined;globalThis.__failures=undefined;globalThis.__snapshots=undefined;
 // An interrupted cohort may still own active worker calls; attempt every release before returning.
 const results=await Promise.allSettled(owners.map(async held=>held.iterator.return()));
 const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
 if(failures.length)throw new AggregateError(failures,'Terminal input iterator cleanup failed');
 return true;
};
globalThis.__ready=true;return true;
};`
  );
};

// Bun's native counter and V8's exposed collector judge the same retained-payload control.
export const heapCounter =
  "const usedHeap=globalThis.Bun ? (await import('bun:jsc')).heapSize : () => process.memoryUsage().heapUsed;";

export const heapCollection = `
import { setImmediate as turn } from 'node:timers';
// The resumed consumer frame can still root temporary values; collect in the host callback.
const collectHeap=()=>new Promise(resolve=>turn(()=>{if(globalThis.Bun)Bun.gc(true);else gc();resolve();}));
`;

// Keep unfinished streams reachable in a fresh host; suite-wide heap changes cannot name their owner.
export const betweenRootsMemoryProbe = (module: string): string => `
import { strict as assert } from 'node:assert';
${heapCollection}
import { createStreamParser, select } from ${JSON.stringify(module)};
${heapCounter}
function owners(width,retain,selected){
  const input='{"items":['+'0,'.repeat(width)+'0]}\\n';
  return Array.from({length:4},()=>{
    const stream=createStreamParser(selected?{select:select([["items"]])}:undefined);
    let value;
    for(const item of stream.feed(input))if(item.ok&&retain)value=item.value;
    for(const item of stream.feed('{"next":'));
    return {stream,value};
  });
}
async function sample(live,retain){
  try{
    await collectHeap();
    const used=usedHeap();assert(Number.isFinite(used)&&used>=0,'Invalid heap counter');
    for(const held of live)assert.equal(held.value!==undefined,retain);
    return used;
  }finally{
    for(const held of live){held.value=undefined;assert.equal(held.stream.close().ok,true);}
  }
}
for(const selected of [false,true]){
  await sample(owners(1000,false,selected),false);
  const base=await sample(owners(1000,false,selected),false);
  const retained=await sample(owners(100000,true,selected),true);
  assert(retained-base>2000000,'Between-root retained control missed: '+selected);
  const released=await sample(owners(100000,false,selected),false);
  assert(released-base<1000000,'Delivered roots retained while next root is unfinished: '+selected+' '+JSON.stringify({base,retained,released}));
}
console.log('between-root ownership: whole and selected controls passed');
`;

// Fresh installed processes distinguish iterator-owned signals from unrelated suite GC roots.
export const wholeSignalMemoryProbe = (module: string): string => `
import { strict as assert } from 'node:assert';
${heapCollection}
import { auto, initAsyncParser, parseManyAsync, worker } from ${JSON.stringify(module)};
${heapCounter}
function owner(width,route,retain){
  const task=new AbortController(),local=new AbortController();
  const reason={payload:new Array(width).fill(17)};
  const parser=initAsyncParser(route==='task'||route==='joined'?{execution:auto,signal:task.signal}:{execution:auto});
  const input='{"a":1} {"b":2}';
  const iterator=route==='free'
    ?parseManyAsync(input,{execution:auto,signal:local.signal})
    :parseManyAsync(input,parser,route==='local'||route==='joined'?{signal:local.signal}:undefined);
  assert.equal(parser.close().ok,true);
  return {
    iterator,reason:new WeakRef(reason),
    control:retain?[task.signal,local.signal]:undefined,
    abort(){task.abort(reason);local.abort(reason)}
  };
}
async function finish(held,exit){
  if(exit==='aborted')held.abort();
  if(exit==='exhausted'||exit==='aborted'){
    let count=0;
    for await(const item of held.iterator){assert.equal(item.ok,exit!=='aborted');count++;}
    assert.equal(count,exit==='aborted'?1:2);
  }else if(exit==='unstarted-throw'){
    await assert.rejects(held.iterator.throw('caller failure'),cause=>cause==='caller failure');
    assert.deepEqual(await held.iterator.next(),{done:true,value:undefined});
  }else{
    if(exit==='early-return')assert.equal((await held.iterator.next()).value?.ok,true);
    assert.deepEqual(await held.iterator.return(),{done:true,value:undefined});
  }
  held.abort();
  // The caller's abort closure must not outlive the operation it exercised.
  held.abort=()=>{};
  return held;
}
async function sample(width,route,exit,retain){
  const owners=await Promise.all(Array.from({length:10},()=>finish(owner(width/10,route,retain),exit)));
  for(let i=0;i<2;i++)await collectHeap();
  const heap=usedHeap();
  assert(Number.isFinite(heap)&&heap>=0,'Invalid heap counter');
  // Observe weak references after the heap sample; observation itself can root caller data.
  let liveReasons=0;
  for(const held of owners){
    if(held.reason.deref()!==undefined)liveReasons++;
    assert.equal(held.control?.[0]?.aborted,retain?true:undefined);
    held.control=undefined;
  }
  if(retain)assert.equal(liveReasons,owners.length);
  return {heap,liveReasons};
}
for(const route of ['free','task','local','joined']){
  for(const exit of ['exhausted','early-return','unstarted-return','unstarted-throw','aborted']){
    await sample(100,route,exit,false);
    const retained=await sample(500000,route,exit,true);
    const base=await sample(100,route,exit,false);
    assert(retained.heap-base.heap>3000000,'Whole-input retained control missed: '+route+' '+exit);
    const released=await sample(500000,route,exit,false);
    assert(released.heap-base.heap<1000000,'Whole-input caller signals retained: '+route+' '+exit+' '+JSON.stringify({base,retained,released}));
  }
}
console.log('whole-input caller signal ownership: all routes and exits passed');
`;

// A closed parser stays reachable; only its caller's task reason must be released.
export const closedParserMemoryProbe = (module: string): string => `
import { strict as assert } from 'node:assert';
${heapCollection}
import { auto, initAsyncParser, parseAsync, worker } from ${JSON.stringify(module)};
${heapCounter}
function owner(width,retain){
  const task=new AbortController();
  const reason={payload:new Array(width).fill(17)};
  task.abort(reason);
  const parser=initAsyncParser({execution:auto,signal:task.signal});
  assert.equal(parser.close().ok,true);
  return {parser,reason:retain ? reason : undefined,weak:new WeakRef(reason)};
}
async function sample(held){
  for(let i=0;i<2;i++)await collectHeap();
  const heap=usedHeap();
  assert(Number.isFinite(heap)&&heap>=0,'Invalid heap counter');
  // Read after sampling so the weak-reference observation cannot retain the reason during GC.
  const reachable=held.weak.deref()!==undefined;
  assert.equal(held.reason?.payload[0],held.reason ? 17 : undefined);
  assert.equal(held.parser.close().ok,true);
  const closed=await parseAsync('{}',held.parser);
  assert.equal(closed.ok,false);assert.equal(closed.failure.kind,'parser-closed');
  held.reason=undefined;
  return {heap,reachable};
}
await sample(owner(100,false));
const base=await sample(owner(100,false));
const retained=await sample(owner(500000,true));
assert.equal(retained.reachable,true);
assert(retained.heap-base.heap>3000000,'Closed parser retained control missed');
const released=await sample(owner(500000,false));
assert(released.heap-base.heap<1000000,'Closed parser task reason retained '+JSON.stringify({base,retained,released}));
console.log('closed parser task ownership: retained control and released reason passed');
`;

// Synchronous handles must release caller input even when closed before their first pull.
export const syncWholeInputMemoryProbe = (module: string): string => `
import { strict as assert } from 'node:assert';
import { initParser, parseMany } from ${JSON.stringify(module)};
${heapCollection}
${heapCounter}
function owner(width,route,exit){
  const text=exit==='missing'?'plain prose':'{"a":1} {"b":{"c":2}}';
  let bytes=exit==='encoding'?new Uint8Array([255,254,123,0]):new TextEncoder().encode(text);
  let input=Object.assign(bytes,{caller:new Array(width).fill(17)});
  const options=exit==='limit'?{maxDepth:1}:undefined;
  const parser=route==='configured'?initParser(options):undefined;
  const iterator=parser?parseMany(input,parser):parseMany(input,options);
  parser?.close();
  let failure;
  if(exit==='early-return'||exit==='limit')assert.equal(iterator.next().value?.ok,true);
  if(exit==='unstarted-throw'){
    const cause={caller:true};
    assert.throws(()=>iterator.throw(cause),error=>error===cause);
  }else if(exit==='early-return'||exit==='unstarted-return'){
    assert.deepEqual(iterator.return(17),{value:17,done:true});
  }else if(exit==='exhausted'){
    assert.equal([...iterator].length,2);
  }else{
    failure=iterator.next().value;
    assert.equal(failure?.ok,false);
    assert.equal(failure.failure.kind,({encoding:'unsupported-encoding',missing:'no-json-found',limit:'limit-reached'})[exit]);
  }
  const held={iterator,failure,input};
  // Only the returned owner may retain caller storage; completed native frames can keep locals.
  bytes=input=undefined;
  return held;
}
function validate(owners){
    for(const held of owners){
      assert.deepEqual(held.iterator.next(),{value:undefined,done:true});
      assert.deepEqual(held.iterator.return(29),{value:29,done:true});
      assert.throws(()=>held.iterator.throw(undefined),error=>error===undefined);
      assert.equal(held.iterator[Symbol.iterator](),held.iterator);
      if(typeof [].values().map==='function')assert.deepEqual([...held.iterator.map(value=>value)],[]);
      if(held.failure?.failure.kind==='limit-reached')
        assert.deepEqual(held.failure.failure.recovered,{value:{b:{}},complete:true});
    }
}
function owners(width,route,exit){
  return Array.from({length:4},()=>owner(width/4,route,exit));
}
const task=callback=>new Promise(resolve=>turn(()=>resolve(callback())));
const heap=async()=>{
  await collectHeap(); const used=usedHeap();
  assert(Number.isFinite(used)&&used>=0,'Invalid heap counter'); return used;
};
for(const route of ['free','configured'])for(const exit of ['unstarted-return','unstarted-throw','early-return','exhausted','encoding','missing','limit']){
  const baseline=await heap();
  const held=await task(()=>owners(500000,route,exit));
  try{
    const retained=await heap();
    // Read and release caller fields in a completed host task, outside the sampling frame.
    await task(()=>{for(const value of held){assert.equal(value.input.caller[0],17);value.input=undefined;}});
    const released=await heap();
    console.log(JSON.stringify({route,exit,baseline,retained,released}));
    assert(retained-baseline>3000000,'Sync caller control missed: '+route+' '+exit);
    assert(released-baseline<1000000,'Sync iterator retained input: '+route+' '+exit);
    validate(held);
  }finally{
    await task(()=>{for(const value of held){value.input=undefined;value.iterator.return();value.iterator=undefined;}});
  }
}
console.log('synchronous whole-input ownership: free/configured routes and all exits passed');
`;

// Installed iterators must release caller-only storage before the consumer resumes a failure.
export const terminalInputMemoryProbe = (module: string): string => `
import { strict as assert } from 'node:assert';
${heapCollection}
import { auto, cooperative, initAsyncParser, parseManyAsync, worker } from ${JSON.stringify(module)};
const strategies={auto:{execution:auto},cooperative:{execution:cooperative},worker:{execution:worker}};
${heapCounter}
const heap=async()=>{
  for(let i=0;i<2;i++)await collectHeap();
  const used=usedHeap();assert(Number.isFinite(used)&&used>=0,'Invalid heap counter');return used;
};
function owner(width,retain,execution,exit,route){
  const bytes=exit==='encoding' ? new Uint8Array([255,254,123,0]) :
    new TextEncoder().encode(exit==='missing' ? 'plain prose' : '{"a":1} {"b":{"c":2}}');
  // This storage is not recovered data; a held failure must not keep it alive.
  const input=Object.assign(bytes,{caller:new Array(width).fill(17)});
  const local=new AbortController(),task=new AbortController();
  const settings={...strategies[execution],...(exit==='limit' ? {maxDepth:1} : {})};
  const parser=route==='free' ? undefined : initAsyncParser({
    ...settings,...(route==='task'||route==='joined' ? {signal:task.signal} : {})
  });
  const iterator=parser===undefined ? parseManyAsync(input,{...settings,signal:local.signal}) :
    parseManyAsync(input,parser,route==='local'||route==='joined' ? {signal:local.signal} : undefined);
  parser?.close();
  return {iterator,controller:route==='task' ? task : local,exit,input:retain ? input : undefined,weak:new WeakRef(input.caller)};
}
async function sample(owners){
  try{
    const failures=await Promise.all(owners.map(async held=>{
      if(held.exit==='aborted'||held.exit==='limit'){
        const first=await held.iterator.next();assert.equal(first.done,false);
        assert.equal(first.value.ok,true);assert.deepEqual(first.value.value,{a:1});
      }
      if(held.exit==='aborted')held.controller.abort('stop');
      const failed=await held.iterator.next();assert.equal(failed.done,false);assert.equal(failed.value.ok,false);
      assert.equal(failed.value.failure.kind,{
        aborted:'aborted',limit:'limit-reached',encoding:'unsupported-encoding',missing:'no-json-found'
      }[held.exit]);
      if(held.exit==='limit')assert.deepEqual(failed.value.failure.recovered,{value:{b:{}},complete:true});
      if(held.exit==='aborted')assert.equal(failed.value.failure.reason,'stop');
      return failed.value;
    }));
    const delivered=failures.map(value=>structuredClone(value));
    const suspended=await heap();
    for(const held of owners)assert.deepEqual(await held.iterator.next(),{done:true,value:undefined});
    const terminal=await heap();
    const reachableAfter=owners.filter(held=>held.weak.deref()!==undefined).length;
    // Hold the same failures and caller controls across both samples, then read them.
    assert.deepEqual(failures,delivered);
    for(const held of owners)assert.equal(held.input?.caller[0],held.input ? 17 : undefined);
    // Dereferencing between samples roots caller arrays and changes the ownership being measured.
    return {suspended,released:suspended-terminal,reachableAfter};
  }finally{
    // Controls are caller-owned; release them after validation to avoid measuring their storage again.
    for(const held of owners)held.input=undefined;
    await Promise.all(owners.map(held=>held.iterator.return()));
  }
}
// Every route holds the same caller-array shape; prove the heap counter once, before route samples.
const counterOwners=(width,retain)=>Array.from({length:8},()=>owner(width,retain,'auto','encoding','free'));
await sample(counterOwners(100,false));
const counterBase=await sample(counterOwners(100,false));
const counterControl=await sample(counterOwners(100000,true));
assert(counterControl.suspended-counterBase.suspended>3000000,'Retained caller-array control missed');
assert((counterControl.suspended-counterControl.released)-(counterBase.suspended-counterBase.released)>3000000,'Terminal caller-array control missed');
let checked=0;
for(const execution of ['auto','cooperative','worker'])for(const exit of ['aborted','limit','encoding','missing'])
for(const route of ['free','task','local','joined']){
  const owners=(width,retain)=>Array.from({length:8},()=>owner(width,retain,execution,exit,route));
  await sample(owners(100,false));
  const small=await sample(owners(100,false));
  const large=await sample(owners(100000,false));
  // Release deltas alone miss input retained across both boundaries; compare live storage too.
  const atFailure=large.suspended-small.suspended;
  const atCompletion=(large.suspended-large.released)-(small.suspended-small.released);
  assert(atFailure<1000000 && atCompletion<1000000,'Caller input remains after failed delivery or completion '+execution+'/'+exit+'/'+route+' '+JSON.stringify({atFailure,atCompletion,small,large}));
  assert(large.released-small.released<1000000,'Terminal input retained '+execution+'/'+exit+'/'+route+' '+JSON.stringify({small,large}));
  checked++;
}
assert.equal(checked,48);console.log('terminal input ownership: '+checked+' installed routes passed');
`;

// Keep the same failed recovery reachable on both sides; only terminal advancement may differ.
export const interruptedWorkerMemoryProbe = (module: string): string => `
import { MessagePort } from 'node:worker_threads';
import { setImmediate as turn } from 'node:timers/promises';
import { parseManyAsync, worker } from ${JSON.stringify(module)};
const key='long-key-'+'x'.repeat(64);
${heapCounter}
const collect=()=>{if(globalThis.Bun)Bun.gc(true);else gc();};
const heap=async()=>{
  await turn();collect();await turn();collect();
  const used=usedHeap();
  if(!Number.isFinite(used)||used<0)throw Error('Heap counter returned an invalid value');
  return used;
};
const method=typeof Deno === 'undefined' ? 'on' : 'addEventListener';
const originalOn=MessagePort.prototype[method],originalPost=MessagePort.prototype.postMessage;
let finalPort,disconnected=0;
let refusePull=false;
let abortingController;
let observeAbortClose=false,abortPort;
let observeLimitClose=false,limitPort;
MessagePort.prototype[method]=function(name,listener,...rest){
  if(name!=='message')return originalOn.call(this,name,listener,...rest);
  return originalOn.call(this,name,(event,...args)=>{
    const message=method === 'on' ? event : event.data;
    if(observeLimitClose&&message.kind==='done'&&message.result?.value?.failure?.kind==='limit-reached')limitPort=this;
    if(message.kind==='item' && abortingController!==undefined){
      if(observeAbortClose)abortPort=this;
      const controller=abortingController;abortingController=undefined;controller.abort('stopped');
    }
    if(message.kind==='piece'&&message.piece.kind==='members'){
      let leaf=message.piece.envelope.value;
      while(typeof leaf==='object'&&leaf!==null&&Object.hasOwn(leaf,key))leaf=leaf[key];
      if(leaf===1)finalPort=this;
    }
    return listener(event,...args);
  },...rest);
};
MessagePort.prototype.postMessage=function(message,...rest){
  if(message==='pull'&&refusePull){refusePull=false;throw Error('Control send refused');}
  if(this===finalPort&&message==='pull'){finalPort=undefined;disconnected++;this.close();return;}
  return originalPost.call(this,message,...rest);
};
async function owner(depth){
  const input=('{"'+key+'":').repeat(depth)+'1'+'}'.repeat(depth);
  const iterator=parseManyAsync(input,{execution: worker,builtinParsers:false,maxDepth:depth+10});
  try{
    const previous=disconnected,first=await iterator.next();
    if(disconnected!==previous+1||first.done||first.value.ok||first.value.failure.kind!=='execution-unavailable'||!first.value.failure.recovered)
      throw Error('Fault phase missed: '+JSON.stringify({depth,disconnected,previous,done:first.done,ok:first.value?.ok,kind:first.value?.failure?.kind}));
    const result=first.value;
    checkRecovery(result,depth);
    return {iterator,result};
  }catch(cause){await iterator.return();throw cause;}
}
function checkRecovery(result,depth){
  const recovery=result.failure.recovered;
  if(!recovery.complete)throw Error('Held recovery completion changed');
  let leaf=recovery.value;
  for(let i=0;i<depth;i++){if(!Object.hasOwn(leaf,key))throw Error('Held recovery path changed');leaf=leaf[key];}
  if(leaf!==1)throw Error('Held recovery leaf changed');
}
async function sample(depth){
  const owners=[];
  try{
    for(let i=0;i<8;i++)owners.push(await owner(depth));
    const suspended=await heap();
    for(const held of owners)if(!(await held.iterator.next()).done)throw Error('Failure replayed');
    const terminal=await heap();
    for(const held of owners)checkRecovery(held.result,depth);
    return {depth,owners:owners.length,suspended,terminal,released:suspended-terminal};
  }finally{for(const held of owners)await held.iterator.return();}
}
async function stoppedOwner(width, phase){
  const input=new TextEncoder().encode('{"a":1} {"b":2}');
  // This caller data is not JSON and must not survive solely through an already stopped operation.
  input.callerData=new Array(width).fill(17);
  const controller=phase==='active-abort'?new AbortController():undefined;
  const signal=phase==='aborted'?AbortSignal.abort('stopped'):controller?.signal;
  const iterator=parseManyAsync(input,{execution: worker,...(signal===undefined?{}:{signal})});
  // Hide both worker hosts; missing shared memory now selects message cancellation.
  const saved=phase==='unsupported'?['process','Worker'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]):[];
  let first;
  try{
    for(const [name] of saved)Object.defineProperty(globalThis,name,{configurable:true,value:undefined});
    abortingController=controller;
    first=await iterator.next();
  }finally{
    abortingController=undefined;
    for(const [name,descriptor] of saved){
      if(descriptor===undefined)Reflect.deleteProperty(globalThis,name);
      else Object.defineProperty(globalThis,name,descriptor);
    }
  }
  if(first.done || first.value.ok || first.value.failure.kind!==(phase==='unsupported'?'execution-unavailable':'aborted') || first.value.failure.reason!==(phase==='unsupported'?'unsupported':'stopped')){
    await iterator.return();throw Error('Initial stop fixture reached the wrong outcome: '+phase);
  }
  if(phase==='active-abort' && (!first.value.failure.recovered?.complete || first.value.failure.recovered.value.a!==1))throw Error('Active abort lost its received prefix');
  return {iterator,result:first.value};
}
async function stoppedSample(width,phase){
  const owners=[];
  try{
    for(let i=0;i<8;i++)owners.push(await stoppedOwner(width,phase));
    const suspended=await heap();
    for(const held of owners)if(!(await held.iterator.next()).done)throw Error('Initial failure replayed');
    const terminal=await heap();
    if(owners.some(x=>x.result.ok))throw Error('Held initial failure absent');
    return suspended-terminal;
  }finally{for(const held of owners)await held.iterator.return();}
}
try{
  // Request posting succeeded, but the first demand can still fail before scanning starts.
  refusePull=true;
  const refused=parseManyAsync('{"a":1}',{execution: worker});
  try{
    const first=await refused.next();
    if(refusePull||first.done||first.value.ok||first.value.failure.kind!=='execution-unavailable'||first.value.failure.reason!=='failed'||first.value.failure.recovered!==undefined)
      throw Error('Refused first demand must settle as a typed failure without invented recovery');
    if(!(await refused.next()).done)throw Error('Refused first demand replayed');
  }finally{refusePull=false;await refused.return();}
  const base=await heap();let control=Array.from({length:100000},()=>[{},'key']);
  const retained=await heap();if(control.length!==100000||retained-base<2000000)throw Error('Slot-shaped control undetected');control=undefined;
  const small=await sample(600),large=await sample(6000);
  if(disconnected!==16 || large.released-small.released >= 1000000) throw Error('Failed worker delivery retains its private operation until another pull: '+JSON.stringify({small,large,disconnected}));
  for(const phase of ['unsupported','aborted','active-abort']){
    const smallStopped=await stoppedSample(100,phase),largeStopped=await stoppedSample(62500,phase);
    if(largeStopped-smallStopped>=1000000)throw Error('Terminal failure retains caller input: '+phase+'; finish cleanup and release the public iterator owner before delivery');
  }
  // Fail after real channel closure so the original cleanup cause must ride with the abort.
  const close=MessagePort.prototype.close,cleanupCause=new Error('Abort close failed');
  let held,closeFault=false;
  observeAbortClose=true;
  MessagePort.prototype.close=function(){
    close.call(this);
    if(this===abortPort){abortPort=undefined;closeFault=true;throw cleanupCause;}
  };
  try{
    held=await stoppedOwner(100,'active-abort');
    if(!closeFault || held.result.failure.cleanupFailure?.kind!=='cleanup-failed' || held.result.failure.cleanupFailure.cause!==cleanupCause)throw Error('Active abort lost its original cleanup cause');
    if(!(await held.iterator.next()).done)throw Error('Aborted cleanup failure replayed');
  }finally{observeAbortClose=false;abortPort=undefined;MessagePort.prototype.close=close;await held?.iterator.return();}
  // A producer stop has no local abort relay; cleanup must still keep that failure primary.
  let limited;closeFault=false;observeLimitClose=true;
  MessagePort.prototype.close=function(){
    close.call(this);
    if(this===limitPort){limitPort=undefined;closeFault=true;throw cleanupCause;}
  };
  try{
    limited=parseManyAsync('{"a":1} {"b":{"c":2}}',{execution: worker,maxDepth:1});
    const first=await limited.next();
    if(first.done||!first.value.ok||first.value.value.a!==1)throw Error('Producer limit lost its first root');
    const stopped=await limited.next(),failure=stopped.value?.failure;
    if(stopped.done||stopped.value.ok||!closeFault||failure?.kind!=='limit-reached'||failure.cleanupFailure?.cause!==cleanupCause)throw Error('Producer terminal failure lost its cleanup cause');
    const recovery=failure.recovered;
    if(!recovery?.complete||Reflect.ownKeys(recovery.value).join()!=='b'||Reflect.ownKeys(recovery.value.b).length!==0)throw Error('Producer limit lost useful recovery');
    if(!(await limited.next()).done)throw Error('Producer terminal failure replayed');
  }finally{observeLimitClose=false;limitPort=undefined;MessagePort.prototype.close=close;await limited?.return();}
  console.log('worker interrupted delivery released before terminal pull');
}finally{MessagePort.prototype[method]=originalOn;MessagePort.prototype.postMessage=originalPost;}

`;

// Keep terminal iterators reachable while distinguishing their caller data from unrelated heap growth.
export const workerIteratorMemoryProbe = (module: string): string => `
  import { parseManyAsync, worker } from ${JSON.stringify(module)};
  // Bun's previous minor keeps the Node-compatible counter fixed despite live array storage.
  const usedHeap = globalThis.Bun
    ? (await import("bun:jsc")).heapSize
    : () => process.memoryUsage().heapUsed;
  const collect = () => {
    if (globalThis.Bun) Bun.gc(true);
    else if (globalThis.gc) gc();
    else throw Error("Worker retention requires forced GC");
  };
  const heap = async () => {
    const used = await new Promise(resolve => setImmediate(() => {
      collect();
      setImmediate(() => { collect(); resolve(usedHeap()); });
    }));
    // NaN defeats both ordinary comparisons, including the deliberately retained control.
    if (!Number.isFinite(used) || used < 0) throw Error("Invalid worker iterator heap counter");
    return used;
  };
  function owner(width, retain) {
    const controller = new AbortController();
    const reason = { payload: new Array(width).fill(17) };
    return {
      iterator: parseManyAsync('{"a":1} {"b":2}', {
        execution: worker, signal: controller.signal,
      }),
      control: retain ? controller.signal : undefined,
      abort: () => controller.abort(reason),
    };
  }
  async function finish(value, exit) {
    try {
      if (exit === "aborted") value.abort();
      if (exit === "exhausted" || exit === "aborted") {
        let count = 0;
        for await (const item of value.iterator) {
          if (exit === "aborted") {
            if (item.ok || item.failure.kind !== "aborted") throw Error("Worker cancellation missing");
          } else if (!item.ok) throw Error("Worker did not execute: " + item.failure.kind);
          count++;
        }
        if (count !== (exit === "aborted" ? 1 : 2)) throw Error("Worker root count differs");
      } else if (exit === "unstarted-throw") {
        const cause = {};
        try { await value.iterator.throw(cause); throw Error("Consumer throw missing"); }
        catch (thrown) { if (thrown !== cause) throw thrown; }
      } else {
        if (exit === "early-return" && !(await value.iterator.next()).value?.ok)
          throw Error("Worker did not deliver before return");
        const terminal = await value.iterator.return();
        if (!terminal.done) throw Error("Worker return did not close iteration");
      }
      value.abort();
      value.abort = undefined;
      if (!(await value.iterator.next()).done) throw Error("Worker iterator resumed after closure");
      return value;
    } catch (cause) {
      await value.iterator.return();
      throw cause;
    }
  }
  async function held(width, exit, retain) {
    const values = await Promise.all(Array.from({ length: 10 }, () => finish(owner(width / 10, retain), exit)));
    try {
      const used = await heap();
      for (const value of values) {
        if (value.control?.aborted !== (retain ? true : undefined)) throw Error("Retained signal control lost");
      }
      return used;
    } finally {
      for (const value of values) { value.control = undefined; await value.iterator.return(); }
    }
  }
  for (const exit of ["exhausted", "early-return", "unstarted-return", "unstarted-throw", "aborted"]) {
    await held(100, exit, false);
    const retained = await held(500000, exit, true);
    const baseline = await held(100, exit, false);
    const released = await held(500000, exit, false);
    if (retained - baseline <= 3000000) throw Error("Heap instrument missed retained worker caller data: " + exit);
    if (released - baseline >= 1000000) throw Error("Worker iterator retains caller data: " + exit);
    console.log("worker caller data released: " + exit);
  }
`;

// A paused iterator must release reported diagnostics while keeping later roots available.
export const deliveredMetadataMemoryProbe = (
  module: string,
  asyncModule: string,
  executions: readonly ("sync" | "cooperative" | "worker")[],
): string => `
import { parseMany, STRICT, diagnostics, select } from ${JSON.stringify(module)};
import { cooperative, parseManyAsync, worker } from ${JSON.stringify(asyncModule)};
${heapCounter}
const heap = () => new Promise(resolve => setImmediate(() => {
  if (globalThis.Bun) Bun.gc(true); else gc();
  setImmediate(() => {
    if (globalThis.Bun) Bun.gc(true); else gc();
    resolve(usedHeap());
  });
}));
for (const execution of ${JSON.stringify(executions)}) for (const selection of ["none", "final", "occurrences"]) {
async function owner(count, retain) {
  const source = "[" + Array.from({length: count}, () => "{k:1}").join(",") + '] {"safe":1}';
  const settings = { ...(selection === "none" ? STRICT : {
    select: select([[]], {occurrences: selection === "occurrences"}) }),
    builtinParsers: false, maxErrors: count + 1,
    diagnostics: diagnostics({maxEntries: count}) };
  const iterator = execution === "sync" ? parseMany(source, settings)
    : parseManyAsync(source, {...settings, execution: execution === "worker" ? worker : cooperative});
  try {
    let first = await iterator.next();
    if (first.done || (selection === "none"
        ? first.value.ok || first.value.failure.kind !== "policy-refused" : !first.value.ok))
      throw Error("Missing refused root or selected success");
    let result = first.value, report = result.diagnostics;
    let entries = selection === "none" ? report.errors : report.repairs;
    let recovery = result.ok ? {complete: result.complete, value: result.value.value} : result.failure.recovered;
    if (entries.length !== count || (!result.ok && !entries.includes(result.failure.issue)))
      throw Error("Report count or issue identity changed");
    if (!recovery?.complete || recovery.value.length !== count)
      throw Error("Completed recovery or selected value changed");
    for (let index = 0; index < count; index++) {
      if (entries[index].path[0] !== index || (selection === "none" && !Object.isFrozen(entries[index].path))
        || recovery.value[index].k !== 1 || Object.keys(recovery.value[index]).length !== 1)
        throw Error("Recovered content or diagnostic path changed");
    }
    const held = {iterator, control: retain ? entries : undefined};
    // Drop caller-only aliases before the promise resolves; native frames can outlive the call.
    first = result = report = entries = recovery = undefined;
    return held;
  } catch (cause) { await iterator.return(); throw cause; }
}
async function sample(count, retain) {
  const held = await owner(count, retain);
  try {
    const suspended = await heap();
    const next = await held.iterator.next();
    if (next.done || !next.value.ok || (selection === "none" ? next.value.value : next.value.value.value).safe !== 1)
      throw Error("Releasing diagnostics lost the following root");
    const advanced = await heap();
    if (retain && held.control.length !== count) throw Error("Caller-held metadata control lost");
    if (retain) for (let index = 0; index < count; index++)
      if (held.control[index].path[0] !== index) throw Error("Caller-held diagnostic path changed");
    if (!(await held.iterator.next()).done) throw Error("Completed values replayed");
    return {suspended, advanced};
  } finally { held.control = undefined; await held.iterator.return(); }
}
await sample(100, false);
const small = await sample(100, false), control = await sample(20000, true);
const large = await sample(20000, false);
console.log(JSON.stringify({execution, selection, small, control, large}));
if (!(control.suspended - small.suspended > 2000000))
  throw Error("Heap counter missed caller-held diagnostic metadata");
if (!(large.suspended - small.suspended < 1000000 && large.advanced - small.advanced < 1000000))
  throw Error("Suspended iterator retains delivered diagnostic metadata");
}
`;
