# SPDX-License-Identifier: Apache-2.0
"""Python's `json_repair` as one runner in the `baseline.ts` matrix.

Reads `{"cases": {case: document}, "wants": {case: value}}` on stdin — the same documents and the
same expected values every runner is judged by — and prints the `Emitted` wire format. The
denominator is the standard library's `json.loads` on the clean case, measured in this process.

A rate is printed only when the parsed value equals the expected one under a STRICT comparison:
Python's `==` treats `True == 1` and `1 == 1.0`, which would let a wrong answer pass.

The estimator transliterates `bench/estimator.ts`; MEASUREMENT.md owns the reasons.
"""

import json
import sys
import time
from importlib.metadata import version

import json_repair


def same(a, b):
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    return a == b


def estimate_ns(fn):
    min_batch_ms, patience, max_batches, budget_ms = 0.5, 25, 200, 200.0
    now = lambda: time.perf_counter_ns() / 1e6
    k = 1
    while True:
        t0 = now()
        for _ in range(k):
            fn()
        ms = now() - t0
        if ms >= min_batch_ms:
            break
        # A zero reading is under one clock step: double rather than aim from an invented reading.
        k = k * 2 if ms == 0 else max(k * 2, int(k * min_batch_ms / max(ms, 0.01)) + 1)
    start = now()
    warm_until = start + budget_ms / 2
    i = 0
    while i < max(k, 100) and now() < warm_until:
        fn()
        i += 1
    deadline = start + budget_ms
    best, unbeaten = float("inf"), 0
    for _ in range(max_batches):
        t0 = now()
        for _ in range(k):
            fn()
        ms = now() - t0
        if ms < best:
            best, unbeaten = ms, 0
        else:
            unbeaten += 1
            if unbeaten >= patience:
                break
        if now() > deadline:
            break
    return best * 1e6 / k


def main():
    received = json.load(sys.stdin)
    cases, wants = received["cases"], received["wants"]
    subjects = {"json": json.loads, "json_repair": json_repair.loads}
    rates = {}
    for name, fn in subjects.items():
        cells = {}
        for case, text in cases.items():
            try:
                got = fn(text)
            except Exception as error:  # a refusal is a missing cell, not a crash of the runner
                print(f"{name} {case}: {type(error).__name__}", file=sys.stderr)
                continue
            if not same(got, wants[case]):
                print(f"{name} {case}: value differs from oracle; no rate", file=sys.stderr)
                continue
            # MB/s over UTF-16 code units, the unit every JavaScript row divides by.
            size = len(text.encode("utf-16-le")) / 2 / 1024 / 1024
            cells[case] = size / (estimate_ns(lambda: fn(text)) / 1e9)
        rates[name] = cells
    v = sys.version_info
    runtime = f"python {v.major}.{v.minor} json_repair {version('json_repair')}"
    print(json.dumps({"runtime": runtime, "rates": rates}))


main()
