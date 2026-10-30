// SPDX-License-Identifier: Apache-2.0

/**
 * The corpus's own option vocabulary, and the one mapping between it and the package's options.
 *
 * The recorded contract is read by ports in other languages, so its profiles hold plain data:
 * booleans, numbers and paths. The package takes optional features as imported VALUES
 * (`{ diagnostics }`, `select(paths)`) because a boolean keeps their code in every bundle; a value
 * like that is a function, which no other language can read and JSON cannot hold. So the corpus
 * keeps the boolean spelling the features replaced, and every reader turns a profile into package
 * options HERE. One mapping means a recorder and a verifier cannot disagree about what a profile
 * asks for, and the contract does not change with how the package spells a feature.
 */

import type { ResolvedOptions, StreamParserOptions } from "../../src/options";
import { resolveOptions } from "../../src/options";
import {
  decodedFragments,
  diagnostics,
  locations,
  ownedView,
  select,
  sharedView,
  skip,
} from "../../src/index";
import type { ViewMode } from "../../src/types";
import type { SelectorPath } from "../../src/selector";

/** A profile as the corpus records it: the package's options with each feature spelled as data. */
export type CorpusOptions = Omit<
  StreamParserOptions,
  "diagnostics" | "locations" | "select" | "skip" | "view"
> & {
  readonly view?: ViewMode;
  readonly diagnostics?: boolean | "all";
  readonly maxDiagnostics?: number;
  readonly locations?: boolean;
  readonly select?: readonly SelectorPath[];
  readonly skip?: readonly SelectorPath[];
  readonly occurrences?: boolean;
  readonly fragments?: boolean;
};

/**
 * Every parse option a profile can set, in the order the recorded profile writes them. The coverage
 * rows `option:<name>` come from this list, so it is the corpus's vocabulary, not the package's.
 */
export const CORPUS_OPTION_NAMES = [
  "allowComments",
  "allowSingleQuotes",
  "allowTrailingComma",
  "allowUnquotedKeys",
  "allowJavaScript",
  "repairBroken",
  "recover",
  "maxErrors",
  "diagnostics",
  "maxDiagnostics",
  "locations",
  "exactNumbers",
  "builtinParsers",
  "cutSuffix",
  "maxBuffer",
  "maxDepth",
  "onDangerousKey",
  "nullPrototype",
  "customDangerousKeys",
  "maxScalar",
  "maxRetained",
  "select",
  "skip",
  "occurrences",
  "objectOnly",
  "requiredKeys",
] as const;

/** The package options a profile asks for. */
export const featuresOf = (profile: CorpusOptions): StreamParserOptions => {
  const {
    diagnostics: report,
    maxDiagnostics: maxEntries,
    locations: spans,
    select: picked,
    skip: skipped,
    occurrences,
    fragments,
    view,
    ...plain
  } = profile;
  const settings = {
    ...(maxEntries === undefined ? {} : { maxEntries }),
    ...(report === "all" ? { scope: "all" as const } : {}),
  };
  return {
    ...plain,
    // Preserve invalid wire spellings for the ordinary resolver instead of coercing them to a view.
    ...(view === undefined
      ? {}
      : { view: view === "owned" ? ownedView : view === "shared" ? sharedView : view }),
    ...(report === undefined ? {} : { diagnostics: report !== false && diagnostics(settings) }),
    ...(spans === undefined ? {} : { locations: spans && locations }),
    ...(picked === undefined
      ? {}
      : {
          select: select(picked, {
            ...(occurrences === undefined ? {} : { occurrences }),
            ...(fragments === undefined ? {} : { fragments: fragments && decodedFragments }),
          }),
        }),
    ...(skipped === undefined ? {} : { skip: skip(skipped) }),
  };
};

/**
 * The resolved profile as the contract records it: every parse option with its default filled in,
 * in a fixed order, features spelled as data. Recorded resolved rather than as written so two
 * spellings of one configuration are one profile.
 */
export const resolvedProfile = (profile: CorpusOptions): Record<string, unknown> => {
  const { summary: _summary, view: _view, ...parse } = featuresOf(profile);
  const resolved: ResolvedOptions = resolveOptions(parse, undefined, undefined, true);
  const report = resolved.diagnostics;
  return {
    allowComments: resolved.allowComments,
    allowSingleQuotes: resolved.allowSingleQuotes,
    allowTrailingComma: resolved.allowTrailingComma,
    allowUnquotedKeys: resolved.allowUnquotedKeys,
    allowJavaScript: resolved.allowJavaScript,
    repairBroken: resolved.repairBroken,
    recover: resolved.recover,
    maxRetained: resolved.maxRetained,
    select: resolved.selection?.select?.paths,
    skip: resolved.selection?.skip?.paths ?? [],
    occurrences: resolved.occurrences,
    maxErrors: resolved.maxErrors,
    maxBuffer: resolved.maxBuffer,
    // Without a report the cap binds nothing, so the profile keeps what was written.
    maxDiagnostics: report === false ? (profile.maxDiagnostics ?? 1000) : report.maxEntries,
    diagnostics: report === false ? false : report.scope === "all" ? "all" : true,
    locations: resolved.locations,
    exactNumbers: resolved.exactNumbers,
    builtinParsers: resolved.builtinParsers,
    cutSuffix: resolved.cutSuffix,
    maxDepth: resolved.maxDepth,
    maxScalar: resolved.maxScalar,
    onDangerousKey: resolved.onDangerousKey,
    nullPrototype: resolved.nullPrototype,
    customDangerousKeys: resolved.customDangerousKeys,
    objectOnly: resolved.objectOnly,
    requiredKeys: resolved.requiredKeys,
  };
};
