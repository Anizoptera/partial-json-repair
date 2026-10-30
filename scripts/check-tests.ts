#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/** Run the shared suite in both supported test runners and reject a silent discovery mismatch. */
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";

import { LANE_DEADLINE_MS, runScript } from "./run-script";

interface JunitDocument {
  readonly testsuites?: { readonly "@tests"?: unknown };
}

type Report = { readonly path: string } & (
  | { readonly ok: true; readonly document: unknown }
  | { readonly ok: false; readonly cause: unknown }
);

const readReport = async (report: string): Promise<Report> => {
  try {
    return { path: report, ok: true, document: Bun.XML.parse(await Bun.file(report).text()) };
  } catch (cause) {
    return { path: report, ok: false, cause };
  }
};

const testCount = (report: Report): number => {
  if (!report.ok) throw report.cause;
  const document = report.document as JunitDocument;
  const raw = document.testsuites?.["@tests"];
  const count = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0 || String(count) !== raw) {
    throw new Error(`${report.path}: JUnit root has no canonical nonnegative integer tests count.`);
  }
  return count;
};

const FAILED = ["failure", "error"] as const;

/**
 * `file :: describe :: test` for every test case holding one of `elements`. Walks the parsed
 * document instead of assuming its nesting, which differs between the two reporters; an unreadable
 * or missing report yields a line saying so rather than nothing.
 */
const casesHolding = (report: Report, elements: readonly string[]): string[] => {
  if (!report.ok) return [`(no readable JUnit report at ${report.path}: ${String(report.cause)})`];
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    // Vitest writes the file as `classname`; Bun writes the describe block there and the file as
    // `file`. Print whichever are present, once each.
    const held = elements.find((element) => element in record);
    if (typeof record["@name"] === "string" && held !== undefined) {
      const parts = [record["@file"], record["@classname"], record["@name"]].filter(
        (part): part is string => typeof part === "string" && part !== "",
      );
      // The reason decides the next act: a timeout under load reruns, a wrong value is a defect.
      // Both runners write it as `message`, often over several lines.
      const failure = [record[held]].flat()[0];
      const message =
        typeof failure === "object" && failure !== null && "@message" in failure
          ? failure["@message"]
          : "";
      const reason = typeof message === "string" ? message.replaceAll(/\s+/gu, " ").trim() : "";
      names.push(
        [...new Set(parts)].join(" :: ") + (reason === "" ? "" : ` — ${reason.slice(0, 200)}`),
      );
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(report.document);
  return names;
};

const directory = await mkdtemp(path.join(tmpdir(), "partial-json-repair-tests-"));
const signal = AbortSignal.timeout(LANE_DEADLINE_MS);

try {
  const vitestReport = path.join(directory, "vitest.xml");
  const bunReport = path.join(directory, "bun.xml");
  // The runners share the machine: each alone starts a worker per core, so together they put twice
  // as many busy processes as cores, and on a 4-vCPU CI runner cases that take 0.2 s locally passed
  // their 5 s timeout on contention alone. Split the cores; `check.ts` gives this step all of them.
  const cores = availableParallelism();
  const vitestWorkers = Math.max(1, Math.min(4, Math.floor(cores / 2)));
  const bunWorkers = Math.max(1, cores - vitestWorkers);
  const [vitest, bun] = await Promise.all([
    runScript("test", signal, [
      `--maxWorkers=${vitestWorkers}`,
      "--reporter=junit",
      `--outputFile=${vitestReport}`,
    ]),
    runScript("test:bun", signal, [
      `--parallel=${bunWorkers}`,
      "--reporter=junit",
      `--reporter-outfile=${bunReport}`,
    ]),
  ]);

  // Failure names, skipped cases and discovery counts judge the same report bytes.
  const [vitestDocument, bunDocument] = await Promise.all([
    readReport(vitestReport),
    readReport(bunReport),
  ]);

  const failed = [
    { run: vitest, report: vitestDocument },
    { run: bun, report: bunDocument },
  ].filter(({ run }) => run.kind !== "passed");
  // The JUnit reporters print no test names to the console, so a failure here read only "did not
  // pass". The report is written on failure too: name every failing case from it.
  const names = failed.map(({ report }) => casesHolding(report, FAILED));
  for (const [index, { run }] of failed.entries()) {
    console.error(`--- ${run.script}`);
    console.error(run.output.trimEnd());
    for (const name of names[index] ?? []) console.error(`  failed: ${name}`);
  }
  if (failed.length > 0) throw new Error("One or more test runners did not pass.");

  // Both reporters count a skipped or todo case in `tests`, so a test skipped in both runners keeps
  // the counts equal and the run green while proving nothing.
  const skipped = [vitestDocument, bunDocument].flatMap((report) =>
    casesHolding(report, ["skipped"]),
  );
  if (skipped.length > 0) {
    for (const name of skipped) console.error(`  skipped: ${name}`);
    throw new Error("Skipped or todo tests are not allowed: run them or delete them.");
  }

  const vitestCount = testCount(vitestDocument);
  const bunCount = testCount(bunDocument);
  if (vitestCount !== bunCount) {
    throw new Error(`Test discovery differs: Vitest ran ${vitestCount}; Bun ran ${bunCount}.`);
  }
  // Equal counts of zero would pass the comparison above while proving nothing ran.
  if (vitestCount === 0) throw new Error("Both runners discovered zero tests.");
  // Keep runner attribution visible when this combined step determines the hook's cost.
  console.log(
    `tests: ${vitestCount} under Vitest and under Bun; Vitest ${vitest.ms} ms; Bun ${bun.ms} ms`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
