//! Whether the brackets in front of the scanner are JSON the source MEANT.
//!
//! Prose is full of them — citations, indexes, placeholders, code — so a syntactically perfect array
//! is no evidence at all that the writer meant data. `see [1] for the citation` spells a valid
//! array, and answering with `[1]` at confidence 1.0 is a perfect answer to a question nobody asked.
//!
//! **This is a CANDIDACY question, never a diagnostic.** There is nothing to report and no
//! confidence to lower: the text simply held no value. It is also where detection's CONSERVATIVE
//! disposition lives, the opposite of recovery's forgiving one, and the two must never leak into
//! each other — a permissive detector invents values, a strict recoverer discards them.
//!
//! Apart from the scanner because it decides nothing about how bytes are read: it takes what a value
//! turned out to span and what it turned out to contain, and answers yes or no.

use crate::chars::{is_ws, unit};

/// What a read value turned out to be worth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// JSON the source meant. Delivered.
    Accept,
    /// Punctuation in a sentence. The scan resumes after it and reads on.
    Reject,
    /// Undecidable until more chunks arrive, and only ever for the stand-alone route: the claim is
    /// that this value FILLS the document, which prose in the next chunk would falsify. Delivering
    /// it now would be answering a question the input has not finished asking — `{,}` fed as `{`
    /// then `,}` is the whole document if the stream ends there and prose punctuation if it does
    /// not. The scan keeps the completed value until later input settles that claim;
    /// a mark of data never holds, being a fact about bytes already in hand.
    Hold,
}

/// The rules for what counts as JSON in a document, and what the value being read has shown.
///
/// One per scan. The marks are reset per value; the document extent is fixed.
#[derive(Default)]
pub struct Candidate {
    /// The first content unit. A standalone value must begin here; its end is checked by the reader.
    ///
    /// Only ASCII whitespace, the same set the scanner skips — a wider notion of space here would
    /// make the two disagree about the same bytes.
    content_start: usize,
    /// The source wrote a quoted string inside the value.
    quoted: bool,
    /// The source wrote a colon. The strongest mark, since prose brackets carry none.
    colon: bool,
    /// How many values were placed into containers. More than one is a mark of data by itself.
    placed: usize,
    /// A container opener stood where the ROOT object's FIRST key belongs — `{{name}}` and friends.
    ///
    /// Decisive evidence AGAINST candidacy, which is why it overrides the marks-of-data rule rather
    /// than joining it: no leniency reads `{` as a key, so an object that would need one manufactured
    /// is a template the writer never meant as JSON. Judged at the candidate's own root only; the
    /// same shape nested inside established JSON is recovery's problem, not detection's.
    brace_key: bool,
}

impl Candidate {
    pub(crate) const fn from_content_start(content_start: usize) -> Self {
        Self {
            content_start,
            quoted: false,
            colon: false,
            placed: 0,
            brace_key: false,
        }
    }

    #[must_use]
    pub fn new<T: Copy + Into<u32>>(input: &[T]) -> Self {
        Self::from_content_start(content_start(input))
    }

    /// Advance past leading whitespace in newly available input without changing per-value marks.
    pub fn retrim<T: Copy + Into<u32>>(&mut self, input: &[T]) {
        self.retrim_to(content_start(input));
    }

    pub(crate) fn retrim_to(&mut self, start: usize) {
        // The start only ever moves FORWARD: leading trivia already consumed is not content, and
        // recomputing from zero would hand those bytes back as prose in front of the value.
        self.content_start = start.max(self.content_start);
    }

    /// Records that the run from `from` to `to` was TRIVIA the reader consumed, not content.
    ///
    /// Only when the run reaches back TO where the content currently starts: a comment further in
    /// has prose in front of it, and moving the start past that would turn a sentence with a
    /// comment in it into a document holding whatever follows the comment.
    ///
    /// Without this a scalar behind a comment was unreachable while an object behind the same
    /// comment parsed — a container carries its own marks of data, and a scalar's only route is
    /// standing alone, which the comment took away.
    pub const fn consumed_leading(&mut self, from: usize, to: usize) {
        if from <= self.content_start && to > self.content_start {
            self.content_start = to;
        }
    }

    /// Moves the document's start, for bytes that were consumed as an encoding declaration rather
    /// than as content. A value after a byte-order mark still FILLS the document, and judging it
    /// against a start of zero would read the mark as prose in front of it.
    pub const fn start_at(&mut self, at: usize) {
        self.content_start = at;
    }

    /// Forgets what the previous value showed. The document extent is not a per-value fact.
    pub const fn begin(&mut self) {
        self.quoted = false;
        self.colon = false;
        self.placed = 0;
        self.brace_key = false;
    }

    /// Records a container opener standing where a key belongs, from the one caller that knows it is
    /// the root object's.
    ///
    /// **FIRST key only, and the guard is load-bearing.** Once members have been placed, an opener in
    /// key position is the reader carrying a wrong expectation from an earlier bad guess — an
    /// ordinary recovery mistake — not proof the text holds no JSON. Without it one bad guess
    /// rejected a whole document: a mis-read unquoted value shifted the reader by a member, so a
    /// `tags: [...]` five lines later arrived in key position and seven recoverable fields came back
    /// as `no-json-found` with nothing to say why.
    pub const fn note_brace_key(&mut self) {
        if self.placed == 0 {
            self.brace_key = true;
        }
    }

    /// Whether detection has already decided AGAINST this candidate, whatever the scan then does.
    ///
    /// Read where the scan FAILED rather than completed: an opener in key position is also a scan
    /// error, and answering with that error would hand the caller a refusal carrying an empty object
    /// nobody wrote, where the truth is that the text held no JSON here.
    #[must_use]
    pub const fn decided_against(&self) -> bool {
        self.brace_key
    }

    pub const fn saw_quoted(&mut self) {
        self.quoted = true;
    }

    pub const fn saw_colon(&mut self) {
        self.colon = true;
    }

    pub const fn saw_placed(&mut self) {
        self.placed += 1;
    }

    /// Whether the current container has already shown evidence that it is JSON rather than prose.
    #[must_use]
    pub const fn established(&self) -> bool {
        !self.brace_key && (self.quoted || self.colon || self.placed > 1)
    }

    /// Whether a value beginning here could stand alone — be the whole trimmed document.
    ///
    /// The only route open to a SCALAR, which carries no marks of data: a bare word or a quoted
    /// string in the middle of a sentence is prose, however well formed. Asked BEFORE the scalar is
    /// read, which is what keeps a prose document linear — reading one per character and retracting
    /// it is the same answer at quadratic cost.
    #[must_use]
    pub const fn may_stand_alone(&self, start: usize, completed: usize) -> bool {
        completed == 0 && start == self.content_start
    }

    /// Whether the value just read is an answer.
    ///
    /// Standing alone is always enough — `{}` and `[1]` are valid JSON and a caller who passes only
    /// that means it. Otherwise the value must be a CONTAINER carrying a mark of data: a colon the
    /// source wrote, a quoted string, or more than one value. A scalar has no way to carry one,
    /// which is why a container is required rather than merely usual.
    ///
    /// `ended` says whether the buffer is all there will ever be, and it separates the two routes:
    /// a mark of data is a fact about bytes already read, while standing alone is a claim about
    /// bytes that have not arrived. See [`Verdict::Hold`].
    #[must_use]
    pub const fn judge(
        &self,
        start: usize,
        fills_input: bool,
        completed: usize,
        container: bool,
        ended: bool,
    ) -> Verdict {
        // Ahead of standing alone, which `{{name}}` as a whole document would otherwise pass.
        if self.brace_key {
            return Verdict::Reject;
        }
        if container && (self.quoted || self.colon || self.placed > 1) {
            return Verdict::Accept;
        }
        // A SCALAR's only route is filling the document, whatever it shows: `"hello" and more` is
        // prose holding a well-formed string, not a document holding a value.
        if !(self.may_stand_alone(start, completed) && fills_input) {
            return Verdict::Reject;
        }
        match ended {
            true => Verdict::Accept,
            false => Verdict::Hold,
        }
    }
}

/// Locate the first non-whitespace unit without scanning the input's unused trailing extent.
///
/// Only the ASCII set the scanner skips: a wider notion of space here would make the two disagree
/// about the same bytes.
fn content_start<T: Copy + Into<u32>>(input: &[T]) -> usize {
    input
        .iter()
        .position(|&value| !is_ws(value.into()))
        .unwrap_or(input.len())
}

/// The next place a container could open, at or after `from`.
///
/// **Quoting an opener does not hide it.** A model told to emit JSON and quoting the whole thing is
/// the commonest way this package is handed data, so `he said "{a:1}" today` yields the object and
/// reports its unquoted key: what makes prose brackets safe is the mark-of-data rule in `accepts`,
/// which `see [1] for the citation` fails and this passes on the colon the source wrote. Skipping
/// quoted runs here would be a second, quieter detector answering the same question differently.
///
/// A scan for two ASCII openers rather than a parse. Everything between candidates is prose by definition,
/// so interpreting it costs work that can only produce answers that are then thrown away.
#[must_use]
pub fn next_opener<T: Copy + Into<u32>>(input: &[T], from: usize) -> Option<usize> {
    input[from.min(input.len())..]
        .iter()
        .position(|&value| matches!(value.into(), unit::OPEN_BRACE | unit::OPEN_BRACKET))
        .map(|at| from + at)
}

#[cfg(test)]
mod input_units_tests {
    use super::{Candidate, next_opener};

    #[test]
    fn non_ascii_units_are_not_ascii_punctuation_or_space() {
        let units = [0x015b_u16, 0xd800, 0x5b, 0x31, 0x5d];
        assert_eq!(next_opener(&units, 0), Some(2));
        assert_eq!(next_opener(&units, units.len() + 1), None);
        let candidate = Candidate::new(&[0x0120_u16, 0x31]);
        assert!(candidate.may_stand_alone(0, 0));
        assert!(!candidate.may_stand_alone(1, 0));
        let candidate = Candidate::new(&[0x20_u16, 0x31, 0x20]);
        assert!(candidate.may_stand_alone(1, 0));
    }
}
