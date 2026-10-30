// SPDX-License-Identifier: Apache-2.0

/**
 * What a shared view costs per call, which is what decided that the live tree is never exposed.
 *
 * `view: sharedView` copies the spine from root to the incomplete node — O(depth + width of the open
 * containers), not O(size), because every finished branch is shared. A live view would hand back the parser's own
 * object for O(1), and would mutate under the reader. Shipping that footgun is permanent; the only
 * thing that could earn it is a cost a caller cannot absorb, and this number says there is none.
 *
 * Each `bench` runs an entire stream — every chunk fed, a snapshot taken after each — because a
 * streaming UI pulls a view once per chunk and a single call in isolation would measure a cold
 * spine. **But read the result per CALL, dividing by `CHUNKS`.** A per-stream figure is the
 * per-call cost multiplied by a chunk count that is a constant in this file rather than a fact about
 * any caller, so any budget written in per-stream terms can be crossed or not crossed by editing the
 * line below — which is exactly what happened to the 4 ms threshold this bench was written against.
 *
 * Depth is chosen by the INPUT, not by us, which is why this sweeps rather than samples: the answer
 * has to hold at the deepest nesting the default budget permits, not at a depth we picked.
 *
 * Never gates. It informs one decision and is then evidence for it.
 */
import { bench, describe, run } from "./harness.ts";

import { createStreamParser } from "../src/parser";
import { ownedView, sharedView } from "../src/index";

/** How many chunks a stream is cut into — one view per chunk, as a UI would. */
const CHUNKS = 1000;

/**
 * Nesting `depth` deep with a payload at the bottom, so the spine copy has something to walk and the
 * shared branches have something to be. Left unclosed on purpose: an incomplete value is the only
 * state in which a snapshot is interesting, and it is the state a stream is in at every chunk but
 * the last.
 */
const deepText = (depth: number): string => {
  const rows = Array.from({ length: 30 }, (_, i) => `"k${i}":${i},"s${i}":"v${i}"`).join(",");
  return `${'{"a":'.repeat(depth)}{${rows}`;
};

/**
 * `snapshot: false` is the CONTROL, and it is what makes this measure anything.
 *
 * Deeper input is also longer input — 512 levels carry 2.6 KB of `{"a":` that 4 levels do not — so
 * the difference between two depths is part scan and part snapshot, and comparing depths alone
 * cannot say which. Each depth is therefore run twice, identically but for the snapshot call, and
 * the snapshot's true cost is the difference between the pair. Reading the with-snapshot number
 * alone would have attributed the scan of a 5x longer document to the view.
 */
const stream = (text: string, snapshot: boolean): (() => void) => {
  const size = Math.ceil(text.length / CHUNKS);
  const chunks = Array.from({ length: CHUNKS }, (_, i) => text.slice(i * size, (i + 1) * size));
  return () => {
    const sp = createStreamParser({ maxDepth: 600, view: sharedView });
    for (const chunk of chunks) {
      for (const _ of sp.feed(chunk)) {
        /* drain */
      }
      if (snapshot) sp.snapshot();
    }
  };
};

/**
 * Three depths x with/without the snapshot. 512 is the default budget's ceiling, so it is the worst
 * case a caller reaches without raising it; the other two make the result a slope rather than a
 * single number, which is what shows whether cost tracks DEPTH (as the design claims) or SIZE (which
 * would mean the branch sharing is not working).
 */
/**
 * Width is the other axis, and the one the depth sweep cannot see: every open container is copied
 * shallowly, so a snapshot of an array still being filled costs its width. One space is fed before
 * each pull because a pull with nothing new returns the memoised snapshot and would measure nothing.
 */
const wide = (width: number, view: "shared" | "owned"): (() => void) => {
  const sp = createStreamParser({
    view: view === "owned" ? ownedView : sharedView,
    maxBuffer: 1 << 26,
    maxRetained: 1 << 26,
  });
  for (const _ of sp.feed(`[${Array.from({ length: width }, (_v, i) => i).join(",")},`)) {
    /* drain */
  }
  return () => {
    for (const _ of sp.feed(" ")) {
      /* drain */
    }
    sp.snapshot();
  };
};

describe("one snapshot of an open root array, by width", () => {
  for (const width of [1_000, 10_000, 100_000]) {
    bench(`width ${width}: shared`, wide(width, "shared"));
    bench(`width ${width}: owned`, wide(width, "owned"));
  }
});

describe(`a shared view over a ${CHUNKS}-chunk stream`, () => {
  for (const depth of [512, 64, 4]) {
    const text = deepText(depth);
    bench(`depth ${depth}: feed + snapshot`, stream(text, true));
    bench(`depth ${depth}: feed only (control)`, stream(text, false));
  }
});

await run();
