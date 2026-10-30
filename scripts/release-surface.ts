import { combineReleaseLevels } from "./release-comparison";
import type { ApiDifference, ReleaseLevel } from "./release-comparison";

export interface NpmReleaseSurface {
  readonly node_engine: unknown;
  readonly exports: unknown;
  readonly main: unknown;
  readonly module: unknown;
  readonly sideEffects: unknown;
  readonly type: unknown;
  readonly types: unknown;
}

export function npmReleaseSurface(manifest: Record<string, unknown>): NpmReleaseSurface {
  return {
    node_engine: (manifest.engines as { node?: unknown } | undefined)?.node,
    exports: manifest.exports,
    main: manifest.main,
    module: manifest.module,
    sideEffects: manifest.sideEffects,
    type: manifest.type,
    types: manifest.types,
  };
}

function floor(value: unknown, field: string, prefix = ""): readonly bigint[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a minimum version string.`);
  const match = new RegExp(`^${prefix}(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$`, "u").exec(value);
  if (!match) throw new Error(`${field} uses an unsupported version range: ${value}`);
  return match.slice(1).map((part) => BigInt(part ?? 0));
}

function compareFloor(
  before: readonly bigint[] | undefined,
  after: readonly bigint[] | undefined,
): ReleaseLevel {
  if (!before) return after ? "major" : "patch";
  if (!after) return "patch";
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    const change = (after[index] ?? 0n) - (before[index] ?? 0n);
    if (change !== 0n) return change > 0n ? "major" : "patch";
  }
  return "patch";
}

function exportsLevel(before: unknown, after: unknown): ReleaseLevel {
  // Which file serves an import is implementation: every old import still resolves, and the API
  // reports plus packed consumers judge what it provides. Only a lost path or condition, or a
  // reorder that changes which condition wins, breaks resolution.
  if (Object.is(before, after) || (typeof before === "string" && typeof after === "string"))
    return "patch";
  if (!isMap(before) || !isMap(after)) return "major";
  const oldEntries = Object.entries(before);
  const newExports = after;
  const targets = oldEntries.map(([name, target]) =>
    Object.hasOwn(newExports, name) ? exportsLevel(target, newExports[name]) : "major",
  );
  if (targets.includes("major")) return "major";
  const names = Object.keys(after);
  // Conditions choose one result in order; subpath keys identify distinct imports.
  if (!oldEntries.some(([name]) => name.startsWith("."))) {
    let retained = 0;
    for (const name of names) if (name === oldEntries[retained]?.[0]) retained++;
    if (retained !== oldEntries.length) return "major";
  }
  return combineReleaseLevels(...targets, names.length > oldEntries.length ? "minor" : "patch");
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const code = (value: unknown) => `\`${typeof value === "string" ? value : JSON.stringify(value)}\``;

/**
 * One line per changed export entry, addressed as code would read it (`exports["."].deno`), so a
 * one-condition change reads as one line instead of two copies of the whole condition block.
 * Condition order decides which target a runtime loads, so a reorder gets its own line; subpath
 * keys are independent imports whose order means nothing.
 */
function exportChanges(path: string, before: unknown, after: unknown): string[] {
  if (before === undefined) return [`- ${code(path)} added: ${code(after)}`];
  if (after === undefined) return [`- ${code(path)} removed (was ${code(before)})`];
  if (!isMap(before) || !isMap(after))
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [`- ${code(path)}: ${code(before)} → ${code(after)}`];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const lines = keys.flatMap((key) =>
    exportChanges(
      /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`,
      before[key],
      after[key],
    ),
  );
  const shared = (map: Record<string, unknown>) =>
    Object.keys(map).filter((key) => key in before && key in after);
  if (!keys.some((key) => key.startsWith(".")) && shared(before).join() !== shared(after).join())
    lines.push(
      `- ${code(path)} condition order: ${shared(before).join(", ")} → ${shared(after).join(", ")}`,
    );
  return lines;
}

export function npmSurfaceDifference(
  before: NpmReleaseSurface,
  after: NpmReleaseSurface,
): ApiDifference {
  const changes: string[] = [];
  const levels: ReleaseLevel[] = [];
  if (before.node_engine !== after.node_engine) {
    const oldNode = before.node_engine;
    const newNode = after.node_engine;
    levels.push(
      compareFloor(floor(oldNode, "engines.node", ">="), floor(newNode, "engines.node", ">=")),
    );
    changes.push(`Node support changed from ${String(oldNode)} to ${String(newNode)}.`);
  }
  const exports = exportChanges("exports", before.exports, after.exports);
  if (exports.length > 0) {
    levels.push(exportsLevel(before.exports, after.exports));
    changes.push(`Package export conditions:\n\n${exports.join("\n")}`);
  }
  for (const field of ["main", "module", "sideEffects", "type", "types"] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      levels.push("major");
      changes.push(
        `${field}: ${JSON.stringify(before[field]) ?? "unset"} → ${JSON.stringify(after[field]) ?? "unset"}.`,
      );
    }
  }
  return changes.length > 0
    ? { changed: true, report: changes.join("\n"), level: combineReleaseLevels(...levels) }
    : { changed: false, level: "patch" };
}
