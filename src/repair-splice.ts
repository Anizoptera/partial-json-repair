// SPDX-License-Identifier: Apache-2.0

/**
 * Applies the edit log to the source and hands back the repaired text with every span carried
 * through the splices, so a value — or each match — can be cut out of the result.
 *
 * Most edit logs already follow source order. Projection uses those directly and applies a
 * resumable stable merge only when a later decision reaches behind an earlier edit. Equal offsets
 * stay in recording order: every closer for an unclosed document is inserted at the SAME offset, and
 * `{"a":[1,{"b":2` needs `}`, `]`, `}` in the order the builder recorded them.
 *
 * No prefilter removes overlapping edits, and none is needed: the builder RETRACTS the edits of
 * any construct it drops from the tree, so an edit inside a deleted span cannot reach here. A
 * filter would also be wrong where retraction is right — an inserted comma has zero width and
 * sits at the deleted key's start, so containment cannot distinguish it from an adjacent one.
 */
// An empty span's end includes every edit before its start; its recorded closer cutoff cannot
// exclude those edits. Edit records have no cutoff and retain their original order on ties.
const closingIndex = (entry: { start: number; end: number; until?: number } | undefined): number =>
  entry?.until === undefined ? 0 : entry.start === entry.end ? Infinity : entry.until;

function* editOrder(
  log: readonly { start: number; end: number; until?: number }[],
  units: number,
  field: "start" | "end" = "start",
): Generator<void, number[] | undefined> {
  let runs: { start: number; end: number }[] = [];
  let runStart = 0;
  // Keep fixed property reads on the ordinary source-order path; a dynamic key in this
  // per-edit loop charges even one-span repairs for the optional cumulative index.
  if (field === "start") {
    for (let index = 1; index < log.length; index++) {
      if ((log[index - 1]?.start ?? 0) > (log[index]?.start ?? 0)) {
        runs.push({ start: runStart, end: index });
        runStart = index;
      }
      if (index % units === 0) yield;
    }
  } else {
    for (let index = 1; index < log.length; index++) {
      const left = log[index - 1];
      const right = log[index];
      if (
        (left?.end ?? 0) > (right?.end ?? 0) ||
        (left?.end === right?.end && closingIndex(left) > closingIndex(right))
      ) {
        runs.push({ start: runStart, end: index });
        runStart = index;
      }
      if (index % units === 0) yield;
    }
  }
  if (runStart === 0) return undefined;
  let order: number[] = [];
  let buffer: number[] = [];
  runs.push({ start: runStart, end: log.length });
  for (let index = 0; index < log.length; index++) {
    order.push(index);
    buffer.push(0);
    if ((index + 1) % units === 0) yield;
  }
  let work = 0;
  while (runs.length > 1) {
    const merged: { start: number; end: number }[] = [];
    for (let pair = 0; pair < runs.length; pair += 2) {
      const leftRun = runs[pair];
      const rightRun = runs[pair + 1];
      if (leftRun === undefined) throw new Error("repair edit run is incomplete");
      const end = rightRun?.end ?? leftRun.end;
      let left = leftRun.start;
      let right = leftRun.end;
      for (let output = leftRun.start; output < end; output++) {
        const leftIndex = left < leftRun.end ? order[left] : undefined;
        const rightIndex =
          rightRun !== undefined && right < rightRun.end ? order[right] : undefined;
        const leftOffset = leftIndex === undefined ? undefined : log[leftIndex];
        const rightOffset = rightIndex === undefined ? undefined : log[rightIndex];
        const takeLeft =
          rightIndex === undefined ||
          (leftIndex !== undefined &&
            ((leftOffset?.[field] ?? 0) < (rightOffset?.[field] ?? 0) ||
              (leftOffset?.[field] === rightOffset?.[field] &&
                (field === "start" || closingIndex(leftOffset) <= closingIndex(rightOffset)))));
        const selected = takeLeft ? leftIndex : rightIndex;
        if (selected === undefined) throw new Error("repair edit merge selected no edit");
        buffer[output] = selected;
        if (takeLeft) left++;
        else right++;
        if (++work % units === 0) yield;
      }
      merged.push({ start: leftRun.start, end });
    }
    [order, buffer] = [buffer, order];
    runs = merged;
  }
  return order;
}

function* spanEndOrder(
  spans: readonly { start: number; end: number; until: number }[],
  units: number,
): Generator<void, number[] | undefined> {
  // Flat source-order ranges already need no index. Nested selections normally close in
  // stack order, which avoids merge runs and a second width-sized index buffer.
  let sorted = true;
  let work = 0;
  for (let index = 1; index < spans.length; index++) {
    const left = spans[index - 1];
    const right = spans[index];
    if (
      left !== undefined &&
      right !== undefined &&
      (left.end > right.end || (left.end === right.end && closingIndex(left) > closingIndex(right)))
    ) {
      sorted = false;
      break;
    }
    if (++work % units === 0) yield;
  }
  if (sorted) return undefined;
  const order: number[] = [];
  const parents: number[] = [];
  let start = -Infinity;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    if (span === undefined) throw new Error("repair span order is incomplete");
    let nested = span.start >= start;
    start = span.start;
    while (nested && parents.length > 0) {
      const prior = spans[parents.at(-1) as number];
      if (prior === undefined) throw new Error("repair span order is incomplete");
      if (
        prior.end < span.start ||
        (prior.end === span.start &&
          (prior.end < span.end || closingIndex(prior) <= closingIndex(span)))
      ) {
        order.push(parents.pop() as number);
        if (++work % units === 0) yield;
        continue;
      }
      nested =
        span.end < prior.end ||
        (span.end === prior.end && closingIndex(span) <= closingIndex(prior));
      break;
    }
    if (!nested) {
      // Keep the general contract for crossing or reordered ranges; no span was changed yet.
      yield;
      return yield* editOrder(spans, units, "end");
    }
    parents.push(index);
    if (++work % units === 0) yield;
  }
  while (parents.length > 0) {
    order.push(parents.pop() as number);
    if (++work % units === 0) yield;
  }
  return order;
}

// Sweep ordered boundaries through cumulative edit deltas instead of storing a prefix per edit.
// Query state scales with the selected spans, not all edits in a mostly unselected document.
// The recording index separates a match's own closer from its ancestors' at the same offset.
function* shiftSpans(
  log: readonly { start: number; end: number; text: string }[],
  spans: { start: number; end: number; until: number }[],
  units: number,
): Generator<void> {
  const order = yield* editOrder(log, units, "end");
  let work = 0;
  // End first: changing it leaves original starts intact for the second sweep and avoids copies.
  for (const field of ["end", "start"] as const) {
    const boundaries =
      field === "end" ? yield* spanEndOrder(spans, units) : yield* editOrder(spans, units, field);
    let rank = 0;
    let delta = 0;
    for (let query = 0; query < spans.length; query++) {
      const span = spans[boundaries?.[query] ?? query];
      if (span === undefined) throw new Error("repair span order is incomplete");
      const offset = span[field];
      const until = field === "start" ? Infinity : closingIndex(span);
      while (rank < log.length) {
        const index = order?.[rank] ?? rank;
        const edit = log[index];
        if (edit === undefined) throw new Error("repair edit order is incomplete");
        if (edit.end > offset || (edit.end === offset && index >= until)) break;
        delta += edit.text.length - (edit.end - edit.start);
        rank++;
        if (++work >= units) {
          work = 0;
          yield;
        }
      }
      span[field] += delta;
      if (++work >= units) {
        work = 0;
        yield;
      }
    }
  }
}

export function* spliceSteps(
  text: string,
  log: readonly { start: number; end: number; text: string }[],
  // `from` is read on the linear path only, which every single-span call takes: a root's repair.
  spans: { start: number; end: number; until: number; from?: number }[],
  units: number,
): Generator<void, string> {
  if (!Number.isSafeInteger(units) || units < 1) throw new RangeError("units must be positive");
  const order = yield* editOrder(log, units);
  // One span needs one linear edit walk and no ordering state. Sweep only when repeated
  // span walks exceed two boundary sorts and edit walks. Ordering compares and moves indexes,
  // unlike a linear span update; pricing those separately keeps small nested selections linear.
  const indexed =
    spans.length > 1 &&
    log.length > 1 &&
    log.length * spans.length >
      2 * log.length + 8 * spans.length * Math.ceil(Math.log2(spans.length + 1));
  const originalSpans: { start: number; end: number }[] = [];
  const linearSpans = indexed ? 0 : spans.length;
  let work = 0;
  for (let index = 0; index < linearSpans; index++) {
    const span = spans[index];
    if (span === undefined) throw new Error("repair span order is incomplete");
    originalSpans.push({ start: span.start, end: span.end });
    if (++work % units === 0) yield;
  }
  let previous = 0;
  const parts: string[] = [];
  const chunks: string[] = [];
  const group = Math.min(units, 4096);
  for (let rank = 0; rank < log.length; rank++) {
    const index = order?.[rank] ?? rank;
    const e = log[index];
    if (e === undefined) throw new Error("repair edit order is incomplete");
    if (previous < e.start) parts.push(text.slice(previous, e.start));
    if (e.text.length > 0) parts.push(e.text);
    previous = e.end;
    const delta = e.text.length - (e.end - e.start);
    for (let spanIndex = 0; spanIndex < originalSpans.length; spanIndex++) {
      const span = spans[spanIndex];
      const original = originalSpans[spanIndex];
      if (span === undefined || original === undefined)
        throw new Error("repair span order is incomplete");
      // A zero-width insert AT the span's end — every closer for an unclosed container is one —
      // satisfies `e.end <= end` and so extends the span, which is what keeps `[1,{"b":2` whole.
      // For a match, only closers recorded before it closed are inside it: its own closers and
      // its ancestors' sit at the same offset, and the log order is the only thing telling them
      // apart.
      // Entirely BEFORE the span, so the whole span slides: moving `start` alone stretches it by
      // `delta` and the result carries text the value does not, such as prose after a BOM-prefixed
      // value whose leading byte-order mark was removed.
      // A zero-width insert AT the span's start is outside it, unless the span's own value recorded
      // it (`from`): a list's opening bracket sits there, and so can the previous value's closer.
      if (
        e.end < original.start ||
        (e.end === original.start && (e.start < e.end || index < (span.from ?? Infinity)))
      ) {
        span.start += delta;
        span.end += delta;
      } else if (e.end < original.end || (e.end === original.end && index < span.until)) {
        span.end += delta;
      }
      if (++work % units === 0) yield;
    }
    if ((rank + 1) % group === 0 && parts.length > 0) {
      chunks.push(parts.join(""));
      parts.length = 0;
    }
    if (++work % units === 0 && rank + 1 < log.length) yield;
  }
  if (previous < text.length) parts.push(text.slice(previous));
  if (parts.length > 0) chunks.push(parts.join(""));
  if (indexed) yield* shiftSpans(log, spans, units);
  return chunks.join("");
}
