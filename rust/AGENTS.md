# rust/ — the port

**The recorded corpus is the contract.** TypeScript efficiency comes before easy porting, so the
TypeScript core may move ahead; a Rust catch-up must meet the corpus the TypeScript package records.
The npm release ships TypeScript only; this tree stays outside its gate until it returns by meeting
the current recorded cases (HLD "Native and WASM (deferred)").
`src/AGENTS.md` owns design invariants, `docs/API.md` the contract, and `HLD.md` the guarantees.

`HLD.md` rules, deferred with native and WASM, that Rust programs use this as an ORDINARY Rust
library, not only as the engine behind the JavaScript package. The core crate is the product; every
binding is a wrapper over it.

Keep the Rust scan loop unless a named recovery kind cannot be expressed. `missing-colon` belongs in
`key_then_colon`, `missing-comma` in unwind fallback, and `dropped-member` in builder retraction.

## Core constraints

- **Core is `no_std` plus `alloc`.** Keep `std`, WASI, and host bindings in thin wrappers.
- **All scan state on an explicit context; no global mutable state.** Two instances in one host must
  not be able to see each other.
- **One byte-buffer ABI across variants:** pointer and length in, pointer and length out. Keep
  JavaScript-specific glue outside the ordinary Rust library.
- **`js-adapters/` holds the parked JavaScript side of native and WASM** — loaders, wire codec,
  their tests, checks and benchmarks. It is not built, linted or type-checked: it imports `src/`
  modules by their old relative paths. Reintegration returns it as an imported feature (`{ native }`
  from its own subpath), never as an option string, so no caller breaks.

## Gate

- **Outside `bun run check` and the commit hook.** Run `bun run rust:check` by hand when touching
  `rust/`: all-feature tests and Clippy, isolated feature compilation, then conformance against the
  PINNED corpus in `scripts/rust/conform.ts` — the last contract Rust met. Bump that pin only in the
  commit where Rust meets the live corpus.
- `bun run format:rust` formats; the root manifest is a virtual workspace and does not name a crate.

## Building release artifacts

Build from one clean commit and promote only the files consumers receive.

- Use `scripts/rust/cargo.ts` wherever it can run; it owns the toolchain, source-path remapping and
  musl `cdylib` flags. A target container that calls Cargo directly must carry the same policy.
- Package into a scratch destination, verify the package there, then promote only its `.tgz` or
  `.crate` into the retained set.
- Compatibility-layer execution adds evidence; only `js-adapters/scripts/native-matrix.ts host` produces a
  host record.

## Workspace shape

- Gate the product crate and unpublished conformance runner; the runner compiles against the public
  API and catches unusable API changes.
- **`bench/` has its own bare `[workspace]`** so it stays outside the product gate. Its `target/` is
  untracked.
- Add `[lints] workspace = true` to every member; Cargo does not inherit workspace lints implicitly.
- **Authored unsafe code is forbidden.** Core, boundary, and conformance crates use `forbid`.
  Transport crates use workspace `deny` because generated FFI scopes need narrow allowances.
- **A `no_std` test module imports its own `alloc` macros and types.** Parent imports do not put
  `vec!` or `String` into the child module's scope, even though the library target compiles.
- **Build the portable crate as a WASM `cdylib`, not only an `rlib`.** The standalone target must
  supply its allocator and panic handler; native tests and dependency builds cannot reveal either.

## Chunk boundaries

Missing lookahead at a chunk boundary does not mean end of input. `need_byte` and `closer_fits`
return `None`; pause and reread the lexeme when the next byte arrives. Test reader changes on both
`fed` and `ended` corpus surfaces because whole input cannot expose this distinction.

## Stream bounds

Adding `feed` and `end` does not complete the streaming contract. `maxBuffer` must bound scanner
carry, `maxRetained` must bound parser-owned recovered content, and `maxScalar` must stop an
undelimited scalar; releasing completed prefixes is part of the first bound, not a later
optimization. Keep the options documentation true after every stream change and test each limit on
an input that would otherwise grow past it.

## Conformance

**Reports have completion and refusal paths.** Test report scope, entries, counts, and completeness
through both; a completed value says nothing about a budget stop.

The recorded contract (`scripts/corpus/record.ts`) compares canonical strings so implementations need no shared type system.
Rust is another producer for the observation defined in TypeScript, not another harness. Read
`corpus/AGENTS.md` before changing conformance.

**Canonical strings never cross production bindings.** They contain non-JSON test markers. Bindings
use the typed binary protocol; only conformance uses `canonical_of`.

**A native async boundary resumes one operation and projects its terminal verb from that state.** It
never reparses after progress. Cancellation closes that state and returns only owned recovery.

**Background cancellation does not require scheduler yielding.** Each operation checks one stop
state at bounded safe points. Demand pauses remain separate. A message is a stop state only when the
worker services the channel that delivers it.

`bun run rust:conform` fails on mismatches, missing observations, and invalid records. Sampling limits
display only. Feed JavaScript chunks as UTF-16, including lone surrogates; `&str` cannot preserve
them. Rust strings and bytes use byte positions; UTF-16 uses code-unit positions.

Read differences against the row profile. Report the changed count and surface, then inspect the
source change before assigning fault.

Cluster full output by repair and refusal kind differences; these identify divergent decisions.
Within a decision-matched cluster, compare report fields. Treat cluster counts as observations, not
defect counts, and inspect member inputs before sizing work. Diff signatures and counts, not unstable
example labels.

## Facts the port must not rediscover

Root `AGENTS.md` §Contract facts holds them — delta semantics of `feed`, strategy priority order, the
dangerous-key set, multiplicative confidence. They are properties of the PROBLEM, they bind both
implementations, and they live in ONE place so the two cannot drift.
