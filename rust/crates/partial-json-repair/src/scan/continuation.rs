//! Preserve scanner state and rewind unfinished syntax at input boundaries.

use super::*;

/// Input needs another chunk; output needs another consumer pull over the same chunk.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pause {
    Input,
    Output,
}

/// A candidate owns either its parsing continuation or its completed value, never both.
/// Its start and container shape survive source release. Its mark retracts the whole candidate
/// if later input rejects it, including work done before the most recent chunk.
pub(crate) enum Paused {
    Reading {
        start: usize,
        container: bool,
        mark: Logged,
        at: Resume,
    },
    Judging {
        start: usize,
        container: bool,
        mark: Logged,
        end: usize,
        value: Value<'static>,
    },
}

/// Input release, source-coordinate retention and report reset have different lifetimes.
#[derive(Default)]
pub(crate) struct Released {
    pub(crate) units: usize,
    pub(crate) reports_reset: bool,
}

/// Remember ownership so repeated candidacy waits never traverse an already owned tree.
pub(super) enum CandidateValue<'a> {
    Fresh(Value<'a>),
    Owned(Value<'static>),
}

impl<'a> CandidateValue<'a> {
    pub(super) fn get(&self) -> &Value<'a> {
        match self {
            Self::Fresh(value) | Self::Owned(value) => value,
        }
    }

    pub(super) fn take(self) -> Value<'a> {
        match self {
            Self::Fresh(value) | Self::Owned(value) => value,
        }
    }

    pub(super) fn own(self) -> Value<'static> {
        match self {
            Self::Fresh(value) => value.into_owned(),
            Self::Owned(value) => value,
        }
    }
}

impl Suspended {
    pub(crate) fn with_view(mut self) -> Self {
        self.builder.view();
        self
    }

    pub(crate) fn snapshot(&self) -> Option<(Value<'static>, SourcePath<'static>)> {
        if self.builder.selecting() {
            return None;
        }
        let container = self.builder.view_container();
        let pending_container = container.is_some();
        let pending = self
            .quoted
            .as_ref()
            .map(|quoted| Value::String(quoted.snapshot_text()))
            .or(container);
        let path = self
            .builder
            .snapshot_path(pending.is_some(), pending_container);
        self.builder.snapshot(pending).map(|value| (value, path))
    }

    pub(crate) fn selected_snapshot(
        &self,
    ) -> Option<(
        alloc::vec::Vec<crate::builder::Occurrence<'static>>,
        SourcePath<'static>,
    )> {
        if !self.builder.selecting()
            || (self.builder.stack.is_empty() && self.builder.view_container().is_none())
        {
            return None;
        }
        let container = self.builder.view_container();
        let pending_container = container.is_some();
        let pending = self
            .quoted
            .as_ref()
            .map(|quoted| Value::String(quoted.snapshot_text()))
            .or(container);
        let path = self
            .builder
            .snapshot_path(pending.is_some(), pending_container);
        Some((self.builder.snapshot_occurrences(pending), path))
    }

    /// Logical positions remain authoritative; the stream retains only their original chunk owners.
    pub(crate) fn source_positions(&self) -> impl Iterator<Item = usize> + '_ {
        self.builder
            .source_positions()
            .chain(self.resuming.iter().flat_map(|state| {
                let (start, end) = match state {
                    Paused::Reading { start, .. } => (*start, None),
                    Paused::Judging { start, end, .. } => (*start, Some(*end)),
                };
                core::iter::once(start).chain(end)
            }))
            .chain(self.quoted.as_ref().map(|state| state.open))
            .chain(self.word.as_ref().map(|state| state.start))
            .chain(self.word.as_ref().and_then(|state| state.space_at))
            .chain(self.number_extent.as_ref().map(|state| state.start))
            .chain(self.comma_at)
            .chain(self.repairs.iter().map(|repair| repair.at))
            .chain(self.issues.iter().map(|issue| issue.at))
            .chain(self.edits.iter().flat_map(|edit| [edit.start, edit.end]))
            .chain(
                self.dropped
                    .iter()
                    .flat_map(|dropped| [dropped.start, dropped.end]),
            )
    }

    /// Installs compiled selectors before the first stream chunk arrives.
    pub(crate) fn with_selection(mut self, selection: Selection<'static>) -> Self {
        self.builder.select(Some(selection));
        self
    }

    /// Installs fragment delivery and its compiled selectors before input arrives.
    pub(crate) fn with_fragments(mut self, selection: Selection<'static>) -> Self {
        self.builder.fragment(selection);
        self
    }

    /// Release decided syntax while positions and unfinished reports keep their own lifetimes.
    pub(crate) fn release_prefix(&mut self) -> Released {
        let end = self.quoted.as_ref().map_or_else(
            || {
                self.word
                    .as_ref()
                    .filter(|_| !self.builder.stack.is_empty())
                    .map_or(self.at, |state| state.next)
            },
            |state| state.retained_from(),
        );
        let end = self
            .number_extent
            .as_ref()
            .filter(|state| !state.raw.is_empty())
            .map_or(end, |state| state.next);
        let released = Released {
            units: end - self.input_start,
            reports_reset: self.resuming.is_none()
                && self.builder.stack.is_empty()
                && self.delivered_mark.repairs == self.repairs.len()
                && self.delivered_mark.issues == self.issues.len()
                && self.delivered_mark.kinds == self.kinds.len(),
        };
        self.input_start = end;
        if !released.reports_reset {
            return released;
        }
        self.repairs.clear();
        self.kinds.clear();
        self.retained = 0;
        self.issues.clear();
        self.edits.clear();
        self.member_mark = Logged::default();
        self.delivered_mark = Logged::default();
        released
    }
}

impl Scanner<'_> {
    /// Save only positions that unfinished keys, tokens, whitespace or commas may still report.
    pub(crate) fn source_marks(&self) -> impl Iterator<Item = usize> {
        self.builder
            .stack
            .iter()
            .filter_map(|frame| frame.pending().map(|key| key.at))
            .chain(self.quoted.as_ref().map(|quoted| quoted.open))
            .chain(self.word.as_ref().map(|word| word.start))
            .chain(self.word.as_ref().and_then(|word| word.space_at))
            .chain(self.number_extent.as_ref().map(|number| number.start))
            .chain(self.comma_at.filter(|_| !self.builder.stack.is_empty()))
    }

    /// Pauses the scan, giving up the borrow on the input.
    #[must_use]
    pub fn suspend(self) -> Suspended {
        Suspended {
            input_start: self.input.start(),
            at: self.at,
            quoted: self.quoted,
            word: self.word,
            number_extent: self.number_extent,
            repairs: self.repairs.into_owned(),
            kinds: self.kinds,
            retained: self.retained,
            issues: self.issues,
            errors_seen: self.errors_seen,
            dropped: self.dropped,
            edits: self.edits.into_iter().map(Edit::into_owned).collect(),
            logging_edits: self.logging_edits,
            resuming: self.resuming,
            after_comma: self.after_comma,
            comma_at: self.comma_at,
            member_mark: self.member_mark,
            delivered_mark: self.delivered_mark,
            candidate: self.candidate,
            completed: self.completed,
            root_object: self.root_object,
            root_required: self.root_required,
            builder: self.builder.into_owned(),
        }
    }
}

impl Scanner<'_> {
    /// Records that the scan stands at a boundary it could be re-entered at.
    ///
    /// The offset and the log lengths are taken in the same act, which is the whole point: a mark
    /// from one boundary paired with another's offset un-logs a span nobody chose. Cheap enough to
    /// do unconditionally — three `usize` reads — so no site has to predict whether it will pause.
    pub(super) fn stands_at(&mut self, at: usize, resume: Resume) {
        self.rewind = Rewind {
            at,
            resume,
            logged: self.mark(),
        };
    }

    /// Stop until more input arrives. Decoded tokens keep their state; undecided syntax rewinds
    /// to its last boundary without deciding from a partial input.
    ///
    /// Genuinely an unexpected end — the stream's extra bit is [`Scanner::wants_more`], which says
    /// whether it may yet be undone. `next_value` reads that and answers "nothing yet" rather than
    /// handing the caller a failure about input that is still in flight.
    pub(crate) fn pause(&mut self) -> ScanError {
        self.pause_for(Pause::Input)
    }

    pub(crate) fn is_yielding(&self) -> bool {
        self.pause == Some(Pause::Output)
    }

    pub(crate) fn yield_output(&mut self) -> ScanError {
        self.pause_for(Pause::Output)
    }

    fn pause_for(&mut self, reason: Pause) -> ScanError {
        self.pause = Some(reason);
        self.paused_at = self.rewind.resume;
        if let Some(quoted) = &self.quoted {
            // The grammar re-enters at the opener, but the quoted reader resumes its decided
            // prefix. Its diagnostics survive for the same reason its decoded content does.
            self.at = quoted.open;
        } else if let Some(word) = &self.word {
            self.at = word.start;
        } else if let Some(number) = &self.number_extent {
            self.at = number.start;
        } else {
            self.at = self.rewind.at;
            // Replayed input must not report the same repair or decoding error twice.
            self.retract(self.rewind.logged);
        }
        ScanError {
            kind: ScanErrorKind::UnexpectedEnd,
            at: self.rewind.at,
            path: path_of(&self.builder.stack),
        }
    }

    pub(crate) fn pause_scalar(&mut self, start: usize) -> ScanError {
        if self.at.saturating_sub(start) > self.options.max_scalar.get() {
            return ScanError {
                kind: ScanErrorKind::ScalarBudget,
                at: start,
                path: path_of(&self.builder.stack),
            };
        }
        self.pause()
    }

    pub(crate) fn pause_string(&mut self, start: usize, units: usize) -> ScanError {
        if self.builder.would_exceed_retained(units) {
            return ScanError {
                kind: ScanErrorKind::RetainedBudget,
                at: start,
                path: path_of(&self.builder.stack),
            };
        }
        self.pause()
    }

    /// Waits when the byte that would decide the next step has not arrived.
    ///
    /// An absent byte is not a byte. `[` at a chunk boundary is an array whose first element has
    /// not arrived, never an array that turned out to be empty — and the difference is not
    /// recoverable later: the frame opens, and the `]` in the next chunk then arrives in VALUE
    /// position, where it is a character that begins nothing. `[true, false, null, 42, "str", {},
    /// []]` cut just after the inner opener reported an unparsable span inside the empty array.
    pub(super) fn need_byte(&mut self) -> Result<(), ScanError> {
        match self.peek().is_none() && !self.at_end {
            true => Err(self.pause()),
            false => Ok(()),
        }
    }
}
