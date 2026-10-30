//! One pass over the source, building the value as it goes.
//!
//! **Why one pass.** Every duplicated guard and re-parse in the package this was extracted from
//! existed because a second mechanism read the same bytes and disagreed with the first. There is no
//! event bus and no emitter: a seam with one consumer is a seam where nothing varies, and a second
//! consumer shape makes every per-token call polymorphic — measured at 3.6x on the TypeScript side.
//!
//! **Why iterative.** Recursion would put the nesting limit on the call stack, making the ceiling a
//! crash boundary rather than a budget, and it cannot stop between two characters — which is what
//! streaming needs.
//!
//! Read the source's original units so unchanged strings can borrow it. Byte and UTF-16 inputs
//! share the grammar; decoding differs only at token boundaries. The input window maps logical
//! scanner offsets to its retained slice; outcomes map them to the caller's source positions.
//!
//! Recovery uses the same branches as valid JSON, so both paths obey the same boundaries.

use alloc::borrow::Cow;
use alloc::string::String;
use alloc::vec::Vec;

use crate::builder::{Builder, Frame, Logged, PendingKey, RawFragment, path_of};
use crate::candidate::{Candidate, Verdict};
use crate::canonical::{write_str, write_units};
use crate::chars::{is_delimiter, is_ws, unit};
use crate::options::{DangerousKeyPolicy, Parser};
use crate::report::{PathStep, RepairKind, SourcePath, SwitchableRepair};
use crate::selector::Selection;
use crate::value::{JsonString, Object, Value};

mod candidates;
mod continuation;
use continuation::Paused;
pub(crate) use continuation::Released;
mod grammar;
mod input;
mod issues;
pub(crate) mod mixed;
mod recovery;
mod repairs;

pub(crate) use input::{Units, Window};
use repairs::Repairs;

pub use issues::{IssueKind, RawIssue, ScanErrorKind};

/// Why a scan could not produce a value.
///
/// Positions index the original input: bytes for UTF-8, code units for UTF-16. Every conversion
/// into a public source position happens at the edge, keeping scanner arithmetic in one coordinate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScanError {
    /// What went wrong, as a tag rather than prose: English is a formatter's job at the edge, and a
    /// reimplementation cannot be expected to reproduce wording.
    pub kind: ScanErrorKind,
    /// Original-unit offset where the scan stopped.
    pub at: usize,
    /// Where inside the partly-built value the scan was. Derived from the open frames at the moment
    /// of the refusal, which is why the frame stack outlives the failure rather than unwinding.
    pub path: SourcePath<'static>,
}

/// One alteration the scan made, before it is given a reportable position and a value index.
///
/// Separate from [`crate::report::Repair`] because the scanner speaks source offsets and a report
/// speaks the caller's units; converting here would give the scanner a second coordinate system in
/// its hottest loop.
#[derive(Clone, Debug, PartialEq)]
pub struct RawRepair<'a> {
    /// What was altered.
    pub kind: RepairKind,
    /// Original-unit offset in the input.
    pub at: usize,
    /// Where inside the value.
    pub path: SourcePath<'a>,
}

/// One rewrite of the SOURCE, for `repair(text)`.
///
/// Parallel to [`RawRepair`], never derived from it: a repair is located where a HUMAN looks — at the
/// construct's start, with the path to it — and an edit where the BYTES are, spanning exactly what
/// must be replaced. The two answer different questions, and a scan decision may leave one, both or
/// neither.
#[derive(Clone, Debug, PartialEq)]
pub struct Edit<'a> {
    /// Original-unit offset where the replaced text begins.
    pub start: usize,
    /// Original-unit offset one past it. Equal to `start` for an insertion.
    pub end: usize,
    /// What goes in its place. Borrowed where the replacement is already in the source.
    pub text: Cow<'a, str>,
}

impl RawRepair<'_> {
    fn into_owned(self) -> RawRepair<'static> {
        RawRepair {
            kind: self.kind,
            at: self.at,
            path: self.path.into_iter().map(PathStep::into_owned).collect(),
        }
    }
}

impl Edit<'_> {
    fn into_owned(self) -> Edit<'static> {
        Edit {
            start: self.start,
            end: self.end,
            text: Cow::Owned(self.text.into_owned()),
        }
    }
}

/// One value and the source it occupies, in the input's original units.
#[derive(Clone, Debug, PartialEq)]
pub struct Spanned<'a> {
    /// The value.
    pub value: Value<'a>,
    /// Original-unit offset of its first character, after any whitespace.
    pub start: usize,
    /// Original-unit offset one past its last character.
    pub end: usize,
}

/// Where a paused scan re-enters the loop.
///
/// **A one-pass scanner's position is implicit in which LINE of the loop it is on, and a stream has
/// to make that explicit.** The frames say which containers are open; they cannot say what the scan
/// was about to read. Deriving it from the tree was tried and is wrong: an object holding one
/// member with no pending key is waiting for a SEPARATOR, while the same object holding none is
/// waiting for a KEY, and nothing in the tree tells them apart — measured, it read `{"a":'b'` and
/// `, 'c': "d"}` as a key position and refused the whole document.
///
/// Set once by the pause that knows where it is, consumed once on resumption. Not a flag kept in
/// step with something else: it is the continuation itself.
#[derive(Clone, Copy, Default)]
pub(crate) enum Resume {
    /// A value belongs here — the start of the document, after an opener, or after a colon.
    #[default]
    Value,
    /// An object member's key belongs here.
    Key,
    /// The completed key is in its object frame; only its colon remains undecided.
    Colon,
    /// A value is already in its container, and what follows it — a separator or a closer — is what
    /// has not arrived.
    AfterValue,
}

/// A member removed from the tree, and the source span the repaired TEXT must lose with it.
///
/// **Deferred to the next token rather than spliced where the member is dropped**, because whether
/// it also takes a FOLLOWING comma is only decidable there: `{"__proto__":1,"ok":2}` must lose
/// `"__proto__":1,` or the splice leaves `{,"ok":2}`, while `{"a":1,"__proto__":2}` must lose the
/// comma BEFORE it and leave the one after alone.
///
/// Without this the value and the text disagreed — `parse` dropped the dangerous key and `repair`
/// handed back text still carrying it, so feeding that text to `JSON.parse` restored the member the
/// policy had just removed.
#[derive(Clone, Copy)]
pub(crate) struct Dropped {
    /// The comma before the member when there was one, otherwise where the key begins.
    start: usize,
    /// One past the member's value.
    end: usize,
    /// Whether `start` is already a comma, so the one after the member still separates what remains.
    leading_comma: bool,
}

/// Reads JSON documents out of one source.
///
/// **`crate::scalars` holds the other half of this type** — the readers for strings, numbers and
/// bare words — split off because it is a different subject, the one every remaining recovery kind
/// touches, and the same line the reference draws between `scan.ts` and `scalar-reader.ts`.
///
/// The `pub(crate)` members below are that seam, and they are deliberately NOT a decoupling: the two
/// files are one state machine, divided for navigability. Nothing outside this crate sees them.
/// Making them genuinely private to each half means the reference's three-way split — a cursor, a
/// diagnostics sink and a scalar reader as separate objects — which is a reshape worth doing when
/// something needs it, not for tidiness.
pub struct Scanner<'a> {
    pub(crate) input: Window<'a>,
    pub(crate) at: usize,
    pub(crate) options: &'a Parser,
    /// Alterations made so far, across every value this scanner has read. A report slices the ones
    /// belonging to its value; nothing here is discarded early, because a caller may ask for the
    /// report after the fact.
    /// Capped by `max_diagnostics`: a repair carries a heap-allocated path, and this is the only log
    /// whose length the input alone can drive. `kinds` below keeps what the cap costs.
    repairs: Repairs<'a>,
    /// Every repair's KIND, retained or not, at a byte apiece. Counts and confidence are read from
    /// here, so a cap on what is STORED can never make a document look cleaner than it is — and the
    /// score stays the same fold over the same kinds as an uncapped scan, rather than an accumulator
    /// whose value a per-value report would have to divide back out.
    kinds: Vec<RepairKind>,
    /// Report entries kept so far, against `max_diagnostics`. Scan-wide, because the reference
    /// spends one budget across every report a scan will produce.
    retained: usize,
    /// Decoder errors and policy refusals in observation order, bounded by `max_errors`.
    /// Report limits change entry visibility, never error counts or refusal outcomes.
    issues: Vec<RawIssue>,
    /// Errors counted against `max_errors`, never decremented.
    ///
    /// Not `issues.len()`, which retraction shrinks. A construct the scan goes on to drop takes
    /// its log entries with it — rightly, since they describe something no longer in the tree — but
    /// the scanner still READ those bytes and still spent that budget, and a counter that forgets it
    /// gives a document made of rejected candidates an unbounded number of attempts.
    ///
    /// The reference keeps the two apart for this reason: `src/scan-diagnostics.ts` increments an
    /// `errorCount` that nothing decrements, and separately stores an entry the builder may retract.
    /// So a strict profile can answer `no-json-found` with an EMPTY error log — the refusals were
    /// counted, the candidate carrying them was dropped, and the budget stayed spent.
    errors_seen: usize,
    /// A member the policy removed, waiting for the token that says whether it takes a comma too.
    dropped: Option<Dropped>,
    /// Source rewrites so far, empty unless a caller asked for them. `src/AGENTS.md`: a call pays
    /// only for the capabilities it asked for, and an edit log costs a span per decision — a cost
    /// `parse` must not carry for `repair`'s benefit.
    edits: Vec<Edit<'a>>,
    /// Whether to keep `edits` at all. Read at every recording site, so the cost of not wanting them
    /// is one branch rather than an allocation.
    logging_edits: bool,
    /// Whether the input in hand is the whole input.
    ///
    /// **The whole difference between "this string is unterminated" and "this string has not
    /// finished arriving yet", and no reader can decide correctly without it.** True for every
    /// whole-input verb, and for a stream only inside `end()`. While it is false, running out of
    /// input is not damage to repair — inventing a closer for bytes that may still arrive is the one
    /// repair guaranteed to be wrong.
    at_end: bool,
    /// A value that was begun and paused: where it started, and the logs as they stood then.
    ///
    /// **Where a value BEGAN is settled once, when it began.** Asking the candidacy question again
    /// on resumption would judge the TAIL of a value as if it were a fresh one — and answer no,
    /// because a tail carries no opener — so a container split across chunks would never be
    /// delivered at all. The mark travels with it because a value the candidacy rules eventually
    /// reject must un-log back to where IT started, not to where the last chunk did.
    resuming: Option<Paused>,
    /// Which position the pause happened at. Written beside `pause` by the pause that knows,
    /// read once by `next_value` when it records the paused value; the two are one signal.
    paused_at: Resume,
    /// Where a pause rewinds to, and the logs as they stood there.
    rewind: Rewind,
    /// Distinguish waiting for input from yielding available output to the consumer.
    ///
    /// A field rather than a third return variant because the signal must cross every frame between
    /// a scalar reader and [`Scanner::next_value`], and threading it through the signatures would
    /// put a stream's concern in the type of every strict-path call. Cleared when a scan starts, so
    /// it describes the attempt in progress and nothing else.
    pause: Option<continuation::Pause>,
    /// Where the innermost container's last separator was, and whether nothing has followed it.
    ///
    /// Two pieces rather than one because they are cleared at different moments: reading a key ends
    /// the "nothing followed" state while the comma's POSITION is still needed, to delete the comma
    /// along with a member whose value never arrived. Only the innermost container can have either,
    /// which is why one of each suffices for the whole stack.
    after_comma: bool,
    comma_at: Option<usize>,
    /// Where the logs stood when the innermost container's current MEMBER began.
    ///
    /// Taken at a container's opening and at the token after each completed member — never where the
    /// key is read, which is later. Everything between those two points describes the member too:
    /// the separator this reader inferred, the comment it removed. Dropping a member and retracting
    /// only from the KEY leaves those behind, describing bytes the repaired text no longer contains —
    /// measured, `{"a": 12 34, "b": 2}` kept the `missing-comma` it inferred before `34`, a member
    /// that then went away.
    member_mark: Logged,
    /// Where the logs stood when the last value was DELIVERED — the start of the next value's report.
    ///
    /// Not the log length at the moment a report is asked for, which is the same number only while
    /// nothing can happen between two values. A chunk boundary is exactly where something can: a
    /// byte-order mark or a comment read by a chunk that then completes no value would fall before
    /// the next chunk's reading of the length and be reported by nobody, so `\u{feff}` fed one unit
    /// at a time lost its `bom-removed` while the same bytes fed whole kept it.
    delivered_mark: Logged,
    /// Whether what is being read is JSON the source meant, rather than punctuation in a sentence.
    pub(crate) candidate: Candidate,
    /// How many values this scanner has already delivered. A second value in a document is only
    /// reachable through the first, so prose after one is not a fresh chance to be a candidate.
    completed: usize,
    root_object: bool,
    root_required: Vec<bool>,
    /// Value construction and every depth-indexed decision that must move with its frame.
    pub(crate) builder: Builder<'a>,
    /// Start of the scalar or empty container currently waiting to be placed.
    placing_start: usize,
    /// Decoded scalar state survives input pauses without replaying its source prefix.
    pub(crate) quoted: Option<crate::scalars::QuotedState<'static>>,
    pub(crate) word: Option<crate::scalars::WordState<'static>>,
    /// A bare token stopped at the decoder budget after producing a recoverable prefix.
    pub(crate) decode_stopped: bool,
    /// Undelimited numeric spelling and scan position survive release of container input.
    pub(crate) number_extent: Option<crate::scalars::NumberState>,
}

/// The last boundary the scan STOOD ON, and the logs as they stood there.
///
/// A pause rewinds to such a boundary, so what must be un-logged is not a question about offsets —
/// it is everything written since the scan was here. Offsets cannot answer it: `{"key" "` records
/// `missing-colon` AT the very byte its value then rewinds to, and resuming at a value does not
/// re-decide the colon, so a test on position drops a repair that will never be written again.
///
/// The three facts are ONE value because they are one fact. Split apart, a site could rewind to one
/// boundary while carrying another's mark, and that mismatch un-logs a span nobody chose.
#[derive(Clone, Copy, Default)]
pub(crate) struct Rewind {
    at: usize,
    resume: Resume,
    logged: Logged,
}

/// Why a construct was refused, which decides both what a report calls it and what a caller can do.
///
/// Only the first names something the caller can SWITCH on; pointing them at a switch for any of
/// the others would send them to loosen a flag that changes nothing. Kept as the reason rather than
/// derived later from the error kind, because several of them produce the same kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// A spelling a leniency switch governs. The caller can turn exactly that one on.
    Switch(SwitchableRepair),
    /// Nesting past `max_depth` — a resource bound the caller set, which no switch permits.
    Depth,
    /// A construct JSON has no spelling for at all, met under `repair_broken: false`: a control
    /// character inside a string, a string whose escapes left it unspellable. No switch is named
    /// because no leniency would make the source's own bytes spell the value.
    Unspellable,
    /// A key the caller's dangerous-key policy declines under
    /// [`DangerousKeyPolicy::Reject`]. Not switchable
    /// either: `onDangerousKey` is its own option and is not one of the leniency flags.
    DangerousKey,
}

/// A scan paused between two characters, detached from the bytes it read.
///
/// **This is what makes streaming possible without `unsafe`.** A stream's buffer grows, so nothing
/// may still borrow it when the next chunk arrives; a scanner is therefore suspended into owned
/// state at each boundary and resumed over the retained suffix plus new input. Logical offsets
/// remain unchanged when the source window moves.
///
/// Opaque on purpose: it is scan state, not a value, and a consumer who could read it would be
/// depending on how the scan is written rather than on what it answers.
#[derive(Default)]
pub struct Suspended {
    input_start: usize,
    at: usize,
    quoted: Option<crate::scalars::QuotedState<'static>>,
    word: Option<crate::scalars::WordState<'static>>,
    number_extent: Option<crate::scalars::NumberState>,
    repairs: Vec<RawRepair<'static>>,
    kinds: Vec<RepairKind>,
    retained: usize,
    issues: Vec<RawIssue>,
    errors_seen: usize,
    dropped: Option<Dropped>,
    edits: Vec<Edit<'static>>,
    logging_edits: bool,
    resuming: Option<Paused>,
    after_comma: bool,
    comma_at: Option<usize>,
    member_mark: Logged,
    delivered_mark: Logged,
    candidate: Candidate,
    completed: usize,
    builder: Builder<'static>,
    root_object: bool,
    root_required: Vec<bool>,
}

impl<'a> Scanner<'a> {
    pub(crate) fn releasable_prefix(&self) -> usize {
        let end = self.quoted.as_ref().map_or_else(
            || {
                self.word
                    .as_ref()
                    .filter(|_| !self.builder.stack.is_empty())
                    .map_or(self.at, |state| state.next)
            },
            |state| state.retained_from(),
        );
        self.number_extent
            .as_ref()
            .filter(|state| !state.raw.is_empty())
            .map_or(end, |state| state.next)
            - self.input.start()
    }

    /// The same scanner, recording the source rewrites `repair(text)` splices.
    #[must_use]
    pub fn with_edits(mut self) -> Self {
        self.logging_edits = true;
        self
    }

    /// The same scanner, honouring compiled selectors.
    ///
    /// Attached rather than read from the options, because compiling can FAIL and a constructor
    /// that cannot return an error would have to swallow it. Whoever compiles reports the failure
    /// before a byte is read — see [`Parser::selection`](crate::options::Parser::selection).
    #[must_use]
    pub fn with_selection(mut self, selection: Option<Selection<'static>>) -> Self {
        self.builder.select(selection);
        self
    }

    pub(crate) fn take_fragments(&mut self, stopped: bool) -> Vec<RawFragment> {
        if stopped {
            self.builder.flush_fragment_tail();
        }
        self.builder.take_fragments()
    }

    /// Declares that no further input will arrive, so what is open is damage rather than delay.
    ///
    /// A stream's last pass. Everything a paused scan was holding — an open container, a string
    /// still missing its quote — becomes exactly the truncation a whole-input parse would repair.
    pub fn no_more_input(&mut self) {
        self.at_end = true;
    }

    /// Where the value now being read begins in the repair and refusal logs.
    ///
    /// **Everything logged since the last DELIVERY belongs to this value**, including what was read
    /// before the value itself began: the byte-order mark stripped in front of it, a comment removed
    /// ahead of it. Slicing from where the value started instead leaves those to be reported by
    /// nobody — the entry sits in the log behind every later mark — and slicing from where the chunk
    /// started drops what a value straddling the boundary logged before it. Both are the same error
    /// at different distances, and the last delivery is the one point neither can fall behind.
    #[must_use]
    pub const fn value_mark(&self) -> (usize, usize, usize) {
        let m = self.delivered_mark;
        (m.repairs, m.issues, m.kinds)
    }

    /// Whether the input in hand is all there will be. False only while a stream is still feeding.
    #[must_use]
    pub(crate) const fn input_ended(&self) -> bool {
        self.at_end
    }

    /// Whether the scan stopped because it wants input that has not arrived, rather than because
    /// there is nothing more to read.
    #[must_use]
    pub const fn wants_more(&self) -> bool {
        matches!(self.pause, Some(continuation::Pause::Input))
    }

    /// The input ran out where more was expected.
    ///
    /// A whole-input scan CLOSES what is open: a truncated document is the commonest damaged one
    /// there is, and the caller is holding all the bytes there will ever be. A stream must not,
    /// because the same bytes may simply be mid-flight — so it rewinds to `from`, the start of the
    /// lexeme it could not finish, and the next chunk re-reads it whole.
    fn ran_out(&mut self) -> Result<Value<'a>, ScanError> {
        match self.at_end {
            true => self.finalize(None),
            false => Err(self.pause()),
        }
    }

    /// Every alteration made so far, in the order it was made.
    #[must_use]
    pub fn repairs(&self) -> &[RawRepair<'a>] {
        self.repairs.as_slice()
    }

    /// Every source rewrite made so far, in the order it was made. Empty unless [`Self::with_edits`]
    /// asked for them. **The order is load-bearing** — see `crate::parse`'s splice, where it is the
    /// only thing telling apart closers that sit at the same offset.
    #[must_use]
    pub fn edits(&self) -> &[Edit<'a>] {
        &self.edits
    }

    /// Decoder errors and policy refusals, in observation order.
    #[must_use]
    pub fn issues(&self) -> &[RawIssue] {
        &self.issues
    }

    /// Every repair MADE, as kinds, whether or not `max_diagnostics` had room to store the entry.
    /// A report's counts and confidence come from here, so a cap on storage cannot flatter a value.
    #[must_use]
    pub fn repair_kinds(&self) -> &[RepairKind] {
        &self.kinds
    }

    /// Selected occurrences completed by the accepted root, in source order.
    pub(crate) fn take_occurrences(&mut self) -> Vec<crate::builder::Occurrence<'a>> {
        self.builder.take_occurrences()
    }

    pub(crate) fn occurrences_after(
        &self,
        sequence: usize,
    ) -> Vec<crate::builder::Occurrence<'static>> {
        self.builder.occurrences_after(sequence)
    }

    /// Whether this scan returns selected matches rather than a whole value.
    pub(crate) fn selecting(&self) -> bool {
        self.builder.selecting()
    }

    pub(crate) fn accepts_root(&self) -> bool {
        !self.options.filters_roots()
            || (self.root_object && self.root_required.iter().all(|matched| *matched))
    }

    pub(crate) const fn root_is_object(&self) -> bool {
        self.root_object
    }

    /// What had been built when the scan stopped, closed off from the inside out.
    ///
    /// `HLD.md` rules that a refusal still hands the caller what was read, and this is where that
    /// data comes from: built frames still hold their retained members, while skipped and unselected
    /// frames contribute no placeholder. A pending key with no value is NOT invented a value — the
    /// member simply is not there, which keeps the promise that nothing is manufactured to mark
    /// incompleteness.
    ///
    /// Consuming, because the frames hold the only copy of what was read.
    pub fn salvage(&mut self) -> Option<Value<'a>> {
        match self.resuming.take() {
            Some(Paused::Judging { value, .. }) => Some(value),
            state => {
                self.resuming = state;
                self.builder.salvage(self.at, self.edits.len())
            }
        }
    }

    /// Disposes of one recognised non-strict construct: a repair when the caller accepts the kind,
    /// a refusal when they do not.
    ///
    /// **The one seam recovery goes through.** Both dispositions read the same bytes and build the
    /// same value, so a recogniser calls this and carries on — there is no second code path to keep
    /// in step, and no configuration under which the same input yields a different tree.
    ///
    /// It never stops the scan, not even when the refusal budget is spent: the construct in hand is
    /// finished and PLACED first, and the budget is read at the next member boundary. Measured on
    /// the recorded contract — `{"a": 'b', 'c': "d"}` under a strict profile recovers `{"a":"b"}`,
    /// so the string whose quote was refused is still part of the answer.
    pub(crate) fn lenient(&mut self, kind: SwitchableRepair, at: usize) {
        if self.options.recover.allows(kind) {
            self.record_repair(RepairKind::Switchable(kind), at);
        } else {
            self.refuse(Refused::Switch(kind), at);
        }
    }

    /// Reports a construct whose own bytes cannot spell the value it holds, when the caller asked for
    /// text that was already JSON.
    ///
    /// Not a repair and not switchable: no leniency makes a raw control character a JSON string, so
    /// there is nothing to turn on and nothing to report where `repair_broken` is set. The value is
    /// built either way — refusing to READ it would hand back a different tree per preset.
    pub(crate) fn unspellable(&mut self, at: usize) {
        if !self.options.repair_broken {
            self.refuse(Refused::Unspellable, at);
        }
    }

    /// Records a refusal, whether or not a switch could have taken it.
    ///
    /// A spent budget stops REPORTING as well as reading. Once `max_errors` refusals are in hand the
    /// scan is already over as far as the caller is concerned, and the sites that cannot check a
    /// budget — the unwind closing every container the input left open — would otherwise report a
    /// refusal apiece past the number the caller asked for: `[{"name": "John"` under `max_errors: 1`
    /// reported the unclosed object AND the unclosed array.
    pub(crate) fn refuse(&mut self, refused: Refused, at: usize) {
        self.record_issue(IssueKind::Refused(refused), at);
    }

    /// Whether a repair recorded right now belongs in the report.
    ///
    /// Judged by the INNERMOST OPEN frame, which is what makes one rule cover two answers that look
    /// contradictory. `{'a': 'b'}` under `skip: [["a"]]` keeps the skipped key's `single-quote`,
    /// because a key is read while its object — not the skipped member — is the open frame. The
    /// same input truncated as `{"a": {"b": [1, 2` reports only the ROOT's `unclosed-object`: the
    /// inner two are recorded while the skipped member's own frames are open.
    ///
    /// The caller wrote the selector, so confidence must not fall for content they declined — which
    /// is why this gates the count as well as the stored entry.
    ///
    /// **Repairs only.** A refusal inside skipped content still decides the candidate and is still
    /// charged to `max_errors`; the reference scopes only where it is REPORTED. That half is
    /// unported: no recorded row pairs `skip` with a strict profile, so there is nothing to hold it
    /// to — see `ROADMAP.md`.
    fn in_scope(&self) -> bool {
        self.options.diagnostics.audits() || self.builder.in_scope()
    }

    /// Takes one slot from the shared report budget, answering whether there was one.
    fn claim_entry(&mut self) -> bool {
        let room = self.retained < self.options.max_diagnostics;
        if room {
            self.retained += 1;
        }
        room
    }

    /// What happens to the member whose key is waiting on the top frame, as its value joins it.
    ///
    /// **The ONE place the dangerous-key policy is applied**, and BOTH routes to placing a member
    /// reach it: the unwind, and the truncation close, where the member's own container never got
    /// its closer. Guarding only the first made the policy answer differently depending on where the
    /// input stopped — `{"a": [1, 2, 3` kept a governed `a` that `{"a": [1, 2, 3]}` drops. The
    /// reference carries the same lesson from the package this was extracted from, which asked the
    /// question in three places with three answers and ran the weakest.
    ///
    /// Decided BEFORE the frame is borrowed to receive the value, because the report needs the path
    /// and the path is read off the whole stack.
    ///
    /// Answers whether the member leaves the tree, so the caller places nothing and clears the key.
    ///
    /// # Errors
    /// Under [`DangerousKeyPolicy::Reject`] the scan refuses instead of dropping.
    fn govern_pending(&mut self) -> Result<bool, ScanError> {
        // An object the policy already refused decides nothing further: a second governed key is not
        // a second refusal, a repeated key in it is not worth reporting, and no text is deleted
        // because `Frame::place` drops the member on its own. Measured against the reference:
        // `{"__proto__": 1, "constructor": 2, "prototype": 3, "safe": 4}` reports ONE dangerous-key.
        if matches!(self.builder.stack.last(), Some(Frame::Object(_, _, true))) {
            return Ok(false);
        }
        // Reported BEFORE the dangerous-key policy is applied, and at the KEY rather than the value:
        // a governed name that repeats is still a repeated key, and checking after the policy made
        // every dangerous name bypass duplicate reporting. The LAST value wins whatever the caller
        // decided — which value survives is not a policy question — so a refused switch changes the
        // report and never the tree.
        let duplicate = match self.builder.stack.last() {
            Some(Frame::Object(object, Some(p), _)) if object.contains_key(&p.key) => Some(p.at),
            _ => None,
        };
        if let Some(at) = duplicate {
            self.lenient(SwitchableRepair::DuplicateKey, at);
        }
        let governed = match self.builder.stack.last() {
            Some(Frame::Object(_, Some(p), _)) => match &p.key {
                key if self.options.is_dangerous_string(key) => {
                    Some((self.options.on_dangerous_key, p.at, p.comma, p.mark))
                }
                _ => None,
            },
            _ => None,
        };
        match governed {
            Some((DangerousKeyPolicy::Reject, at, _, _)) => {
                // Recoverable, not fatal: the caller declined a KEY, not the document, and the
                // values around it still arrive. What the policy costs is the containing object,
                // which is emptied and marked so members after the refused key cannot quietly
                // repopulate what was already declined.
                self.refuse(Refused::DangerousKey, at);
                // Replaced rather than emptied in place, so `Object` grows no clearing method for
                // one caller — and a fresh one carries the same prototype shape the options chose.
                let empty = self.new_object();
                if let Some(Frame::Object(object, _, refused)) = self.builder.stack.last_mut() {
                    *object = empty;
                    *refused = true;
                }
                Ok(true)
            }
            Some((DangerousKeyPolicy::Drop, at, comma, mark)) => {
                let start = self.drop_start(mark, comma.unwrap_or(at));
                // The member leaves the tree, so everything it logged leaves with it: those entries
                // describe bytes the repaired text will not contain, and an edit inside the span the
                // deletion below removes makes two splices overlap. Measured in the reference:
                // `{"__proto__":[1,2,],"ok":2}` repaired to `{],"ok"` and still reported success.
                self.retract(mark);
                // The LOSS is recorded AFTER the retraction, never before: dropping without
                // reporting leaves a consumer unable to tell a removed member from one the input
                // never had, and the object keeps its siblings either way.
                self.record_repair(RepairKind::DangerousKey, at);
                // The repaired TEXT loses the member too, or `repair` hands back a document that
                // restores the very key `parse` refused to keep. Which bytes go is settled at the
                // next token — see `Dropped`.
                self.dropped = Some(Dropped {
                    start,
                    end: self.at,
                    leading_comma: comma.is_some(),
                });
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Removes a dropped member from the repaired text, now that the next token is known.
    ///
    /// Called where the scan already stands on that token, never at the drop itself: see [`Dropped`]
    /// for why the span cannot be settled any earlier.
    /// Answers whether the separator the scan stands on went with it, so the caller can step past a
    /// comma that no longer exists: reading it again would set it as the NEXT member's leading
    /// comma, and a second dropped member would then delete a span already deleted.
    /// `{"__proto__":1,"constructor":2}` overlapped two splices that way.
    fn splice_dropped(&mut self) -> bool {
        let Some(gone) = self.dropped.take() else {
            return false;
        };
        // A member with no comma of its own takes the one that FOLLOWS it, or the splice leaves
        // `{,"ok":2}`. One that has a leading comma leaves the following one to separate the rest.
        let consumed = !gone.leading_comma && self.peek() == Some(unit::COMMA);
        if consumed {
            // The deletion includes following trivia; its edits must leave with those bytes.
            self.retract(self.member_mark);
        }
        let end = if consumed { self.at + 1 } else { gone.end };
        self.edit(gone.start, end, Cow::Borrowed(""));
        // The next member begins AFTER this deletion, not at the boundary that was marked before it.
        // The deletion describes the member that went, so leaving the earlier mark makes a second
        // governed key retract the first one's deletion along with its own member:
        // `{"__proto__":1,"constructor":2,"ok":3}` then keeps `"__proto__":1` in the repaired text
        // while the value drops it, which is the one disagreement `repair` must never have.
        self.member_mark = self.mark();
        consumed
    }

    /// Delete source trivia along with any member mark that retracts its repair.
    fn drop_start(&self, mark: Logged, from: usize) -> usize {
        self.edits[mark.edits..]
            .iter()
            .fold(from, |start, edit| start.min(edit.start))
    }

    /// Records one source rewrite, if a caller asked for the log.
    ///
    /// Recorded whatever the options DECIDED: a refused leniency still consumed those bytes, and
    /// `repair` must hand back text something else can parse. `undefined` becomes `null` when
    /// `js-literal` is on and the quoted word `"undefined"` when it is off — a different value, and
    /// so a different rewrite, but a rewrite either way.
    pub(crate) fn edit(&mut self, start: usize, end: usize, text: Cow<'a, str>) {
        if self.logging_edits {
            self.edits.push(Edit { start, end, text });
        }
    }

    pub(crate) fn records_edits(&self) -> bool {
        self.logging_edits
    }

    /// Records a rewrite to the JSON spelling of a string value, quoted and escaped.
    ///
    /// The value rather than the source span it came from: what the tree holds is what the repaired
    /// text must spell, and the two differ wherever the source used a spelling JSON has not — a
    /// single quote, no quotes at all, or an escape that resolved to a lone surrogate.
    pub(crate) fn edit_string(&mut self, start: usize, end: usize, value: &JsonString<'_>) {
        if self.logging_edits {
            let mut quoted = String::new();
            match value {
                JsonString::Text(text) => write_str(text, &mut quoted),
                JsonString::Units(units) => write_units(units, &mut quoted),
            }
            self.edits.push(Edit {
                start,
                end,
                text: Cow::Owned(quoted),
            });
        }
    }

    /// The same, for text the reader holds as a plain `&str`.
    pub(crate) fn edit_quoted(&mut self, start: usize, end: usize, text: &str) {
        self.edit_string(start, end, &JsonString::Text(Cow::Borrowed(text)));
    }

    /// How much has been logged, so a construct the scan goes on to drop can take its entries with
    /// it. All three logs, because a construct may have added to any of them.
    pub(crate) fn mark(&self) -> Logged {
        Logged {
            repairs: self.repairs.len(),
            issues: self.issues.len(),
            edits: self.edits.len(),
            kinds: self.kinds.len(),
            occurrences: self.builder.occurrence_mark(),
            content: self.builder.retained_mark(),
        }
    }

    /// How many SOURCE REWRITES have been recorded since `mark`.
    ///
    /// Asked by a reader that would splice the same bytes a nested reader may already have spliced.
    /// The splice deliberately does not reconcile overlaps — the reader that saw the construct is
    /// the one that knows where it ended — so the outer rewrite stands down rather than compete.
    pub(crate) fn logged_since(&self, mark: Logged) -> usize {
        self.edits.len() - mark.edits
    }

    /// Undoes everything logged since `mark`.
    ///
    /// **A retraction is not an exemption.** It is right for entries describing a construct that is
    /// no longer in the tree, and it does NOT excuse reporting the LOSS — a caller told nothing at
    /// all cannot distinguish a dropped member from one the input never had. Record the loss AFTER
    /// retracting, or the retraction takes that too.
    ///
    /// **Refusals are NOT retracted**, and the asymmetry is deliberate. A repair describes an
    /// alteration to a construct that is no longer in the tree, so it describes nothing; a refusal
    /// describes a POLICY the input met, and dropping the member does not unmake the meeting. It also
    /// SPENT budget: measured, `{"key": }` under `maxErrors: 1` reports the refused `missing-comma`
    /// and no `dropped-member`, because recording the refusal is what stopped the scan.
    pub(crate) fn retract(&mut self, mark: Logged) {
        // Only the repairs' share, since only they are going: a construct read and dropped
        // repeatedly — every rejected candidate in a prose document — would otherwise spend a
        // report's whole capacity on entries nothing ever shows.
        self.retained -= self.repairs.len() - mark.repairs;
        self.repairs.truncate(mark.repairs);
        self.edits.truncate(mark.edits);
        self.kinds.truncate(mark.kinds);
        self.builder.retract_occurrences(mark.occurrences);
        self.builder.retract_retained(mark.content);
    }

    /// Stops the scan if the refusal budget is spent.
    ///
    /// **Called before reading a NEW token, never inside one.** That is the whole rule, and it is
    /// what makes the budget a stop rather than a throw: the construct in hand finishes and is
    /// placed, and nothing after it is read. It follows that a refusal on a KEY loses the member —
    /// a key alone is not one — while a refusal on a VALUE keeps it, which is why the two cases look
    /// inconsistent in the recorded contract and are not.
    ///
    /// It also decides `scanComplete`: a stopped scan did not reach the end of the input, whatever
    /// it managed to build. A refusal on its own does not stop anything, so 452 recorded rows pair a
    /// refusal with a complete scan.
    ///
    /// # Errors
    /// `ErrorBudget` at the current position, from which the caller salvages the open frames.
    fn stop_if_spent(&mut self) -> Result<(), ScanError> {
        self.stop_if_retained()?;
        if self.budget_spent() {
            return Err(ScanError {
                kind: ScanErrorKind::ErrorBudget,
                at: self.at,
                path: path_of(&self.builder.stack),
            });
        }
        Ok(())
    }

    fn stop_if_retained(&self) -> Result<(), ScanError> {
        match self.builder.retained_failure() {
            Some(at) => Err(ScanError {
                kind: ScanErrorKind::RetainedBudget,
                at,
                path: path_of(&self.builder.stack),
            }),
            None => Ok(()),
        }
    }

    /// Whether the refusal budget is spent. Read at a member boundary, never inside a token.
    pub(crate) fn budget_spent(&self) -> bool {
        self.errors_seen >= self.options.max_errors.get()
    }

    pub(crate) fn peek(&self) -> Option<u32> {
        self.input.get(self.at)
    }

    /// Whitespace and comments, which occupy the same positions.
    ///
    /// Comments are skipped HERE rather than at each site that expects whitespace, because JSON has
    /// no syntax for them at all: anywhere a space may sit, a model may have written `// note`. An
    /// unterminated block comment runs to the end of input — the alternative is refusing to read a
    /// document because its last line was cut off mid-comment, which discards data over trivia.
    ///
    /// **That last rule holds only where the input HAS ended.** While chunks may still arrive, a
    /// comment reaching the end of the buffer is unfinished rather than unterminated, and consuming
    /// it hands the next chunk a position inside a comment, whose remaining text is then read as
    /// JSON: measured, the tail of `{ // line comment` cut mid-comment came back as an unquoted key
    /// with an inferred colon and a refusal, losing both comments the document actually held.
    ///
    /// # Errors
    /// The trivia is unfinished and more input may come; the scan pauses and re-reads it whole.
    fn skip_trivia(&mut self) -> Result<(), ScanError> {
        loop {
            while self.peek().is_some_and(is_ws) {
                self.at += 1;
            }
            let width = self.input.whitespace(self.at);
            if width != 0 {
                let start = self.at;
                self.at += width;
                self.lenient(SwitchableRepair::NonJsonWhitespace, start);
                self.edit(start, self.at, Cow::Borrowed(" "));
                continue;
            }
            if self.peek() == Some(unit::BACKSLASH) {
                match self.input.get(self.at + 1) {
                    None if !self.at_end => return Err(self.pause()),
                    Some(next) if is_delimiter(next) => {
                        // Leave the delimiter for the grammar; only its stray escape is trivia.
                        let start = self.at;
                        self.at += 1;
                        self.lenient(SwitchableRepair::EscapedDelimiter, start);
                        self.edit(start, self.at, Cow::Borrowed(""));
                        continue;
                    }
                    _ => {}
                }
            }
            if self.peek() != Some(unit::SLASH) {
                return Ok(());
            }
            let start = self.at;
            match self.input.get(self.at + 1) {
                Some(unit::SLASH) => {
                    self.at += 2;
                    while self.peek().is_some_and(|c| c != unit::LF && c != unit::CR) {
                        self.at += 1;
                    }
                    if self.peek().is_none() && !self.at_end {
                        return Err(self.pause());
                    }
                }
                Some(unit::STAR) => {
                    self.at += 2;
                    let mut closed = false;
                    while let Some(c) = self.peek() {
                        self.at += 1;
                        if c == unit::STAR && self.peek() == Some(unit::SLASH) {
                            self.at += 1;
                            closed = true;
                            break;
                        }
                    }
                    if !closed && !self.at_end {
                        return Err(self.pause());
                    }
                }
                // Whether a slash opens a comment is decided by the byte AFTER it, and that byte
                // may simply not have arrived.
                None if !self.at_end => return Err(self.pause()),
                // A lone slash is not a comment. It may still be an unquoted string, which is the
                // caller's business, so the position is left exactly where it was found.
                _ => return Ok(()),
            }
            // The comment is recognized before its first malformed sequence arrives at the decoder.
            self.lenient_at(SwitchableRepair::CommentRemoved, start, start);
            self.decode_text(start, self.at, crate::scalars::TextMode::Discard)?;
            self.edit(start, self.at, Cow::Borrowed(""));
        }
    }

    /// Consumes a container the depth budget refused, opener included, without reading it.
    ///
    /// Quote- and comment-aware, because a closer inside a string or a comment closes nothing and the
    /// skipped extent has to be the one the source wrote — anything else lands every later value at
    /// the wrong depth. Answers `false` when the input runs out mid-construct and more may still
    /// arrive; the caller pauses and the whole subtree is re-read from the opener. Input that is
    /// simply TRUNCATED skips to its end and answers `true`, so the containers still open are closed
    /// and reported as the damage they are.
    fn skip_container(&mut self) -> bool {
        let (mut nest, mut quote, mut escaped) = (0usize, 0u32, false);
        // 0 none, 1 to end of line, 2 to the closing star-slash.
        let (mut comment, mut star) = (0u8, false);
        while let Some(c) = self.peek() {
            if comment != 0 {
                self.at += 1;
                if (comment == 1 && c == unit::LF) || (comment == 2 && star && c == unit::SLASH) {
                    comment = 0;
                }
                star = c == unit::STAR;
                continue;
            }
            if quote != 0 {
                self.at += 1;
                if escaped {
                    escaped = false;
                } else if c == unit::BACKSLASH {
                    escaped = true;
                } else if c == quote {
                    quote = 0;
                }
                continue;
            }
            if c == unit::QUOTE || c == unit::APOSTROPHE {
                quote = c;
                self.at += 1;
                continue;
            }
            if c == unit::SLASH {
                match self.input.get(self.at + 1) {
                    Some(next @ (unit::SLASH | unit::STAR)) => {
                        comment = if next == unit::SLASH { 1 } else { 2 };
                        star = false;
                        self.at += 2;
                        continue;
                    }
                    // Whether a lone trailing slash opens a comment is undecidable until the next
                    // character lands, and reading it as ordinary content would end the skip early.
                    None if !self.at_end => return false,
                    _ => {}
                }
            }
            self.at += 1;
            if c == unit::OPEN_BRACE || c == unit::OPEN_BRACKET {
                nest += 1;
            } else if c == unit::CLOSE_BRACE || c == unit::CLOSE_BRACKET {
                nest = nest.saturating_sub(1);
                if nest == 0 {
                    return true;
                }
            }
        }
        self.at_end
    }

    pub(crate) fn fail<T>(&self, kind: ScanErrorKind) -> Result<T, ScanError> {
        Err(ScanError {
            kind,
            at: self.at,
            path: SourcePath::new(),
        })
    }
}
