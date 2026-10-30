// SPDX-License-Identifier: Apache-2.0

import { it } from "vitest";
import { request } from "node:http";
import { listen, HTTP_SERVERS } from "../bench/prior-art/http-server";
import { parseStream, stringify } from "../src/index";
import { cooperative, parseAsync } from "../src/async";
import { httpRequestProbe } from "./http-request-probe";

it.each(HTTP_SERVERS)(
  "%s preserves HTTP recovery before EOF and after an interrupted upload",
  async (framework) => {
    await httpRequestProbe(
      listen,
      framework,
      parseAsync,
      cooperative,
      parseStream,
      stringify,
      request,
    );
  },
);
