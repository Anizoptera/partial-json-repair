// SPDX-License-Identifier: Apache-2.0

/**
 * The single definition of what a contract record OBSERVES, shared by the recorder and every
 * verifier — this package's own, and the Rust port's.
 *
 * Two hand-maintained copies drift, and a comparison cannot tell drift from a real behaviour
 * difference: a field one copy stopped observing reads as a mismatch on every record, which looks
 * like a broken implementation rather than a broken harness. One function with two callers makes
 * that unrepresentable.
 *
 * **Each surface is recorded as `canonical()` of its WHOLE result, never as a list of fields.**
 * Listing fields is what lets a corpus go quietly blind: the old one enumerated them, so a field
 * added later — `refused` on an error, say — was observed by nobody until someone remembered. The
 * canonical form already spells everything a result can hold that JSON cannot (`ExactNumber`,
 * `undefined`, `NaN`, `-0`, a null prototype), so passing the result whole costs nothing and cannot
 * fall behind the type.
 *
 * What is deliberately NOT observed: English prose. Messages are wording a reimplementation cannot
 * be expected to reproduce, which is why errors are pinned by kind, path and position instead. The
 * `context` slice is recorded because it is a substring of the source, not prose about it.
 */
import type { ParserOptions } from "../../src/options";
import {
  createStreamParser,
  findJsonSpan,
  parse,
  parseMany,
  repair,
  stringify,
} from "../../src/index";
import type { Input } from "../../src/types";
import { REPAIR_PENALTY } from "../../src/types";

import { canonical } from "./canonical";
import type { CorpusOptions } from "./profile";
import { CORPUS_OPTION_NAMES, featuresOf, resolvedProfile } from "./profile";

/**
 * Everything that DEFINES a case, and nothing any parser produced. Exactly one input form is
 * present: `text` for a string, `bytes` as lowercase hex, or `chunks` for a stream.
 *
 * Hex rather than base64 for bytes: it is unambiguous, needs no library on either side, and a
 * reader can see the byte that broke a record without decoding it.
 */
export type Case = {
  readonly id: string;
  readonly text?: string;
  readonly bytes?: string;
  readonly chunks?: readonly (string | { readonly bytes: string })[];
  readonly stringifyBounds?: boolean;
  readonly options?: CorpusOptions;
};

export type Observation = {
  readonly observed: Record<string, string>;
  readonly covers: Readonly<Record<string, string>>;
};

const SHARED_SURFACES = [
  "parse",
  "repair",
  "findJsonSpan",
  "parseMany",
  "stringify",
  "createStreamParser",
  "feed",
  "end",
] as const;
const REPRESENTATIONS = ["text", "bytes", "chunks"] as const;
const CHUNK_REPRESENTATIONS = ["text", "bytes", "mixed"] as const;
const DELIVERY = ["values", "fragments", "views"] as const;
const STREAM_OPTIONS = ["fragments", "summary", "view"] as const;
const SHARED_OPTIONS = CORPUS_OPTION_NAMES.filter((name) => name !== "builtinParsers");
const LIMITS = [
  "buffer",
  "depth",
  "errors",
  "scalar",
  "retained",
  "diagnostics",
  "output",
] as const;
const VERB_BY_SURFACE: Readonly<Record<string, string>> = Object.freeze({
  parse: "parse",
  repair: "repair",
  span: "findJsonSpan",
  many: "parseMany",
  stringify: "stringify",
});

/** The contract dimensions that cannot be derived from values returned by the parser. */
export const REQUIRED_COVERAGE = Object.freeze(
  [
    ...SHARED_SURFACES.map((name) => `verb:${name}`),
    ...REPRESENTATIONS.map((name) => `representation:${name}`),
    ...CHUNK_REPRESENTATIONS.map((name) => `chunks:${name}`),
    ...DELIVERY.map((name) => `delivery:${name}`),
    ...SHARED_OPTIONS.map((name) => `option:${name}`),
    ...STREAM_OPTIONS.map((name) => `option:${name}`),
    ...LIMITS.map((name) => `limit:${name}`),
    "terminal:end",
    ...Object.keys(REPAIR_PENALTY).map((name) => `repair:${name}`),
  ].toSorted(),
);

const defaultOptions = resolvedProfile({});

// Which options differ from the defaults depends on the options alone; `record.ts` passes one
// object per option set, so the canonical comparisons run once per set rather than once per row.
const differing = new WeakMap<CorpusOptions, readonly string[]>();
const optionCoverage = (options: CorpusOptions, surface: string): Record<string, string> => {
  let names = differing.get(options);
  if (names === undefined) {
    names = [
      ...SHARED_OPTIONS.filter((n) => canonical(options[n]) !== canonical(defaultOptions[n])),
      ...STREAM_OPTIONS.filter((n) => options[n] !== undefined),
    ].map((n) => `option:${n}`);
    differing.set(options, names);
  }
  const covers: Record<string, string> = {};
  for (const name of names) covers[name] = surface;
  return covers;
};

const resultCoverage = (surface: string, value: unknown): Record<string, string> => {
  const verb = VERB_BY_SURFACE[surface];
  const covers: Record<string, string> = verb === undefined ? {} : { [`verb:${verb}`]: surface };
  const coverRepair = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const kind = (node as Record<string, unknown>)["kind"];
    if (typeof kind === "string" && Object.hasOwn(REPAIR_PENALTY, kind)) {
      covers[`repair:${kind}`] = surface;
    }
  };
  const coverError = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const refused = (node as Record<string, unknown>)["refused"];
    if (typeof refused === "string" && Object.hasOwn(REPAIR_PENALTY, refused)) {
      covers[`repair:${refused}`] = surface;
    }
  };
  const coverFailure = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const failure = node as Record<string, unknown>;
    if (failure["kind"] === "limit-reached" && typeof failure["resource"] === "string") {
      covers[`limit:${failure["resource"]}`] = surface;
    }
    if (failure["kind"] === "policy-refused") coverError(failure["issue"]);
  };
  const coverDiagnostics = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const diagnostics = node as Record<string, unknown>;
    if (diagnostics["entriesComplete"] === false) covers["limit:diagnostics"] = surface;
    if (Array.isArray(diagnostics["repairs"])) {
      for (const repairEntry of diagnostics["repairs"]) coverRepair(repairEntry);
    }
    if (Array.isArray(diagnostics["errors"])) {
      for (const error of diagnostics["errors"]) coverError(error);
    }
  };
  const visitOutcomes = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visitOutcomes(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record["ok"] === false) coverFailure(record["failure"]);
    coverDiagnostics(record["diagnostics"]);
  };
  visitOutcomes(value);
  return covers;
};

const observation = (
  raw: Record<string, unknown>,
  structural: Readonly<Record<string, string>>,
  options: CorpusOptions,
): Observation => ({
  observed: Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, canonical(value)]),
  ),
  covers: Object.assign(
    {},
    structural,
    optionCoverage(options, structural["representation:chunks"] ?? "parse"),
    ...Object.entries(raw).map(([name, value]) => resultCoverage(name, value)),
  ) as Record<string, string>,
});

const bytesOf = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Return a whole input exactly as a recorded case supplies it; chunked cases have no whole input. */
export const wholeInputOf = (c: Case): Input | undefined =>
  c.chunks === undefined ? (c.bytes === undefined ? (c.text ?? "") : bytesOf(c.bytes)) : undefined;

export const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const chunkOf = (chunk: string | { readonly bytes: string }): string | Uint8Array =>
  typeof chunk === "string" ? chunk : bytesOf(chunk.bytes);

const chunkCoverage = (
  chunks: readonly (string | { readonly bytes: string })[],
  surface: string,
): Record<string, string> => {
  const text = chunks.some((chunk) => typeof chunk === "string");
  const bytes = chunks.some((chunk) => typeof chunk !== "string");
  return {
    ...(text && { "chunks:text": surface }),
    ...(bytes && { "chunks:bytes": surface }),
    ...(text && bytes && { "chunks:mixed": surface }),
  };
};

// Batch sizing is internal; reports, positions and terminal items remain public evidence.
// Merge data only when every field except its text agrees, so normalization cannot erase a change.
const fragmentContract = (items: readonly unknown[]): unknown[] => {
  const out: unknown[] = [];
  for (const item of items) {
    if (
      typeof item === "object" &&
      item !== null &&
      "ok" in item &&
      item.ok === true &&
      "value" in item
    ) {
      const value = item.value as { kind?: unknown; id?: unknown; text?: unknown };
      const previous = out.at(-1) as
        | { ok?: unknown; value?: { kind?: unknown; id?: unknown; text?: unknown } }
        | undefined;
      if (
        value.kind === "data" &&
        typeof value.text === "string" &&
        previous?.ok === true &&
        previous.value?.kind === "data" &&
        previous.value.id === value.id &&
        typeof previous.value.text === "string" &&
        canonical({ ...item, value: { ...value, text: "" } }) ===
          canonical({ ...previous, value: { ...previous.value, text: "" } })
      ) {
        previous.value.text += value.text;
      } else {
        out.push({ ...item, value: { ...value } });
      }
      continue;
    }
    out.push(item);
  }
  return out;
};

/**
 * What the case is worth comparing on. A whole-input case exercises the four one-shot verbs; a
 * chunked case exercises the stream, where WHICH chunk completes a value is the thing a resumable
 * scanner most easily gets wrong and a total at the end would hide.
 */
export function observeCase(c: Case): Observation {
  const options = c.options ?? {};
  const packageOptions = featuresOf(options);

  if (c.chunks !== undefined) {
    // Invalid options throw before any input is read, so they are a defective case, never an
    // observation: recording a refusal both sides agree on would measure nothing.
    const parser = createStreamParser(packageOptions);
    // Per chunk, not summed: `feed` returns the values THAT chunk completed, so a total would let a
    // port deliver everything at the end and still conform.
    if (options.fragments === true) {
      const chunks = c.chunks.map((chunk) => [...parser.feed(chunkOf(chunk))]);
      // Data sizing may differ; occurrence boundaries and failures must leave with their chunk.
      const boundaries = chunks.map((items) =>
        items.filter(
          (item) =>
            !(
              "ok" in item &&
              item.ok &&
              typeof item.value === "object" &&
              item.value !== null &&
              "kind" in item.value &&
              item.value.kind === "data"
            ),
        ),
      );
      return observation(
        {
          fed: fragmentContract(chunks.flat()),
          boundaries,
          ended: fragmentContract([...parser.end()]),
        },
        {
          "verb:createStreamParser": "fed",
          "verb:feed": "fed",
          "verb:end": "ended",
          "representation:chunks": "fed",
          "delivery:fragments": "fed",
          "terminal:end": "ended",
          ...chunkCoverage(c.chunks, "fed"),
        },
        options,
      );
    }
    if (options.view !== undefined) {
      const fed: unknown[] = [];
      const views: unknown[] = [];
      for (const chunk of c.chunks) {
        fed.push([...parser.feed(chunkOf(chunk))]);
        views.push(parser.snapshot?.());
      }
      const ended = [...parser.end()];
      views.push(parser.snapshot?.());
      return observation(
        { fed, ended, views },
        {
          "verb:createStreamParser": "fed",
          "verb:feed": "fed",
          "verb:end": "ended",
          "representation:chunks": "fed",
          "delivery:views": "views",
          "terminal:end": "ended",
          ...chunkCoverage(c.chunks, "fed"),
        },
        options,
      );
    }
    return observation(
      { fed: c.chunks.map((chunk) => [...parser.feed(chunkOf(chunk))]), ended: [...parser.end()] },
      {
        "verb:createStreamParser": "fed",
        "verb:feed": "fed",
        "verb:end": "ended",
        "representation:chunks": "fed",
        "delivery:values": "fed",
        "terminal:end": "ended",
        ...chunkCoverage(c.chunks, "fed"),
      },
      options,
    );
  }

  const input = wholeInputOf(c);
  if (input === undefined) throw new Error(`${c.id}: whole-input observation received chunks`);
  // Whole-input verbs take parse options only; a stream key here is a defective case, which
  // validation throws on. Typed as such, so the call states the contract it relies on.
  const wholeOptions = packageOptions as ParserOptions;
  const parsed = parse(input, wholeOptions);
  const raw: Record<string, unknown> = {
    parse: parsed,
    // `repair` is not derivable from `parse`: it splices the source through an edit log that is kept
    // in parallel with the repairs, never regenerated from them, so a port can get one right and the
    // other wrong.
    repair: repair(input, wholeOptions),
    span: findJsonSpan(input, wholeOptions),
    // Lazily produced, so it is drained here: an unread iterator observes nothing.
    many: [...parseMany(input, wholeOptions)],
  };
  if (parsed.ok && options.select === undefined) raw.stringify = stringify(parsed.value);
  if (parsed.ok && c.stringifyBounds === true) {
    const encoded = stringify(parsed.value);
    if (encoded.ok) {
      const size = encoded.value.length;
      // `maxOutput` must be a positive integer, so a one-character encoding has no "below" bound.
      if (size > 1) raw.stringifyBelow = stringify(parsed.value, { maxOutput: size - 1 });
      raw.stringifyAt = stringify(parsed.value, { maxOutput: size });
      raw.stringifyAbove = stringify(parsed.value, { maxOutput: size + 1 });
    }
  }
  return observation(
    raw,
    {
      [c.bytes === undefined ? "representation:text" : "representation:bytes"]: "parse",
      "delivery:values": "parse",
    },
    options,
  );
}

/** Canonical results retained for callers that compare observations without coverage metadata. */
export const observe = (c: Case): Record<string, string> => observeCase(c).observed;
