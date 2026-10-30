// SPDX-License-Identifier: Apache-2.0

import { chromium } from "playwright-core";
import type { CDPSession } from "playwright-core";
import { PLATFORM_OBSERVATION_MS } from "./run-script";

export type BrowserView = {
  readonly engineVersion?: string;
  rendererPids?(): Promise<number[]>;
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  cdp: CDPSession["send"];
  close(): void | Promise<void>;
};

export const openBrowser = async (backend: "webkit" | "chrome"): Promise<BrowserView> => {
  if (backend === "webkit") return new Bun.WebView({ backend: "webkit" });
  // A healthy blank-page Bun bridge can still stall on renderer navigation. Both qualification
  // and timing use this owned Chromium session; native WebKit keeps its system engine.
  const executablePath = process.env.BUN_CHROME_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath === undefined ? {} : { executablePath }),
    timeout: PLATFORM_OBSERVATION_MS,
  });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    return {
      engineVersion: browser.version(),
      async navigate(url) {
        await page.goto(url, { timeout: PLATFORM_OBSERVATION_MS });
      },
      evaluate: (expression) => page.evaluate(expression),
      cdp: session.send.bind(session),
      async rendererPids() {
        // Process type comes from the owned browser, not a guess from executable names.
        const browserSession = await browser.newBrowserCDPSession();
        try {
          const { processInfo } = await browserSession.send("SystemInfo.getProcessInfo");
          return processInfo.filter((info) => info.type === "renderer").map((info) => info.id);
        } finally {
          await browserSession.detach();
        }
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
};
