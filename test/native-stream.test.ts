// SPDX-License-Identifier: Apache-2.0

import { it } from "vitest";
import { parseStream, stringify } from "../src/index";
import { webStreamProbe } from "./native-stream-probe";

it("native Web pipelines preserve split bytes, exact digits, failed recovery and reader release", async () => {
  await webStreamProbe(parseStream, stringify);
});
