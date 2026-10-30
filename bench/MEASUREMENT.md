# Benchmark estimator and rounding

Read this before changing `estimator.ts`, `baseline.ts`, `prior-art/compare.ts`, or another language's
benchmark harness. These rules keep rows comparable and make reported precision match repeatability.

## Sampling

- Warm up by invocation count. Tiering runtimes optimize after calls, so duration-only warm-up can
  time a slow subject before it reaches steady state.
- Stop when samples converge within a wall-clock budget. A fixed batch count has neither a stability
  condition nor a time bound.
- Take the minimum within one process. Unrelated work can add latency but cannot make the operation
  faster.
- Fork fresh processes and take the median of their minima. Report their spread as the error bar;
  repeated batches in one process share JIT, heap, and GC state.
- Interleave subjects within a fork so machine drift affects rivals together. Compare ratios inside
  that process.
- No within-run estimator proves repeatability across separate runs. Record machine load and rerun
  when the spread changes the decision.
- A batch total divided by its calls measures average throughput cost, not individual-call latency or its tail. Measure those calls separately when responsiveness decides the change.
- Shared-process ratios can retain JIT and allocation interactions between subjects. Confirm consequential source comparisons with independent processes and the packed public route; equal call-site exposure does not prove equal optimizer effects.
- Independent processes can still share the same layout bias. When a small result determines a design, vary otherwise irrelevant launch layout across processes and retain the spread; environment padding belongs at process launch, not inside a timed batch.

`bench/estimator.ts` owns the JavaScript method. Rust uses the same sequence in `rust/bench` because
process-boundary timing would dominate short operations. Change both implementations together.

## Published precision

- Speed uses the fixed log-uniform ladder in `bench/estimator.ts`. A fixed grid prevents unchanged
  values from moving only because an error bar changed.
- Do not keep an old value merely because a new sample overlaps its error bar. That makes noisy cells
  permanently stale and bypasses the current rounding rule.
- Peak memory uses whole MiB after repeated-process measurement. Its noise differs from speed,
  so it does not use the speed ladder.
- Deterministic byte size is exact. Publish bytes or derive display units from the same recorded
  value.
- Apply a rounding rule only to the instrument whose repeatability established it. Re-measure before
  changing precision.
