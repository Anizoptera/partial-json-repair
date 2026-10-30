/**
 * Decides the scanner's inner-loop syntax by measurement, before the scanner is written.
 *
 * The rewrite's premise is that the original was built out of the slowest primitives available, so
 * "this shape is faster" is exactly the claim that must not be taken on reputation: each group below
 * pits the real rivals against each other on the same input, and the winner is what the scanner uses.
 * Running this AFTER the scanner exists would make it a report; running it first makes it a decision.
 *
 * Never gates. Numbers here inform; the corpus judges correctness.
 *
 * Each group is a separate `describe` so vitest reports a per-group ranking rather than one pool of
 * unrelated operations.
 */
import { bench, describe, run } from "./harness.ts";

/**
 * Deterministic input in the shape this parser actually sees: LLM-ish JSON, mixed key lengths,
 * strings with escapes, numbers, nesting. Generated rather than pasted so the size is a knob and the
 * content cannot be accidentally tuned to favour one rival.
 */
const sample = ((): string => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    note: i % 7 === 0 ? 'has "quotes" and \\ escapes' : "plain text value",
    score: i / 3,
    tags: [`a${i}`, `b${i}`],
    nested: { deep: { deeper: i % 2 === 0 } },
  }));
  return JSON.stringify(rows);
})();

const LEN = sample.length;

describe("character access", () => {
  // The claim under test: indexing materialises a one-character string per access, while charCodeAt
  // returns an integer and allocates nothing. `codePointAt` is the correctness-minded rival -- it
  // handles surrogate pairs in one read -- so its cost is what buying that would cost.
  bench("s[i]", () => {
    let acc = 0;
    for (let i = 0; i < LEN; i++) if (sample[i] === '"') acc++;
    if (acc < 0) throw new Error("unreachable");
  });

  bench("s.charCodeAt(i)", () => {
    let acc = 0;
    for (let i = 0; i < LEN; i++) if (sample.charCodeAt(i) === 34) acc++;
    if (acc < 0) throw new Error("unreachable");
  });

  bench("s.codePointAt(i)", () => {
    let acc = 0;
    for (let i = 0; i < LEN; i++) if (sample.codePointAt(i) === 34) acc++;
    if (acc < 0) throw new Error("unreachable");
  });
});

describe("token dispatch", () => {
  // Classifying a code unit is the single most executed branch in the scanner. A 128-entry typed
  // lookup costs one memory read; a switch costs whatever the engine compiles it to; a comparison
  // chain costs its position in the chain, which is why the common case is placed first in it.
  const TABLE = new Uint8Array(128);
  for (const c of [0x20, 0x09, 0x0a, 0x0d]) TABLE[c] = 1; // whitespace
  for (const c of [0x7b, 0x7d, 0x5b, 0x5d, 0x3a, 0x2c]) TABLE[c] = 2; // structural
  TABLE[0x22] = 3; // quote

  bench("switch", () => {
    let acc = 0;
    for (let i = 0; i < LEN; i++) {
      switch (sample.charCodeAt(i)) {
        case 0x20:
        case 0x09:
        case 0x0a:
        case 0x0d:
          acc += 1;
          break;
        case 0x7b:
        case 0x7d:
        case 0x5b:
        case 0x5d:
        case 0x3a:
        case 0x2c:
          acc += 2;
          break;
        case 0x22:
          acc += 3;
          break;
        default:
          break;
      }
    }
    if (acc < 0) throw new Error("unreachable");
  });

  bench("comparison chain", () => {
    let acc = 0;
    for (let i = 0; i < LEN; i++) {
      const c = sample.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) acc += 1;
      else if (c === 0x7b || c === 0x7d || c === 0x5b || c === 0x5d || c === 0x3a || c === 0x2c)
        acc += 2;
      else if (c === 0x22) acc += 3;
    }
    if (acc < 0) throw new Error("unreachable");
  });

  bench("Uint8Array lookup", () => {
    let acc = 0;
    for (let i = 0; i < LEN; i++) {
      const c = sample.charCodeAt(i);
      acc += c < 128 ? (TABLE[c] ?? 0) : 0;
    }
    if (acc < 0) throw new Error("unreachable");
  });

  bench("regex .test per char", () => {
    // The primitive the original actually used in its inner loops, kept as the baseline the rewrite
    // is claiming to beat. It also allocates the one-character string it is handed.
    const WS = /\s/u;
    let acc = 0;
    for (let i = 0; i < LEN; i++) if (WS.test(sample[i] ?? "")) acc += 1;
    if (acc < 0) throw new Error("unreachable");
  });
});

describe("container stack", () => {
  // The scanner's depth stack: pushed and popped once per container, so its cost scales with
  // structure rather than with input length. A typed array needs a fixed ceiling; a plain array does
  // not, which is the trade being priced.
  const DEPTH = 64;
  const ops = 200_000;

  bench("number[] push/pop", () => {
    const stack: number[] = [];
    for (let i = 0; i < ops; i++) {
      stack.push(i & 1);
      if (stack.length === DEPTH) stack.length = 0;
    }
  });

  bench("Uint8Array + index", () => {
    const stack = new Uint8Array(DEPTH);
    let top = 0;
    for (let i = 0; i < ops; i++) {
      stack[top++] = i & 1;
      if (top === DEPTH) top = 0;
    }
  });
});

describe("call site shape", () => {
  // The scanner calls the builder once per token, so whether that call site stays monomorphic is a
  // per-token cost. This is the measurement behind "no event bus": an emitter with two shapes of
  // consumer makes every one of these calls polymorphic.
  // Every case resets its counters and every `take` has the SAME body. Both are load-bearing: when
  // the monomorphic case drove one counter by +1 while the split pair drove theirs by +1 and -1,
  // its accumulator grew twice as fast and left the small-integer representation first, so the
  // group priced numeric representation rather than dispatch. That inverted the result on
  // JavaScriptCore -- polymorphic measured 2.4x FASTER -- while leaving it standing on V8.
  const mono = {
    n: 0,
    take(v: number): void {
      this.n += v;
    },
  };
  // Same property names in the same order, so this shares `mono`'s hidden class and only the callee
  // function object differs. That is the CHEAP half of polymorphism, and reading it alone would
  // understate what a second consumer costs.
  const sameShape = {
    n: 0,
    take(v: number): void {
      this.n += v;
    },
  };
  // A genuinely different hidden class. This is what an emitter with two KINDS of consumer produces,
  // and it is the number the "no event bus" decision rests on.
  const otherShape = {
    extra: 1,
    n: 0,
    pad: "x",
    take(v: number): void {
      this.n += v;
    },
  };

  bench("monomorphic", () => {
    mono.n = 0;
    for (let i = 0; i < 200_000; i++) mono.take(1);
  });

  bench("two callees, one shape", () => {
    mono.n = 0;
    sameShape.n = 0;
    for (let i = 0; i < 200_000; i++) (i & 1 ? mono : sameShape).take(1);
  });

  bench("two shapes", () => {
    mono.n = 0;
    otherShape.n = 0;
    for (let i = 0; i < 200_000; i++) (i & 1 ? mono : otherShape).take(1);
  });
});

describe("stream buffer growth", () => {
  // V8 makes `+=` cheap by building a rope, and `charCodeAt` on a rope forces a flatten -- so the
  // naive streaming loop re-flattens the whole buffer on every chunk and ends up slower than the code
  // it replaced. Compacting the consumed prefix keeps one flat string. Many small chunks is the shape
  // that exposes it, and it is exactly what an LLM stream delivers.
  const chunks = Array.from({ length: 2000 }, (_, i) => `{"k${i}":${i}}`);

  // THREE variants, because the obvious two differ in two ways at once and their gap cannot be
  // attributed: re-scanning from zero is quadratic on its own, whether or not a rope is involved.
  // The middle variant isolates the rope: same growing buffer, but scanning only the new suffix.
  bench("append, rescan from zero each chunk", () => {
    let buf = "";
    let seen = 0;
    for (const chunk of chunks) {
      buf += chunk;
      for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 0x7d) seen++;
    }
    if (seen < 0) throw new Error("unreachable");
  });

  bench("append, scan only the new suffix", () => {
    let buf = "";
    let pos = 0;
    let seen = 0;
    for (const chunk of chunks) {
      buf += chunk;
      for (; pos < buf.length; pos++) if (buf.charCodeAt(pos) === 0x7d) seen++;
    }
    if (seen < 0) throw new Error("unreachable");
  });

  bench("append, compact the consumed prefix", () => {
    let buf = "";
    let seen = 0;
    for (const chunk of chunks) {
      buf += chunk;
      for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 0x7d) seen++;
      buf = ""; // every chunk here closes its own value, so the whole prefix is consumed
    }
    if (seen < 0) throw new Error("unreachable");
  });
});

await run();
