/**
 * Canonical serialisation for conformance records.
 *
 * One documented spelling per value, so a TypeScript run and a Rust run can be compared as STRINGS
 * with no shared type system, no bindings and no tagged-union protocol to keep in step. That is the
 * whole reason this exists rather than `JSON.stringify`.
 *
 * `JSON.stringify` is unusable here because it would silently erase a
 * behaviour this package is responsible for:
 *   - it renders `undefined`, `NaN` and `±Infinity` as `null` or drops the key, and the parser can
 *     produce all three under `allowJavaScript`;
 *   - it cannot distinguish `-0` from `0`, which `JSON.parse` itself preserves;
 *   - it collapses sparse elements into null, hiding missing array data;
 *   - it cannot show that an object has a null prototype, which is an option of this parser;
 *   - it throws on cyclic input, and a prototype-pollution bug is exactly how a cycle would appear.
 *
 * **Two properties it deliberately does not have**, because the values it serialises cannot need
 * them: it renders a shared substructure by expanding it at each site, so it neither shows aliasing
 * (`{a:x,b:x}` reads the same as `{a:x,b:copyOf(x)}`) nor stays linear on a DAG; and a throwing
 * accessor propagates rather than being captured. A parse result is a tree the builder constructs
 * from distinct spans of source text, holding no accessors and no node reachable by two paths, so
 * both cases are unreachable here. Adding either would be paying for a shape the corpus cannot hold.
 *
 * KEY ORDER IS PRESERVED, NEVER SORTED. Insertion order is observable behaviour: the old
 * implementation rebuilt every object during sanitisation and changed it, which is one of the
 * defects being removed. Sorting here would hide the change this corpus exists to detect.
 */

import { isExactNumber } from "../../src/index";

const escape = (s: string): string => JSON.stringify(s);

/** Distinguishes values JSON has no spelling for. `#` cannot begin any JSON token, so no collision. */
function scalar(value: unknown): string | undefined {
  if (value === null) return "null";
  if (value === undefined) return "#undef";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return escape(value);
  if (typeof value === "bigint") return `#big:${value}`;
  if (isExactNumber(value)) return `#exact:${value.text}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "#nan";
    if (value === Infinity) return "#inf";
    if (value === -Infinity) return "#-inf";
    // `Object.is` because `-0 === 0`. The sign survives `JSON.parse`, so it must survive this.
    if (Object.is(value, -0)) return "#-0";
    return String(value);
  }
  if (typeof value === "function") return "#fn";
  if (typeof value === "symbol") return "#sym";
  return undefined;
}

/** Emit the same spelling without retaining a whole comparison string for hash-only callers. */
export function writeCanonical(
  value: unknown,
  write: (part: string) => void,
  seen: Set<object> = new Set(),
): void {
  const s = scalar(value);
  if (s !== undefined) {
    write(s);
    return;
  }

  const obj = value as object;
  // A cycle is not a valid parse result. Emitting a marker rather than throwing keeps the record
  // comparable and makes the defect visible in a diff instead of aborting the whole run.
  if (seen.has(obj)) {
    write("#cycle");
    return;
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      write("[");
      for (let index = 0; index < obj.length; index++) {
        if (index !== 0) write(",");
        // A missing element is corrupt parser output, not an empty array or explicit undefined.
        // Inherited values must not disguise that missing own element as recovered source data.
        if (Object.hasOwn(obj, index)) writeCanonical(obj[index], write, seen);
        else write("#hole");
      }
      write("]");
      return;
    }

    // `Object.keys` is own+enumerable, which is what a consumer iterates. A polluted prototype
    // therefore does NOT hide here as a phantom key, and a key written onto the prototype instead of
    // the object shows up as its ABSENCE -- which is the signal we want.
    // Anything that is not a plain object is tagged by its constructor. A Date, Map, Set, RegExp or
    // class instance has no own enumerable keys, so all of them -- and `{}` -- would otherwise
    // serialise to the same four characters. None is a valid parse result; the tag exists so that an
    // implementation which accidentally produces one is caught by a diff instead of passing as an
    // empty object.
    const proto: unknown = Object.getPrototypeOf(obj);
    write(
      proto === null
        ? "#np{"
        : proto === Object.prototype
          ? "{"
          : `#${obj.constructor?.name ?? "?"}{`,
    );
    let first = true;
    for (const key of Object.keys(obj)) {
      if (!first) write(",");
      first = false;
      write(escape(key));
      write(":");
      writeCanonical((obj as Record<string, unknown>)[key], write, seen);
    }
    write("}");
  } finally {
    seen.delete(obj);
  }
}

export function canonical(value: unknown, seen: Set<object> = new Set()): string {
  let text = "";
  writeCanonical(
    value,
    (part) => {
      text += part;
    },
    seen,
  );
  return text;
}
