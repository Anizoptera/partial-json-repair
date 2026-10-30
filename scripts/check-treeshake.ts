#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * HLD D5: an app that uses one feature must ship only that feature and the shared core.
 *
 * `sideEffects: false` in `package.json` PERMITS a bundler to drop unused exports; it does not make
 * anything droppable. What decides that is the SHAPE of the code, and the shape has no gate of its
 * own — a method on a returned object literal is retained by any use of that literal, so one
 * streaming method reachable from `buildParser` put the whole transport into a bundle that imported
 * `parse` and nothing else. Measured before this script existed: 73.5 KB against 76.7 KB for
 * importing the entire package, or 96% of everything for one verb.
 *
 * Presence is asserted through STRING LITERALS a feature cannot work without, because a minifier
 * mangles every identifier and would make an identifier-based probe report success on any input.
 *
 * Both signs are controlled, and that is the point of `wants` rather than a list of forbidden
 * markers. A marker absent from a build that imports EVERYTHING is a broken probe, not a shaken
 * feature, and it reads identically to a pass — measured here: `"unsupported-value"` was invented
 * from memory of the stringify failure kinds, matched neither build, and looked like proof that
 * stringify shakes out.
 *
 * Bun's bundler is not what every consumer runs. What it measures is that OUR module graph permits
 * the drop, which is the half we own; a consumer's bundler can only do worse than a graph that
 * already fails here.
 */
import { build } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_MARKERS } from "./consumer-markers";

const FEATURES = Object.entries(FEATURE_MARKERS).map(([name, marker]) => ({ name, marker }));

/** What one entry point imports, and which features that entitles it to carry. */
interface Case {
  readonly name: string;
  readonly entry?: "async";
  readonly imports: string;
  readonly body: string;
  /** Features this entry may contain. Everything else must be absent. */
  readonly wants: readonly string[];
}

/**
 * Parsing and text repair share a reader, but only repair needs edit projection. Each case
 * distinguishes a separate retention edge; the full import controls every marker.
 */
const CASES: readonly Case[] = [
  // The control: importing everything must contain everything, or the probes below prove nothing.
  {
    name: "everything",
    imports: "* as all",
    body: "if (all === undefined) throw new Error('unreachable');",
    wants: FEATURES.map((f) => f.name),
  },
  {
    name: "parse only",
    imports: "{ parse }",
    body: "if (parse('{\"a\":1}') === undefined) throw new Error('unreachable');",
    wants: [],
  },
  {
    name: "skip only",
    imports: "{ parse, skip }",
    body: 'if (parse(\'{"a":1,"embedding":[1,2]}\', { skip: skip([["embedding"]]) }) === undefined) throw new Error(\'unreachable\');',
    wants: [],
  },
  {
    name: "select without views",
    imports: "{ parse, select }",
    body: "if (parse('{\"a\":1}', { select: select([[\"a\"]]) }) === undefined) throw new Error('unreachable');",
    // Fragment constructors and their position history travel only through their own imports.
    wants: ["fragment setup guidance", "multi-value delivery"],
  },
  {
    name: "parseAsync only",
    entry: "async",
    imports: "{ cooperative, parseAsync }",
    body: "await parseAsync('{\"a\":1}', { execution: cooperative });",
    wants: [],
  },
  {
    name: "repair only",
    imports: "{ repair }",
    body: "if (repair('{a:1,}') === undefined) throw new Error('unreachable');",
    wants: ["repair", "text edit recording"],
  },
  {
    name: "parseStream only",
    imports: "{ parseStream }",
    body: "if (parseStream([]) === undefined) throw new Error('unreachable');",
    wants: ["transport", "stream position history"],
  },
];

const work = await mkdtemp(join(tmpdir(), "pjr-shake-"));

/** One entry point's verdict: every marker that disagreed with what the entry imports. */
const inspect = async (probe: Case): Promise<string[]> => {
  const entrypoint = join(import.meta.dir, "..", "src", `${probe.entry ?? "index"}.ts`);
  const entry = join(work, `${probe.name.replaceAll(" ", "-")}.ts`);
  await writeFile(
    entry,
    `import ${probe.imports} from ${JSON.stringify(entrypoint)};\n${probe.body}\n`,
  );
  const built = await build({ entrypoints: [entry], minify: true, target: "node" });
  const [output] = built.outputs;
  if (!built.success || output === undefined) {
    return [`${probe.name}: bundle failed — ${built.logs.map((log) => log.message).join("; ")}`];
  }
  const code = await output.text();
  const kb = String(Math.round(code.length / 1024));
  return FEATURES.flatMap((feature) => {
    const present = code.includes(feature.marker);
    const wanted = probe.wants.includes(feature.name);
    if (present === wanted) return [];
    return [
      wanted
        ? `${probe.name}: "${feature.name}" is missing, so its marker no longer proves presence — fix the marker, not the build`
        : `${probe.name}: ships "${feature.name}", which it never imports (${kb} KB)`,
    ];
  });
};

// Concurrent: the entry points share nothing but the source graph they read, and the lane's
// whole-run deadline is what bounds them.
let failures: string[];
try {
  failures = (await Promise.all(CASES.map((probe) => inspect(probe)))).flat();
} finally {
  await rm(work, { recursive: true });
}

if (failures.length === 0) {
  console.log(`treeshake: ${String(CASES.length)} entry points carry only what they import`);
} else {
  for (const failure of failures) console.error(`treeshake: ${failure}`);
  process.exitCode = 1;
}
