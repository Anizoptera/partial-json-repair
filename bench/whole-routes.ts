#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Which whole input should a built-in parser read? Per input class, `parse` as shipped against the
 * scanner alone (`builtinParsers: false`) and against the diagnostics path, which never tries a
 * built-in parser. `docs/DESIGN-REVIEW.md` F14b cites this; re-run it before moving a route.
 *
 * `bun bench/whole-routes.ts` measures Bun, then bundles this file and runs the same code under
 * `node`. Each figure is the fastest of interleaved runs in one process, so the claim is the RATIO;
 * machine load moves the absolute times.
 *
 * The classes are the shapes the route choice in `builtinRead` (src/builtin-route.ts) turns on: complete
 * JSON pretty and compact, a reply cut off mid-stream, comments and trailing commas, and damage the
 * gate declines early or only late. Damage late in text ending with a closer is the one class a
 * speculative route must lose on: the attempt and the gate both read nearly all of it first.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnostics, initParser } from "../src/index";
import { canonical } from "../scripts/corpus/canonical";
import { parse as configuredParse } from "../src/index";

const record = (i: number) => ({
  id: i,
  name: `item number ${i} with a longer label`,
  score: i * 1.25,
  tags: ["alpha", "beta", i % 3 === 0 ? "gamma" : "delta"],
  nested: { ok: i % 2 === 0, note: null, ratio: i / 7 },
});

const classes = (count: number): Record<string, string> => {
  const value = { items: Array.from({ length: count }, (_, i) => record(i)) };
  const pretty = JSON.stringify(value, null, 2);
  return {
    "clean, pretty": pretty,
    "clean, compact": JSON.stringify(value),
    "cut off": pretty.slice(0, Math.floor(pretty.length * 0.73)),
    "trailing commas": pretty.replaceAll("\n    }", () => ",\n    }"),
    "comment first": `// reply\n${pretty}`,
    "damaged early": `{a:1, ${pretty.slice(1)}`,
    "damaged late": `${pretty.slice(0, -2)}, b: 2}`,
  };
};

const fastest = (run: () => unknown, reps: number): number => {
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
};

const measure = (): void => {
  const shipped = initParser({});
  const scanner = initParser({ builtinParsers: false });
  const reported = initParser({ diagnostics });
  const runtime = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`;
  console.log(`${runtime}: ratio = other route / shipped parse; above 1 means shipped is faster`);
  for (const count of [250, 5000]) {
    for (const [name, text] of Object.entries(classes(count))) {
      // A timing is meaningful only for the same answer: the shipped route must return the scanner's
      // outcome (the report aside, which only the diagnostics route carries).
      const { diagnostics: _report, ...reportedFacts } = configuredParse(text, reported) as Record<
        string,
        unknown
      >;
      const expected = canonical(configuredParse(text, scanner));
      if (
        canonical(configuredParse(text, shipped)) !== expected ||
        canonical(reportedFacts) !== expected
      )
        throw new Error(`${name}: the routes disagree; fix the route before timing it`);
      const reps = count > 1000 ? 10 : 150;
      const best = { shipped: Infinity, scanner: Infinity, reported: Infinity };
      // Interleaved rounds, so drift in machine load lands on all three routes alike.
      for (let round = 0; round < 3; round++) {
        best.shipped = Math.min(
          best.shipped,
          fastest(() => configuredParse(text, shipped), reps),
        );
        best.scanner = Math.min(
          best.scanner,
          fastest(() => configuredParse(text, scanner), reps),
        );
        best.reported = Math.min(
          best.reported,
          fastest(() => configuredParse(text, reported), reps),
        );
      }
      console.log(
        `${String(text.length).padStart(8)} ${name.padEnd(16)} shipped ${best.shipped.toFixed(3).padStart(8)} ms` +
          `  vs scanner ${(best.scanner / best.shipped).toFixed(2)}x  vs diagnostics ${(best.reported / best.shipped).toFixed(2)}x`,
      );
    }
  }
};

measure();
if (typeof Bun !== "undefined" && !process.argv.includes("--bun-only")) {
  const scratch = mkdtempSync(join(tmpdir(), "partial-json-repair-routes-"));
  try {
    const built = await Bun.build({
      entrypoints: [import.meta.path],
      target: "node",
      format: "esm",
      outdir: scratch,
    });
    const output = built.outputs[0]?.path;
    if (!built.success || output === undefined) throw new Error("whole-routes bundle failed");
    const node = spawnSync("node", [output], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (node.status !== 0) throw new Error(`node exited ${String(node.status)}`);
    process.stdout.write(node.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
