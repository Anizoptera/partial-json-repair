// SPDX-License-Identifier: Apache-2.0

/** Encode worker options without loading the worker's result traversal or transfer planner. */

import type { ParserOptions } from "./options";
import type { DiagnosticsSettings } from "./types";
import type { SelectionFeature, WirePath } from "./selection-feature";
import type { Input } from "./types";
import type { WholeOperation } from "./whole-operation";
import { ownOption } from "./configuration-error";

export type Slot = readonly [object, string | number];
/** A cloned parent and its own key identify a slot without an ancestor path. */
export type Address = readonly [number, ...Slot];
/** Replace a cloned slot directly with a previously registered canonical value. */
export type Alias = readonly [number, ...Slot];
export type WorkerEnvelope = {
  readonly exact: readonly { readonly text: string }[];
  readonly frozen: readonly object[];
  readonly nullPrototype: readonly object[];
  readonly value: unknown;
};
export type WorkerOperation = WholeOperation;
export type WorkerControl = "abort" | "discard" | "pull" | "recover";
/**
 * Parser options as `postMessage` can clone them. A feature value is a function or carries one,
 * which structured clone refuses, so each crosses as the settings that rebuild it on the other side
 * (`async-worker.ts`); wildcards are symbols, so paths cross in the selection's own wire form.
 */
export type WorkerParserOptions = Omit<
  ParserOptions,
  "diagnostics" | "locations" | "select" | "skip"
> & {
  readonly diagnostics?: DiagnosticsSettings;
  readonly locations?: true;
  readonly select?: { readonly paths: readonly WirePath[]; readonly occurrences: boolean };
  readonly skip?: readonly WirePath[];
};
export type WorkerLike = {
  addEventListener?: {
    (name: "close" | "error", listener: (event?: { preventDefault?(): void }) => void): void;
    (
      name: "message",
      listener: (event: { readonly data: unknown }) => void,
      options: { readonly once: true },
    ): void;
  };
  once?(name: "message", listener: (message: unknown) => void): void;
  on?: {
    (name: "error", listener: () => void): void;
    (name: "exit", listener: () => void): void;
  };
  postMessage(message: WorkerRequest | WorkerStartup, transfer: readonly object[]): void;
  ref?(): void;
  terminate(): unknown;
  unref?(): void;
};

export type WorkerPort<Incoming, Outgoing> = {
  addEventListener(name: "message", listener: (event: { readonly data: Incoming }) => void): void;
  addEventListener(name: "messageerror" | "close", listener: () => void): void;
  on?(name: "message", listener: (message: Incoming) => void): void;
  close(): void;
  postMessage(message: Outgoing): void;
  ref?(): void;
  /** Server ports only: whether this port alone keeps the process alive. */
  hasRef?(): boolean;
  start?(): void;
  unref?(): void;
};
export type WorkerRequest = {
  readonly input: Input;
  readonly operation: WorkerOperation;
  readonly options: WorkerParserOptions;
  readonly port: WorkerPort<WorkerControl, WorkerResponse>;
  readonly stop?: SharedArrayBuffer;
  /** Keep projected recovery until delivery; absent for calls without a signal and parse results. */
  readonly retainRecovery?: true;
};
export type WorkerStartup = {
  readonly operation: "start";
  readonly port: WorkerPort<unknown, "started">;
};
export type WorkerChannel<Incoming = WorkerResponse, Outgoing = WorkerControl> = {
  readonly port1: WorkerPort<Incoming, Outgoing>;
  readonly port2: WorkerPort<Outgoing, Incoming>;
};
/**
 * A result too large to receive in one main-thread task, in the order it crosses. Receiving a
 * structured clone is one task whose cost grows with the value — an 8 MB array of 500 000 small
 * objects blocked Node 24's main thread for 94 ms and Bun's for 22 ms (M4 Max), where the HLD
 * targets 4 ms between yields — so a large result crosses as pieces, each received in its own task.
 */
export type WorkerPiece =
  /** The root: whole, or an empty shell later pieces fill. */
  | { readonly kind: "place"; readonly envelope: WorkerEnvelope }
  /** Items appended to the array at the registered slot, in order. */
  | {
      readonly kind: "items";
      readonly at: number;
      readonly envelope: WorkerEnvelope;
      readonly addresses?: readonly Address[];
      readonly aliases?: readonly Alias[];
      readonly freeze?: true;
    }
  /** Own members defined onto the object at the registered slot, in order. */
  | {
      readonly kind: "members";
      readonly at: number;
      readonly envelope: WorkerEnvelope;
      readonly addresses?: readonly Address[];
      readonly aliases?: readonly Alias[];
      readonly freeze?: true;
    }
  /** Text appended to the string at the registered slot, one too long for a task of its own. */
  | { readonly kind: "text"; readonly at: number; readonly text: string }
  /** Source completion and requested reports arrived; later pieces fill this recovery's value. */
  | { readonly kind: "recovery"; readonly at: number }
  /** Spend a property-work budget freezing containers after their identity links have landed. */
  | { readonly kind: "freeze"; readonly count: number };
/**
 * `piece` is part of the value the next `item`, `ready` or `done` completes, and the worker sends the next
 * message only when asked (`pull`), so pieces never queue up into one task. A completing message
 * holds the whole value in `result`, or none when pieces carried it.
 */
export type WorkerResponse =
  | { readonly kind: "piece"; readonly piece: WorkerPiece }
  | { readonly kind: "item"; readonly result?: WorkerEnvelope }
  | { readonly kind: "done"; readonly result?: WorkerEnvelope; readonly pieces?: true }
  /** Projected result awaits acceptance or a request for its original recovery. */
  | { readonly kind: "ready"; readonly result?: WorkerEnvelope; readonly pieces?: true }
  | { readonly kind: "failed" };

/**
 * Reads only the settings off each feature, so the main thread's async bundle imports none of the
 * feature code; the worker, which must rebuild them, imports it all. The options were resolved
 * first, so a selection here is the factory's value and carries its `wire` encoder. `false` and
 * absent both cross as absent: options reaching here are already merged, so nothing below them
 * could turn one on. Feature keys are read as OWN properties, like `validateOptions` reads every
 * key: a destructuring read would take a `locations` planted on `Object.prototype`, and the worker
 * would then answer differently from the same call run on the main thread.
 */
export const encodeWorkerOptions = (options: ParserOptions): WorkerParserOptions => {
  const plain = { __proto__: null, ...options };
  const own = <K extends "diagnostics" | "locations" | "select" | "skip">(
    key: K,
  ): ParserOptions[K] | undefined => ownOption(options, key, plain) as ParserOptions[K] | undefined;
  const diagnostics = own("diagnostics");
  const locations = own("locations");
  const select = own("select");
  const skip = own("skip");
  delete plain.diagnostics;
  delete plain.locations;
  delete plain.select;
  delete plain.skip;
  // Spread defines own data properties; assignment would invoke a caller's inherited setters.
  return {
    ...(plain as Omit<ParserOptions, "diagnostics" | "locations" | "select" | "skip">),
    ...(diagnostics !== undefined && diagnostics !== false
      ? {
          diagnostics:
            diagnostics.scope === undefined
              ? { maxEntries: diagnostics.maxEntries }
              : { maxEntries: diagnostics.maxEntries, scope: diagnostics.scope },
        }
      : {}),
    ...(locations !== undefined && locations !== false ? { locations: true as const } : {}),
    ...(select !== undefined && select !== false
      ? {
          select: {
            paths: (select as SelectionFeature & typeof select).wire(),
            occurrences: select.occurrences,
          },
        }
      : {}),
    ...(skip !== undefined && skip !== false
      ? { skip: (skip as SelectionFeature & typeof skip).wire() }
      : {}),
  };
};
