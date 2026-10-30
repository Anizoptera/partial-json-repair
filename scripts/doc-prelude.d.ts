// SPDX-License-Identifier: Apache-2.0

/**
 * The free names documented examples lean on, declared once so each example reads like the caller's
 * own code. A script file (no import or export), so every name is ambient. Only the CALLER's side
 * belongs here — never a name this package exports, or an example could compile against a
 * declaration the package does not ship.
 */

declare const text: string;
declare const source: string;
declare const modelOutput: string;
declare const chunk: string;
declare const chunks: AsyncIterable<string>;
declare const request: Request;
declare const response: Response;
/** A Node HTTP response, as the Node-stream example receives it. */
declare const res: import("node:http").IncomingMessage;
declare const controller: AbortController;
declare function render(value: unknown): void;
declare function handle(value: unknown): void;
declare function useValue(value: unknown): void;
declare function handleResult(result: unknown, source?: string | number): void;
declare function handleFailure(failure: unknown): void;
declare function showUnmatched(unmatched: unknown, complete: boolean): void;
declare function parseYaml(text: string): unknown;
