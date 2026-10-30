// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Miniflare } from "miniflare";
import { openBrowser } from "../scripts/browser";
import { workerRecipe } from "../scripts/consumer-package";
import type { Consumer } from "../scripts/consumer-package";
import { PLATFORM_OBSERVATION_MS } from "../scripts/run-script";
import { captureHostContext } from "./async-host";
import { PLATFORM_HOSTS, platformMembers } from "./async-platform-protocol";
import type { AsyncRuntime, PlatformRequest } from "./async-platform-protocol";

// Build once; oracle and observer children read the same immutable installed consumer.
export const platformRuntimes = async (
  root: string,
  consumer: Consumer,
  requested?: string,
): Promise<AsyncRuntime[]> => {
  const members = platformMembers(requested);
  if (members.length === 0) return [];
  // Compile only the instrument first. From the consumer directory, ordinary package resolution
  // then reaches the installed tarball without an alias or plugin changing the measured app.
  const prepared = await Bun.build({
    entrypoints: [join(root, "bench/async-platform-entry.ts")],
    outdir: consumer.dir,
    target: "browser",
    format: "esm",
    packages: "external",
    naming: { entry: "[name].[ext]" },
  });
  const instrument = prepared.outputs[0];
  if (!prepared.success || instrument === undefined || instrument.size === 0)
    throw new AggregateError(prepared.logs, "async platform instrument did not compile");
  const dir = join(consumer.dir, "platform");
  const result = await Bun.build({
    entrypoints: [instrument.path, ...Object.values(workerRecipe(consumer))],
    outdir: dir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
  });
  if (!result.success || result.outputs.length === 0)
    throw new AggregateError(result.logs, "async platform observer build failed");
  return members.map(({ host, isolation, label }) => ({
    label,
    argv: [process.execPath, import.meta.path, "--child", host, isolation],
    observerEntry: dir,
  }));
};

const child = async (): Promise<string> => {
  const [hostName, isolation, dir, ...args] = process.argv.slice(3);
  const host = PLATFORM_HOSTS.find((name) => name === hostName);
  if (host === undefined || (isolation !== "iso" && isolation !== "plain") || dir === undefined)
    throw new Error(
      "async platform child requires host, iso|plain and its built consumer directory",
    );
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === undefined) throw new Error("platform observer flag is missing");
    if (flags.has(flag)) throw new Error("duplicate platform observer flag: " + flag);
    if (["--observe", "--oracle-only", "--cancel-after-first"].includes(flag))
      flags.set(flag, true);
    else if (
      [
        "--workload",
        "--route",
        "--size",
        "--sampling-budget",
        "--concurrency",
        "--expected-record",
      ].includes(flag)
    ) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--"))
        throw new Error("missing value for " + flag);
      flags.set(flag, value);
    } else throw new Error("unsupported platform observer flag: " + flag);
  }
  const required = (flag: string): string => {
    const value = flags.get(flag);
    if (typeof value !== "string") throw new Error("platform observer requires " + flag);
    return value;
  };
  const positive = (flag: string): number => {
    const value = Number(required(flag));
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(flag + " requires a positive safe integer");
    return value;
  };
  if (flags.get("--observe") !== true)
    throw new Error("platform child is an observer, not a launcher");
  const expected = flags.get("--expected-record");
  const request: PlatformRequest = {
    host,
    runtime: host === "workerd" ? host : host + " " + isolation,
    workload: required("--workload"),
    route: required("--route"),
    size: positive("--size"),
    budgetMilliseconds: positive("--sampling-budget"),
    concurrency: flags.has("--concurrency") ? positive("--concurrency") : 1,
    cancelAfterFirst: flags.get("--cancel-after-first") === true,
    oracleOnly: flags.get("--oracle-only") === true,
    ...(typeof expected === "string" ? { expectedRecord: expected } : {}),
  };
  const context = captureHostContext();
  const deadline = performance.now() + PLATFORM_OBSERVATION_MS;
  const bounded = async <T>(start: () => Promise<T>): Promise<T> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("async platform observer exhausted its host deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(reject, remaining, new Error("async platform observation timed out"));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const files = new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => {
        const bytes = readFileSync(join(dir, name));
        if (bytes.byteLength === 0) throw new Error("empty async platform artifact: " + name);
        return [name, bytes] as const;
      }),
  );
  const entry = "async-platform-entry.js";
  if (!files.has(entry)) throw new Error("async platform build omitted its entry");
  let raw: unknown;
  // Attempt every owned release and preserve a primary observation failure.
  await using resources = new AsyncDisposableStack();
  if (host === "workerd") {
    // Explicit modules permit the untaken Node import without enabling Node compatibility.
    const mf = new Miniflare({
      modules: [
        {
          type: "ESModule",
          path: "worker.mjs",
          contents: `import { run } from "./${entry}"; export default { fetch: async () => new Response(await run(${JSON.stringify(request)})) };`,
        },
        ...Array.from(files, ([name, bytes]) => ({
          type: "ESModule" as const,
          path: name,
          contents: bytes.toString("utf8"),
        })),
      ],
      compatibilityDate: "2026-07-01",
    });
    resources.defer(() => mf.dispose());
    raw = await bounded(async () => {
      const response = await mf.dispatchFetch("http://localhost/");
      const body = await response.text();
      if (!response.ok) throw new Error(`workerd observation failed (${response.status}): ${body}`);
      return body;
    });
  } else {
    const headers =
      isolation === "iso"
        ? {
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-embedder-policy": "require-corp",
          }
        : {};
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(http) {
        const name = basename(new URL(http.url).pathname);
        if (files.has(name))
          return new Response(files.get(name), {
            headers: { ...headers, "content-type": "text/javascript" },
          });
        if (new URL(http.url).pathname !== "/") return new Response("not found", { status: 404 });
        return new Response(
          `<!doctype html><title>async observation</title><script>globalThis.__module = new Promise(resolve => globalThis.__ready = resolve);</script><script type="module">import * as module from "/${entry}"; globalThis.__ready(module);</script>`,
          { headers: { ...headers, "content-type": "text/html" } },
        );
      },
    });
    resources.defer(() => server.stop(true));
    const response = await fetch(new URL(entry, server.url));
    if (!response.ok || (await response.arrayBuffer()).byteLength === 0)
      throw new Error("async browser entry was not served");
    const activeView = await openBrowser(host === "webkit" ? "webkit" : "chrome");
    resources.defer(() => activeView.close());
    await bounded(() => activeView.navigate(server.url.href));
    if ((await activeView.evaluate("crossOriginIsolated")) !== (isolation === "iso"))
      throw new Error("async browser isolation differs from its declared route");
    console.error(
      request.runtime +
        ": " +
        String(activeView.engineVersion ?? (await activeView.evaluate("navigator.userAgent"))),
    );
    const expression = "globalThis.__module.then(m => m.run(" + JSON.stringify(request) + "))";
    raw = await bounded(() => activeView.evaluate(expression));
  }
  if (typeof raw !== "string")
    throw new Error("async platform did not return its completion record");
  if (request.oracleOnly) return raw;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "runtime") !== request.runtime
  )
    throw new Error("async platform returned a different host's record");
  const observedHost: unknown = Reflect.get(value, "host");
  if (typeof observedHost !== "object" || observedHost === null)
    throw new Error("async platform omitted host evidence");
  return JSON.stringify({ ...value, host: { ...context, ...observedHost } });
};

if (import.meta.main) {
  if (process.argv[2] === "--build") {
    const [root, dir, installed, requested] = process.argv.slice(3);
    if (root === undefined || dir === undefined || installed === undefined)
      throw new Error("platform build requires repository, consumer and installed package paths");
    console.log(JSON.stringify(await platformRuntimes(root, { dir, installed }, requested)));
  } else if (process.argv[2] === "--child") console.log(await child());
  else throw new Error("launch platform observations through bench/async.ts --runtime <host>");
}
