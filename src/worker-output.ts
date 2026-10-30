// SPDX-License-Identifier: Apache-2.0

/** Keep result traversal in the worker to avoid loading transfer code on the caller's main thread. */

import { isExactNumber } from "./exact-number";
import type { Address, Alias, WorkerEnvelope, WorkerPiece } from "./worker-message";

export const describeWorkerValue = (
  value: unknown,
  observe?: (value: object, parent: object | undefined, key: string | number | undefined) => void,
): WorkerEnvelope => {
  const exact: { readonly text: string }[] = [];
  // Structured clone preserves references within an envelope, so freezing needs no root paths.
  const frozen: object[] = [];
  const nullPrototype: object[] = [];
  const seen = new WeakSet<object>();
  // Array indexes avoid allocating key strings or ancestor paths for every scalar member.
  const child = (item: unknown, parent: object, key: string | number): void => {
    if (typeof item === "object" && item !== null) visit(item, parent, key);
  };
  const visit = (current: object, parent?: object, key?: string | number): void => {
    observe?.(current, parent, key);
    if (seen.has(current)) return;
    seen.add(current);
    if (isExactNumber(current)) {
      // Clone preserves references; restoring this leaf in place needs no repeated parent key.
      exact.push(current);
      return;
    }
    if (Object.getPrototypeOf(current) === null) nullPrototype.push(current);
    if (Object.isFrozen(current)) frozen.push(current);
    if (Array.isArray(current))
      for (let index = 0; index < current.length; index++)
        child(current[index] as unknown, current, index);
    else
      for (const memberKey of Object.keys(current))
        child(Reflect.get(current, memberKey), current, memberKey);
  };
  if (typeof value === "object" && value !== null) visit(value);
  return { exact, frozen, nullPrototype, value };
};

/**
 * The weight a piece may carry, in values plus 32-character runs of text. Receiving costs about
 * 0.04 µs per value on Node 24 and a third of that on Bun (structured clone, M4 Max), so a piece is
 * about 0.16 ms there. The receipt alone would allow 8x more, but the pace of arrival sets Node's
 * young-generation pauses: an 8 MB array of 500 000 small objects paused it 8-11 ms at 32 768 and
 * 5-7 ms at 4096, with no change in total time; 2048 gained nothing more.
 */
export const PIECE_WEIGHT = 4096;

const textWeight = (text: string): number => 1 + (text.length >>> 5);

// Clone nesting consumes host stack independently of weight. Keep pieces well below Node's
// measured 2048-level successful envelope; this bounds wire pieces, never accepted input depth.
const PIECE_DEPTH = 512;

type WeightFrame = {
  readonly item: object;
  readonly keys: readonly string[] | undefined;
  readonly length: number;
  index: number;
  weight: number;
  depth: number;
};

const weightFrame = (item: object): WeightFrame => {
  const keys = Array.isArray(item) ? undefined : Object.keys(item);
  return {
    item,
    keys,
    length: keys?.length ?? (item as unknown[]).length,
    index: 0,
    weight: 1,
    depth: 1,
  };
};

/**
 * The pieces a result crosses as, or `undefined` when it fits one piece and crosses whole, as nearly
 * every result does. Runs in the worker, so the walks it costs are off the main thread.
 *
 * A container beyond the weight or clone-depth budget is placed as a shell and filled by batches of its
 * members; a member that is itself too heavy is a shell in its batch, filled right after it lands.
 * Repeated light nodes cross with links preserving identity; a refusal can share its diagnostic
 * issue with its report. Heavy nodes are filled once and later occurrences link to that copy.
 */
export const planWorkerPieces = (
  value: unknown,
  limit = PIECE_WEIGHT,
  recovery?: object,
): Iterator<WorkerPiece> | undefined => {
  const heavy = new Set<object>();
  const seen = new WeakSet<object>();
  let shared: Set<object> | undefined;
  const frames: WeightFrame[] = [];
  if (typeof value === "object" && value !== null && !isExactNumber(value)) {
    seen.add(value);
    frames.push(weightFrame(value));
  }
  // Post-order heap frames bound planning stack even when the recovered tree is arbitrarily deep.
  while (frames.length > 0) {
    const frame = frames[frames.length - 1] as WeightFrame;
    if (frame.index === frame.length) {
      if (frame.weight > limit || frame.depth > PIECE_DEPTH) heavy.add(frame.item);
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        parent.weight += frame.weight;
        parent.depth = Math.max(parent.depth, frame.depth + 1);
      }
      continue;
    }
    const key = frame.keys?.[frame.index];
    // Numeric array access avoids key strings and reflective coercion for every scalar member.
    const item: unknown =
      key === undefined ? (frame.item as unknown[])[frame.index] : Reflect.get(frame.item, key);
    frame.index++;
    if (key !== undefined) frame.weight += textWeight(key);
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) {
        (shared ??= new Set()).add(item);
        // A reused heavy child must not hide inside a wrapper that would otherwise clone whole.
        frame.weight += heavy.has(item) ? limit + 1 : 1;
      } else {
        seen.add(item);
        // Exact leaves still need alias links, but their token is opaque to the container walk.
        if (isExactNumber(item)) frame.weight += textWeight(item.text);
        else frames.push(weightFrame(item));
      }
    } else frame.weight += typeof item === "string" ? textWeight(item) : 1;
  }
  // Only a container or a string splits; one long exact number is a single value however heavy.
  const splits =
    typeof value === "string"
      ? textWeight(value) > limit
      : typeof value === "object" && value !== null && heavy.has(value);
  return splits ? pieces(value, heavy, limit, shared, recovery) : undefined;
};

/** An empty container of the same kind and prototype, for later pieces to fill. */
const shellOf = (container: object): object =>
  Array.isArray(container)
    ? []
    : Object.getPrototypeOf(container) === null
      ? (Object.create(null) as object)
      : {};

const define = (target: object, key: PropertyKey, value: unknown): void => {
  // Never assignment: an own `__proto__` member would call the setter instead of being written.
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

function* pieces(
  root: unknown,
  heavy: ReadonlySet<object>,
  limit: number,
  shared: ReadonlySet<object> | undefined,
  recovery: object | undefined,
): Generator<WorkerPiece, undefined, undefined> {
  type Fill = { readonly kind: "fill"; readonly item: unknown; readonly at: number };
  type Delivery = WorkerPiece | Fill;
  // The receiver owns each container; property counts avoid retransmitting paths or keeping widths.
  let freezeUnits = 0;
  // Register only deferred or shared slots; ordinary batch members need no address table.
  let nextAddress = 1;
  const first = shared === undefined ? undefined : new Map<object, number>();
  if (typeof root === "object" && root !== null && shared?.has(root) === true) first?.set(root, 0);
  // Only outcome wrappers change fill order; source members retain their order. Completion,
  // cuts and reports must be usable before a failed transfer exposes received source data.
  const priorities = recovery === undefined ? undefined : new Map<object, string>();
  if (
    priorities !== undefined &&
    recovery !== undefined &&
    typeof root === "object" &&
    root !== null
  ) {
    priorities.set(root, "failure");
    const failure: unknown = Reflect.get(root, "failure");
    if (typeof failure === "object" && failure !== null) priorities.set(failure, "recovered");
    priorities.set(recovery, "value");
  }
  const textRun = limit * 32;
  // Heavy members fill later; registered shared members need only a link, never another payload.
  const stand = (item: unknown): unknown => {
    if (typeof item === "string") return textWeight(item) > limit ? "" : item;
    if (typeof item !== "object" || item === null) return item;
    const wrapper = priorities?.has(item) === true;
    if (!heavy.has(item) && first?.has(item) !== true && !wrapper) return item;
    const shell = shellOf(item);
    // Reserve wrapper keys in source order; filling metadata first must not reorder outcomes.
    if (wrapper) for (const key of Object.keys(item)) define(shell, key, undefined);
    return shell;
  };
  function* freezePending(): Generator<WorkerPiece, undefined, undefined> {
    while (freezeUnits > 0) {
      const count = Math.min(freezeUnits, limit);
      yield { kind: "freeze", count };
      freezeUnits -= count;
    }
    return undefined;
  }
  function* fill(item: unknown, at: number): Generator<Delivery, undefined, undefined> {
    if (typeof item === "string") {
      for (let offset = 0; offset < item.length; offset += textRun)
        yield { kind: "text", at, text: item.slice(offset, offset + textRun) };
      return undefined;
    }
    const container = item as object;
    let freeze = Object.isFrozen(container);
    const array = Array.isArray(container);
    const keys = array ? undefined : Object.keys(container);
    const length = keys === undefined ? (container as unknown[]).length : keys.length;
    let batch: unknown[] | Record<string, unknown> = array ? [] : {};
    let plainArray = array;
    let weight = 0;
    let later: [unknown, number][] = [];
    let addresses: Address[] | undefined;
    let aliases: Alias[] | undefined;
    let batchStart = 0;
    const lastKey = priorities?.get(container);
    // Reorder only outcome wrappers; a light payload must also wait for a heavy report.
    const lastIndex = lastKey === undefined ? -1 : (keys?.indexOf(lastKey) ?? -1);
    if (lastIndex >= 0 && keys !== undefined && lastKey !== undefined) {
      keys.splice(lastIndex, 1);
      keys.push(lastKey);
    }
    function* flush(): Generator<Delivery, undefined, undefined> {
      if (weight === 0) return undefined;
      // Copy only wrappers whose registered descendants can be replaced by links. Mutating the
      // source would corrupt frozen outcomes; promoting wrappers to fills adds a message each.
      const originals =
        !plainArray && first !== undefined && first.size > 0
          ? new WeakMap<object, object>()
          : undefined;
      if (first !== undefined && originals !== undefined) {
        const copies = new WeakMap<object, object>();
        const trim = (candidate: unknown): unknown => {
          if (typeof candidate !== "object" || candidate === null) return candidate;
          const cached = copies.get(candidate);
          if (cached !== undefined) return cached;
          if (first.has(candidate)) {
            const shell = shellOf(candidate);
            copies.set(candidate, shell);
            originals.set(shell, candidate);
            return shell;
          }
          if (isExactNumber(candidate)) return candidate;
          let copy: object | undefined;
          for (const key of Object.keys(candidate)) {
            const child: unknown = Reflect.get(candidate, key);
            const replacement = trim(child);
            if (replacement === child) continue;
            copy ??= Array.isArray(candidate)
              ? candidate.slice()
              : Object.getPrototypeOf(candidate) === null
                ? Object.assign(Object.create(null) as object, candidate)
                : { ...candidate };
            define(copy, key, replacement);
          }
          if (copy === undefined) return candidate;
          if (Object.isFrozen(candidate)) Object.freeze(copy);
          copies.set(candidate, copy);
          originals.set(copy, candidate);
          return copy;
        };
        batch = trim(batch) as typeof batch;
        // Previously registered shells refer to the original batch or a copied nested parent.
        addresses = addresses?.map(([address, parent, key]) => [
          address,
          copies.get(parent) ?? parent,
          key,
        ]);
        aliases = aliases?.map(([address, parent, key]) => [
          address,
          copies.get(parent) ?? parent,
          key,
        ]);
      }
      // Clone already preserves sharing inside this packet. Only earlier canonical values need
      // links; retain their destination parent in the packet, never in the receiver's slot table.
      const firstLocalAddress = nextAddress;
      // Fresh arrays of primitives have no object metadata or aliases to discover again.
      const envelope = plainArray
        ? { exact: [], frozen: [], nullPrototype: [], value: batch }
        : describeWorkerValue(
            batch,
            first === undefined
              ? undefined
              : (node, parent, key) => {
                  node = originals?.get(node) ?? node;
                  if (shared?.has(node) !== true || parent === undefined || key === undefined)
                    return;
                  // Appended arrays use destination indexes, while nested parents cross by reference.
                  const slot = array && parent === batch ? batchStart + Number(key) : key;
                  const target = first.get(node);
                  if (target === undefined) {
                    const address = nextAddress++;
                    (addresses ??= []).push([address, parent, slot]);
                    first.set(node, address);
                  } else if (target < firstLocalAddress)
                    (aliases ??= []).push([target, parent, slot]);
                },
          );
      for (const node of envelope.frozen)
        freezeUnits += 1 + (Array.isArray(node) ? node.length : Object.keys(node).length);
      if (freeze) freezeUnits += length + 1;
      yield array
        ? {
            kind: "items",
            at,
            envelope,
            ...(addresses === undefined ? {} : { addresses }),
            ...(aliases === undefined ? {} : { aliases }),
            ...(freeze ? { freeze: true as const } : {}),
          }
        : {
            kind: "members",
            at,
            envelope,
            ...(addresses === undefined ? {} : { addresses }),
            ...(aliases === undefined ? {} : { aliases }),
            ...(freeze ? { freeze: true as const } : {}),
          };
      freeze = false;
      const deferred = later;
      if (array) batchStart += (batch as unknown[]).length;
      batch = array ? [] : {};
      plainArray = array;
      weight = 0;
      later = [];
      addresses = undefined;
      aliases = undefined;
      for (const [member, address] of deferred) {
        yield { kind: "fill", item: member, at: address };
      }
      return undefined;
    }
    for (let index = 0; index < length; index++) {
      const key = keys === undefined ? String(index) : (keys[index] as string);
      if (key === lastKey) {
        yield* flush();
        if (container === recovery) {
          // Public outcome wrappers are mutable; only fully filled metadata is frozen so far.
          // Identity links have landed, so reports keep their source shape even if delivery fails.
          yield* freezePending();
          yield { kind: "recovery", at };
        }
      }
      const member: unknown = Reflect.get(container, key);
      const standIn = stand(member);
      let deferred = member;
      let parent: object = batch;
      let slot = key;
      let standWeight = 1;
      if (standIn !== member) {
        const sharedNode =
          typeof member === "object" && member !== null && shared?.has(member) === true;
        const previous = sharedNode ? first?.get(member) : undefined;
        if (previous === undefined) {
          const canonical = sharedNode ? nextAddress++ : undefined;
          if (canonical !== undefined) {
            first?.set(member as object, canonical);
            (addresses ??= []).push([canonical, batch, key]);
          }
          let target = standIn;
          // Batch single-member shells; keep the deferred leaf writable.
          while (
            typeof deferred === "object" &&
            deferred !== null &&
            typeof target === "object" &&
            target !== null &&
            standWeight < PIECE_DEPTH &&
            standWeight < limit
          ) {
            const arrayShell = Array.isArray(deferred);
            const shellKeys = arrayShell ? undefined : Object.keys(deferred);
            if ((shellKeys?.length ?? (deferred as unknown[]).length) !== 1) break;
            const shellKey = shellKeys?.[0] ?? "0";
            const nextWeight = standWeight + 1 + (arrayShell ? 0 : textWeight(shellKey));
            if (nextWeight > limit || nextWeight > PIECE_DEPTH) break;
            const child: unknown = Reflect.get(deferred, shellKey);
            if (
              typeof child !== "object" ||
              child === null ||
              !heavy.has(child) ||
              shared?.has(child) === true
            )
              break;
            const nested = shellOf(child);
            if (Array.isArray(target)) target.push(nested);
            else define(target, shellKey, nested);
            // Clone records this shell locally; the receiver freezes it after identity links land.
            if (Object.isFrozen(deferred)) Object.freeze(target);
            parent = target;
            slot = shellKey;
            target = nested;
            deferred = child;
            standWeight = nextWeight;
          }
          const address = canonical !== undefined && parent === batch ? canonical : nextAddress++;
          if (address !== canonical) (addresses ??= []).push([address, parent, slot]);
          later.push([deferred, address]);
        } else {
          (aliases ??= []).push([previous, batch, key]);
        }
      }
      if (typeof standIn === "object" && standIn !== null) plainArray = false;
      if (Array.isArray(batch)) batch.push(standIn);
      else define(batch, key, standIn);
      weight +=
        (keys === undefined ? 0 : textWeight(key)) +
        (standIn === member ? weightOf(member, first) : standWeight);
      if (weight >= limit) yield* flush();
    }
    yield* flush();
    return undefined;
  }
  yield { kind: "place", envelope: describeWorkerValue(stand(root)) };
  // Delegated generators consume the call stack again on every pull. Keep the same depth-first
  // wire order with heap-owned continuations, so deep results do not overflow during delivery.
  const pending = [fill(root, 0)];
  while (pending.length > 0) {
    const step = pending[pending.length - 1]?.next();
    if (step === undefined || step.done === true) pending.pop();
    else if (step.value.kind === "fill") pending.push(fill(step.value.item, step.value.at));
    else yield step.value;
  }
  // No links remain to write. Freeze bounded property batches without walking root paths again.
  yield* freezePending();
  return undefined;
}

const weightOf = (item: unknown, registered: ReadonlyMap<object, number> | undefined): number => {
  if (typeof item === "string") return textWeight(item);
  if (typeof item !== "object" || item === null) return 1;
  // flush replaces registered nodes with identity shells; their payload must not be counted again.
  if (registered?.has(item) === true) return 1;
  if (isExactNumber(item)) return textWeight(item.text);
  let weight = 1;
  if (Array.isArray(item)) for (const member of item) weight += weightOf(member, registered);
  else
    for (const key of Object.keys(item))
      weight += textWeight(key) + weightOf(Reflect.get(item, key), registered);
  return weight;
};
