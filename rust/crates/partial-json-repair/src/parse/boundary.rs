//! One whole-input operation shared by host transports.

use super::{Input, Reader, ReaderStep, stopped_report};
use crate::options::{Parser, SelectedParser};
use crate::outcome::{Failed, Match, Outcome, ParseFailure, RepairFailure, Report, Success};
use crate::report::Span;
use crate::value::{JsonString, Value};
use alloc::boxed::Box;
use alloc::vec::Vec;

/// The projection one request asks the shared reader to produce.
#[derive(Clone, Copy)]
#[doc(hidden)]
pub enum BoundaryKind {
    /// The first recovered value.
    Parse,
    /// Every recovered value.
    ParseMany,
    /// Repaired source text for the first value.
    Repair,
    /// The first value's source extent.
    Span,
}

/// One typed result produced by [`BoundaryOperation`].
#[doc(hidden)]
pub enum BoundaryOutcome<'a> {
    /// One unselected parse result.
    Parse(Outcome<'a, Value<'a>, ParseFailure<'a>>),
    /// One selected parse result.
    Selected(Outcome<'a, Vec<Match<Value<'a>>>, ParseFailure<'a>>),
    /// One unselected parse-many item.
    Many(Outcome<'a, Value<'a>, ParseFailure<'a>>),
    /// One selected parse-many item.
    SelectedMany(Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>),
    /// One unselected repair result.
    Repair(Outcome<'a, JsonString<'a>, RepairFailure<'a>>),
    /// One selected repair result.
    SelectedRepair(Outcome<'a, Vec<Match<JsonString<'a>>>, RepairFailure<'a>>),
    /// One unselected span result.
    Span(Outcome<'a, Span, ParseFailure<'a>>),
    /// One selected span result.
    SelectedSpan(Outcome<'a, Vec<Match<Span>>, ParseFailure<'a>>),
}

/// One bounded advance of a whole-input operation.
#[doc(hidden)]
#[expect(
    clippy::large_enum_variant,
    reason = "boxing would allocate every parse-many item at this transport boundary"
)]
pub enum BoundaryStep<'a> {
    /// More source remains after this safe point.
    Checkpoint,
    /// One result is ready for transport encoding.
    Item(BoundaryOutcome<'a>),
    /// No further result can complete.
    Complete,
}

/// State already recovered when an executor stops the operation.
#[doc(hidden)]
pub struct Stopped<'a> {
    /// Partial value built before cancellation.
    pub recovered: Option<Value<'a>>,
    /// Diagnostics collected before cancellation, when requested.
    pub diagnostics: Report<'a>,
}

/// The reader and projection state for one host-owned request.
#[doc(hidden)]
pub struct BoundaryOperation<'a> {
    reader: Reader<'a>,
    kind: BoundaryKind,
    selected: bool,
    pending: alloc::vec::IntoIter<Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>>,
    saw_root: bool,
    done: bool,
}

impl Parser {
    /// Starts a transport operation over the same reader used by direct Rust calls.
    #[doc(hidden)]
    pub fn boundary_operation<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
        kind: BoundaryKind,
    ) -> Result<BoundaryOperation<'a>, Box<BoundaryOutcome<'a>>> {
        Reader::new(input.into(), self, matches!(kind, BoundaryKind::Repair))
            .map(|reader| BoundaryOperation::new(reader, kind, false))
            .map_err(|failure| Box::new(initial_outcome(failure, kind, false)))
    }
}

impl SelectedParser {
    /// Starts a selected transport operation over the same reader used by direct Rust calls.
    #[doc(hidden)]
    pub fn boundary_operation<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
        kind: BoundaryKind,
    ) -> Result<BoundaryOperation<'a>, Box<BoundaryOutcome<'a>>> {
        self.reader(input.into(), matches!(kind, BoundaryKind::Repair))
            .map(|reader| BoundaryOperation::new(reader, kind, true))
            .map_err(|failure| Box::new(initial_outcome(failure, kind, true)))
    }
}

fn initial_outcome<'a>(
    failure: Box<Failed<'a, ParseFailure<'a>>>,
    kind: BoundaryKind,
    selected: bool,
) -> BoundaryOutcome<'a> {
    if matches!(kind, BoundaryKind::ParseMany) {
        return if selected {
            BoundaryOutcome::SelectedMany(Err(failure))
        } else {
            BoundaryOutcome::Many(Err(failure))
        };
    }
    match (selected, kind) {
        (false, BoundaryKind::Parse) => BoundaryOutcome::Parse(Err(failure)),
        (true, BoundaryKind::Parse) => BoundaryOutcome::Selected(Err(failure)),
        (false, BoundaryKind::Repair) => BoundaryOutcome::Repair(Err(Box::new(Failed {
            failure: RepairFailure::Parse(failure.failure),
            diagnostics: failure.diagnostics,
        }))),
        (true, BoundaryKind::Repair) => BoundaryOutcome::SelectedRepair(Err(Box::new(Failed {
            failure: RepairFailure::Parse(failure.failure),
            diagnostics: failure.diagnostics,
        }))),
        (false, BoundaryKind::Span) => BoundaryOutcome::Span(Err(failure)),
        (true, BoundaryKind::Span) => BoundaryOutcome::SelectedSpan(Err(failure)),
        (_, BoundaryKind::ParseMany) => unreachable!("parse-many returned above"),
    }
}

impl<'a> BoundaryOperation<'a> {
    fn new(reader: Reader<'a>, kind: BoundaryKind, selected: bool) -> Self {
        Self {
            reader,
            kind,
            selected,
            pending: Vec::new().into_iter(),
            saw_root: false,
            done: false,
        }
    }

    /// Whether this operation emits a collection of results.
    #[must_use]
    pub fn is_many(&self) -> bool {
        matches!(self.kind, BoundaryKind::ParseMany)
    }

    /// Advances to the next cancellation checkpoint or result.
    pub fn advance(&mut self) -> BoundaryStep<'a> {
        loop {
            if self.done {
                return BoundaryStep::Complete;
            }
            if let Some(item) = self.pending.next() {
                return BoundaryStep::Item(BoundaryOutcome::SelectedMany(item));
            }
            match self.reader.advance() {
                ReaderStep::Checkpoint => return BoundaryStep::Checkpoint,
                ReaderStep::Item(read) if matches!(self.kind, BoundaryKind::ParseMany) => {
                    self.saw_root = true;
                    if !self.selected {
                        return BoundaryStep::Item(BoundaryOutcome::Many(read));
                    }
                    match read {
                        Ok(success) => {
                            self.pending = self
                                .reader
                                .take_matches()
                                .map(|matched| {
                                    Ok(Success {
                                        value: matched,
                                        span: None,
                                        diagnostics: success.diagnostics.clone(),
                                    })
                                })
                                .collect::<Vec<_>>()
                                .into_iter();
                        }
                        Err(failure) => {
                            return BoundaryStep::Item(BoundaryOutcome::SelectedMany(Err(failure)));
                        }
                    }
                }
                ReaderStep::Item(read) => {
                    self.done = true;
                    return BoundaryStep::Item(self.project(read));
                }
                ReaderStep::Complete if matches!(self.kind, BoundaryKind::ParseMany) => {
                    self.done = true;
                    if self.saw_root {
                        return BoundaryStep::Complete;
                    }
                    let read = self.reader.first();
                    return BoundaryStep::Item(if self.selected {
                        BoundaryOutcome::SelectedMany(read.map(|_| unreachable!()))
                    } else {
                        BoundaryOutcome::Many(read)
                    });
                }
                ReaderStep::Complete => {
                    self.done = true;
                    let read = self.reader.first();
                    return BoundaryStep::Item(self.project(read));
                }
            }
        }
    }

    /// Stops without end-of-input repair and returns only state already built.
    pub fn stop(&mut self) -> Stopped<'a> {
        self.done = true;
        Stopped {
            recovered: self.reader.scanner.salvage(),
            diagnostics: self.reader.options.diagnostics.reporting().then(|| {
                Box::new(stopped_report(
                    &self.reader.scanner,
                    &self.reader.source,
                    self.reader.logged,
                    self.reader.index,
                ))
            }),
        }
    }

    fn project(&mut self, read: Outcome<'a, Value<'a>, ParseFailure<'a>>) -> BoundaryOutcome<'a> {
        match (self.selected, self.kind) {
            (false, BoundaryKind::Parse) => BoundaryOutcome::Parse(read),
            (false, BoundaryKind::Repair) => BoundaryOutcome::Repair(self.reader.repair(read)),
            (false, BoundaryKind::Span) => BoundaryOutcome::Span(self.reader.span(read)),
            (true, BoundaryKind::Parse) => BoundaryOutcome::Selected(self.reader.selected(read)),
            (true, BoundaryKind::Repair) => {
                BoundaryOutcome::SelectedRepair(self.reader.selected_repair(read))
            }
            (true, BoundaryKind::Span) => {
                BoundaryOutcome::SelectedSpan(self.reader.selected_span(read))
            }
            (_, BoundaryKind::ParseMany) => unreachable!("parse-many projects while advancing"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BoundaryKind, BoundaryStep, Parser};
    use crate::options::DiagnosticsMode;
    use alloc::vec;

    #[test]
    fn stopping_marks_requested_diagnostics_incomplete() {
        let parser = Parser {
            diagnostics: DiagnosticsMode::On,
            ..Parser::default()
        };
        let source = [b"{\"open\":\"".as_slice(), &vec![b'x'; 10_000]].concat();
        let Ok(mut operation) = parser.boundary_operation(source.as_slice(), BoundaryKind::Parse)
        else {
            panic!("valid parser configuration must start an operation");
        };
        assert!(matches!(operation.advance(), BoundaryStep::Checkpoint));

        assert!(!operation.stop().diagnostics.unwrap().scan_complete);
    }
}
