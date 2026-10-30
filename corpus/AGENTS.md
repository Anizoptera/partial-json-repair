# corpus/ — the conformance contract

The contract is GENERATED from the two input banks by `scripts/corpus/record.ts`: every input
under every recorded profile, with its observed answers as canonical STRINGS, so this package and
the Rust port need no shared type system. Git keeps only `contract.sha256`, the hash of the accepted
recording; the ~47 MB contract itself never enters Git. `corpus:conform` records in memory and
compares the hash, and on a mismatch re-records the accepted commit to print what moved.
`corpus:record` accepts the current behaviour; `bun scripts/corpus/record.ts --out <file>` writes
the full contract for a port or a reviewer.

- **RED means CHANGED, not broken.** It records behaviour, including WRONG behaviour. Decide which
  side is right, then either fix the code or re-record and changelog the difference. **Re-recording
  without that decision buys green by deleting the evidence.**
- **Rows reference resolved option profiles.** Preset names do not contain their inherited values,
  so replaying names can silently use another implementation's defaults.
- Encode selector wildcards through `scripts/corpus/selectors.ts`. Direct JSON serialization turns
  wildcard symbols into `null`, producing a false cross-language agreement on `invalid-options`.
- Record diagnostics and keep the quiet variant. Diagnostics cover reports; quiet covers the default
  `JSON.parse` route.
- For a limit witness, inspect its resolved profile and leave competing limits unspent; `maxBuffer` also supplies `maxRetained` by default, so a decoded-value refusal can mask missing raw-source accounting.
- Keep a variant only when its observation differs. Do not prune distinct observations for file size;
  each pins behavior and offsets.
- When auditing a removed row after regeneration, replay that row through current `observeCase` and require an equivalent kept observation for the same input. Its old output cannot prove current deduplication; verify unchanged inputs and resolved profiles separately.
- **What is observed is defined ONCE**, in `scripts/corpus/observe.ts`, used by recorder and verifier
  alike. A second copy drifts, and then the comparison cannot separate harness drift from a real
  behaviour difference. A Rust conformance runner is a different PRODUCER for the same comparison,
  never a second harness.
- Keep `observe()` as the flat canonical-result API used by focused tests; recorder-only metadata
  belongs in `observeCase()` so extending the contract cannot silently change those callers.
- Keep each coverage witness once in the header; the recorder fails when a required one is missing.
- **A verifier that cannot go red is worth nothing.** Control both signs before trusting a green:
  mutate a value the corpus should watch, see it fail, revert, see it pass.

## The two input banks

Sanitize fixtures before saving them: replace private identities and credentials while preserving
tested syntax and relationships. Use reserved domains. Keep provenance, legal names, and required
notices. Review source banks before regenerating observations. `fixtures:check` catches literal email
domains only; it does not replace review for names, secrets, or encoded data.

- `corpus.jsonl` preserves inherited input IDs, order, text and chunk boundaries. Keep only those inputs, not obsolete parser options or outputs; current option profiles and observations belong to the recorded contract. Historical implementation details remain in Git. Some inputs are json24's (MIT); its notice lives in `NOTICE.md` and must stay while any of them remain.
- `seeds.jsonl` — hand-authored cases. The inherited suite captured only what it happened to
  exercise, so a capability with no test was invisible to it and is now indistinguishable from
  absent. Each seed states the gap it closes. Use lowercase hex `bytes` for malformed encoding;
  decoding it into `text` destroys the input. Verify that every added seed produces observations.
  Put option variants in the recorder's profile owners, not seed metadata. Reject unsupported input-bank fields instead of silently recording a different case from the one its author intended.
- **Edit the input banks as text, with the edit tool.** Rows hold lone-surrogate escapes that some
  JSON libraries refuse or rewrite, and a script that opens the bank for writing before serializing
  every row empties it when one row fails. A scripted change writes a new file, compares its row
  count and unchanged rows with the original, and only then replaces it.

## Searching these files

Write control characters as escapes. A raw NUL makes recursive searches omit the file. Use
`rg --binary` or `grep --binary-files=binary`; avoid text mode because it dumps binary content.
Check `type grep` first because agent shells may wrap it.
