// SPDX-License-Identifier: Apache-2.0

/**
 * Every rival adapter that runs on any JavaScript host: pure-JS libraries, `JSON.parse` and this
 * package. Host-neutral (no `node:` import, no file read, no native addon) so a browser page or a
 * workerd isolate measures the same adapters `compare.ts` does; host-only subjects (`simdjson`,
 * Bun's built-ins) and installed versions are added there.
 */
import bestEffort from "best-effort-json-parser";
import { loads as jsonRepairJsLoads } from "json-repair-js";
import { jsonrepair } from "jsonrepair";
import { ALL, parse as partialParse } from "partial-json";
import { repairJson } from "repair-json-stream";
import untruncateImport from "untruncate-json";
import JSON5 from "json5";
import { parse as jsoncParse } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import jsonBigint from "json-bigint";
import secureParse from "secure-json-parse";

// The BUILT artefact, not `src/`: it is what a consumer installs, and Node resolves it without the
// extensionless-import handling that only Bun has — which is why the Node column of the tables
// silently never ran until it was measured rather than assumed. Run `bun run build` first.
import { LLM_FULL, parse as ours, parseMany as oursMany, STRICT } from "../../dist/index.js";
import { ours0 } from "./speed-docs.ts";

/**
 * One adapter per library. `strict` is the same library under whatever configuration makes it
 * refuse invalid JSON. Every library with such a configuration has the adapter, so an empty column
 * is a finding rather than a gap in the harness.
 */
export type Lib = {
  name: string;
  parse: (text: string) => unknown;
  /**
   * The library at its MOST permissive, for the capability table — comparing our default against a
   * rival's maximum would measure our defaults rather than what each library can do. Absent where
   * the library has one behaviour, which is most of them.
   */
  permissive?: (text: string) => unknown;
  /**
   * Every value in the text, for the JSONL column. Absent where the library has no multi-value API,
   * which is every one of them but this package — and the empty cells are the finding.
   */
  many?: (text: string) => unknown;
  /** Refuses invalid JSON, for the JSONTestSuite rows. `undefined` where the library cannot. */
  strict?: (text: string) => unknown;
};

// The package ships CommonJS under `main` and ESM under `module`. Bun and bundlers take the ESM
// build, whose default import is the function; Node and Deno take the CommonJS build, whose default
// import is the `exports` object holding it as `default`, and calling that object throws on every
// input, which would blank the library's cells on those runtimes.
const untruncate: (json: string) => string =
  (untruncateImport as unknown as { default?: (json: string) => string }).default ??
  untruncateImport;

// Its recovery path writes to the console; left on, every measurement below would include the cost
// of formatting and printing a message, which is not what any caller uses it for.
(bestEffort as { disableErrorLogging?: () => void }).disableErrorLogging?.();

export const PORTABLE_LIBS: readonly Lib[] = [
  {
    name: "partial-json-repair",
    parse: ours0,
    // `parseMany` yields per-value OUTCOMES, not values; unwrap them as `ours0` does for `parse`.
    // Comparing outcomes against the reference makes every element differ and blanks the cell —
    // which in this table means "wrong answer", not "wrong adapter".
    many: (text) =>
      [...oursMany(text)].map((r) => {
        if (!r.ok) throw new Error(r.failure.kind);
        return r.value;
      }),
    permissive: (text) => {
      const r = ours(text, LLM_FULL);
      if (!r.ok) throw new Error(r.failure.kind);
      return r.value;
    },
    strict: (text) => {
      const r = ours(text, STRICT);
      // `STRICT` is every leniency off and `maxErrors: 1`, and a refusal is a failure, not a success
      // with a note — so `ok` alone is the verdict.
      if (!r.ok) throw new Error("strict");
      return r.value;
    },
  },
  {
    name: "JSON.parse",
    parse: (t) => JSON.parse(t),
    strict: (t) => JSON.parse(t),
  },
  {
    name: "jsonrepair",
    parse: (t) => JSON.parse(jsonrepair(t)),
  },
  {
    name: "partial-json",
    // `ALL` is its most permissive mask: anything less would measure a configuration nobody parsing
    // LLM output would choose.
    parse: (t) => partialParse(t, ALL),
    // A mask of 0 allows no partial value and no non-JSON number, its closest to plain JSON.
    strict: (t) => partialParse(t, 0),
  },
  {
    name: "best-effort-json-parser",
    parse: (t) => (bestEffort as { parse: (s: string) => unknown }).parse(t),
  },
  {
    name: "json-repair-js",
    parse: (t) => jsonRepairJsLoads(t),
  },
  {
    name: "untruncate-json",
    parse: (t) => JSON.parse(untruncate(t)),
  },
  {
    name: "repair-json-stream",
    // Repairs text like `jsonrepair`, so it is scored the same way: repair, then `JSON.parse`.
    parse: (t) => JSON.parse(repairJson(t)) as unknown,
  },
  /*
   * CANONICAL AND NATIVE PARSERS, not repair libraries.
   *
   * Most JSON a consumer feeds this library is not damaged. For the bulk of their traffic the real
   * alternative is not another repair library, it is the parser already in their runtime — so a
   * comparison against repair libraries alone measures the minority case and calls it the result.
   * Measured once it was added: on Bun a built-in reads merely non-standard input ~10x faster than
   * this package does.
   *
   * They are in the SAME tables rather than a set of their own because the trade is the whole point:
   * every capability row below is ✗ for them, and the speed rows are where that is paid for.
   */
  {
    name: "json5",
    parse: (t) => JSON5.parse(t),
  },
  {
    name: "jsonc-parser",
    // Default options already allow comments and trailing commas, which is the dialect.
    parse: (t) => jsoncParse(t) as unknown,
    // It never throws; it collects errors. Every leniency off, and any collected error refuses.
    strict: (t) => {
      const errors: ParseError[] = [];
      const value = jsoncParse(t, errors, {
        disallowComments: true,
        allowTrailingComma: false,
        allowEmptyContent: false,
      }) as unknown;
      if (errors.length > 0) throw new Error("strict");
      return value;
    },
  },
  {
    name: "secure-json-parse",
    // The usual answer to prototype pollution in JS, so it is the rival for `onDangerousKey`.
    parse: (t) => secureParse(t),
  },
  {
    name: "json-bigint",
    // The usual answer to integers `JSON.parse` rounds, so it is the rival for the fidelity check
    // that makes our fast path decline.
    parse: (t) => jsonBigint.parse(t),
  },
];
