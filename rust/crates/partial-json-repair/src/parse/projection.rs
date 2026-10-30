//! Shape every whole-input result from the reader that scanned it.

use super::Reader;
use crate::outcome::{Failed, Match, NonJsonKind, Outcome, ParseFailure, RepairFailure, Success};
use crate::report::{PathStep, SourcePath, Span};
use crate::value::{JsonString, Number, Value};
use alloc::boxed::Box;
use alloc::vec::Vec;

impl<'a> Reader<'a> {
    pub(super) fn first(&mut self) -> Outcome<'a, Value<'a>, ParseFailure<'a>> {
        self.next().unwrap_or_else(|| Err(self.exhausted()))
    }

    pub(super) fn span(
        &self,
        outcome: Outcome<'a, Value<'a>, ParseFailure<'a>>,
    ) -> Outcome<'a, Span, ParseFailure<'a>> {
        let (start, end) = self.extent;
        outcome.map(|read| Success {
            value: self.source.span(start, end),
            span: None,
            diagnostics: read.diagnostics,
        })
    }

    pub(super) fn repair(
        &self,
        outcome: Outcome<'a, Value<'a>, ParseFailure<'a>>,
    ) -> Outcome<'a, JsonString<'a>, RepairFailure<'a>> {
        let read = outcome.map_err(|failed| parse_repair_failure(*failed))?;
        if let Some((value_kind, path)) = non_json_value(&read.value) {
            return Err(Box::new(Failed {
                failure: RepairFailure::NonJsonValue { value_kind, path },
                diagnostics: read.diagnostics,
            }));
        }
        Ok(Success {
            value: self.source.repaired(self.scanner.edits(), self.extent),
            span: read.span,
            diagnostics: read.diagnostics,
        })
    }

    pub(super) fn selected(
        &mut self,
        outcome: Outcome<'a, Value<'a>, ParseFailure<'a>>,
    ) -> Outcome<'a, Vec<Match<Value<'a>>>, ParseFailure<'a>> {
        outcome.map(|read| Success {
            value: self.take_matches().collect(),
            span: read.span,
            diagnostics: read.diagnostics,
        })
    }

    pub(super) fn selected_span(
        &mut self,
        outcome: Outcome<'a, Value<'a>, ParseFailure<'a>>,
    ) -> Outcome<'a, Vec<Match<Span>>, ParseFailure<'a>> {
        self.selected(outcome).map(|read| Success {
            value: read
                .value
                .into_iter()
                .map(|matched| Match {
                    value: matched.span,
                    path: matched.path,
                    value_index: matched.value_index,
                    span: matched.span,
                    selectors: matched.selectors,
                })
                .collect(),
            span: None,
            diagnostics: read.diagnostics,
        })
    }

    pub(super) fn selected_repair(
        &mut self,
        outcome: Outcome<'a, Value<'a>, ParseFailure<'a>>,
    ) -> Outcome<'a, Vec<Match<JsonString<'a>>>, RepairFailure<'a>> {
        let read = outcome.map_err(|failed| parse_repair_failure(*failed))?;
        let index = self.index.saturating_sub(1);
        let mut matches = Vec::new();
        for occurrence in self.scanner.take_occurrences() {
            let Some(value) = occurrence.value else {
                continue;
            };
            if let Some((value_kind, below)) = non_json_value(&value) {
                let mut path = occurrence.path.clone();
                path.extend(below);
                return Err(Box::new(Failed {
                    failure: RepairFailure::NonJsonValue { value_kind, path },
                    diagnostics: read.diagnostics,
                }));
            }
            matches.push(Match {
                value: self.source.repaired(
                    &self.scanner.edits()[..occurrence.close_edit],
                    (occurrence.start, occurrence.end),
                ),
                path: occurrence.path,
                value_index: index,
                span: self.source.span(occurrence.start, occurrence.end),
                selectors: occurrence.selectors,
            });
        }
        Ok(Success {
            value: matches,
            span: read.span,
            diagnostics: read.diagnostics,
        })
    }
}

fn parse_repair_failure<'a>(
    failed: Failed<'a, ParseFailure<'a>>,
) -> Box<Failed<'a, RepairFailure<'a>>> {
    Box::new(Failed {
        failure: RepairFailure::Parse(failed.failure),
        diagnostics: failed.diagnostics,
    })
}

/// Find the first unspellable value iteratively so a permitted-depth tree cannot overflow the stack.
fn non_json_value<'a>(root: &Value<'a>) -> Option<(NonJsonKind, SourcePath<'a>)> {
    let mut pending: Vec<(&Value<'a>, SourcePath<'a>)> = alloc::vec![(root, SourcePath::new())];
    while let Some((value, path)) = pending.pop() {
        match value {
            Value::Undefined => return Some((NonJsonKind::Undefined, path)),
            Value::Number(Number::Double(number)) if number.is_nan() => {
                return Some((NonJsonKind::Nan, path));
            }
            Value::Number(Number::Double(number)) if number.is_infinite() => {
                return Some((NonJsonKind::Infinity, path));
            }
            Value::Array(items) => {
                for (at, item) in items.iter().enumerate().rev() {
                    let mut below = path.clone();
                    below.push(PathStep::Index(at));
                    pending.push((item, below));
                }
            }
            Value::Object(object) => {
                for (key, member) in object.entries().iter().rev() {
                    let mut below = path.clone();
                    below.push(PathStep::Key(key.clone()));
                    pending.push((member, below));
                }
            }
            _ => {}
        }
    }
    None
}
