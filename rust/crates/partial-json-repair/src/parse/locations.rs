//! Keep error locations available after a stream releases their source text.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use super::Source;
use crate::report::Position;
use crate::scan::{IssueKind, RawIssue, Scanner};
use crate::value::JsonString;

/// Context depends on when decoding exposed the source, not on the eventual report path.
#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
enum Origin {
    Refused {
        at: usize,
        observed_at: usize,
        end: usize,
    },
    Decoded {
        at: usize,
        end: usize,
    },
}

impl From<&RawIssue> for Origin {
    fn from(issue: &RawIssue) -> Self {
        match issue.kind {
            IssueKind::InvalidUtf8 { end } => Self::Decoded { at: issue.at, end },
            IssueKind::Refused(_) => Self::Refused {
                at: issue.at,
                observed_at: issue.observed_at,
                end: issue.observed_end,
            },
        }
    }
}

/// Save only location data; keys and value indexes can settle after the location was observed.
#[derive(Clone)]
pub(super) struct IssueLocation<'a> {
    pub(super) at: Position,
    pub(super) line: usize,
    pub(super) column: usize,
    pub(super) context: JsonString<'a>,
}

impl IssueLocation<'_> {
    fn into_owned(self) -> IssueLocation<'static> {
        IssueLocation {
            at: self.at,
            line: self.line,
            column: self.column,
            context: self.context.into_owned(),
        }
    }
}

/// The error budget bounds this sparse map; unrequested decoder reports allocate no entries.
#[derive(Default)]
pub(super) struct IssueLocations {
    captured: usize,
    saved: BTreeMap<Origin, IssueLocation<'static>>,
    /// Bounded by live keys, token/whitespace starts and an undecided comma, not stream length.
    marks: BTreeMap<usize, IssueLocation<'static>>,
    needed: Vec<usize>,
}

impl<'a> Source<'a> {
    pub(super) fn saved_mark(&self, at: usize) -> Option<&IssueLocation<'static>> {
        self.locations.marks.get(&at)
    }

    /// Save context before releasing its source; discard marks as soon as their tokens settle.
    pub(super) fn capture_marks(&mut self, scanner: &Scanner<'_>) {
        self.locations.needed.clear();
        self.locations.needed.extend(scanner.source_marks());
        self.locations.needed.sort_unstable();
        self.locations.needed.dedup();
        let needed = &self.locations.needed;
        self.locations
            .marks
            .retain(|at, _| needed.binary_search(at).is_ok());
        for index in 0..self.locations.needed.len() {
            let at = self.locations.needed[index];
            if self.locations.marks.contains_key(&at) {
                continue;
            }
            let (line, column) = self.line_column(at);
            let location = IssueLocation {
                at: self.position(at),
                line,
                column,
                context: self.context(at).into_owned(),
            };
            self.locations.marks.insert(at, location);
        }
    }

    pub(super) fn issue_position(&self, issue: &RawIssue) -> Position {
        self.locations
            .saved
            .get(&Origin::from(issue))
            .map_or_else(|| self.position(issue.at), |location| location.at)
    }

    pub(super) fn issue_location(&self, issue: &RawIssue) -> IssueLocation<'a> {
        if let Some(location) = self.locations.saved.get(&Origin::from(issue)) {
            return location.clone();
        }
        let (line, column) = self.line_column(issue.at);
        IssueLocation {
            at: self.position(issue.at),
            line,
            column,
            context: match issue.kind {
                IssueKind::InvalidUtf8 { end } => self.decoded_context(issue.at, end),
                IssueKind::Refused(_) => {
                    self.observed_context(issue.at, issue.observed_at, issue.observed_end)
                }
            },
        }
    }

    /// Snapshot each needed location once, before the active input borrow ends.
    pub(super) fn capture_issue_locations(
        &mut self,
        issues: &[RawIssue],
        from: usize,
        reporting: bool,
    ) {
        for issue in &issues[self.locations.captured.max(from)..] {
            if issue.refused().is_none() && !(reporting && issue.scoped) {
                continue;
            }
            let origin = Origin::from(issue);
            if !self.locations.saved.contains_key(&origin) {
                let location = self.issue_location(issue).into_owned();
                self.locations.saved.insert(origin, location);
            }
        }
        self.locations.captured = issues.len();
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        Input, Source,
        diagnostics::{RefusalContext, refusal, refused_error},
    };
    use crate::options::Parser;
    use crate::outcome::{ParseFailure, Resource};
    use crate::report::{PathStep, SwitchableRepair};
    use crate::scan::Units;
    use core::num::NonZeroUsize;

    /// A depth stop needs its saved position and partial value, but no unrequested report context.
    #[test]
    fn unreported_depth_stop_needs_no_released_source() {
        let options = Parser {
            max_depth: NonZeroUsize::MIN,
            max_errors: NonZeroUsize::MIN,
            ..Parser::default()
        };
        let mut source = Source::new(Input::Text("\n[[0]]")).expect("text");
        let mut scanner = source.scanner(&options);
        let error = scanner.next_value().expect("root").expect_err("depth stop");
        let recovered = scanner.salvage();
        source.capture_issue_locations(scanner.issues(), 0, false);
        source.input = Units::Bytes(&[]);
        let failed = refusal(
            &error,
            recovered,
            scanner.issues(),
            RefusalContext {
                source: &source,
                options: &options,
                index: 0,
                scan_complete: false,
                selected: false,
            },
        );
        assert!(failed.diagnostics.is_none());
        let ParseFailure::LimitReached {
            resource,
            at,
            recovered,
            ..
        } = failed.failure
        else {
            panic!("depth remains a typed limit without diagnostics");
        };
        assert_eq!(resource, Resource::Depth);
        assert_eq!(at.expect("saved depth position").offset, 2);
        assert!(recovered.is_some());
    }

    /// A later report needs the original location even when the source is gone and its path settled later.
    #[test]
    fn saved_locations_survive_source_release_without_freezing_paths() {
        let options = Parser {
            recover: Parser::default()
                .recover
                .without(SwitchableRepair::UnquotedKey),
            ..Parser::default()
        };
        let mut source = Source::new(Input::Text("\n{a:1}")).expect("text");
        let mut scanner = source.scanner(&options);
        scanner
            .next_value()
            .expect("root")
            .expect("recovered value");
        let mut issue = scanner.issues()[0].clone();
        source.capture_issue_locations(scanner.issues(), 0, false);
        source.input = Units::Bytes(&[]);
        issue.path.push(PathStep::Index(3));
        let error = refused_error(&issue, &source, 2);
        assert_eq!(error.at.offset, 2);
        assert_eq!((error.line, error.column), (2, 2));
        assert_eq!(error.context.as_str().expect("text"), "\n{a:1}");
        assert_eq!(error.path, [PathStep::Index(3)]);
        assert_eq!(error.value_index, 2);
        assert_eq!(source.issue_position(&issue), error.at);
    }
}
