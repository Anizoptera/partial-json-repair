// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import type { Server } from "node:http";

export const HTTP_SERVERS = ["elysia", "hono", "fastify"] as const;
export type HttpServer = (typeof HTTP_SERVERS)[number];
type Handler = (request: Request) => Response | Promise<Response>;
type Listener = { readonly url: string; close(): Promise<void> };
type DenoHttp = {
  serve(
    options: { hostname: string; port: number; onListen(info: { port: number }): void },
    handler: Handler,
  ): { shutdown(): Promise<void> };
};

// Keep the application identical across frameworks; all requests cross real loopback sockets.
export async function listen(framework: HttpServer, handler: Handler): Promise<Listener> {
  if (framework === "elysia") {
    const { Elysia } = await import("elysia");
    const app =
      typeof Bun === "undefined"
        ? new Elysia({ adapter: (await import("@elysiajs/node")).node() })
        : new Elysia();
    return new Promise((resolve, reject) => {
      app
        .all("/*", ({ request }) => handler(request), { parse: "none" })
        .listen({ port: 0, hostname: "127.0.0.1" }, (info) => {
          // The Node adapter snapshots port zero before binding and omits its native handle from types.
          const native = (info as typeof info & { node?: { server: Server } }).node?.server;
          const ready = async () => {
            if (native !== undefined && !native.listening) await once(native, "listening");
            const address = native?.address();
            const port = typeof address === "object" && address !== null ? address.port : info.port;
            resolve({
              url: `http://127.0.0.1:${port}`,
              close: async () => {
                await info.stop();
              },
            });
          };
          void ready().catch(reject);
        });
    });
  }
  if (framework === "hono") {
    const { Hono } = await import("hono");
    const app = new Hono().all("*", (context) => handler(context.req.raw));
    const deno = (globalThis as { Deno?: DenoHttp }).Deno;
    if (deno !== undefined)
      return new Promise((resolve) => {
        const server = deno.serve(
          {
            hostname: "127.0.0.1",
            port: 0,
            onListen: ({ port }) => {
              resolve({ url: `http://127.0.0.1:${port}`, close: () => server.shutdown() });
            },
          },
          app.fetch,
        );
      });
    if (typeof Bun !== "undefined") {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      return {
        url: server.url.origin,
        close: async () => {
          await server.stop();
        },
      };
    }
    const { serve } = await import("@hono/node-server");
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Hono did not bind TCP");
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    };
  }
  const { default: Fastify } = await import("fastify");
  const { getRequestListener } = await import("@hono/node-server");
  const app = Fastify({ logger: false });
  // Use the maintained Fetch bridge for cancellation and response backpressure, not a second shim.
  const dispatch = getRequestListener(handler);
  // Damaged JSON must reach recovery before Fastify's content-type parser can reject or consume it.
  app.addHook("onRequest", async (request, reply) => {
    reply.hijack();
    await dispatch(request.raw, reply.raw);
  });
  app.all("/*", () => undefined);
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { url, close: () => app.close() };
}
