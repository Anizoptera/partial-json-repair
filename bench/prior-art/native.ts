// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the C/C++ clean-parse runner (`native/runner.cpp`) for the `baseline.ts` matrix.
 *
 *     bun bench/prior-art/native.ts   # build, then print the binary path
 *
 * Sources come through {@link acquireSuite}, which fetches each library at a pinned commit and
 * refuses a cache whose HEAD or tree differs, so the binary always names what it measured. The build
 * lands in the gitignored `.native-build/`, keyed by a hash of the runner source, the pins and the
 * compiler identity: a stale binary would report an older build's speed under this one's name.
 *
 * A missing compiler is reported as unavailable with the exact tool, never provisioned: system
 * toolchains are outside this harness's authority.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { acquireSuite } from "./suites.ts";

/** Pinned by the peeled commit of each release tag; the tag is only the human-readable name. */
export const NATIVE_LIBRARIES = {
  yyjson: {
    repo: "ibireme/yyjson",
    revision: "6447536015f3d600f3d65323b10976103b337ca7",
    tag: "0.13.0",
  },
  rapidjson: {
    repo: "Tencent/rapidjson",
    revision: "f54b0e47a08782a6131cc3d60f94d038fa6e0a51",
    tag: "1.1.0",
  },
  simdjson: {
    repo: "simdjson/simdjson",
    revision: "8c512a3227ad322bfcb43c57c71fac67a83b5b8e",
    tag: "5.0.1",
  },
} as const;

/** The runtime string the binary prints from the libraries' own version macros. */
export const NATIVE_LABEL = `native yyjson ${NATIVE_LIBRARIES.yyjson.tag} rapidjson ${NATIVE_LIBRARIES.rapidjson.tag} simdjson ${NATIVE_LIBRARIES.simdjson.tag}`;

const here = import.meta.dirname;
const BUILD = join(here, ".native-build");

export type Built = { readonly argv: readonly string[]; readonly expect: string };
export type Unavailable = { readonly unavailable: string };

export const buildNative = async (): Promise<Built | Unavailable> => {
  const cxx = Bun.which("clang++") ?? Bun.which("g++");
  const cc = Bun.which("clang") ?? Bun.which("gcc");
  if (cxx === null) return { unavailable: "no C++ compiler: neither clang++ nor g++ is on PATH" };
  if (cc === null) return { unavailable: "no C compiler: neither clang nor gcc is on PATH" };
  const identity = spawnSync(cxx, ["--version"], { encoding: "utf8" }).stdout.split("\n")[0] ?? "";

  const roots: Record<string, string> = {};
  for (const [name, lib] of Object.entries(NATIVE_LIBRARIES)) {
    try {
      // One at a time, so the first failing fetch is the reason reported.
      // oxlint-disable-next-line eslint/no-await-in-loop
      roots[name] = (await acquireSuite(lib)).root;
    } catch (cause) {
      return {
        unavailable: `${lib.repo}@${lib.tag}: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }
  const source = join(here, "native", "runner.cpp");
  const key = Bun.hash(
    [readFileSync(source, "utf8"), JSON.stringify(NATIVE_LIBRARIES), identity].join("\0"),
  ).toString(16);
  const binary = join(BUILD, `runner-${key}`);
  if (!existsSync(binary)) {
    mkdirSync(BUILD, { recursive: true });
    const yy = roots["yyjson"] ?? "";
    const yyObject = join(BUILD, `yyjson-${key}.o`);
    // yyjson is C; compiled as C so its own language rules apply, then linked into the C++ runner.
    const c = spawnSync(cc, ["-O3", "-c", join(yy, "src", "yyjson.c"), "-o", yyObject], {
      encoding: "utf8",
    });
    if (c.status !== 0) return { unavailable: `yyjson compile failed: ${c.stderr.slice(-600)}` };
    const sj = join(roots["simdjson"] ?? "", "singleheader");
    const built = spawnSync(
      cxx,
      [
        "-O3",
        "-std=c++17",
        "-DNDEBUG",
        `-I${join(yy, "src")}`,
        `-I${join(roots["rapidjson"] ?? "", "include")}`,
        `-I${sj}`,
        source,
        join(sj, "simdjson.cpp"),
        yyObject,
        "-o",
        binary,
      ],
      { encoding: "utf8" },
    );
    if (built.status !== 0)
      return { unavailable: `runner compile failed: ${built.stderr.slice(-800)}` };
  }
  return { argv: [binary], expect: NATIVE_LABEL };
};

if (import.meta.main) {
  const built = await buildNative();
  console.log("unavailable" in built ? `unavailable: ${built.unavailable}` : built.argv[0]);
}
