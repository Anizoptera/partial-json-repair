//! Advance a manual value stream only when its caller requests another result.
//!
//! Detach each result before yielding so dropping a drain can release its source immediately.
//! Suspended state keeps the same scanner's progress without a self-referential buffer or unsafe
//! lifetime extension; continuing within a chunk preserves its established candidate bounds.

use super::{Buffer, EndState, FragmentStreamItem, StreamItem, StreamParser};
use crate::outcome::{Match, ParseFailure, Resource};
use crate::parse::PausedReader;
use crate::parse::{AsInput, Input, Marks, Reader, bare};
use crate::value::Value;
use alloc::vec::Vec;

/// A drain owns the mutable stream borrow; abandoning it cannot replay unread input.
pub(super) struct Drain<'a, C: AsInput = Input<'static>> {
    pub(super) stream: &'a mut StreamParser,
    cursor: Cursor,
    chunk: Option<C>,
}

/// Capture only the selected output mode before its reader releases the input borrow.
pub(super) enum Capture<'a> {
    Value,
    Matches {
        values: &'a mut Vec<Match<Value<'static>>>,
        occurrences: bool,
    },
    Fragments {
        items: &'a mut Vec<FragmentStreamItem<'static>>,
        reported: &'a mut Marks,
    },
}

/// Keep drain progress separate from its borrow so an owning transport can retain it between pulls.
pub(super) struct Cursor {
    ending: bool,
    finished: bool,
    reader_done: bool,
    first: bool,
    borrowed: bool,
}

impl Cursor {
    /// Keep the active owner until its drain settles; retained storage holds only prior carry.
    pub(super) fn borrows_chunk(&self) -> bool {
        self.borrowed && !self.finished
    }

    pub(super) fn feed<C: AsInput + ?Sized>(stream: &mut StreamParser, chunk: &C) -> (Self, bool) {
        let mut finished = false;
        let mut reports_reset = false;
        let mut borrowed = false;
        if !stream.is_closed() {
            let input = chunk.as_input();
            (reports_reset, borrowed) =
                stream
                    .buffer
                    .begin(input, stream.scan.release_prefix(), chunk.final_slice());
            stream.buffer.prune_coordinates(&stream.scan);
            finished = input.is_empty();
        }
        (
            Self {
                ending: false,
                finished,
                reader_done: false,
                first: true,
                borrowed,
            },
            reports_reset,
        )
    }

    pub(super) fn end() -> Self {
        Self {
            ending: true,
            finished: false,
            reader_done: false,
            first: true,
            borrowed: false,
        }
    }
}

impl<C: AsInput> Iterator for Drain<'_, C> {
    type Item = StreamItem<'static>;

    fn next(&mut self) -> Option<Self::Item> {
        self.advance(Capture::Value)
    }
}

impl<C: AsInput> Drain<'_, C> {
    /// The output wrapper can still hold events after input scanning settled.
    pub(super) fn abandon(&mut self) {
        close(self.stream, EndState::Abandoned);
    }

    pub(super) fn advance(&mut self, capture: Capture<'_>) -> Option<StreamItem<'static>> {
        let item = self.cursor.advance(
            self.stream,
            capture,
            self.chunk.as_ref().map(AsInput::as_input),
        );
        if self.cursor.finished {
            self.chunk = None;
        }
        item
    }
}

impl Drain<'_> {
    pub(super) fn feed<C: AsInput>(stream: &mut StreamParser, chunk: C) -> (Drain<'_, C>, bool) {
        let (cursor, reports_reset) = Cursor::feed(stream, &chunk);
        let chunk = cursor.borrows_chunk().then_some(chunk);
        (
            Drain {
                stream,
                cursor,
                chunk,
            },
            reports_reset,
        )
    }

    pub(super) fn end(stream: &mut StreamParser) -> Drain<'_> {
        Drain {
            stream,
            cursor: Cursor::end(),
            chunk: None,
        }
    }
}

impl Cursor {
    /// Move matches out before suspending their reader; whole-value delivery requests no matches.
    pub(super) fn advance(
        &mut self,
        stream: &mut StreamParser,
        mut capture: Capture<'_>,
        active: Option<Input<'_>>,
    ) -> Option<StreamItem<'static>> {
        if self.finished {
            return None;
        }
        if stream.is_closed() {
            self.finished = true;
            return Some(Err(bare(
                ParseFailure::StreamClosed,
                stream.parser.diagnostics,
            )));
        }
        let source = match active.filter(|_| self.borrowed) {
            Some(input) => stream.buffer.borrowed_source(input, self.ending),
            None => stream.buffer.source(self.ending),
        };
        let input = match source {
            Ok(input) => input,
            Err(encoding) => {
                let item = Err(bare(
                    ParseFailure::UnsupportedEncoding { encoding },
                    stream.parser.diagnostics,
                ));
                self.finished = true;
                close(stream, EndState::Stopped);
                return Some(item);
            }
        };
        let mut reader = Reader::resume_chunk(
            input,
            &stream.parser,
            core::mem::take(&mut stream.scan),
            stream.delivered,
            self.first,
        );
        self.first = false;
        if self.ending {
            reader.no_more_input();
        }
        let value_index = reader.value_index();
        let mut item = if self.reader_done {
            None
        } else {
            reader.next()
        };
        self.reader_done |= reader.is_done();
        if item.is_none() && !reader.is_yielding() {
            self.finished = true;
            if reader.retained_source() > stream.parser.max_buffer.get() {
                item = Some(Err(
                    reader.resource_limit(Resource::Buffer, stream.parser.max_buffer.get())
                ));
            } else if self.ending && stream.silent {
                item = Some(Err(
                    if stream.parser.filters_roots() && reader.value_index() > 0 {
                        reader.no_match()
                    } else {
                        bare(ParseFailure::NoJsonFound, stream.parser.diagnostics)
                    },
                ));
            }
        }
        let terminal = matches!(&item, Some(Err(failed)) if matches!(failed.failure, ParseFailure::LimitReached { .. }));
        if let Capture::Matches {
            values,
            occurrences,
        } = &mut capture
        {
            if *occurrences {
                let (next, completed) = reader.matches_after(stream.delivered_occurrence);
                stream.delivered_occurrence = next;
                values.extend(completed);
                if item.is_some() {
                    reader.take_matches().for_each(drop);
                }
            } else if item.is_some() {
                values.extend(reader.take_matches().map(|matched| Match {
                    value: matched.value.into_owned(),
                    path: matched.path,
                    value_index: matched.value_index,
                    span: matched.span,
                    selectors: matched.selectors,
                }));
            }
        }
        if let Capture::Fragments { items, reported } = &mut capture {
            items.extend(reader.take_fragments(
                value_index,
                reported,
                matches!(item, Some(Err(_))),
            ));
        }
        let item = item.map(|item| match item {
            Ok(success) => Ok(success.into_owned()),
            Err(failed) => Err(alloc::boxed::Box::new((*failed).into_owned())),
        });
        let budget_spent = reader.budget_spent();
        let (state, index) =
            reader.suspend(self.finished && !self.ending && !terminal && !budget_spent);
        stream.scan = state;
        // Completed refusals already advance the reader index. A limit may instead salvage
        // an open root; count that root once before closing and releasing its scan state.
        let stopped_root = terminal
            && index == value_index
            && matches!(&item, Some(Err(failed)) if matches!(
                failed.failure, ParseFailure::LimitReached { recovered: Some(_), .. }
            ));
        stream.delivered = index + usize::from(stopped_root);
        stream.silent &= item.is_none();
        // A refusal can spend the budget without carrying a LimitReached failure. Stop the
        // transport here too: another chunk cannot restore the scanner's error allowance.
        if terminal || budget_spent || (self.finished && self.ending) {
            self.finished = true;
            close(
                stream,
                if terminal || budget_spent {
                    EndState::Stopped
                } else {
                    EndState::Complete
                },
            );
        } else if self.finished {
            // Decided source leaves even inside a root; live report cursors stay with their logs.
            let released = stream.scan.release_prefix();
            let reports_reset = match active.filter(|_| self.borrowed) {
                Some(input) => stream.buffer.retain(input, released),
                None => stream.buffer.compact(released),
            };
            if reports_reset && let Capture::Fragments { reported, .. } = capture {
                *reported = Marks::default();
            }
            stream.buffer.prune_coordinates(&stream.scan);
        }
        item
    }
}

pub(super) fn close(stream: &mut StreamParser, reason: EndState) {
    if !stream.is_closed() {
        stream.end_state = reason;
    }
    stream.scan = PausedReader::default();
    stream.buffer = Buffer::default();
}

impl<C: AsInput> Drop for Drain<'_, C> {
    fn drop(&mut self) {
        if !self.cursor.finished {
            close(self.stream, EndState::Abandoned);
        }
    }
}

impl StreamParser {
    /// Yield owned values as requested; abandoning an unfinished drain closes the stream.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = StreamItem<'static>> + 'a {
        Drain::feed(self, chunk).0
    }

    /// Recover the unfinished tail once, closing the stream when this drain finishes or is dropped.
    pub fn end(&mut self) -> impl Iterator<Item = StreamItem<'static>> + '_ {
        Drain::end(self)
    }
}

#[cfg(test)]
mod tests {
    use super::{Drain, StreamParser};
    use crate::outcome::ParseFailure;
    use crate::stream::EndState;

    #[test]
    fn completion_retains_its_cause_after_storage_release_and_repeated_calls() {
        let mut complete = StreamParser::default();
        complete.feed("{}").for_each(drop);
        complete.end().for_each(drop);
        assert_eq!(complete.end_state, EndState::Complete);
        complete.end().for_each(drop);
        assert_eq!(complete.end_state, EndState::Complete);

        let mut stopped = StreamParser::default();
        stopped.feed(&[0xff_u8, 0xfe, 0, 0][..]).for_each(drop);
        assert_eq!(stopped.end_state, EndState::Stopped);
        stopped.end().for_each(drop);
        assert_eq!(stopped.end_state, EndState::Stopped);

        let mut abandoned = StreamParser::default();
        drop(abandoned.feed("{} {}"));
        assert_eq!(abandoned.end_state, EndState::Abandoned);
        abandoned.end().for_each(drop);
        assert_eq!(abandoned.end_state, EndState::Abandoned);

        let mut refused = StreamParser::new(crate::Parser {
            recover: crate::Parser::default()
                .recover
                .without(crate::report::SwitchableRepair::UnquotedKey),
            max_errors: core::num::NonZeroUsize::new(1).expect("positive bound"),
            ..crate::Parser::default()
        });
        refused.feed("{a:1} {}").for_each(drop);
        refused.end().for_each(drop);
        assert_eq!(refused.end_state, EndState::Stopped);
    }

    #[test]
    fn active_chunks_are_borrowed_and_only_unfinished_input_is_copied() {
        let mut stream = StreamParser::default();
        let input = alloc::format!("{{\"text\":\"{}\"}} {{\"next\":2}}", "x".repeat(8192));
        let (mut drain, _) = Drain::feed(&mut stream, input);
        assert_eq!(
            drain
                .stream
                .buffer
                .source(false)
                .expect("source")
                .input
                .len(),
            0
        );
        assert!(drain.next().expect("first root").is_ok());
        assert_eq!(
            drain
                .stream
                .buffer
                .source(false)
                .expect("source")
                .input
                .len(),
            0
        );
        assert!(drain.next().expect("second root").is_ok());
        assert!(drain.next().is_none());
        drop(drain);
        assert_eq!(stream.buffer.source(false).expect("source").input.len(), 0);

        let tail = "{\"next\":";
        stream.feed(tail).for_each(drop);
        assert_eq!(stream.buffer.source(false).expect("carry").input.len(), 0);
        stream.feed("3").for_each(drop);
        assert_eq!(
            stream
                .buffer
                .source(false)
                .expect("undecided number")
                .input
                .len(),
            1
        );
        assert!(stream.feed("}").next().expect("continued root").is_ok());
    }

    #[test]
    fn abandoned_drains_do_not_scan_unrequested_roots_or_retain_input() {
        for pulls in [0, 1] {
            let mut stream = StreamParser::default();
            let mut drain = stream.feed(r#"{"a":"kept"} {"b":"unrequested"}"#);
            let held = (pulls == 1).then(|| drain.next().expect("first root").expect("valid"));
            drop(drain);
            assert_eq!(stream.delivered, pulls);
            assert_eq!(
                stream
                    .buffer
                    .source(false)
                    .expect("empty buffer")
                    .input
                    .len(),
                0
            );
            assert!(
                matches!(stream.end().next(), Some(Err(failed)) if failed.failure == ParseFailure::StreamClosed)
            );
            if let Some(held) = held {
                assert_eq!(
                    held.value,
                    crate::parse(r#"{"a":"kept"}"#).expect("expected").value
                );
            }
        }
    }
}
