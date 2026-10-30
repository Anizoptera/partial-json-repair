// SPDX-License-Identifier: Apache-2.0

/**
 * Records the contract corpus from THIS package: the cases a Rust port must reproduce.
 *
 * `bun scripts/corpus/record.ts [--write] [--out <file>]`. Without either it reports what it would
 * produce, so the cost of a policy change here is visible before it is accepted. Importing it
 * records in memory: `verify.ts` and `check-async.ts` read the exported `contract`.
 *
 * **Every row names its options as RESOLVED VALUES, never a preset and never "the default".** The
 * presets are mostly empty objects — `LLM_BALANCED` is literally `{}` — so a row recorded under one
 * would carry no options at all and the port would fall through to ITS defaults, which is the
 * silent way two implementations agree on paper and differ in fact. Resolved values are ~700 bytes
 * each, so they live once in a profile table on the first line and every row names an index into
 * it: one indirection for the reader, against repeating the whole option space per row.
 *
 * **A variant is kept only when it OBSERVES something different.** Recording every option against
 * every input multiplies the corpus by the option space for rows that mostly repeat; recording none
 * leaves the port's policy table pinned by nothing. Difference is mechanically decidable, so the
 * corpus prunes itself and every surviving row earns its bytes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { RECOVERY_FLAG, resolveOptions } from "../../src/options";
import { COMPAT, LLM_BALANCED, LLM_FULL, STRICT } from "../../src/presets";
import { scan } from "../../src/scan-collect";
import { ANY, ANY_DEPTH } from "../../src/index";
import type { SwitchableRepair } from "../../src/types";

import type { Case } from "./observe";
import { observeCase, REQUIRED_COVERAGE, toHex } from "./observe";
import type { CorpusOptions } from "./profile";
import { featuresOf, resolvedProfile } from "./profile";
import { encodeWildcards } from "./selectors";

/** The input banks, in the order they are read; the contract is generated from these alone. */
const BANKS = ["corpus.jsonl", "seeds.jsonl"] as const;
const corpusFile = (name: string): URL => new URL(`../../corpus/${name}`, import.meta.url);

/**
 * Split every offset of a SHORT input: a resumption defect is position-dependent, and the ones this
 * package has actually had appeared only at particular offsets — a comment logged twice, a number
 * losing its digits to compaction. Longer inputs would multiply the corpus without reaching another
 * code path, since every interesting boundary is within a token of a short input's own.
 */
const SPLIT_MAX = 64;

/**
 * Recording asks for diagnostics and locations even though the shipped default does not.
 *
 * MEASURED, and it is why this is spelled out rather than left at the preset: with the presets as
 * written — `LLM_BALANCED` is `{}` — every row observed values only, and changing a confidence
 * penalty in `src/types.ts` moved NOTHING in the corpus. Repairs, errors, confidence and positions
 * are the package's other half, so a port could get all of them wrong and stay green. `#quiet` below
 * keeps the default path recorded too, which is also the only route that reaches `JSON.parse`.
 */
const reporting = (options: RecordOptions): RecordOptions => ({
  ...options,
  diagnostics: true,
  locations: true,
});

/**
 * Option sets tried beyond the baseline, each kept per input only where it changes the answer.
 *
 * The three presets move the RECOVERY policy — six coarse flags and `maxErrors` — and for a long
 * time they were the whole list, which left every profile fixing `maxDepth`, `maxScalar`,
 * `maxDiagnostics`, `exactNumbers`, `nullPrototype`, `customDangerousKeys` and two of the three
 * `onDangerousKey` dispositions. A corpus that never varies an option cannot tell a port that
 * honours it from one that ignores it, and the score stays green either way: measured, a probe over
 * exactly these axes put the Rust port at 4 of 12 on `parse`, including `repair` re-emitting a
 * dangerous key that `parse` had dropped. Four of these are the bounds `SECURITY.md` promises
 * consumers, so an unwatched axis here is an unwatched promise.
 *
 * Values are chosen to BIND on inputs the bank already holds rather than to be round: a variant that
 * changes nothing is pruned and pins nothing.
 */
const SELECTION_VARIANTS = [
  ["selectany", { select: [[ANY]] }],
  ["selectdeep", { select: [[ANY_DEPTH, "a"]] }],
  ["selectroot", { select: [[]] }],
  ["select-skip", { select: [["a", ANY]], skip: [["a", "b"]] }],
] as const satisfies readonly (readonly [string, CorpusOptions])[];

const STREAM_SELECTION_VARIANTS = [
  ...SELECTION_VARIANTS,
  ["object-only", { objectOnly: true }],
  ["required-id", { requiredKeys: ["id"] }],
  ["summary", { summary: true }],
  ["summary-buffer", { summary: true, maxBuffer: 8 }],
  ["summary-errors", { summary: true, maxErrors: 1 }],
  ["scalar", { maxScalar: 8 }],
  ["refused-key", { recover: { "unquoted-key": false } }],
  // The hold at a pending line break is stream behaviour, so the opt-in needs chunked rows too.
  ["guessed-string-end", { recover: { "guessed-string-end": true } }],
  ["fragments", { select: [[ANY_DEPTH, "a"]], fragments: true }],
  ["retained", { maxBuffer: 1024, maxRetained: 8 }],
  ["summary-selectdeep", { select: [[ANY_DEPTH, "a"]], summary: true }],
  ["summary-fragments", { select: [[ANY_DEPTH, "a"]], fragments: true, summary: true }],
  ["view", { view: "owned" }],
  ["view-selectdeep", { select: [[ANY_DEPTH, "a"]], view: "owned" }],
  // The suffix is grafted onto each snapshot copy, a path no whole-input variant reaches.
  ["view-suffix", { view: "owned", cutSuffix: true }],
  // Delivered fragments release content; a held decoder tail must still obey the storage bound.
  ["fragments-retained", { select: [[ANY_DEPTH, "a"]], fragments: true, maxRetained: 8 }],
] as const satisfies readonly (readonly [string, CorpusOptions])[];

const VARIANTS: readonly (readonly [string, CorpusOptions])[] = [
  ["full", LLM_FULL],
  ["strict", STRICT],
  ["compat", COMPAT],
  // Off by default and in every preset, so only this profile records the opt-in reading.
  ["guessed-string-end", { recover: { "guessed-string-end": true } }],
  ["depth", { maxDepth: 3 }],
  ["scalar", { maxScalar: 8 }],
  ["diagcap", { maxDiagnostics: 1 }],
  ["exact", { exactNumbers: true }],
  ["suffix", { cutSuffix: true }],
  ["nullproto", { nullPrototype: true }],
  ["reject", { onDangerousKey: "reject" }],
  // `a` rather than an invented key: it is the commonest key in the bank, so the exact-match path
  // is exercised without a seed written only to feed this row.
  ["customkey", { customDangerousKeys: ["a"], onDangerousKey: "drop" }],
  ["object-only", { objectOnly: true }],
  ["required-id", { requiredKeys: ["id"] }],
  // Keep the selection table whole so every new combination reaches fixed and streaming inputs.
  ...SELECTION_VARIANTS,
  // Key policy governs members a selection does not build: a port that applies it only to built
  // objects returns `ok` here where the whole candidate is refused.
  [
    "selectrefuse",
    { select: [[ANY]], onDangerousKey: "reject", recover: { "duplicate-key": false } },
  ],
  ["skip", { skip: [["a"]] }],
  ["strictskip", { ...STRICT, skip: [["a"]] }],
];

type Row = Omit<Case, "options"> & {
  readonly p: number;
  readonly observed: Record<string, string>;
};

type RecordOptions = CorpusOptions;

const profiles: string[] = [];
// Rows reuse a few dozen option sets, and resolving one per row was a fifth of recording time.
// One shared object per set also lets `observe.ts` cache its coverage by identity.
const profileCache = new Map<string, { index: number; options: RecordOptions }>();
const profileOf = (options: RecordOptions): { index: number; options: RecordOptions } => {
  const key = JSON.stringify(options, encodeWildcards);
  const cached = profileCache.get(key);
  if (cached !== undefined) return cached;
  const { fragments, summary, view } = options;
  const fields = resolvedProfile(options);
  const stream = {
    ...(fragments === undefined ? {} : { fragments }),
    ...(summary === undefined ? {} : { summary }),
    ...(view === undefined ? {} : { view }),
  };
  const text = JSON.stringify({ ...fields, ...stream }, encodeWildcards);
  let index = profiles.indexOf(text);
  if (index === -1) index = profiles.push(text) - 1;
  const profile = { index, options: { ...fields, ...stream } };
  profileCache.set(key, profile);
  return profile;
};

/** Preserve raw bytes: decoding a malformed seed before recording erases the defect it tests. */
type Input =
  | { readonly id: string; readonly text: string; readonly stringifyBounds?: boolean }
  | { readonly id: string; readonly bytes: string }
  | {
      readonly id: string;
      readonly chunks: readonly (string | { readonly bytes: string })[];
    };

type ChunkInput = string | { readonly bytes: string };

const chunkFrom = (chunk: unknown): ChunkInput | undefined => {
  if (typeof chunk === "string") return chunk;
  if (
    typeof chunk !== "object" ||
    chunk === null ||
    Object.keys(chunk).length !== 1 ||
    !("bytes" in chunk)
  )
    return undefined;
  const bytes = chunk.bytes;
  return typeof bytes === "string" && /^(?:[0-9a-f]{2})*$/u.test(bytes) ? { bytes } : undefined;
};

// Unconsumed option overrides and output snapshots would silently describe a different case.
const BANK_FIELDS = new Set([
  "id",
  "why",
  "source",
  "license",
  "text",
  "chunks",
  "bytes",
  "stringifyBounds",
]);

/**
 * Ids are `<file initial><line number>`, so adding an input renumbers nothing else. A running
 * counter would shift every later id and turn a one-row change into a whole-file diff, which is the
 * difference between a reviewable re-recording and an unreadable one.
 */
const inputsFrom = (name: string): Input[] =>
  readFileSync(corpusFile(name), "utf8")
    .split("\n")
    .flatMap((line, at): Input[] => {
      if (line === "") return [];
      const id = `${name[0] ?? "?"}${at + 1}`;
      const record: unknown = JSON.parse(line);
      if (record === null || typeof record !== "object" || Array.isArray(record))
        throw new TypeError(`${name}:${at + 1}: expected an input record.`);
      const unsupported = Object.keys(record).find((key) => !BANK_FIELDS.has(key));
      if (unsupported !== undefined)
        throw new Error(
          `${name}:${at + 1}: unsupported field ${unsupported}. Input banks hold source inputs, provenance and reasons; configure option variants in scripts/corpus/record.ts, not ignored metadata.`,
        );
      const r = record as {
        text?: unknown;
        chunks?: unknown;
        bytes?: unknown;
        stringifyBounds?: unknown;
      };
      if (r.bytes !== undefined) {
        if (typeof r.bytes !== "string" || !/^(?:[0-9a-f]{2})*$/u.test(r.bytes)) {
          throw new Error(`${name}:${at + 1}: bytes must be lowercase hexadecimal pairs.`);
        }
        return [{ id, bytes: r.bytes }];
      }
      if (Array.isArray(r.chunks)) {
        const chunks = r.chunks.map((chunk: unknown) => chunkFrom(chunk));
        if (!chunks.every((chunk): chunk is ChunkInput => chunk !== undefined)) {
          throw new Error(
            `${name}:${at + 1}: chunks must contain text or lowercase hexadecimal byte pairs.`,
          );
        }
        return [{ id, chunks }];
      }
      if (typeof r.text === "string") {
        return [{ id, text: r.text, ...(r.stringifyBounds === true && { stringifyBounds: true }) }];
      }
      throw new Error(`${name}:${at + 1}: expected text, bytes or chunks; input was not recorded.`);
    });

/**
 * The kinds an input actually triggers, so a switch is recorded only where it can bind. Resolved
 * without `profileOf`: no row replays the probe, so registering it would put an unused profile in
 * the header.
 */
const probe = resolvedProfile({ ...LLM_FULL, diagnostics: true, builtinParsers: false });
const probeResolved = resolveOptions(featuresOf(probe));
const kindsIn = (text: string): SwitchableRepair[] => {
  const resolved = probeResolved;
  const seen = new Set<string>();
  for (const repair of scan(text, resolved).repairs) seen.add(repair.kind);
  return [...seen].filter((k): k is SwitchableRepair => k in RECOVERY_FLAG).toSorted();
};

const rows: Row[] = [];
const kept = new Set<string>();
const witnesses: Record<string, { readonly id: string; readonly surface: string }> = {};

/**
 * Keeps a case only when its observation is new for this input. Deduplicating on the OBSERVATION
 * rather than the options is what prunes the option space: a preset that changes nothing for these
 * bytes would otherwise cost a row that can never fail differently from the baseline.
 */
const add = (id: string, input: Omit<Case, "id" | "options">, options: RecordOptions): void => {
  const profile = profileOf(options);
  const { observed, covers } = observeCase({ ...input, id, options: profile.options });
  const fingerprint = `${id.split("#")[0] ?? id}\0${Object.values(observed).join("\0")}`;
  if (kept.has(fingerprint)) return;
  kept.add(fingerprint);
  rows.push({ ...input, id, p: profile.index, observed });
  for (const [requirement, surface] of Object.entries(covers)) {
    witnesses[requirement] ??= { id, surface };
  }
};

// Validate every bank before observing any case; otherwise a late malformed seed wastes the run.
for (const bank of BANKS.map((file) => inputsFrom(file))) {
  for (const input of bank) {
    const id = input.id;
    if ("bytes" in input) {
      const raw = { bytes: input.bytes };
      add(id, raw, reporting(LLM_BALANCED));
      add(`${id}#quiet`, raw, LLM_BALANCED);
      for (const [name, options] of VARIANTS) add(`${id}#${name}`, raw, reporting(options));
      // Consecutive malformed sequences must stop at the sequence spending the budget, not at
      // token completion. Different limits expose which partial data has actually completed.
      for (const maxErrors of [1, 2, 3]) {
        add(`${id}#errors${maxErrors}`, raw, reporting({ maxErrors }));
      }
      // Probe every switch on raw bytes; text scanning cannot observe decoder repairs.
      for (const kind of Object.keys(RECOVERY_FLAG)) {
        add(`${id}#no-${kind}`, raw, reporting({ ...LLM_FULL, recover: { [kind]: false } }));
      }
      continue;
    }
    if ("chunks" in input) {
      add(`${id}#chunks`, { chunks: input.chunks }, reporting(LLM_BALANCED));
      add(`${id}#chunks-quiet`, { chunks: input.chunks }, LLM_BALANCED);
      for (const [name, options] of STREAM_SELECTION_VARIANTS) {
        add(`${id}#chunks-${name}`, { chunks: input.chunks }, reporting(options));
      }
      add(
        `${id}#chunks-occurrences`,
        { chunks: input.chunks },
        {
          select: [[ANY_DEPTH, "a"]],
          occurrences: true,
        },
      );
      continue;
    }
    const text = input.text;
    if (input.stringifyBounds === true) {
      add(id, { text, stringifyBounds: true }, reporting(LLM_BALANCED));
      continue;
    }
    add(id, { text }, reporting(LLM_BALANCED));
    // The default path, where diagnostics cost nothing and built-in parsers may reach `JSON.parse`.
    // Nothing else in the corpus records that route, and it is the one most callers take.
    add(`${id}#quiet`, { text }, LLM_BALANCED);
    for (const [name, options] of VARIANTS) add(`${id}#${name}`, { text }, reporting(options));
    // One row per kind this input triggers, with that kind refused. The port's policy table is
    // otherwise pinned by nothing, and a kind the input cannot reach would only repeat the baseline.
    for (const kind of kindsIn(text)) {
      add(`${id}#no-${kind}`, { text }, reporting({ ...LLM_FULL, recover: { [kind]: false } }));
    }
    // Byte input for the same content. MEASURED: nearly every one survives deduplication, because
    // positions come back in the input's own unit, so `span` reports `byte` where the text row
    // reports `utf16` — a ruled difference, not a divergence. Kept rather than pruned because the
    // cost lands in the PACK, not the working tree: the file gzips ~34x, so the near-duplicates
    // cost kilobytes while each still pins its own offsets, and offsets are what a port gets wrong.
    add(`${id}#bytes`, { bytes: toHex(new TextEncoder().encode(text)) }, reporting(LLM_BALANCED));
    if (text.length <= SPLIT_MAX) {
      for (let cut = 1; cut < text.length; cut++) {
        add(
          `${id}#cut${cut}`,
          { chunks: [text.slice(0, cut), text.slice(cut)] },
          reporting(LLM_BALANCED),
        );
      }
    }
  }
}

const missing = REQUIRED_COVERAGE.filter((requirement) => witnesses[requirement] === undefined);
if (missing.length > 0) {
  throw new Error(`contract coverage missing:\n${missing.map((name) => `- ${name}`).join("\n")}`);
}
const header = JSON.stringify({
  profiles: profiles.map((p) => JSON.parse(p) as unknown),
  coverage: { required: REQUIRED_COVERAGE, witnesses },
});
/** The whole contract, recorded from the code this process imported. */
export const contract = `${[header, ...rows.map((r) => JSON.stringify(r))].join("\n")}\n`;

/**
 * Git keeps only this hash of the accepted contract. The contract is ~47 MB of generated JSON and
 * every behaviour change rewrote most of it, so committing it bloated history while its diff was
 * unreadable; the inputs it is generated from (`BANKS`) and this hash pin the same behaviour.
 */
export const CONTRACT_HASH = corpusFile("contract.sha256");
export const contractHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

if (import.meta.main) {
  // `--write` accepts the current behaviour; `--out <file>` emits the full contract for a port or
  // a reviewer, outside Git.
  const outAt = process.argv.indexOf("--out");
  const outFile = outAt === -1 ? undefined : process.argv[outAt + 1];
  if (outAt !== -1 && outFile === undefined) throw new Error("--out needs a file path");
  if (outFile !== undefined) writeFileSync(outFile, contract);
  const write = process.argv.includes("--write");
  if (write) writeFileSync(CONTRACT_HASH, `${contractHash(contract)}\n`);
  console.log(
    `${rows.length} rows, ${profiles.length} profiles, ${(contract.length / 1024 / 1024).toFixed(2)} MB` +
      (write ? "; accepted into corpus/contract.sha256" : "") +
      (outFile === undefined ? "" : `; written to ${outFile}`) +
      (write || outFile !== undefined ? "" : " (dry run; --write accepts, --out <file> emits)"),
  );
}
