// SPDX-License-Identifier: Apache-2.0

import type { Result } from "./types";
import type { Exact } from "./options";
import { checkHelperOptions, configurationError } from "./configuration-error";

/** A synchronous caller-supplied parser tried by {@link tryParsers}. */
export type CustomParser = (text: string) => unknown;

export type TryParsersOptions<T = unknown> = {
  /** Accepts the first parsed value worth returning. Objects and arrays are accepted by default. */
  isResult?: (value: T) => boolean;
};

export type TryParsersFailure =
  | { readonly kind: "async-parser"; readonly parserIndex: number }
  | {
      readonly kind: "result-inspection-failed";
      readonly parserIndex: number;
      readonly cause: unknown;
    }
  | { readonly kind: "acceptance-failed"; readonly parserIndex: number; readonly cause: unknown }
  | { readonly kind: "parsers-exhausted"; readonly attempts: number };

const structured = (value: unknown): boolean => value !== null && typeof value === "object";
const ignore = (): void => undefined;

/** Tries synchronous caller parsers in order and returns the first accepted value unchanged. */
// Parser results supply callback context; exact options reject typos in forwarded variables too.
export function tryParsers<
  const P extends readonly CustomParser[],
  Options extends TryParsersOptions<ReturnType<P[number]>> | undefined = TryParsersOptions<
    ReturnType<P[number]>
  >,
>(
  text: string,
  parsers: P,
  options: Exact<Options, TryParsersOptions<ReturnType<P[number]>>>,
): Result<Exclude<ReturnType<P[number]>, PromiseLike<unknown>>, TryParsersFailure>;
export function tryParsers<
  const P extends readonly CustomParser[],
  // eslint-disable-next-line typescript/no-unnecessary-type-parameters -- Explicit generic forwarding needs this non-inferred overload; optional inference hides union typos.
  Options extends TryParsersOptions<ReturnType<P[number]>> = never,
>(
  text: string,
  parsers: P,
  options?: Exact<NoInfer<Options>, TryParsersOptions<ReturnType<P[number]>>>,
): Result<Exclude<ReturnType<P[number]>, PromiseLike<unknown>>, TryParsersFailure>;
export function tryParsers(
  text: string,
  parsers: readonly CustomParser[],
  options?: TryParsersOptions,
): Result<unknown, TryParsersFailure> {
  const isResult =
    options === undefined ? undefined : checkHelperOptions(options, ["isResult"]).isResult;
  if (isResult !== undefined && typeof isResult !== "function")
    throw configurationError({ kind: "invalid-options", field: "isResult", reason: "function" });
  const accepts = (isResult as ((value: unknown) => boolean) | undefined) ?? structured;

  for (const [parserIndex, parser] of parsers.entries()) {
    let value: unknown;
    try {
      value = parser(text);
    } catch {
      continue;
    }

    try {
      if (value instanceof Promise) {
        // Local native promises stay asynchronous even with a shadowed `then`. Bypass that property
        // when observing rejection; `catch` dispatches through it and can execute caller code.
        void Promise.prototype.then.call(value, ignore, ignore);
        return { ok: false, failure: { kind: "async-parser", parserIndex } };
      }
      if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        typeof Reflect.get(value, "then") === "function"
      ) {
        try {
          // Detection is settled. Observe native rejection without invoking custom thenables;
          // ordinary data must not pay for a receiver check that throws. Deliberately hidden
          // foreign Promise identity is outside this guard's contract.
          void Promise.prototype.then.call(value, ignore, ignore);
        } catch (cause) {
          // A receiver or construction TypeError cannot make this async result ordinary data.
          // Preserve other construction causes without guessing through caller properties.
          if (!(cause instanceof TypeError)) throw cause;
        }
        return { ok: false, failure: { kind: "async-parser", parserIndex } };
      }
    } catch (cause) {
      return { ok: false, failure: { kind: "result-inspection-failed", parserIndex, cause } };
    }

    try {
      if (accepts(value)) return { ok: true, value };
    } catch (cause) {
      return { ok: false, failure: { kind: "acceptance-failed", parserIndex, cause } };
    }
  }

  return { ok: false, failure: { kind: "parsers-exhausted", attempts: parsers.length } };
}
