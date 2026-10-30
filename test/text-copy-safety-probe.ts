// SPDX-License-Identifier: Apache-2.0

// Text copying must neither transfer unrelated buffers nor read inherited transfer settings.
export const textCopySafetyProbe = (module: string, asyncModule: string): string => `
import { strict as assert } from 'node:assert';
const nativeClone = structuredClone, iterator = Array.prototype[Symbol.iterator];
const previousTransfer = Object.getOwnPropertyDescriptor(Object.prototype, 'transfer');
const lists = new WeakSet(); let owner, inheritedReads = 0, copiedUnits = 0;
// Install before import: the copier captures its host function during module initialization.
globalThis.structuredClone = (value, options) => {
  if (typeof value === 'string') copiedUnits += value.length;
  if (typeof value === 'string' && Array.isArray(options?.transfer)) lists.add(options.transfer);
  return nativeClone(value, options);
};
// Affect only transfer arrays observed at the native boundary, not parser iteration.
Array.prototype[Symbol.iterator] = function () {
  return lists.has(this) && owner?.byteLength ? iterator.call([owner]) : iterator.call(this);
};
try {
  const { parse, isExactNumber } = await import(${JSON.stringify(module)});
  const digits = '9'.repeat(20000);
  const recover = () => {
    const answer = parse('{a:' + digits + '}');
    assert.equal(answer.ok, true);
    assert.ok(isExactNumber(answer.value.a));
    assert.equal(answer.value.a.text, digits);
    assert.equal(owner.byteLength, 8, 'Text recovery detached unrelated caller storage');
  };
  owner = new ArrayBuffer(8); recover();
  Array.prototype[Symbol.iterator] = iterator;
  owner = new ArrayBuffer(8);
  Object.defineProperty(Object.prototype, 'transfer', { configurable: true,
    get() { inheritedReads++; return owner.byteLength ? [owner] : []; } });
  recover(); assert.equal(inheritedReads, 0, 'Text recovery read inherited transfer settings');
  Reflect.deleteProperty(Object.prototype, 'transfer');
  const { cooperative, parseAsync } = await import(${JSON.stringify(asyncModule)});
  const input = new Uint8Array(65536).fill(255);
  const options = { maxScalar: input.length * 2 };
  const expected = parse(input, options);
  copiedUnits = 0;
  const actual = await parseAsync(input, { ...options, execution: cooperative });
  assert.deepEqual(actual, expected);
  // Allow one final owned value plus geometric prefix growth, not a copy per byte.
  assert.ok(copiedUnits <= input.length * 2, 'Repeated prefix copying: ' + copiedUnits);
} finally {
  Array.prototype[Symbol.iterator] = iterator;
  Reflect.deleteProperty(Object.prototype, 'transfer');
  if (previousTransfer) Object.defineProperty(Object.prototype, 'transfer', previousTransfer);
  globalThis.structuredClone = nativeClone;
}
console.log('Text copying preserves unrelated buffers, ignores inherited transfers and bounds prefix work');
`;
