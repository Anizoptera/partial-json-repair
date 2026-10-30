// SPDX-License-Identifier: Apache-2.0

/**
 * How a selector wildcard crosses the wire, for every reader of the recorded contract.
 *
 * `ANY` and `ANY_DEPTH` are SYMBOLS in the public API on purpose: a document whose key is literally
 * `*` then needs no escaping, and no string sentinel can ever collide with a real key. That property
 * is exactly what breaks a recorded profile. `JSON.stringify` turns a symbol in an array into
 * `null` — MEASURED: `{select: [["items", ANY, "name"]]}` records as `[["items",null,"name"]]`, and
 * `null` is not a valid segment, so replaying that profile is refused as `invalid-options` on BOTH sides.
 * They agree perfectly, on a refusal nobody meant to record: a green corpus measuring nothing, which
 * is the one failure the recorder exists to prevent.
 *
 * A segment is otherwise a string key or a non-negative integer index, so an OBJECT is unambiguous
 * and needs no escaping either — the same argument that made the API use symbols. It is spelled with
 * a name rather than a spare JSON scalar: `null` is what the bug produced and reads as "absent",
 * `true` reads as nothing at all, and this file is a generated artefact two languages and several
 * years have to agree about. The bytes cost nothing — the profile table holds each option set ONCE.
 *
 * The codec is a `JSON.stringify` replacer and a `JSON.parse` reviver, so neither side owns a walker
 * over the option shape: adding an option that carries selectors needs no edit here. **A third
 * reader lives in `rust/crates/conformance`** and must spell the same table; there is no way to
 * share one across the languages, which is why the table is two lines long.
 */
import { ANY, ANY_DEPTH } from "../../src/index";

/** The wire name of each wildcard. Hyphenated like every other kind name in this package. */
const WIRE = new Map<symbol, string>([
  [ANY, "any"],
  [ANY_DEPTH, "any-depth"],
]);

/**
 * `JSON.stringify` replacer. Runs before the symbol would be dropped, so nesting depth and which
 * option carries the path are both none of its business.
 */
export const encodeWildcards = (_key: string, value: unknown): unknown => {
  if (typeof value !== "symbol") return value;
  const wire = WIRE.get(value);
  // A wildcard added to the API and not to this table would otherwise be written as a placeholder
  // and only fail at REPLAY, in another tool, naming the corpus rather than this omission.
  if (wire === undefined) throw new Error(`corpus: ${String(value)} has no wire spelling`);
  return { wildcard: wire };
};

/**
 * `JSON.parse` reviver. Nothing else a profile carries is an object with a `wildcard` member —
 * option values are scalars and lists of strings — so the tag cannot be shadowed by real data.
 */
export const decodeWildcards = (_key: string, value: unknown): unknown => {
  if (typeof value !== "object" || value === null || !("wildcard" in value)) return value;
  const name = value.wildcard;
  for (const [symbol, wire] of WIRE) if (wire === name) return symbol;
  throw new Error(`corpus: unknown selector wildcard ${JSON.stringify(name)}`);
};
