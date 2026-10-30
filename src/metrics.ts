// SPDX-License-Identifier: Apache-2.0

import type { Exact, Given, ParserOptions, StreamParserOptions } from "./options";
import type { StreamItem } from "./parser";
import type { Counted, Parser, ParseObserver } from "./parser-configuration";
import { ParserConfiguration } from "./parser-configuration";
import { configurationError, isPlainObject } from "./configuration-error";
import { resolveOptions } from "./options";
import type { TransportOptions } from "./transport";
import type { BufferMetrics } from "./measured-scan-cursor";
import { MeasuredScanCursor } from "./measured-scan-cursor";
import type { Diagnostics, DiagnosticsFeature, ParseError, RepairKind } from "./types";
import { diagnostics, overflowOf } from "./report";
import { REPAIR_PENALTY } from "./types";

export type ParseMetrics = {
  // Per-kind repair counts require scanner diagnostics: JSON.parse erases duplicate keys.
  // Splitting these calls by engine would repeat totals rather than add an observation.
  readonly parseAttempts: number;
  readonly parseSuccesses: number;
  readonly parseFailures: number;
  /** Milliseconds spent by the last fully or partially consumed call. */
  readonly parseDuration?: number;
  readonly repairs: Readonly<Record<RepairKind, number>>;
  readonly memory: Readonly<{
    bufferCleanups: number;
    bufferOverflows: number;
    maxBufferSize: number;
  }>;
  readonly security: Readonly<{
    /**
     * Blocked occurrences per dangerous key: dropped, or refused with the document under `reject`.
     * At most one entry per configured dangerous key, so the record cannot grow with the input. A
     * null-prototype object, so `__proto__` is an ordinary entry.
     */
    blockedKeys: Readonly<Record<string, number>>;
    dangerousKeysBlocked: number;
  }>;
};

/**
 * A configured parser that also counts. Pass it to `parse`, `parseMany`, `repair`, `findJsonSpan`,
 * `parseStream` or `createStreamParser` exactly like an `initParser` handle; every outcome those
 * calls produce is counted. A handle rather than methods, so a bundle keeps only the verbs it
 * imports (HLD D5) and the calls read the same with or without metrics (HLD D3).
 */
export type MetricsParser<O extends ParserOptions = ParserOptions> = Parser<
  O & { diagnostics: DiagnosticsFeature }
> & {
  /** A detached snapshot. Set `reset` to begin a new accounting interval after the read. */
  read(reset?: boolean): ParseMetrics;
  reset(): void;
};

type MutableMetrics = {
  parseAttempts: number;
  parseSuccesses: number;
  parseFailures: number;
  parseDuration: number | undefined;
  repairs: Record<RepairKind, number>;
  bufferCleanups: number;
  bufferOverflows: number;
  maxBufferSize: number;
  blockedKeys: Record<string, number>;
  /** Dangerous keys `reject` refused: blocked, but by a failure rather than a `dangerous-key` repair. */
  refusedKeys: number;
};

const emptyRepairs = (): Record<RepairKind, number> =>
  Object.fromEntries(Object.keys(REPAIR_PENALTY).map((kind) => [kind, 0])) as Record<
    RepairKind,
    number
  >;

const emptyMetrics = (): MutableMetrics => ({
  parseAttempts: 0,
  parseSuccesses: 0,
  parseFailures: 0,
  parseDuration: undefined,
  repairs: emptyRepairs(),
  bufferCleanups: 0,
  bufferOverflows: 0,
  maxBufferSize: 0,
  // Null prototype: the keys counted here are `__proto__`, `constructor` and their kin, and on a
  // plain object `counts["__proto__"]++` would hit the prototype setter instead of counting.
  blockedKeys: Object.create(null) as Record<string, number>,
  refusedKeys: 0,
});

/**
 * Creates one caller-owned accounting scope. Metrics force diagnostics inside this scope so repair
 * counts come from the parser's own report instead of a second reader of the input. Invalid options
 * throw the `configurationError`, like every other constructor (HLD). The type omits `diagnostics`;
 * a JavaScript caller passing it is refused before resolution so metrics always receive a report.
 */
export function createMetrics<O extends Omit<ParserOptions, "diagnostics"> = Record<never, never>>(
  options: Exact<O, Omit<ParserOptions, "diagnostics">>,
): MetricsParser<O>;
export function createMetrics<O extends Omit<ParserOptions, "diagnostics"> | undefined>(
  options: Exact<O, Omit<ParserOptions, "diagnostics">>,
): MetricsParser<Given<O>>;
export function createMetrics<
  O extends Omit<ParserOptions, "diagnostics"> = Record<never, never>,
>(): MetricsParser<O>;
export function createMetrics<O extends Omit<ParserOptions, "diagnostics"> = never>(
  options?: Exact<NoInfer<O>, Omit<ParserOptions, "diagnostics">>,
): MetricsParser<O>;
export function createMetrics<O extends Omit<ParserOptions, "diagnostics"> = Record<never, never>>(
  options?: Exact<O, Omit<ParserOptions, "diagnostics">>,
): MetricsParser<O> {
  if (options !== undefined) {
    if (!isPlainObject(options))
      throw configurationError({ kind: "invalid-options", field: "options", reason: "object" });
    if (Object.hasOwn(options, "diagnostics"))
      throw configurationError({
        kind: "invalid-options",
        field: "diagnostics",
        reason: "metrics-report",
      });
  }
  // Overrides resolve against the inherited settings, so they must carry the forced report too.
  let inherited: ParserOptions = {};
  const resolved = resolveOptions(options, { diagnostics }, (captured) => {
    inherited = { ...captured, diagnostics };
  });

  let totals = emptyMetrics();
  // Open streams' buffer records, never their cursors: a caller may abandon a stream without
  // closing it, and holding the cursor would keep its whole buffer alive for the scope's life.
  const buffers = new Set<BufferMetrics>();

  const fold = (buffer: BufferMetrics): void => {
    if (!buffers.delete(buffer)) return;
    totals.bufferCleanups += buffer.cleanups;
    totals.maxBufferSize = Math.max(totals.maxBufferSize, buffer.peak);
  };
  // Folds an abandoned stream's record once its cursor is collected, so records stay bounded by
  // the open streams. Folding moves counts from `buffers` into `totals`, so `read` is exact before
  // and after it runs. workerd at an older compatibility date (2023-01-01, unlike 2026-07-01) has
  // no `FinalizationRegistry`; there an abandoned stream still frees its buffer and leaves only its
  // three-number record.
  const abandoned =
    typeof FinalizationRegistry === "function" ? new FinalizationRegistry(fold) : undefined;

  const recordDiagnostics = (report: Diagnostics | undefined): void => {
    if (report === undefined) return;
    for (const repair of report.repairs) {
      totals.repairs[repair.kind]++;
      if (repair.kind !== "dangerous-key") continue;
      const key = repair.path.at(-1);
      if (typeof key === "string") totals.blockedKeys[key] = (totals.blockedKeys[key] ?? 0) + 1;
    }
    // Past `maxEntries` the report stops storing entries but keeps counting them; those counts
    // complete the totals, so a document with more repairs than the cap is not under-reported.
    const overflow = overflowOf(report);
    if (overflow === undefined) return;
    for (const kind of Object.keys(overflow) as (RepairKind | "keys")[])
      if (kind !== "keys") totals.repairs[kind] += overflow[kind] ?? 0;
    for (const [key, n] of Object.entries(overflow.keys))
      totals.blockedKeys[key] = (totals.blockedKeys[key] ?? 0) + n;
  };

  const recordOutcome = (item: {
    readonly ok: boolean;
    readonly diagnostics?: Diagnostics;
    readonly failure?: { readonly kind: string; readonly issue?: ParseError };
  }): void => {
    totals.parseAttempts++;
    if (item.ok) totals.parseSuccesses++;
    else totals.parseFailures++;
    recordDiagnostics(item.diagnostics);
    // `reject` blocks a dangerous key by refusing the document, so the key arrives as the refusal's
    // issue, never as a repair; uncounted, the strictest policy would read as no attempt at all.
    const issue = item.failure?.kind === "policy-refused" ? item.failure.issue : undefined;
    if (issue?.kind !== "dangerous-key") return;
    totals.refusedKeys++;
    const key = issue.path.at(-1);
    if (typeof key === "string") totals.blockedKeys[key] = (totals.blockedKeys[key] ?? 0) + 1;
  };

  const reset = (): void => {
    totals = emptyMetrics();
    for (const buffer of buffers) {
      buffer.cleanups = 0;
      buffer.peak = buffer.size;
    }
  };

  const read = (andReset = false): ParseMetrics => {
    let bufferCleanups = totals.bufferCleanups;
    let maxBufferSize = totals.maxBufferSize;
    for (const buffer of buffers) {
      bufferCleanups += buffer.cleanups;
      maxBufferSize = Math.max(maxBufferSize, buffer.peak);
    }
    const snapshot: ParseMetrics = {
      parseAttempts: totals.parseAttempts,
      parseSuccesses: totals.parseSuccesses,
      parseFailures: totals.parseFailures,
      ...(totals.parseDuration === undefined ? {} : { parseDuration: totals.parseDuration }),
      repairs: { ...totals.repairs },
      memory: { bufferCleanups, bufferOverflows: totals.bufferOverflows, maxBufferSize },
      security: {
        blockedKeys: Object.assign(
          Object.create(null) as Record<string, number>,
          totals.blockedKeys,
        ),
        dangerousKeysBlocked: totals.repairs["dangerous-key"] + totals.refusedKeys,
      },
    };
    if (andReset) reset();
    return snapshot;
  };

  /** One stream item, counted the same way whichever stream shape delivered it. */
  const recordItem = (item: StreamItem): void => {
    if (!("ok" in item)) return;
    recordOutcome(item);
    if (!item.ok && item.failure.kind === "limit-reached" && item.failure.resource === "buffer")
      totals.bufferOverflows++;
  };

  const track = function* <P extends StreamParserOptions>(
    items: IterableIterator<StreamItem<P>>,
    started: number,
    settled?: () => void,
  ): Generator<StreamItem<P>, void, undefined> {
    try {
      for (const item of items) {
        recordItem(item);
        yield item;
      }
    } finally {
      totals.parseDuration = performance.now() - started;
      settled?.();
    }
  };

  /** `parseMany` items, counted as the caller reads them: an abandoned iteration counts only those. */
  const counted = function* <T extends Counted>(
    items: IterableIterator<T>,
    started: number,
  ): Generator<T, void, undefined> {
    try {
      for (const item of items) {
        recordOutcome(item);
        yield item;
      }
    } finally {
      totals.parseDuration = performance.now() - started;
    }
  };

  // The verbs pass their own builder and driver output in, so nothing here imports stream code:
  // a scope used only for whole input keeps the stream machinery out of the bundle (HLD D5).
  const observer: ParseObserver = {
    whole: (result, started) => {
      if (Symbol.iterator in result) return counted(result, started);
      totals.parseDuration = performance.now() - started;
      recordOutcome(result);
      return result;
    },
    stream: (build) => {
      let buffer: BufferMetrics | undefined;
      const built = build((positionAt) => {
        const cursor = new MeasuredScanCursor(positionAt);
        buffer = cursor.metrics;
        buffers.add(buffer);
        abandoned?.register(cursor, buffer, buffer);
        return cursor;
      });
      const settle = (): void => {
        if (!built.closed() || buffer === undefined) return;
        abandoned?.unregister(buffer);
        fold(buffer);
      };
      return {
        built,
        parser: () => {
          const parser = built.parser;
          return {
            feed: (chunk: string | Uint8Array) =>
              track(parser.feed(chunk), performance.now(), settle),
            end: () => track(parser.end(), performance.now(), settle),
            close: () => {
              const result = parser.close();
              settle();
              return result;
            },
            ...("snapshot" in parser ? { snapshot: parser.snapshot } : {}),
          } as typeof parser;
        },
        parsed: (stream) => {
          const started = performance.now();
          // Counted where the items leave, on the transport's own iterator, so `close()`,
          // `snapshot` and cancellation stay exactly as `drive` built them. `for await` and manual
          // `next()` both read this property.
          const next = stream.next.bind(stream);
          const close = stream.close.bind(stream);
          const leave = stream.return?.bind(stream);
          const throwing = stream.throw?.bind(stream);
          const finish = (): void => {
            totals.parseDuration = performance.now() - started;
            settle();
          };
          stream.next = async () => {
            const step = await next();
            if (step.done === true) finish();
            else recordItem(step.value);
            return step;
          };
          stream.close = async (wait?: TransportOptions) => {
            const closed = await close(wait);
            finish();
            return closed;
          };
          // Iterator exits can skip terminal next(); preserve accounting even when cleanup rejects.
          if (leave !== undefined)
            stream.return = async (value) => {
              try {
                return await leave(value);
              } finally {
                finish();
              }
            };
          if (throwing !== undefined)
            stream.throw = async (cause) => {
              try {
                return await throwing(cause);
              } finally {
                finish();
              }
            };
          return stream;
        },
      };
    },
  };

  return ParserConfiguration.create(resolved, inherited, observer, {
    read,
    reset,
  }) as MetricsParser<O>;
}
