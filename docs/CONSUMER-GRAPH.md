# Consumer-graph doctrine

Every change to package exports, build output, side-effect metadata, annotations, minification or the size harness must satisfy the rules below; they are Art's doctrine, kept word for word as he gave it on 2026-10-04.

## Optimise the Consumer Graph

Apply these rules within HLD D5's generic-worker exception; shared worker feature code must remain outside startup, but need not disappear from emitted worker assets.

**Library efficiency = marginal consumer cost of the capability actually imported, not the byte count of the library’s own build output.**

**Barrels MAY define a clean public API. They MUST NOT turn unrelated features into one side-effect domain or one opaque runtime namespace.**

**A smaller bundle MUST NOT override semantic disagreement. A faster build MUST NOT override worse consumer output. A single favourable bundler MUST NOT establish package-wide tree-shakability.**

**Design the package so optimisation does not depend on one clever bundler. Build with the tool that gives the best cost/control for your project; test the published package with different consumers; treat disagreement as a bug lead; and gate optimisation on semantic equivalence.**

**Could the consumer need to share, deduplicate, configure, patch, peer-match or independently update the dependency?**
If yes, externalise it. If no, bundling remains a live option.

Make optional features absent from the dependency graph, not merely disabled at runtime. Choose the builder, bundler and minifier separately; accept their combination only when the final consumer output is smaller/better/more efficient without breaking the supported behavior or loading contract.

Publish the most statically legible graph you can: native ESM, useful public entries, truthful side-effect metadata, and lazy boundaries that match real loading decisions. Never judge a library by its own dist size. Prove what a real consumer retains, removes and loads.

Tree shaking removes unreachable code. Code splitting changes when reachable code loads. Bundling changes module boundaries. Do not conflate them.

MUST preserve ESM import/export syntax through the build.
MUST NOT convert to CommonJS before the downstream optimiser.
MUST expose independently useful/heavy features as package subpaths.
SHOULD prefer named exports and statically traceable accesses.
MUST keep normal entry modules free of incidental top-level effects.
MUST isolate CSS, polyfills, registration and global mutation when possible.
MUST treat sideEffects:false as a correctness assertion, never a size knob.
MUST list every required side-effectful published file when sideEffects is selective.
MUST treat PURE annotations as semantic contracts; annotate every proven-pure calls.
MAY use NO_SIDE_EFFECTS only after verifying every important consumer tool.
SHOULD externalise peers and shared/stateful runtime dependencies.
MAY bundle private implementation dependencies when consumer sharing is irrelevant.
SHOULD let applications own lazy loading through import("pkg/feature").
MAY use internal dynamic import when asynchronous loading belongs to library semantics.
SHOULD preserve useful module granularity with multi-entry/unbundle output.
MUST NOT preserve files mechanically when it only creates module/request overhead.
MUST use explicit package exports and intentional module-format conditions.
MUST test every promised runtime/resolution condition.

Verification starts from the packed package, never workspace/source aliases.

Build consumer fixtures that import:
- one root export;
- one subpath export;
- one heavy lazy feature;
- each required side-effect entry;
- CJS and environment branches only when promised.

For each fixture:
MUST assert unrelated heavy modules are absent.
MUST assert required side effects survive.
MUST assert lazy code is outside startup cost and works after its trigger.
MUST compare optimised behaviour with a conservative/no-annotation baseline.
MUST test multiple optimiser families: Rollup/Rolldown, esbuild, webpack/Rspack.
SHOULD add Bun/Parcel when their consumers matter.
MUST validate exports/types with publint + ATTW or equivalent resolution tests.

Measure initial bytes, total bytes, compressed bytes, chunks, duplicated dependencies, and runtime cost when material. Measure producer build speed separately.

Pin tool versions, targets, conditions and minifiers. Investigate cross-bundler disagreement; it is evidence, not noise.

FAIL the release when optimisation changes required behaviour.
FAIL unexpected dependency inclusion or a meaningful per-import size regression.
NEVER fix a failing size test by adding sideEffects:false, PURE, or manual chunking until semantic safety is independently proved.

Rule of thumb:
Optimise what the consumer can prove absent, not what the producer can make look small.

## Keep features removable; choose final minification separately

Make optional features optional in the dependency graph, not merely in configuration. Choose the bundler and minifier separately, then verify their combined output against the same runtime contract.

### API and publication

- SHOULD pass imported implementations into a lean core instead of selecting from an eagerly imported all-feature registry. Keep a separate convenience entry when useful.
- SHOULD expose heavy optional class capabilities as separate functions or plugins when their dependencies cannot otherwise be removed. Do not split small, inseparable APIs without a material benefit.
- MUST inspect emitted initialization: class-property assignments, static initializers, decorators, helpers and factories can change what consumers can remove.
- MUST distinguish whole-module removal through sideEffects from expression removal inside a retained module. Neither metadata mechanism replaces the other.
- MUST interpret PURE as “this invocation may be removed when its result is unused,” not as permission to cache or reorder it. Argument evaluation still requires separate analysis.
- MUST preserve valid optimization annotations through intermediate transforms when downstream elimination depends on them; verify their placement in the packed artifact.
- MUST preserve loader directives on lazy imports, including browser exclusions for guarded Node builtins; deleting them changes the consumer's dependency graph.
- SHOULD leave reusable ESM suitable for downstream optimization. Minify final application/CDN output; justify and consumer-test any pre-minified package output.

### Minifier selection and integration

- SHOULD compare the integrated minifier with credible alternatives before replacing it. Do not add a second pass merely because another tool ranks well.
- MUST isolate comparisons on identical pre-minifier chunks, targets and semantic constraints, then verify the winning complete pipeline.
- MUST retain required dead-code elimination. A module parsed or present before final DCE is not necessarily shipped to users.
- MUST preserve chunk imports/exports, required directives, reflected names and public/serialized property names. Restrict property mangling to a proven closed contract with consistent cross-chunk mappings.
- MUST integrate minification before final content hashes and integrity metadata are computed, and compose source maps. Do not concatenate independently loaded chunks for minification.
- MUST NOT enable unsafe transforms or broad purity assumptions merely to win a size comparison.

### Verification checklist

- [ ] In a packed-package consumer, use one feature while omitting its heaviest sibling; assert correct behavior and absence of the sibling's shipped code.
- [ ] Keep a module live through one export while leaving a factory-created sibling unused; verify elimination and survival of required argument effects.
- [ ] Compare final raw bytes and independently compressed gzip/Brotli/Zstandard (YES each of 3) bytes per actually loaded chunk; record initial/total cost and duplication separately. All of the compression variants matter for browser targeted JavaScript (even potentially targeted). tar + gzip variant matters for ALL (as used for npm packaging).
- [ ] Compare required behavior before and after minification, including lazy loading and cross-chunk interactions; check source maps when shipped.
- [ ] Measure end-to-end build cost and material runtime cost. Repeat timing samples, not deterministic byte counts; report spread and pin versions/options.
- [ ] Use external benchmark data to choose experiments, not winners. Record the actual benefit and compatibility cost of the selected pipeline.
- [ ] Choose the resulting capability joint superset combination It's absolutely alright to to use bundle minifier and then other minifier on top for example, if the result is better and safe.
