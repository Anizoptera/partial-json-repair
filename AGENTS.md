# partial-json-repair

Recover values from damaged or streaming JSON, expose typed outcomes, and collect repair reports
only when requested. Zero runtime dependencies in the recovery core.

## Core

Every invariant below follows from one of these. When a rule seems to conflict, THESE win.

- **Preserve source content.** Requested reports identify recovery changes and losses with their
  paths. Report collection is optional; typed refusal and stopped processing are not.
  Nothing is appended to mark incompleteness unless the caller sets `cutSuffix`; the cut marker still
  identifies it.
- **Keep useful recovery on failure.** Attach available partial data to the failed outcome;
  never disguise stopped or refused recovery as success.
- **One mechanism decides what the bytes mean.** A fast pre-scan may hand input to a built-in parser
  only where a differential test against the scanner proves the same result.
- **Detection is conservative, recovery is forgiving.** Opposite dispositions on purpose. Never leak
  one into the other.
- **TypeScript efficiency comes before easy porting to Rust;** the recorded corpus is the contract a
  later Rust catch-up must meet.
- **Same input, same answer on every route (HLD P3).** `parse`, `repair`, `findJsonSpan` and
  `parseMany`; text or bytes; one chunk or any split; values, fragments or views; synchronous,
  cooperative or worker. A behaviour change is unproved until it holds on each. Add a corpus seed for
  it: the recorder replays every whole-input verb over text and bytes, a seed written as `chunks`
  adds the stream profiles (values, fragments, views), and `async:conform` replays it
  cooperatively. Anything that waits for input across chunks also needs
  an every-split test. The worker route has no corpus replay; check it through packed calls.

## Build capability, never ceremony

**This project is measured by what callers can do with it, and nothing else.** Every token spent on
process instead of missing capability is waste the maintainer pays for. Agents here have repeatedly
burned whole sessions on work with negative value; this section exists so you never do it again.

Before choosing ANY work, write down the HLD capabilities that do not yet work end to end for a
caller (read `HLD.md`, then `docs/API.md`, then the code and tests that would prove each). Work the
most important missing one. Only two things may come first: a correctness, data-loss, resource or
cancellation defect in shipped behaviour, and a red gate that blocks committing that work.

These are ceremony. Do NOT do them unless the maintainer names them in the current request:
- ROADMAP bookkeeping beyond ticking a finished item or adding one line for a found gap: no
  "measured ceiling" paragraphs, rejection-table essays, or closing items "by their kill clause".
- Speed, size, minification, rebaselining or benchmark work while any capability is missing.
- New checkers, gates, test harnesses, packed-run switches or audit passes (coverage sweeps, clone
  detection, duplication hunts) that no failing caller job demands.
- Ritual proof: planting defects to prove an obvious test, re-running full gates after doc-only
  edits, multi-paragraph commit bodies, essays in reports.
- Asking the maintainer to approve designs you have not first made simple, strict and hard to misuse.

THE TELL: your last several commits are `docs(roadmap)`, `chore(size)`, `test:` infrastructure or
`refactor` with no caller-visible capability added. Stop, list the missing capabilities, and build one.
A report states which caller job now works that did not before; if none, say so in one line.

## Who calls this, and what they need

Read this before choosing a default, a recovery or an outcome shape. A choice is right when it
serves these jobs. Satisfying a rule in isolation does not make it right.

- **Streamed model output shown while it arrives.** Callers re-parse the growing buffer on every
  chunk and show each field at once. Fields hold prose, LaTeX, code and graph source with raw line
  breaks. Each parse must return the best reading of the input so far, and later input must repair
  an earlier reading it proves wrong (HLD: later input may revise an unfinished value). Prefer the
  reading that later input extends: the screen then never shows text it must take back. Use every
  clue the input already holds: code cut after `}` keeps it only when the string opened the bracket
  that `}` closes; otherwise the `}` closes the JSON. Only content already handed out as fragments or
  completed values cannot be taken back.
- **A finished model reply turned into one object.** The reply often sits inside prose or a fenced
  block. Callers read fields by name against a schema, so a wrong field value flows straight into the
  application.
- **Truncated records recovered with an account of the damage** (logs, JSONL). The caller shows the
  record as recovered, with its issues. A clean-looking result for damaged input fabricates history.
- Any other untrusted text or bytes holding JSON (HLD Purpose).

These jobs rank failures:
1. **Worst: a wrong value that looks right.** That is `ok`, high confidence, or a member the input
   never spelled. Callers act on it, and many read only `value`.
2. **Next: a refusal, or `complete: false` with the source text kept.** It costs the caller a retry.
3. **Least: slowness.**

So when the literal reading of damage builds a member the input never spelled, that reading is a
defect, not an honest alternative. Prove a default with a run, never from memory: against inputs
these callers receive, and against what rivals return (`bench/prior-art`).

## Authority

Read `HLD.md` before planning or changing public behaviour, then read `docs/API.md` for its derived
contract. Derived docs and task lists cannot add a product, guarantee, user-visible mechanism or irreversible
commitment absent from the HLD. Change HLD only through a maintainer-approved exact delta, except
where HLD.md's header lets you replace a refusal of recoverable JSON with reported recovery: that is
a defect to fix, never a question.

HLD.md is agent-only. Public docs (README, SECURITY, CHANGELOG, CONSUMER-AGENTS, `docs/API.md`,
`docs/PRIOR-ART.md`, `docs/MIGRATION.md`) NEVER name or link it; state the guarantee or reason
itself. CONSUMER-AGENTS.md ships as `dist/AGENTS.md`: guidance for agents USING the package, not
for agents working here.

Make technical decisions yourself using HLD priorities, caller benefit, correctness, failure recovery, compatibility and measured cost. Test assumptions that could change the choice. Diagnose failed or inconclusive checks; do not seek a ruling, exception or weaker completion criteria merely because the cause is unknown. Before proposing an HLD change, name the observed requirement conflict; missing measurement evidence stays an investigation task. Before asking, state which required user outcome and next action each answer changes. If all answers leave the same work, do that work. Put the reason beside the code or rule it explains. Apply approved exceptions without asking again or extending them; D5 defines the generic-worker exception.

For an API or parser change, choose the design by comparing caller tasks, required output, caller memory, failure recovery and compatibility. Do not ask which feature, implementation or API spelling the maintainer prefers when HLD priorities or evidence decide it. A default, a value conversion or the set of inputs a recovery accepts changes what callers see and is still engineering here: derive it, even though global guidance reserves user-visible decisions. Gather the deciding evidence before choosing or asking: the jobs of our own callers (the maintainer's private projects that import this package or its predecessor), what rival libraries return (`bench/prior-art`), and measured host behaviour. A claim about another system in a design or question comes from a run, never from memory. When the derived design contradicts an HLD sentence, ask only to approve that exact sentence change, with the design, evidence and failure cases attached. A new mode needs a caller benefit beyond avoiding a difficult implementation. Ask only about a requirement conflict those priorities cannot settle, or approval of a necessary exact HLD change. Present one design, its costs, failure cases and the unresolved consequence. A roadmap proposal proves neither necessity nor approval.

Derive API types and data shapes from HLD capabilities. For scalar fragments, keep decoded-content processing and bounded source-text delivery for copying oversized selected scalars. These serve different caller tasks; do not ask which to keep.

Use a question tool only when its contract supports the question in this coding session. Do not open a browser tab solely to ask a coding question. If no suitable structured tool accepts approval requests, ask explicitly in this conversation and hold dependent work; a failed tool call is not a delivered question.

Before proposing to remove or drop a public export, option or behaviour, name the user job it serves;
if one exists, HLD D1 forbids removal — redesign it. "Only the ancestor had it", "a few caller lines"
and "can be added later" never prove a feature useless.

## Status

Before npm packaging or release work, read `docs/RELEASE.md`. Both packages must use `@anizoptera/publish-clean`; validate its final cleaned archives and preserve those exact bytes through publication and recovery.

An empty initial state does not cancel a requested future capability. Keep the machinery and test both the empty and populated cases; remove it only when the maintainer changes that scope. In release work, no published predecessor skips historical comparisons, never the compatibility, notes or version machinery required for subsequent releases.

Pre-release: nothing is promised yet. Every doc except the HLD is a draft and may be wrong. Work
happens in the public repository `Anizoptera/partial-json-repair` (remote `origin`); the private
remote `private` keeps only the pre-publication history, on branch `history`.
**Every tracked file is public.** Never commit private project, package or repository names, local
paths, machine details, credentials or personal data, in any file, comment, fixture or commit
message; keep that context in the session. Before each commit, read the diff for them.
Only local preparation is authorized. Leave the release process and its approval requests deferred until the maintainer explicitly starts it. Creating the public repo, publishing to npm and pushing a tag each need separate maintainer permission.

## Working scope

**Slowness alone never blocks development, review or release.** Keep timing misses, regressions and
unknown causes as later optimization work. Before calling anything a blocker, name the demonstrated
failure beyond speed and its user consequence; a missed timing target is not that failure. Keep
correctness, data preservation, resource ownership and working cancellation separate from latency.
Read HLD.md's priorities before classifying a measurement; targets guide improvements, not release holds.

Treat status requests and corrections as part of the active task. Reply in commentary and continue
authorized work. End the turn only when the task is complete, the user tells you to stop, or a real
blocker leaves no independent authorized work.

Judge bundle efficiency by what each public import lets supported bundlers remove. Fix unnecessary
retention, initialization and dependency coupling before chasing byte counts; raw or compressed
size alone does not prove an architectural defect. Read `docs/CONSUMER-GRAPH.md` before measuring.

Choose work from the HLD dependency chain. Prove cheap route checks before slow measurement. Run each
expensive owner once and reuse its result. A skipped, excluded, or empty matrix member is unproved.
Before carrying a blocker into a plan or status report, inspect its latest failure output and compare
source, conditions and verdict. Keep an unresolved supported-contract failure open until its affected
probe passes on the current candidate and failing runtime; unrelated passes do not qualify it. Separate observed failures from untested members; a plan's old label is not evidence, and a later pass does not explain an earlier failure.
Add a checker only when no current instrument reaches
a material user route. Do not create persistent audit logs, heap dumps or a `.release-evidence/` store. Use command-owned temporary directories, print actionable results, and remove scratch on success, failure and cancellation. Keep reproducible cases and essential reasoning in source; keep only unfinished work in the plan. Release artifacts belong only to an explicitly requested release or review, never an audit journal. Never use `.git` as scratch.
Complete release work on this machine; do not start OrbStack or provision infrastructure for checks. Local measurements must not be labelled as remote CI evidence.

Use Bun's registry and update commands for npm dependency freshness; do not browse release pages or fetch registry metadata before an ordinary update. Use the existing version managers for runtime binaries. Update the requested packages, preserve intentional pins, inspect the manifest and lockfile diff, and run the existing gates. Read release notes only to resolve a concrete compatibility question; package-manager output already identifies the resolved versions.

**Work only in this tree, on the current branch: no branches, worktrees or merges** (maintainer
ruling). Helper agents never commit. Each writes its files in a scratch directory outside the tree
(`/tmp/pjr-<lane>/`), and the lead moves them in at handover, reviews and commits. Owning separate
files is not enough: typecheck, lint and test discovery read every file in the tree, tracked or not,
so one unfinished helper file fails the lead's commit gate.

**Register scratch cleanup before work starts:** use `finally` or an EXIT trap for success, failure
and cancellation; the lead also removes helper directories after handover. Delete probe scripts,
backups and extraction trees when their result is recorded, not at sprint end.
Use `rm -r --` for task-owned scratch paths and verify absence; the shell guard rejects force flags even in cleanup traps.
Full `bash scripts/clean-generated.sh` removes generated outputs; each command owns its temporary scratch.
Run cleanup after build or benchmark work closes, never while artifact readers are active.
Before handoff, enumerate task scratch and verify its removal. A tree copy
holds tracked files only (`git archive <ref> | tar -x -C <dir>`) with `node_modules` symlinked;
a full copy drags every build output along. Never follow those links during cleanup.

## When something surprises you

Fix wrong, missing or unreachable guidance before the work that depends on it: repair the owning
text, align the plan, then change code. Preserve HLD approval boundaries.
Contradicted by code, a gate, or a tool? Tell the user and investigate through `record-agent-gotcha`;
do not invent a cause. Put prevention in the narrowest `AGENTS.md` visible at the decision point,
with a trigger to read any linked detail. Name that auto-loaded owner before treating an existing
rule as sufficient; a rule the affected workflow cannot reach is still defective.
Prefer existing types, lint or checks for mechanically decidable failures; do not add a checker
that cannot distinguish the defect from lawful behavior.

Treat a session-injected copy of this file as authority, not as current patch context: read the
tracked bytes before editing because another committed revision may already be on disk.

## Gates

`bun run check` is the complete gate. The hook chooses checks from Git changes; scripts/AGENTS.md
owns that scope. `wiring:check` proves Git calls it.
Build before standalone `typecheck` or artifact checks; benchmark types and packed consumers read
`dist/`, which cleanup removes. Prefer the complete gate's declared build dependencies.

- **Qualify the latest stable runtime first, then the older releases required by HLD's support matrix.** Verify release freshness through the installation owner; an installed pin alone proves no freshness. Name each result's runtime version and role (latest or compatibility). Reproduce a suspected host defect with the same native operations and input, without this library. For a proved limitation in an older runtime, document the affected version/API and a working supported path; do not build complex runtime-specific workarounds or weaken tests merely to make that old API pass. A parser failure on unchanged input remains ours to fix.
- **Run Bun checks through a supported version's absolute binary.** The shell default may be an
  installed patch outside the HLD matrix; verify the version before the first check and ensure Git
  hooks inherit the same binary through `PATH`. asdf picks versions by directory: a probe run from a
  scratch directory gets other runtimes unless the repo's `.tool-versions` is symlinked in, so check
  `node --version` and `bun --version` from where the probe runs.

- Use `&&` or `set -e` for dependent shell steps, then require the nested command's zero exit status before dependent work. An outer tool can finish while its command still returns a session ID: wait for that command to exit. Tools can return failure without throwing. A pipe reports its last command unless `pipefail` is active.
- Run optional probes separately; `|| true` can clear an earlier failure in the same list.
- Inspect staged and unstaged diffs after the hook. It may format and stage only part of a file.
- **Commit whole files, named: `git commit --only -F <message> -- <files>`.** First read `git diff HEAD -- <files>`; no diff means no commit. The Bash guard refuses
  a commit without a `--` pathspec, and a named path commits that file's working-tree content, never
  a partial staging of it. Finish a file's change before committing it; to land two changes in one
  file separately, commit after the first. Check `git show --stat HEAD` lists exactly those files.
  Stage each new file by its literal path first; `--only` cannot commit an untracked path.
- **A commit that changes what a package user gets adds its `CHANGELOG.md` line under
  `## Unreleased` in the same commit.** That is anything shipped that a caller can notice:
  behaviour, speed, bundle size, types, exports, or the README and CONSUMER-AGENTS text. Release
  notes are copied from this section, so a change left out of it ships unannounced. Internal refactors, tests, gates and the ROADMAP need no line.
- Add lanes in `scripts/check.ts`; `scripts/AGENTS.md` owns dependencies and step contracts.
- Both test runners, corpus conformance, artifacts, and steering are gated by their owning checks.
  Rust is outside the gate: run `bun run rust:check` by hand when `rust/` changes. Read the
  directory guidance before changing any of them.
- CI runs `bun run check` as two parallel jobs, `--commit` and `--complete-only`, which partition
  its steps. Keep all workflow logic reproducible through that command.
- Read `.oxlintrc.json` before changing lint policy. Judge a rule by the code its fixer writes.
- Oxfmt ignores Markdown. Check Markdown edits yourself.

## Instruments that lie

- Read a public function's signature and result types before writing a probe. Keep typed results typed; do not guess array nesting, position units or failure fields in an unchecked inline script. A probe that fails on its own result handling provides no evidence about the library.
- Before composing packed consumer probes, read `scripts/AGENTS.md#consumer-checks` for generated-program setup and completion checks.
- Before reading an existing file, copy its path from current `rg --files` output or an opened artifact. An unknown path needs a discovery call before the read call; never put a guessed read beside its discovery. Never construct a path from a feature name; a failed read remains uninspected. A script that uses a file another step produces (an archive, a report) takes the path that step prints or returns, never a guessed output layout.
- Count before narrowing or truncating search output. Search generated JSONL separately by stable
  IDs or fields; truncated output proves nothing.
- Treat a truncated tool result as unread, including every member of a combined read. Reacquire
  named files in bounded ranges before making claims; budget both `functions.exec` output and its
  nested command output, including metadata. Before combining reads, measure their byte lengths;
  paragraph-length rows defeat line-count estimates. Read unknown output one member per call.
  Do not rerun a large batch unchanged.
  Capture combined commit/check output in a task-owned log before execution. Read the failure summary
  first, then the named cases in bounded ranges; the full log can include the passing suite.
- **Quoting ANY number — README, `docs/PRIOR-ART.md`, a commit message, the maintainer?** Read
  `bench/AGENTS.md` FIRST. It owns producing, rounding, re-measuring and citing a figure, and nothing
  in the lane watches any of it. Benchmarks live in `bench/` and never gate.
- `rg` recurses by default; `-r` means replacement and can corrupt displayed evidence.
- Search possible binary files with `rg --binary` or `grep --binary-files=binary`. Check `type grep`
  first because agent shells may wrap it. Write control characters as escapes. See
  `corpus/AGENTS.md` before corpus searches.
- **Never inspect a recovered value through `JSON.stringify`.** It prints `NaN` and `Infinity` as
  `null` and DROPS `undefined` — the exact distinctions you would be looking at. Use `Object.is` or
  read the value.
- **Bun's `console.log` and `Bun.inspect` omit an own `constructor` key**, on any object, so a
  dangerous-key result reads as dropped when it is present. List keys with `Reflect.ownKeys`, or
  print with `inspect` from `node:util`.

## Contract facts

Stream-consumption recipes must handle failed outcomes and release owned scheduled work in
`finally`. Compiling an example proves its types, not that cancellation, source failure or a
throwing handler stops its background work.
Preview recipes render available failed recovery before notifying failure handlers; another
animation frame may never run. Keep that recovery separate from successful returned values.
Multiplexed stream recipes pass the source identifier with every outcome, including EOF recovery;
equal payloads cannot identify which call or block produced them.

Facts about the PROBLEM, not about the old code, so they survive the rewrite and bind the Rust port
too.

- **Each completed stream value is delivered exactly once, by the first iteration after it
  completes** — a delta, not a running total. Values a caller did not read from an earlier `feed()`
  arrive first in the next iteration and count toward `maxRetained`. The consumer accumulates.
- **Recovery strategies run in priority order; changing the order changes results.** The sequence is
  part of the spec — porting the set without it is a silent behaviour change.
- **Async execution is chosen before input is consumed and never changes afterwards.** `execution`
  is required and takes an imported strategy (`auto`, `cooperative`, `worker`), never a string, so an
  app ships only the strategies it names. Never add an omitted default: every verb would reference it
  and every app would ship its executor. Each strategy value carries its own executor; verbs import
  none. Inline is `auto`'s automatic optimisation, not a forceable value. A later native engine or automatic worker placement
  arrives the same way, as another imported value, so adding it breaks no caller and costs no other app a byte.
- **A plausible malformed spelling is implementation work, not a product-policy question.** Add a
  named, switchable recovery kind and corpus case. Escalate only when HLD priorities cannot rank
  competing user outcomes.
- **The dangerous-key set is exactly**: `__proto__`, `constructor`, `__defineGetter__`,
  `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__`. One definition, one insertion point.
- **`confidence` (0.0–1.0) decays multiplicatively**, `∏(1 - penalty)`, never additively. `1.0`
  clean, `< 0.7` consider retrying the model, `< 0.5` likely garbled. Formatting repairs (trailing
  commas, single quotes, comments) carry **zero** penalty — nothing was guessed, so nothing is less
  certain. After release, moving those thresholds breaks consumers even though no type
  mentions them.

## Where the rest lives

Each directory carries its own `AGENTS.md`, loaded only when you touch that tree. Read the one you
are working in BEFORE the first edit.

- `src/AGENTS.md` — scanner, builder, policy, streaming, and API-shape invariants.
- `test/AGENTS.md` — why two runners, and how to read a disagreement between them.
- `scripts/AGENTS.md` — the gate lane, and what each step actually asserts.
- `corpus/AGENTS.md` — the conformance contract and its two input banks.
- `rust/AGENTS.md` — the port. It transliterates `src/`; it does not redesign it.
- `bench/AGENTS.md` — binds for every benchmark, profile, performance claim, or quoted number.

Docs that never auto-load, so go and read them when the topic comes up:

- `HLD.md` and `docs/API.md` — see Authority above.
- `docs/MIGRATION.md` — legacy capability mappings and unresolved differences; read before parity claims.
- `CHANGELOG.md` holds the release notes (see Gates for when to add a line); `docs/DESIGN-REVIEW.md`
  holds settled API reasoning.
- `docs/PRIOR-ART.md` — measured comparison against rival libraries, and what this package owes
  json24. READ IT before answering "why not just use X" or touching attribution.
- `SECURITY.md` — draft resource bounds of the `max*` options.
- `docs/CONSUMER-GRAPH.md` — the rules for exports, build output, `sideEffects`, PURE annotations,
  minification and the size harness. READ IT before changing any of them.
