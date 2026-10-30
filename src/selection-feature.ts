// SPDX-License-Identifier: Apache-2.0

// Factories choose delivery implementations; the shared matcher never imports its strategies.
// Keeping that direction lets optional delivery extend Picks without a runtime import cycle.

import type { Builder, BuildMode } from "./builder";
import type { CompiledSelection, OptionKeys } from "./options";
import type {
  SelectFeature,
  SkipFeature,
  SourceFragmentsFeature,
  DecodedFragmentsFeature,
} from "./types";
import type { ScalarReader } from "./scalar-reader";
import type { Compiled, SelectorPath } from "./selector";
import { ANY, ANY_DEPTH, compileSelectors } from "./selector";
import { configurationError, isPlainObject, ownOption } from "./configuration-error";
import type { fragmentPositions } from "./positions";
import type { BuildFilter } from "./path-filter";
import { SkipFilter } from "./path-filter";
import { Picks } from "./picks";

/** Builds the requested filter; the feature owns its implementation outside the core graph. */
export type FilterFactory = ((
  b: Builder,
  compiled: CompiledSelection,
  occurrences: boolean,
  mode: BuildMode,
) => BuildFilter) & {
  readonly openFragmentHistory?: typeof fragmentPositions;
  readonly streamReader?: typeof ScalarReader;
};

/** What the core reads off a `select` or `skip` value it was handed. */
export type SelectionFeature = (SelectFeature | SkipFeature) & {
  readonly compiled: Compiled;
  readonly picks: FilterFactory;
  /** The paths as `postMessage` can clone them, for the worker that rebuilds this value. */
  readonly wire: () => readonly WirePath[];
};

/**
 * A path with its wildcards as numbers: structured clone refuses symbols. Encoded and decoded here,
 * beside the wildcards, so a caller who never selects carries none of it to a worker.
 */
export type WirePath = readonly (string | number)[];
const WIRE_ANY = -1;
const WIRE_ANY_DEPTH = -2;

const toWire = (paths: readonly SelectorPath[]): readonly WirePath[] =>
  paths.map((path) =>
    path.map((segment) =>
      segment === ANY ? WIRE_ANY : segment === ANY_DEPTH ? WIRE_ANY_DEPTH : segment,
    ),
  );

export const fromWire = (paths: readonly WirePath[]): readonly SelectorPath[] =>
  paths.map((path) =>
    path.map((segment) =>
      segment === WIRE_ANY ? ANY : segment === WIRE_ANY_DEPTH ? ANY_DEPTH : segment,
    ),
  );

/** How matches arrive. `fragments` is for the stream verbs only, which its literal type enforces. */
export type SelectSettings = {
  readonly occurrences?: boolean;
  readonly fragments?: false | DecodedFragmentsFeature | SourceFragmentsFeature;
};

export type SourceFragmentsImplementation = SourceFragmentsFeature & {
  readonly picks: FilterFactory;
};

export type DecodedFragmentsImplementation = DecodedFragmentsFeature & {
  readonly picks: FilterFactory;
};

type FragmentsImplementation = SourceFragmentsImplementation | DecodedFragmentsImplementation;

const isFragments = (value: unknown): value is FragmentsImplementation => {
  if (!isPlainObject(value)) return false;
  const feature = ownOption(value, "feature");
  if (feature !== "source-fragments" && feature !== "decoded-fragments") return false;
  const picks = ownOption(value, "picks");
  return (
    typeof picks === "function" &&
    (feature === "decoded-fragments" || typeof ownOption(picks, "streamReader") === "function")
  );
};

// Distribute before keyof: settings unions can have different keys, not just different mode values.
type FragmentMode<Setting> = Setting extends undefined
  ? false
  : Setting extends DecodedFragmentsFeature
    ? true
    : Setting;

type SelectionFragments<S extends SelectSettings> = S extends SelectSettings
  ? "fragments" extends keyof S
    ? FragmentMode<S["fragments"]>
    : false
  : never;

// Ordinary selection has no runtime edge to either fragment implementation.
const newPicks: FilterFactory = (b, compiled, occurrences, mode) =>
  new Picks(b, compiled, occurrences, mode);

const newSkipFilter: FilterFactory = (b, compiled) => new SkipFilter(b, compiled.skip);

const compile = (field: "select" | "skip", paths: readonly SelectorPath[]): Compiled => {
  const compiled = compileSelectors(field, paths);
  if ("kind" in compiled) throw configurationError(compiled);
  return compiled;
};

/**
 * Selects parts of each value: every verb then returns matches rather than values. The paths are
 * validated and compiled HERE, once, so a malformed path throws where it was written and a value
 * passed to many calls is compiled once; the result is frozen and holds its own copy of the paths,
 * so a caller mutating their array afterwards changes nothing.
 */
export function select<const S extends SelectSettings = Record<never, never>>(
  paths: readonly SelectorPath[],
  // Expose names to editors while preserving the supplied mode and caller settings unions.
  settings?: S | SelectSettings,
  ...invalid: [S] extends [never]
    ? []
    : [Exclude<OptionKeys<S>, keyof SelectSettings>] extends [never]
      ? []
      : [never]
): SelectFeature<SelectionFragments<S>>;
export function select(
  paths: readonly SelectorPath[],
  settings: SelectSettings = {},
): SelectFeature {
  if (!isPlainObject(settings))
    throw configurationError({
      kind: "invalid-options",
      field: "select.settings",
      reason: "object",
    });
  let fragments: false | FragmentsImplementation = false;
  let occurrences = false;
  // Capture what validation reads: getters may change, and nonenumerable own settings count too.
  for (const key of Object.getOwnPropertyNames(settings)) {
    const value = (settings as Record<string, unknown>)[key];
    if (key === "fragments" && value !== undefined && value !== false) {
      if (!isFragments(value))
        throw configurationError(
          {
            kind: "invalid-options",
            field: "select.fragments",
            reason: "import-required",
          },
          'takes imported `decodedFragments` for recovered content, imported `sourceFragments` for source spelling, or `false` for whole matches: `import { decodedFragments, sourceFragments } from "partial-json-repair"`',
        );
      fragments = value;
      continue;
    }
    const reason =
      key !== "occurrences" && key !== "fragments"
        ? "unknown"
        : typeof value === "boolean" || value === undefined
          ? undefined
          : "boolean";
    if (reason !== undefined)
      throw configurationError({ kind: "invalid-options", field: `select.${key}`, reason });
    if (key === "fragments") fragments = false;
    else occurrences = value === true;
  }
  const compiled = compile("select", paths);
  const feature: SelectionFeature & SelectFeature = {
    feature: "select",
    paths: compiled.paths,
    occurrences,
    fragments: fragments !== false && fragments.feature === "decoded-fragments" ? true : fragments,
    compiled,
    picks: typeof fragments === "object" ? fragments.picks : newPicks,
    wire: () => toWire(compiled.paths),
  };
  return Object.freeze(feature);
}

/**
 * Object members not to build. A path must end in a key: an index or wildcard tail could remove an
 * array element and shift every later index, which is never done silently. Its own value rather
 * than a `select` setting, because skipping without selecting is a job of its own.
 */
export const skip = (paths: readonly SelectorPath[]): SkipFeature => {
  const compiled = compile("skip", paths);
  const feature: SelectionFeature & SkipFeature = {
    feature: "skip",
    paths: compiled.paths,
    compiled,
    picks: newSkipFilter,
    wire: () => toWire(compiled.paths),
  };
  return Object.freeze(feature);
};
