//! Whole-input projections for parsers with compiled selection paths.

use alloc::boxed::Box;
use alloc::vec::Vec;

use super::{Input, Reader};
use crate::options::SelectedParser;
use crate::outcome::{Failed, Match, Outcome, ParseFailure, RepairFailure, Success};
use crate::report::Span;
use crate::value::{JsonString, Value};

impl SelectedParser {
    pub(crate) fn reader<'a>(
        &'a self,
        input: Input<'a>,
        edits: bool,
    ) -> Result<Reader<'a>, Box<Failed<'a, ParseFailure<'a>>>> {
        Reader::with_selection(input, &self.parser, edits, Some(self.selection.clone()))
    }

    /// The selected nodes in the first recognized root.
    pub fn parse<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
    ) -> Outcome<'a, Vec<Match<Value<'a>>>, ParseFailure<'a>> {
        let mut reader = self.reader(input.into(), false)?;
        let outcome = reader.first();
        reader.selected(outcome)
    }

    /// Every selected node in the input, lazily and in source order.
    pub fn parse_many<'a>(&'a self, input: impl Into<Input<'a>>) -> SelectedIter<'a> {
        match self.reader(input.into(), false) {
            Ok(reader) => SelectedIter::Reading {
                reader: Box::new(reader),
                pending: Vec::new().into_iter(),
                saw_root: false,
            },
            Err(failure) => SelectedIter::Refused(Box::new(Some(Err(failure)))),
        }
    }

    /// The source extents of selected nodes in the first recognized root.
    pub fn find_json_span<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
    ) -> Outcome<'a, Vec<Match<Span>>, ParseFailure<'a>> {
        let mut reader = self.reader(input.into(), false)?;
        let outcome = reader.first();
        reader.selected_span(outcome)
    }

    /// The repaired source text for every selected node in the first recognized root.
    pub fn repair<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
    ) -> Outcome<'a, Vec<Match<JsonString<'a>>>, RepairFailure<'a>> {
        let mut reader = self.reader(input.into(), true).map_err(|failed| {
            Box::new(Failed {
                failure: RepairFailure::Parse(failed.failure),
                diagnostics: failed.diagnostics,
            })
        })?;
        let outcome = reader.first();
        reader.selected_repair(outcome)
    }
}

/// Selected matches flattened across recognized roots.
pub enum SelectedIter<'a> {
    /// A live reader plus matches from its most recently completed root.
    Reading {
        /// The single scanner shared by every root.
        reader: Box<Reader<'a>>,
        /// Matches already completed, returned before the scanner advances again.
        pending: alloc::vec::IntoIter<Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>>,
        /// Distinguishes an unmatched root from input that held no root.
        saw_root: bool,
    },
    /// A failure raised before input scanning began.
    Refused(Box<Option<Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>>>),
}

impl<'a> Iterator for SelectedIter<'a> {
    type Item = Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self {
                Self::Refused(item) => return item.take(),
                Self::Reading {
                    reader,
                    pending,
                    saw_root,
                } => {
                    if let Some(item) = pending.next() {
                        return Some(item);
                    }
                    match reader.next() {
                        Some(Ok(read)) => {
                            *saw_root = true;
                            *pending = reader
                                .take_matches()
                                .map(|matched| {
                                    Ok(Success {
                                        value: matched,
                                        span: None,
                                        diagnostics: read.diagnostics.clone(),
                                    })
                                })
                                .collect::<Vec<_>>()
                                .into_iter();
                        }
                        Some(Err(failure)) => return Some(Err(failure)),
                        None if !*saw_root => {
                            *saw_root = true;
                            return Some(Err(reader.exhausted()));
                        }
                        None => return None,
                    }
                }
            }
        }
    }
}
