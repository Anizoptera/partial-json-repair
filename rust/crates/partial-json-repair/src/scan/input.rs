//! Bind scanner state to borrowed source units.

use super::{Builder, Logged, Parser, Repairs, Resume, Rewind, Scanner, Suspended};
use crate::report::SwitchableRepair;
use alloc::borrow::Cow;
use alloc::vec::Vec;

mod window;
pub(crate) use window::Window;

mod units;
pub(crate) use units::Units;

impl<'a> Scanner<'a> {
    /// Reveals a longer prefix of the same whole source without resetting scan state.
    pub(crate) fn extend_whole_input(&mut self, input: Units<'a>, ended: bool) {
        self.input = Window::new(input, 0);
        self.at_end = ended;
    }

    /// Resumes a suspended scan over a buffer that starts with the same bytes and may be longer.
    ///
    /// The candidate's view of the document is re-trimmed, because "the value fills the whole input"
    /// is a question about the buffer as it now stands; everything the value itself has shown is
    /// kept, since a value split across chunks showed it all the same.
    #[must_use]
    pub fn resume(input: &'a [u8], options: &'a Parser, state: Suspended) -> Self {
        Self::resume_units(Units::Bytes(input), options, state)
    }

    /// Resume in the retained buffer's alphabet; state offsets stay in that same alphabet.
    pub(crate) fn resume_units(input: Units<'a>, options: &'a Parser, state: Suspended) -> Self {
        Self::resume_chunk(input, options, state, true)
    }

    /// Continuation within the same chunk keeps its already established candidate bounds.
    pub(crate) fn resume_chunk(
        input: Units<'a>,
        options: &'a Parser,
        state: Suspended,
        changed: bool,
    ) -> Self {
        let mut candidate = state.candidate;
        if changed && state.input_start == 0 {
            match input {
                Units::Bytes(bytes) => candidate.retrim(bytes),
                Units::Utf16(units) => candidate.retrim(units),
                Units::Mixed(units) => candidate.retrim(units),
                Units::Joined(..) => candidate.retrim_to(input.content_start()),
            }
        }
        let mut builder = state.builder;
        builder.limit_retained(options.max_retained.get());
        let mut root_required = state.root_required;
        root_required.resize(options.required_keys.len(), false);
        Self {
            input: Window::new(input, state.input_start),
            at: state.at,
            quoted: state.quoted,
            word: state.word,
            decode_stopped: false,
            number_extent: state.number_extent,
            options,
            repairs: Repairs::Owned(state.repairs),
            kinds: state.kinds,
            retained: state.retained,
            issues: state.issues,
            errors_seen: state.errors_seen,
            dropped: state.dropped,
            edits: state.edits,
            logging_edits: state.logging_edits,
            // A resumed scan is a stream's scan: more chunks may follow, so it pauses where a
            // whole-input scan would close what is open. `input_ended` lifts that for the last pass.
            at_end: false,
            resuming: state.resuming,
            paused_at: Resume::Value,
            rewind: Rewind::default(),
            pause: None,
            after_comma: state.after_comma,
            comma_at: state.comma_at,
            member_mark: state.member_mark,
            delivered_mark: state.delivered_mark,
            candidate,
            completed: state.completed,
            root_object: state.root_object,
            root_required,
            builder,
            placing_start: 0,
        }
    }

    /// A scanner over UTF-8 bytes.
    #[must_use]
    pub fn new(input: &'a [u8], options: &'a Parser) -> Self {
        Self::from_units(Units::Bytes(input), options)
    }

    /// Scan original UTF-16 units without replacing unpaired surrogates.
    #[must_use]
    pub fn from_utf16(input: &'a [u16], options: &'a Parser) -> Self {
        Self::from_units(Units::Utf16(input), options)
    }

    pub(crate) fn from_units(input: Units<'a>, options: &'a Parser) -> Self {
        Self::from_whole_prefix(input, input.len(), options)
    }

    pub(crate) fn from_whole_prefix(whole: Units<'a>, end: usize, options: &'a Parser) -> Self {
        let input = whole.prefix(end);
        Self {
            input: Window::new(input, 0),
            at: 0,
            quoted: None,
            word: None,
            decode_stopped: false,
            number_extent: None,
            options,
            repairs: Repairs::Borrowed(Vec::new()),
            kinds: Vec::new(),
            retained: 0,
            issues: Vec::new(),
            errors_seen: 0,
            dropped: None,
            edits: Vec::new(),
            logging_edits: false,
            at_end: end == whole.len(),
            resuming: None,
            paused_at: Resume::Value,
            rewind: Rewind::default(),
            pause: None,
            after_comma: false,
            comma_at: None,
            member_mark: Logged::default(),
            delivered_mark: Logged::default(),
            candidate: whole.candidate(),
            completed: 0,
            root_object: false,
            root_required: alloc::vec![false; options.required_keys.len()],
            builder: Builder::default(),
            placing_start: 0,
        }
    }
}

impl Scanner<'_> {
    /// Remove the opening BOM in the source's own units.
    ///
    /// A U+FEFF here is an encoding DECLARATION, never content, and one `JSON.parse` refuses — so it
    /// goes with a free repair and an edit, and repaired text starts where JSON does. Only the first
    /// characters of the whole source: a U+FEFF anywhere later is data the source wrote.
    ///
    /// An unsupported encoding declared by bytes is refused before scanning; native UTF-16 units
    /// have already been decoded and use the single U+FEFF unit instead of its UTF-8 spelling.
    pub(super) fn strip_bom(&mut self) {
        if self.at != 0 || self.completed != 0 || self.input.start() != 0 {
            return;
        }
        const MARK: &[u8] = &[0xef, 0xbb, 0xbf];
        let width = match self.input.slice(0..self.input.end()) {
            Units::Bytes(_) if self.input.starts_with(0, MARK) => MARK.len(),
            Units::Utf16(_) if self.input.get(0) == Some(0xfeff) => 1,
            Units::Mixed(input) => match super::mixed::decode(input) {
                Some(decoded) if decoded.value == 0xfeff => decoded.width,
                _ => return,
            },
            Units::Joined(..)
                if self.input.slice(0..self.input.end()).is_bytes()
                    && self.input.starts_with(0, MARK) =>
            {
                MARK.len()
            }
            Units::Joined(..) => match self.input.slice(0..self.input.end()).decode(0) {
                Some(decoded) if decoded.value == 0xfeff => decoded.width,
                _ => return,
            },
            _ => return,
        };
        self.lenient(SwitchableRepair::BomRemoved, 0);
        if self.options.recover.allows(SwitchableRepair::BomRemoved) {
            self.edit(0, width, Cow::Borrowed(""));
        }
        // Consumed before the scan starts, and the document's start moves with it, so the value
        // after it is still judged as standing alone rather than as following prose.
        self.at = width;
        self.candidate.start_at(width);
    }
}
