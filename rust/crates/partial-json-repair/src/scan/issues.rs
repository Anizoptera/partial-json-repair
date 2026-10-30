//! Record decoder errors and policy refusals in one bounded, ordered log.

use super::{Refused, Scanner, SourcePath, SwitchableRepair, path_of};

/// Scanner stops keep their cause distinct from the data recovered before them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScanErrorKind {
    /// Input held no value at all.
    Empty,
    /// A value was expected here and the unit found cannot begin one.
    UnexpectedUnit,
    /// The input ended inside a value.
    UnexpectedEnd,
    /// Text after the value ended, where a single value was expected.
    TrailingContent,
    /// A string escape that JSON does not define.
    BadEscape,
    /// Bytes that are not valid UTF-8.
    BadUtf8,
    /// The refusal budget ran out between tokens; the value built so far is kept and reported.
    ErrorBudget,
    /// A decoder error stopped an unfinished token before it could be placed.
    DecodeBudget,
    /// An unfinished scalar exceeded the stream's configured token bound.
    ScalarBudget,
    /// Recovered content still owned by a stream exceeded its configured bound.
    RetainedBudget,
}

/// The reason an error was recorded; a decoding replacement is not a policy refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueKind {
    /// The caller's policy declined a construct.
    Refused(Refused),
    /// Malformed bytes were replaced; `end` is the original byte position after that sequence.
    InvalidUtf8 {
        /// Original byte position immediately after the malformed sequence.
        end: usize,
    },
}

/// An error at its original byte position, before report projection.
#[derive(Clone, Debug, PartialEq)]
pub struct RawIssue {
    /// Whether recovery replaced malformed bytes or policy declined a construct.
    pub kind: IssueKind,
    /// Byte offset in the input.
    pub at: usize,
    /// Scanner position when the location was captured, before later decoder pieces arrived.
    pub observed_at: usize,
    /// Input visible when this issue arose; later chunks must not extend its context.
    pub observed_end: usize,
    /// Where inside the value.
    pub path: SourcePath<'static>,
    /// Whether this error belongs in the requested report scope. It spends `max_errors` either way.
    pub scoped: bool,
    /// Whether the shared `max_diagnostics` budget had room when this arrived, so a report lists it.
    /// Errors remain in the log so report limits cannot change the outcome or error count.
    pub retained: bool,
}

impl RawIssue {
    /// The policy refusal, if this error changes a recovered value's success status.
    pub fn refused(&self) -> Option<Refused> {
        match self.kind {
            IssueKind::Refused(refused) => Some(refused),
            IssueKind::InvalidUtf8 { .. } => None,
        }
    }
}

impl Scanner<'_> {
    /// Preserve an earlier location snapshot while applying the ordinary repair policy.
    pub(crate) fn lenient_at(&mut self, kind: SwitchableRepair, at: usize, observed_at: usize) {
        let before = self.issues.len();
        self.lenient(kind, at);
        if let Some(issue) = self.issues.get_mut(before) {
            issue.observed_at = observed_at;
        }
    }

    pub(crate) fn record_issue(&mut self, kind: IssueKind, at: usize) {
        if self.budget_spent() {
            return;
        }
        self.errors_seen += 1;
        let scoped = self.in_scope();
        let retained = scoped && self.claim_entry();
        self.issues.push(RawIssue {
            kind,
            at,
            observed_at: self.at,
            observed_end: self.input.end(),
            path: if matches!(kind, IssueKind::InvalidUtf8 { .. })
                && !self.options.diagnostics.reporting()
            {
                SourcePath::new()
            } else {
                path_of(&self.builder.stack)
            },
            scoped,
            retained,
        });
    }
}
