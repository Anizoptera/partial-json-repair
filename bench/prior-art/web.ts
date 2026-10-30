#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * The speed comparison in browser and edge hosts: native WebKit, Playwright Chromium,
 * and workerd through miniflare. Prints the same `Emitted` record `compare.ts`
 * prints, so `baseline.ts` registers each host as one more runner (HLD: the comparison covers every
 * runtime the package ships to).
 *
 * Usage: bun bench/prior-art/web.ts webkit|chromium|workerd   (run `bun run build` first)
 *
 * The page is cross-origin isolated (COOP/COEP): browsers coarsen `performance.now` to about 1 ms
 * without it, and to 5-20 µs with it. `web-entry.ts` widens its batches to whatever step remains.
 * Rows carry the host name without a version: the browser engine installed on the machine is the
 * one measured, and the run prints its engine version or user agent to stderr for the record.
 */
import { join } from "node:path";
import { openBrowser } from "../../scripts/browser";
import type { BrowserView } from "../../scripts/browser";

const HOSTS = ["webkit", "chromium", "workerd"] as const;
type Host = (typeof HOSTS)[number];
const host = process.argv[2] as Host;
if (!HOSTS.includes(host)) throw new Error(`usage: bun bench/prior-art/web.ts ${HOSTS.join("|")}`);

// Minified, as an app bundling the package ships it.
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "web-entry.ts")],
  target: "browser",
  format: "esm",
  minify: true,
});
const [bundle] = built.outputs;
if (!built.success || bundle === undefined)
  throw new Error(`bundle failed: ${built.logs.map((log) => log.message).join("; ")}`);
const code = await bundle.text();

const inBrowser = async (backend: "webkit" | "chrome"): Promise<string> => {
  const headers = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/entry.js"
        ? new Response(code, { headers: { ...headers, "content-type": "text/javascript" } })
        : new Response("<!doctype html><title>speed</title>", {
            headers: { ...headers, "content-type": "text/html" },
          }),
  });
  let view: BrowserView | undefined;
  try {
    view = await openBrowser(backend);
    await view.navigate(server.url.href);
    if ((await view.evaluate("crossOriginIsolated")) !== true)
      throw new Error(`${host}: the page is not cross-origin isolated, so its clock is coarse`);
    console.error(
      `${host}: ${view.engineVersion ?? String(await view.evaluate("navigator.userAgent"))}`,
    );
    // `evaluate` awaits the promise, so the result arrives when the measurement finishes.
    return (await view.evaluate(
      `import("/entry.js").then((m) => JSON.stringify(m.measure(${JSON.stringify(host)})))`,
    )) as string;
  } finally {
    try {
      await view?.close();
    } finally {
      await server.stop(true);
    }
  }
};

const inWorkerd = async (): Promise<string> => {
  const { Miniflare } = await import("miniflare");
  // Modules listed explicitly, as platform-check does: one entry module and the bundle it imports.
  // Paths are relative: workerd resolves them inside its own module root and refuses one outside it.
  const mf = new Miniflare({
    modules: [
      {
        type: "ESModule",
        path: "worker.mjs",
        contents: `import { measure } from "./entry.mjs";\nexport default { fetch: () => new Response(JSON.stringify(measure("workerd"))) };\n`,
      },
      { type: "ESModule", path: "entry.mjs", contents: code },
    ],
    compatibilityDate: "2026-07-01",
  });
  try {
    return await (await mf.dispatchFetch("http://localhost/")).text();
  } finally {
    await mf.dispose();
  }
};

console.log(
  host === "workerd" ? await inWorkerd() : await inBrowser(host === "webkit" ? "webkit" : "chrome"),
);
