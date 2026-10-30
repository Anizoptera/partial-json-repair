// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HTTP_MODES = ["auto", "cooperative", "stream"] as const;
export type HttpMode = (typeof HTTP_MODES)[number];
export const HTTP_ENDINGS = ["complete", "failure", "cancel"] as const;
export const MODEL_DELTA_BATCH = 32;
export type HttpEnding = (typeof HTTP_ENDINGS)[number];
export type ModelFixture = { id: string; input: string; parts: string[] };
export type Oracle = {
  input: string;
  parts: string;
  whole: string;
  stream: string;
  units: number;
  bytes: number;
  deltas: number;
};

export async function modelFixtures(root: string, revision?: string): Promise<ModelFixture[]> {
  // These are modeled tool calls, not claimed captures or repeated padding: file contents are real.
  const files = ["README.md", "docs/API.md", "docs/DESIGN-REVIEW.md", "SECURITY.md"];
  // Documentation edits must not change a failure replay's input. Git owns those bytes; avoid a
  // second stored fixture or temporary edits to the checkout. This work stays outside the service.
  const archived =
    revision === undefined
      ? undefined
      : await new Bun.Archive(
          execFileSync("git", ["archive", revision, "--", ...files], {
            cwd: root,
            maxBuffer: 16 * 1024 * 1024,
          }),
        ).files();
  const contents =
    archived === undefined
      ? files.map((path) => ({ path, content: readFileSync(join(root, path), "utf8") }))
      : await Promise.all(
          files.map(async (path) => {
            const file = archived.get(path);
            if (file === undefined) throw new Error(`Fixture revision ${revision} has no ${path}`);
            // Blob.text() drops a leading BOM; preserve filesystem UTF-8 decoding for replay.
            return { path, content: Buffer.from(await file.arrayBuffer()).toString("utf8") };
          }),
        );
  const inputs = [
    { id: "weather", input: JSON.stringify({ location: "San Francisco", unit: "celsius" }) },
    {
      id: "write-files",
      input: JSON.stringify({
        files: contents,
      }),
    },
  ];
  const large = inputs[1];
  if (large === undefined) throw new Error("Missing file-writing fixture");
  inputs.push({ id: "cut-files", input: large.input.slice(0, -137) });
  return inputs.map(({ id, input }) => {
    const parts: string[] = [];
    // Tool-argument deltas have varied token widths; network delivery deliberately coalesces them.
    const widths = [7, 19, 43, 131, 509];
    for (let offset = 0, part = 0; offset < input.length; part++) {
      const width = widths[part % widths.length];
      if (width === undefined) throw new Error("Missing delta width");
      parts.push(input.slice(offset, (offset += width)));
    }
    return { id, input, parts };
  });
}

export function modelReply(fixture: ModelFixture): string {
  return JSON.stringify({
    id: "chatcmpl-replay",
    object: "chat.completion",
    created: 1,
    model: fixture.id,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-replay",
              type: "function",
              function: { name: "write_files", arguments: fixture.input },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
}

export function modelEvents(fixture: ModelFixture): Uint8Array[] {
  const encoder = new TextEncoder();
  const events = fixture.parts.map(
    (arguments_, index) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-replay",
        object: "chat.completion.chunk",
        created: 1,
        model: fixture.id,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  ...(index === 0 ? { id: "call-replay", type: "function" } : {}),
                  function: {
                    ...(index === 0 ? { name: "write_files" } : {}),
                    arguments: arguments_,
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
  );
  events.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-replay",
      object: "chat.completion.chunk",
      created: 1,
      model: fixture.id,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\ndata: [DONE]\n\n`,
  );
  // A transport read can contain many SSE events; one event per packet would hide microtask starvation.
  const batches: Uint8Array[] = [];
  for (let index = 0; index < events.length; index += MODEL_DELTA_BATCH)
    batches.push(encoder.encode(events.slice(index, index + MODEL_DELTA_BATCH).join("")));
  return batches;
}
