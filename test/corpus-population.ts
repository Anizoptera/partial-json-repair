// SPDX-License-Identifier: Apache-2.0

/**
 * The inputs every whole-route differential test reads: each decodable corpus document and each seeded
 * generated document, sampled prefixes at character or structural boundaries,
 * seeded single-character mutations, and hand-picked hazards. One definition, so the pre-scan proof and the completion proof cannot
 * drift onto different populations. A failure prints its seed; `PRESCAN_SEED=<seed>` replays it.
 */
import { readFileSync } from "node:fs";

const CORPUS = new URL("../corpus/", import.meta.url).pathname;

/** Every input text the two corpus banks hold: `text`, joined `chunks`, and well-formed `bytes`. */
const corpusTexts = (): string[] => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts: string[] = [];
  for (const file of ["corpus.jsonl", "seeds.jsonl"]) {
    for (const line of readFileSync(`${CORPUS}${file}`, "utf8").split("\n")) {
      if (line === "") continue;
      const row = JSON.parse(line) as { text?: unknown; chunks?: unknown; bytes?: unknown };
      const hex = (h: string): string | undefined => {
        const bytes = new Uint8Array(h.length / 2);
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
        try {
          return decoder.decode(bytes);
        } catch {
          // Malformed bytes never reach a built-in parser: the wiring declines on any replacement.
          return undefined;
        }
      };
      if (typeof row.text === "string") texts.push(row.text);
      else if (typeof row.bytes === "string") {
        const t = hex(row.bytes);
        if (t !== undefined) texts.push(t);
      } else if (Array.isArray(row.chunks)) {
        let joined = "";
        let ok = true;
        for (const chunk of row.chunks as unknown[]) {
          if (typeof chunk === "string") joined += chunk;
          else {
            const t = hex((chunk as { bytes: string }).bytes);
            if (t === undefined) ok = false;
            else joined += t;
          }
        }
        if (ok) texts.push(joined);
      }
    }
  }
  return texts;
};

/**
 * Structural equality: `Object.is` at the leaves, same prototype, same own keys in the same order.
 * Never through `JSON.stringify`, which erases `NaN`, `undefined` and own `__proto__` members.
 */
export const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i] as PropertyKey;
    if (k !== kb[i]) return false;
    const da = Object.getOwnPropertyDescriptor(a, k);
    const db = Object.getOwnPropertyDescriptor(b, k);
    if (da?.enumerable !== db?.enumerable) return false;
    if (!same(da?.value, db?.value)) return false;
  }
  return true;
};

/** Small seeded PRNG, so a failing mutation replays from its printed seed. */
export const mulberry32 = (seed: number) => () => {
  let t = (seed = (seed + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MUTATION_CHARS = '{}[],:"\\/';
const MUTATIONS_PER_DOC = Number(process.env["PRESCAN_MUTATIONS"] ?? 6);
// `NaN` would compare false in the mutation loop and silently drop every mutation.
if (!Number.isInteger(MUTATIONS_PER_DOC) || MUTATIONS_PER_DOC < 0)
  throw new Error(`PRESCAN_MUTATIONS must be a non-negative integer, got ${MUTATIONS_PER_DOC}`);
/** Consider every character boundary before sampling prefixes of short documents. */
const SHORT = 256;
/** Documents longer than this get fewer mutations. */
const LONG = 4096;
/** Prefixes taken per boundary character in a longer document. */
const PER_BOUNDARY = 24;
const BASE_SEED = Number(process.env["PRESCAN_SEED"] ?? 20261004);

export type Input = { readonly text: string; readonly origin: string; readonly kind: string };

/** What the character just before a cut is, as far as a reader's next decision goes. */
const charClass = (code: number): string => {
  if (code >= 0xd800 && code <= 0xdbff) return "h";
  if (code >= 0xdc00 && code <= 0xdfff) return "l";
  if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) return " ";
  if (code >= 0x30 && code <= 0x39) return "d";
  if ((code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a) return "a";
  return code < 0x80 ? String.fromCharCode(code) : "u";
};

/**
 * The cut state at every prefix length of `doc`: the innermost two open containers with what each
 * expects next, the depth (capped), string, escape, comment and bare-token state, and the class of
 * the last character. These approximate keys select witnesses; matching keys do not establish
 * equivalent scanner states or cover omitted prefixes. This lexer only samples inputs, never
 * supplies expected results: every retained prefix still needs its whole differential comparison.
 */
const cutStates = (doc: string): string[] => {
  const stack: string[] = [];
  let quote = "";
  let esc = 0;
  let comment = "";
  let token = "";
  // What the current run of trivia already holds: a scanner rewinds a run to its start or to its
  // last closed comment, so `/*a*//` and `/` differ although the character before each cut matches.
  let closedComment = false;
  let space = false;
  const top = (): string => stack.at(-1) ?? "";
  const setTop = (s: string): void => {
    if (stack.length > 0) stack[stack.length - 1] = s;
  };
  // A finished value or key moves its container on: a key waits for `:`, a value for `,` or a closer.
  const finished = (): void => {
    const t = top();
    if (t === "{k") setTop("{K");
    else if (t === "{v") setTop("{c");
    else if (t === "[v") setTop("[c");
  };
  const states: string[] = [];
  const snap = (last: string): string =>
    `${Math.min(stack.length, 3)}${stack.slice(-2).join("")}|${quote}${esc}|${comment}|${token}|${closedComment ? "c" : ""}${space ? "w" : ""}|${last}`;
  states.push(snap(""));
  for (let i = 0; i < doc.length; i++) {
    const ch = doc.charAt(i);
    if (comment === "//") {
      if (ch === "\n") [comment, closedComment] = ["", true];
    } else if (comment === "/*") {
      if (ch === "*") comment = "/**";
    } else if (comment === "/**") {
      comment = ch === "/" ? "" : ch === "*" ? "/**" : "/*";
      if (comment === "") closedComment = true;
    } else if (quote.length > 0) {
      if (esc === 1) esc = ch === "u" ? 2 : 0;
      else if (esc >= 2) esc = esc < 5 && /[0-9a-f]/iu.test(ch) ? esc + 1 : 0;
      else if (ch === "\\") esc = 1;
      else if (ch === quote.charAt(0)) {
        quote = "";
        finished();
      }
    } else {
      if (comment === "/") comment = ch === "/" ? "//" : ch === "*" ? "/*" : "";
      if (comment === "" && charClass(ch.charCodeAt(0)) === " ") space = true;
      else if (comment === "" && ch !== "/") [closedComment, space] = [false, false];
      if (comment === "") {
        const numberish = /[0-9+\-.]/u.test(ch) || (token === "n" && /[\w.+-]/u.test(ch));
        if (numberish) token = "n";
        else if (/[A-Za-z_$]/u.test(ch)) token = token === "n" ? "n" : "w";
        else {
          if (token !== "") finished();
          token = "";
          if (ch === "{") stack.push("{k");
          else if (ch === "[") stack.push("[v");
          else if (ch === "}" || ch === "]") {
            stack.pop();
            finished();
          } else if (ch === ":") setTop("{v");
          else if (ch === ",") setTop(top().startsWith("{") ? "{k" : "[v");
          else if (ch === '"' || ch === "'") quote = `${ch}${top() === "{k" ? "k" : "v"}`;
          else if (ch === "/") comment = "/";
        }
      }
    }
    states.push(
      snap(quote === "" ? charClass(doc.charCodeAt(i)) : `s${charClass(doc.charCodeAt(i))}`),
    );
  }
  return states;
};

/** Documents built per seed; each also gets its prefixes and mutations, like a corpus document. */
const GENERATED_DOCS = 400;
/** Between any two tokens, so a comment can touch a literal, a number, a key or a closer. */
const TRIVIA = ["", "", " ", "\n", "/*c*/", "//c\n", " /*c*/ "];
const KEYS = [
  '"a"',
  '"b"',
  '""',
  '"é"',
  '"x\\"y"',
  '"\\/"',
  '"\\u005f_proto__"',
  '"__proto__"',
  '"\uDC00"',
];
const SCALARS = [
  '"s"',
  '"\\n"',
  '"\\ud83d"',
  '"it\'s"',
  '"//"',
  '"\\u00e9"',
  "0",
  "-0",
  "1.5",
  "1e400",
  "12345678901234567890",
  "true",
  "false",
  "null",
];

/**
 * A document written token by token from the alphabets the gate decides on. Corpus mutations change
 * one character at a time, so they cannot write two-character shapes such as a comment touching a
 * literal (`true//c`, which the scanner reads as one word) or an escape inside a key cut by the end.
 */
const generated = (random: () => number): string => {
  const pick = (from: readonly string[]): string => from[Math.floor(random() * from.length)] ?? "";
  const value = (depth: number): string => {
    if (depth > 3 || random() < 0.35) return pick(SCALARS);
    const object = random() < 0.5;
    const items = Array.from({ length: Math.floor(random() * 4) }, () => {
      const key = object ? `${pick(KEYS)}${pick(TRIVIA)}:${pick(TRIVIA)}` : "";
      return `${pick(TRIVIA)}${key}${value(depth + 1)}${pick(TRIVIA)}`;
    });
    const comma = items.length > 0 && random() < 0.15 ? "," : "";
    return object ? `{${items.join(",")}${comma}}` : `[${items.join(",")}${comma}]`;
  };
  return value(0);
};

/** The corpus texts, then the generated documents, each with the label a failure prints. */
const documents = (): { readonly text: string; readonly label: string }[] => {
  const random = mulberry32(BASE_SEED ^ 0x47454e);
  return [
    ...corpusTexts().map((text, d) => ({ text, label: `doc ${d}` })),
    ...Array.from({ length: GENERATED_DOCS }, (_, g) => ({
      text: generated(random),
      label: `generated ${g} (PRESCAN_SEED=${BASE_SEED})`,
    })),
  ];
};

/** The population: documents, boundary prefixes, character prefixes of short ones, and mutations. */
const population = (): Input[] => {
  const inputs: Input[] = [];
  const seen = new Set<string>();
  const add = (text: string, origin: string, kind: string): void => {
    if (seen.has(text)) return;
    seen.add(text);
    inputs.push({ text, origin, kind });
  };
  documents().forEach(({ text: doc, label }, d) => {
    add(doc, label, "document");
    const states = cutStates(doc);
    const fresh = new Set<string>();
    // Keep the first witness per approximate key; later prefixes are outside this sample.
    const freshAt = (i: number): boolean => {
      const state = states[i] as string;
      if (fresh.has(state)) return false;
      fresh.add(state);
      return true;
    };
    if (doc.length < SHORT) {
      for (let i = 0; i < doc.length; i++)
        if (freshAt(i)) add(doc.slice(0, i), `${label} prefix ${i}`, "character prefix");
    } else {
      // Each retained prefix rescans the whole source. Bound the long-document sample by boundary
      // characters and approximate keys; taking every prefix would grow quadratically.
      const taken = new Map<string, number>();
      for (let i = 0; i < doc.length; i++) {
        const ch = doc.charAt(i);
        if (!MUTATION_CHARS.includes(ch)) continue;
        const count = taken.get(ch) ?? 0;
        if (count >= PER_BOUNDARY) continue;
        taken.set(ch, count + 1);
        if (freshAt(i)) add(doc.slice(0, i), `${label} prefix ${i}`, "boundary prefix");
        if (freshAt(i + 1)) add(doc.slice(0, i + 1), `${label} prefix ${i + 1}`, "boundary prefix");
      }
    }
    const seed = (BASE_SEED ^ Math.imul(d + 1, 0x9e3779b1)) >>> 0;
    const random = mulberry32(seed);
    // Each mutation of a long document is a whole-document parse per profile; two still put a
    // corrupted middle into every document while keeping the test inside its budget.
    const mutations = doc.length > LONG ? Math.min(2, MUTATIONS_PER_DOC) : MUTATIONS_PER_DOC;
    for (let k = 0; k < mutations; k++) {
      const at = Math.floor(random() * (doc.length + 1));
      const op = Math.floor(random() * 3);
      const pick = Math.floor(random() * (MUTATION_CHARS.length + 4));
      const ch =
        pick < MUTATION_CHARS.length
          ? MUTATION_CHARS.charAt(pick)
          : String.fromCharCode(Math.floor(random() * 0x20));
      const mutated =
        op === 0
          ? doc.slice(0, at) + doc.slice(at + 1)
          : op === 1
            ? doc.slice(0, at) + doc.charAt(at) + doc.slice(at)
            : doc.slice(0, at) + ch + doc.slice(at);
      const origin = `${label} mutation ${k} (PRESCAN_SEED=${BASE_SEED}, doc seed ${seed}, op ${["delete", "duplicate", "insert"][op]} at ${at})`;
      add(mutated, origin, "mutation");
      // A mutated middle must also be seen cut off, where comments and hazards meet the cut.
      add(
        mutated.slice(0, Math.floor(random() * mutated.length)),
        `${origin} then cut`,
        "mutation",
      );
    }
  });
  return inputs;
};

/** Hand-picked shapes on the gate's hazard boundaries, beyond what mutations hit by chance. */
const HAZARDS: readonly string[] = [
  '{"__proto__":{"x":1},"a":1}',
  '{"\\u005f_proto__":{"x":1}}',
  '{"constructor":1}',
  '{"c\\u006fnstructor":1',
  '{"id":1,"b":2}',
  '{"a":1,"a":2}',
  '{"b":1,"a":2,"b":3}',
  '{"a":{"x":1},"a":{"y"',
  '{"__proto__":1,"__proto__":2}',
  "[12345678901234567890]",
  "[9007199254740993]",
  "[1e400, 1e-400]",
  "[0.1, 1.5e3, -0, 0]",
  "[1, 123456789012345678",
  "[1, 1e-400",
  "[[[[[1]]]]]",
  "[[[[[1",
  "12345",
  "-12",
  '"\\ud83d"',
  '["\\ud83d\\ude00", "\\ud83d',
  '["\\ud83d\\',
  '{"a":"\uD83D',
  '["a b"]',
  "```json\n[1]\n```",
  "```json\n[1]\n```\ntrailing prose",
  "````json\n[1]\n````",
  '  ```\n{"a":1}',
  "```json\n12\n```",
  "```json\r\n[1]\r\n```",
  "```json\n[1]\r\n```",
  "```json\r\n[1]\n```",
  "```json[1]```",
  "```json [1]\n```",
  "```json\n[1]```",
  '```json\n{"a":"x\n',
  '```json\n"abc',
  "text ```json\n[1]\n```",
  "[1, /* c */ 2]",
  "[1, // c\n 2]",
  "[1, // c\r\n 2]",
  "[1, // c\r 2]",
  "/* c */ [1]",
  "[1] /* c */",
  "[1, /* c */",
  "[1, /* c",
  '{"a":1, /* c */ }',
  '{"a" /* c */ : 1}',
  "[1,,2]",
  "[,]",
  "[1,]]",
  "{,}",
  '{"a":1}}',
  "﻿[1]",
  "[1] ",
  "[tru]",
  "[true",
  "[nul",
  "[1, -",
  "[1, 1.",
  "[1, 1e+",
  "[1, 0",
  "[1, -0",
  '{"a":',
  '{"a"',
  '{"a',
  "{",
  "[",
  '"',
  '"abc\\',
  '"abc\\u12',
];

// The seed is fixed at module load; readonly consumers can share generation and corpus reads.
let cachedPopulation: readonly Input[] | undefined;
export const differentialInputs = (): readonly Input[] =>
  (cachedPopulation ??= [
    ...population(),
    ...HAZARDS.map((text, h) => ({ text, origin: `hazard ${h}`, kind: "hazard" })),
  ]);

/**
 * A population cut into consecutive slices, one test case each, labelled by index range. A
 * differential case's time scales with its slice, and on a 2-vCPU CI runner shared with the other
 * runner and the rest of the gate a case runs up to ten times slower than alone, so a
 * whole-population case reaches its timeout. The slices together still compare every input.
 *
 * A slice closes at a text budget as well as a count, because cost follows text length and the
 * population's long documents sit together: by count alone, the first slice of whole inputs held
 * most of their text and ran several times longer than the rest.
 */
export const slices = <T extends { readonly text: string }>(
  items: readonly T[],
): { range: string; items: readonly T[] }[] => {
  const MAX_ITEMS = 2000;
  const MAX_UNITS = 200_000;
  const out: { range: string; items: readonly T[] }[] = [];
  let start = 0;
  let units = 0;
  const close = (end: number): void => {
    out.push({ range: `${start}-${end - 1}`, items: items.slice(start, end) });
    start = end;
    units = 0;
  };
  for (const [at, item] of items.entries()) {
    if (at > start && (at - start === MAX_ITEMS || units >= MAX_UNITS)) close(at);
    units += item.text.length;
  }
  if (items.length > start) close(items.length);
  return out;
};
