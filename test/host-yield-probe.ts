// SPDX-License-Identifier: Apache-2.0

// Real ports expose resources a simulated scheduler cannot prove were released.
export const hostYieldProbe = (module: string): string => `
import { parseManyAsync as yieldMany, cooperative } from ${JSON.stringify(module)};
{
  const saved = Object.fromEntries(["setImmediate", "scheduler", "MessageChannel"].map(
    key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const NativeChannel = globalThis.MessageChannel;
  const count = 600;
  try {
    for (const key of ["setImmediate", "scheduler"])
      Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
    for (const fault of ["none", "start", "post", "close-first", "close-second", "combined", "undefined"]) {
      const setupCause = fault === "undefined" ? undefined : new Error("host task setup failed");
      const cleanupCauses = [new Error("first port close failed"), new Error("second port close failed")];
      const states = [], release = [];
      const setupFails = ["start", "post", "combined", "undefined"].includes(fault);
      const cleanupFails = index => fault === "combined" || fault === (index === 0 ? "close-first" : "close-second");
      Object.defineProperty(globalThis, "MessageChannel", { configurable: true, value: class extends NativeChannel {
        constructor() {
          super();
          const state = [0, 0]; states.push(state);
          for (const [index, port] of [this.port1, this.port2].entries()) {
            const close = port.close.bind(port); release.push(close);
            port.close = () => {
              state[index]++;
              if (cleanupFails(index)) throw cleanupCauses[index];
              close();
            };
          }
          if (setupFails) {
            const port = fault === "post" ? this.port2 : this.port1;
            port[fault === "post" ? "postMessage" : "start"] = () => { throw setupCause; };
          }
        }
      } });
      try {
        let terminal, delivered = 0;
        for await (const outcome of yieldMany('{"a":1}'.repeat(count), { execution: cooperative })) {
          if (terminal !== undefined) throw new Error("host yield replayed output after failure");
          if (outcome.ok) {
            if (outcome.value.a !== 1) throw new Error("host yield changed recovered data");
            delivered++;
          } else terminal = outcome.failure;
        }
        if (states.length === 0 || states.some(state => state.some(closes => closes === 0)))
          throw new Error("host yield left an owned port without a close attempt: " + fault);
        const expectedCleanup = cleanupCauses.filter((_, index) => cleanupFails(index));
        if (!setupFails && expectedCleanup.length === 0) {
          if (terminal !== undefined || delivered !== count) throw new Error("host yield control lost data");
        } else {
          if (terminal?.kind !== "scheduling-failed") throw new Error("host yield did not settle its typed failure: " + fault);
          if (setupFails && terminal.cause !== setupCause)
            throw new Error("host yield replaced its original setup cause: " + fault);
          if (expectedCleanup.length !== 0) {
            const cause = setupFails ? terminal.cleanupFailure?.cause : terminal.cause;
            if (expectedCleanup.length === 1 ? cause !== expectedCleanup[0] :
                !(cause instanceof AggregateError) || cause.errors.length !== expectedCleanup.length ||
                cause.errors.some((error, index) => error !== expectedCleanup[index]))
              throw new Error("host yield lost or reordered cleanup causes: " + fault);
          }
        }
      } finally {
        // A host refusing close still needs native release after the library's failure is observed.
        for (const close of release) close();
      }
    }
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }
}
`;

// EOF can hold many completed matches after the source ends; a rejected wait loses that suffix.
export const streamHostYieldProbe = (module: string): string => `
import { parseStream as yieldStream, select as yieldSelect, ANY as yieldAny, diagnostics as yieldDiagnostics } from ${JSON.stringify(module)};
{
  const saved = Object.fromEntries(["setImmediate", "scheduler", "MessageChannel"].map(
    key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const NativeChannel = globalThis.MessageChannel;
  try {
    for (const key of ["setImmediate", "scheduler"])
      Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
    for (const phase of ["chunk", "eof"]) for (const report of [false, true]) {
      const cause = new Error("stream host yield failed");
      const release = [];
      let exhausted = false, cleaned = false, intercepted = false;
      Object.defineProperty(globalThis, "MessageChannel", { configurable: true, value: class extends NativeChannel {
        constructor() {
          super();
          release.push(this.port1.close.bind(this.port1), this.port2.close.bind(this.port2));
          if (phase === "eof" && !exhausted) return;
          intercepted = true;
          this.port1.start = () => { throw cause; };
        }
      } });
      const count = 2000;
      const input = '{"items":[' + Array.from({ length: count }, (_, id) => '{id:' + id + '}').join(',') + ']';
      function* chunks() {
        try { yield input; exhausted = true; }
        finally { cleaned = true; }
      }
      const values = [];
      let terminal;
      try {
        for await (const outcome of yieldStream(chunks(), {
          select: yieldSelect([["items", yieldAny]]), ...(report ? { diagnostics: yieldDiagnostics } : {}),
        })) {
          if (terminal !== undefined) throw new Error("stream host yield replayed output after failure");
          if (outcome.ok) values.push(outcome.value);
          else terminal = outcome;
        }
        if (!intercepted || !cleaned || exhausted !== (phase === "eof") ||
            terminal?.failure.kind !== "scheduling-failed" || terminal.failure.cause !== cause)
          throw new Error("stream host yield lost its phase, cleanup or typed cause: " + phase);
        const recovery = terminal.failure.recovered;
        if (!recovery || !Array.isArray(recovery.value) || recovery.value.length === 0)
          throw new Error("stream host yield lost unread recovery: " + phase);
        const all = [...values, ...recovery.value];
        if (all.some((match, index) => match.value.id !== index) ||
            (phase === "eof" ? all.length !== count : all.length >= count))
          throw new Error("stream host yield lost, repeated or invented selected values: " + phase);
        if ((terminal.diagnostics !== undefined) !== report ||
            (report && terminal.diagnostics.counts.repairs === 0))
          throw new Error("stream host yield lost requested recovery diagnostics: " + phase);
      } finally { for (const close of release) close(); }
    }
    const cause = new Error("host yield failed before reader cancellation");
    const release = [];
    let releaseCancel, cancelled = false;
    const cancellation = new Promise(resolve => { releaseCancel = resolve; });
    Object.defineProperty(globalThis, "MessageChannel", { configurable: true, value: class extends NativeChannel {
      constructor() {
        super();
        release.push(this.port1.close.bind(this.port1), this.port2.close.bind(this.port2));
        this.port1.start = () => { throw cause; };
      }
    } });
    const source = new ReadableStream({
      start(controller) { controller.enqueue('{"ready":1}' + ' '.repeat(2000)); },
      cancel() { cancelled = true; return cancellation; },
    });
    const stream = yieldStream(source);
    try {
      let terminal, delivered = 0;
      for await (const outcome of stream) {
        if (terminal !== undefined) throw new Error("failed host yield replayed output after failure");
        if (outcome.ok) delivered++;
        else terminal = outcome.failure;
      }
      if (!cancelled || delivered !== 1 || terminal?.kind !== "scheduling-failed" ||
          terminal.cause !== cause || terminal.recovered !== undefined)
        throw new Error("failed host yield waited for reader cleanup or replayed completed recovery");
    } finally {
      releaseCancel();
      try { await stream.close(); }
      finally { for (const close of release) close(); }
    }
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }
}
`;
