//! Return final matches from one root before requesting work on the next root.

use super::values::{Capture, Drain};
use super::{SelectedStreamItem, SelectedStreamParser};
use crate::outcome::{Match, Report, Success};
use crate::parse::AsInput;
use crate::value::Value;
use alloc::vec::Vec;

/// Final matches must survive later duplicate members in their root before they can be delivered.
/// Reports are copied only for requested matches; abandoning the drain releases the rest.
pub(super) struct SelectedDrain<'a, C: AsInput> {
    roots: Drain<'a, C>,
    pending: alloc::vec::IntoIter<Match<Value<'static>>>,
    recovered: Vec<Match<Value<'static>>>,
    report: Report<'static>,
    occurrences: bool,
}

impl<'a, C: AsInput> SelectedDrain<'a, C> {
    pub(super) fn new(roots: Drain<'a, C>, occurrences: bool) -> Self {
        Self {
            roots,
            pending: Vec::new().into_iter(),
            recovered: Vec::new(),
            report: None,
            occurrences,
        }
    }

    pub(super) fn stream(&self) -> &super::StreamParser {
        self.roots.stream
    }

    pub(super) fn take_recovered(&mut self) -> Vec<Match<Value<'static>>> {
        core::mem::take(&mut self.recovered)
    }
}

impl<C: AsInput> Iterator for SelectedDrain<'_, C> {
    type Item = SelectedStreamItem<'static>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(matched) = self.pending.next() {
                let diagnostics = if self.pending.len() == 0 {
                    self.report.take()
                } else {
                    self.report.clone()
                };
                return Some(Ok(Success {
                    value: matched,
                    span: None,
                    diagnostics,
                }));
            }
            let mut matches = Vec::new();
            let root = self.roots.advance(Capture::Matches {
                values: &mut matches,
                occurrences: self.occurrences,
            });
            if self.occurrences && !matches.is_empty() {
                self.pending = matches.into_iter();
                continue;
            }
            match root? {
                Ok(read) => {
                    self.pending = matches.into_iter();
                    self.report = read.diagnostics;
                }
                Err(failed) => {
                    self.recovered = matches;
                    return Some(Err(failed));
                }
            }
        }
    }
}

impl SelectedStreamParser {
    pub(super) fn feed_drain<C: AsInput>(&mut self, chunk: C) -> SelectedDrain<'_, C> {
        SelectedDrain::new(Drain::feed(&mut self.stream, chunk).0, self.occurrences)
    }

    pub(super) fn end_drain(&mut self) -> SelectedDrain<'_, crate::parse::Input<'static>> {
        SelectedDrain::new(Drain::end(&mut self.stream), self.occurrences)
    }

    /// Yield owned final matches as requested, without scanning a later root ahead of demand.
    /// Dropping an unfinished drain closes the stream and releases input and undelivered matches.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = SelectedStreamItem<'static>> + 'a {
        self.feed_drain(chunk)
    }

    /// Yield matches from normal tail recovery; completion or abandonment closes the stream.
    pub fn end(&mut self) -> impl Iterator<Item = SelectedStreamItem<'static>> + '_ {
        self.end_drain()
    }
}

#[cfg(test)]
mod tests {
    use crate::{DiagnosticsMode, ParseFailure, Parser, PathSegment, canonical_of};
    use alloc::vec;

    #[test]
    fn abandonment_keeps_final_matches_without_scanning_the_next_root() {
        let parser = Parser {
            diagnostics: DiagnosticsMode::On,
            ..Parser::default()
        }
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("valid selector");
        for pulls in [0, 1] {
            let mut stream = parser.stream_parser();
            let mut drain = stream.feed(r#"{"a":1,"a":2} {"a":3}"#);
            let held = (pulls == 1).then(|| drain.next().expect("match").expect("valid"));
            drop(drain);
            assert_eq!(stream.stream.delivered, pulls);
            assert_eq!(
                stream
                    .stream
                    .buffer
                    .source(false)
                    .expect("released")
                    .input
                    .len(),
                0
            );
            assert!(
                matches!(stream.end().next(), Some(Err(failed)) if failed.failure == ParseFailure::StreamClosed)
            );
            if let Some(held) = held {
                assert_eq!(canonical_of(&held.value.value), "2");
                assert_eq!(
                    held.diagnostics,
                    parser
                        .parse(r#"{"a":1,"a":2}"#)
                        .expect("same root")
                        .diagnostics
                );
            }
        }
    }
}
