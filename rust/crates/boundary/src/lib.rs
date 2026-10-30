//! Versioned binary boundary shared by native and WebAssembly transports.
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

use alloc::vec::Vec;
use partial_json_repair::parse::{BoundaryKind, BoundaryOperation, BoundaryOutcome, BoundaryStep};
use partial_json_repair::{
    FragmentStreamParser, Input, Parser, SelectedParser, SelectedStreamParser, StreamParser,
    Summarized, ViewedSelectedStreamParser, ViewedStreamParser, parse::InputSlice,
};

mod configuration;
mod response;
use response::{
    Collection, aborted, fragment_events, fragment_many, invalid, many, many_events, outcome,
    repair_outcome, selected_events, selected_item, selected_many, selected_outcome,
    selected_repair_outcome, selected_snapshot, selected_span_outcome, snapshot, span_outcome,
};

const VERSION: u8 = 1;
const PARSE: u8 = 0;
const PARSE_MANY: u8 = 1;
const REPAIR: u8 = 2;
const FIND_JSON_SPAN: u8 = 3;
const SUCCESS: u8 = 0;
const NO_JSON: u8 = 1;
const UNSUPPORTED_ENCODING: u8 = 2;
const LIMIT_REACHED: u8 = 3;
const INVALID_BOUNDARY: u8 = 4;
const MANY: u8 = 6;
const NON_JSON_VALUE: u8 = 7;
const SPAN: u8 = 8;
const NO_MATCH: u8 = 9;
const STREAM_CLOSED: u8 = 10;
const INVALID_OPTIONS: u8 = 11;
const NON_SCALAR_SELECTION: u8 = 12;
const POLICY_REFUSED: u8 = 13;
const SUMMARY: u8 = 14;
const FRAGMENT_START: u8 = 15;
const FRAGMENT_DATA: u8 = 16;
const FRAGMENT_END: u8 = 17;
const SNAPSHOT_NONE: u8 = 18;
const SNAPSHOT: u8 = 19;
const ABORTED: u8 = 20;

/// A parser whose validated configuration and compiled selectors are owned by one host handle.
pub enum ConfiguredParser {
    /// Whole-value results.
    Whole(Parser),
    /// Selected results.
    Selected {
        /// The parser and its compiled selectors.
        parser: SelectedParser,
        /// Whether streams deliver occurrences before ancestor finality.
        occurrences: bool,
    },
}

/// Decodes and compiles one configuration before any source is consumed.
pub fn configure(request: &[u8]) -> Result<ConfiguredParser, Vec<u8>> {
    let configuration = configuration::decode(request).map_err(invalid)?;
    match configuration.select {
        Some(select) => configuration
            .parser
            .select(select)
            .map(|parser| ConfiguredParser::Selected {
                parser,
                occurrences: configuration.occurrences,
            })
            .map_err(|_| invalid(7)),
        None => configuration
            .parser
            .selection()
            .map(|_| ConfiguredParser::Whole(configuration.parser))
            .map_err(|_| invalid(7)),
    }
}

impl ConfiguredParser {
    /// Creates one mutable stream from this immutable compiled configuration.
    pub fn stream(&self, mode: u8) -> Result<ConfiguredStream, Vec<u8>> {
        if mode & !7 != 0 {
            return Err(invalid(7));
        }
        let summary = mode & 1 != 0;
        let fragments = mode & 2 != 0;
        let view = mode & 4 != 0;
        if fragments && view {
            return Err(invalid(7));
        }
        match self {
            Self::Whole(_) if fragments => Err(invalid(7)),
            Self::Whole(parser) => {
                let stream = StreamParser::new(parser.clone());
                Ok(if view && summary {
                    ConfiguredStream::WholeSummaryView(stream.viewed().with_summary())
                } else if view {
                    ConfiguredStream::WholeView(stream.viewed())
                } else if summary {
                    ConfiguredStream::WholeSummary(stream.with_summary())
                } else {
                    ConfiguredStream::Whole(stream)
                })
            }
            Self::Selected {
                parser,
                occurrences,
            } => {
                if fragments {
                    let stream = parser
                        .clone()
                        .fragments()
                        .map_err(|_| invalid(7))?
                        .stream_parser();
                    return Ok(if summary {
                        ConfiguredStream::FragmentSummary(stream.with_summary())
                    } else {
                        ConfiguredStream::Fragments(stream)
                    });
                }
                let stream = parser.stream_parser();
                let stream = if *occurrences {
                    stream.occurrences()
                } else {
                    stream
                };
                Ok(if view && summary {
                    ConfiguredStream::SelectedSummaryView(stream.viewed().with_summary())
                } else if view {
                    ConfiguredStream::SelectedView(stream.viewed())
                } else if summary {
                    ConfiguredStream::SelectedSummary(stream.with_summary())
                } else {
                    ConfiguredStream::Selected(stream)
                })
            }
        }
    }

    /// Runs one source request without rebuilding or recompiling this parser's configuration.
    #[must_use]
    pub fn execute(&self, request: &[u8]) -> Vec<u8> {
        self.execute_controlled(request, || false)
    }

    /// Runs one request while polling independently observable background cancellation.
    #[must_use]
    pub fn execute_controlled(&self, request: &[u8], stop: impl FnMut() -> bool) -> Vec<u8> {
        let Some((&version, rest)) = request.split_first() else {
            return invalid(0);
        };
        if version != VERSION {
            return invalid(1);
        }
        let Some((&operation, rest)) = rest.split_first() else {
            return invalid(2);
        };
        let kind = match operation {
            PARSE => BoundaryKind::Parse,
            PARSE_MANY => BoundaryKind::ParseMany,
            REPAIR => BoundaryKind::Repair,
            FIND_JSON_SPAN => BoundaryKind::Span,
            _ => return invalid(3),
        };
        let Some((&encoding, source)) = rest.split_first() else {
            return invalid(4);
        };
        match encoding {
            0 => self.run_controlled(Input::Bytes(source), kind, stop),
            1 if source.len() % 2 == 0 => {
                let units: Vec<u16> = source
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                self.run_controlled(Input::Utf16(&units), kind, stop)
            }
            1 => invalid(5),
            _ => invalid(6),
        }
    }

    fn run_controlled(
        &self,
        input: Input<'_>,
        kind: BoundaryKind,
        mut stop: impl FnMut() -> bool,
    ) -> Vec<u8> {
        let operation = match self {
            Self::Whole(parser) => parser.boundary_operation(input, kind),
            Self::Selected { parser, .. } => parser.boundary_operation(input, kind),
        };
        let operation = match operation {
            Ok(operation) => operation,
            Err(item) => return encode_initial(*item),
        };
        drive(operation, &mut stop)
    }
}

fn drive(mut operation: BoundaryOperation<'_>, stop: &mut impl FnMut() -> bool) -> Vec<u8> {
    let mut collection = operation.is_many().then(Collection::new);
    loop {
        if stop() {
            let stopped = operation.stop();
            if let Some(mut output) = collection {
                output.stop(&stopped);
                return output.finish();
            }
            let mut output = alloc::vec![VERSION];
            aborted(&stopped, &mut output);
            return output;
        }
        match operation.advance() {
            BoundaryStep::Checkpoint => {}
            BoundaryStep::Item(item) => match item {
                BoundaryOutcome::Many(item) => collection
                    .as_mut()
                    .expect("parse-many operation owns a collection")
                    .push(&item, outcome),
                BoundaryOutcome::SelectedMany(item) => collection
                    .as_mut()
                    .expect("parse-many operation owns a collection")
                    .push(&item, selected_item),
                item => return encode_terminal(item),
            },
            BoundaryStep::Complete => {
                return collection
                    .expect("only parse-many completes without a terminal item")
                    .finish();
            }
        }
    }
}

fn encode_terminal(item: BoundaryOutcome<'_>) -> Vec<u8> {
    let mut output = alloc::vec![VERSION];
    match item {
        BoundaryOutcome::Parse(item) => outcome(&item, &mut output),
        BoundaryOutcome::Selected(item) => selected_outcome(&item, &mut output),
        BoundaryOutcome::Repair(item) => repair_outcome(&item, &mut output),
        BoundaryOutcome::SelectedRepair(item) => selected_repair_outcome(&item, &mut output),
        BoundaryOutcome::Span(item) => span_outcome(&item, &mut output),
        BoundaryOutcome::SelectedSpan(item) => selected_span_outcome(&item, &mut output),
        BoundaryOutcome::Many(_) | BoundaryOutcome::SelectedMany(_) => {
            unreachable!("parse-many items are encoded into a collection")
        }
    }
    output
}

fn encode_initial(item: BoundaryOutcome<'_>) -> Vec<u8> {
    match item {
        BoundaryOutcome::Many(item) => {
            let mut output = Collection::new();
            output.push(&item, outcome);
            output.finish()
        }
        BoundaryOutcome::SelectedMany(item) => {
            let mut output = Collection::new();
            output.push(&item, selected_item);
            output.finish()
        }
        item => encode_terminal(item),
    }
}

/// One configured incremental parser with output shape fixed before input is consumed.
pub enum ConfiguredStream {
    /// Whole-value deltas.
    Whole(StreamParser),
    /// Selected final-match or occurrence deltas.
    Selected(SelectedStreamParser),
    /// Whole-value deltas followed by one terminal summary.
    WholeSummary(Summarized<StreamParser>),
    /// Selected deltas followed by one terminal summary.
    SelectedSummary(Summarized<SelectedStreamParser>),
    /// Selected scalar fragment deltas.
    Fragments(FragmentStreamParser),
    /// Scalar fragment deltas followed by one terminal summary.
    FragmentSummary(Summarized<FragmentStreamParser>),
    /// Whole-value deltas with pull-based snapshots.
    WholeView(ViewedStreamParser),
    /// Selected deltas with pull-based snapshots.
    SelectedView(ViewedSelectedStreamParser),
    /// Whole-value deltas, terminal summary, and pull-based snapshots.
    WholeSummaryView(Summarized<ViewedStreamParser>),
    /// Selected deltas, terminal summary, and pull-based snapshots.
    SelectedSummaryView(Summarized<ViewedSelectedStreamParser>),
}

impl Default for ConfiguredStream {
    fn default() -> Self {
        Self::Whole(StreamParser::default())
    }
}

impl ConfiguredStream {
    /// Feeds one encoded chunk without changing this stream's configured output shape.
    #[must_use]
    pub fn feed(&mut self, request: &[u8]) -> Vec<u8> {
        self.chunk(request)
    }

    /// Finishes this stream once and returns only its remaining tail.
    #[must_use]
    pub fn end(&mut self) -> Vec<u8> {
        match self {
            Self::Whole(parser) => many(parser.end()),
            Self::Selected(parser) => selected_many(parser.end()),
            Self::WholeSummary(parser) => many_events(parser.end()),
            Self::SelectedSummary(parser) => selected_events(parser.end()),
            Self::Fragments(parser) => fragment_many(parser.end()),
            Self::FragmentSummary(parser) => fragment_events(parser.end()),
            Self::WholeView(parser) => many(parser.end()),
            Self::SelectedView(parser) => selected_many(parser.end()),
            Self::WholeSummaryView(parser) => many_events(parser.end()),
            Self::SelectedSummaryView(parser) => selected_events(parser.end()),
        }
    }

    /// Abandons unfinished input and releases parser-owned storage.
    pub fn close(&mut self) {
        match self {
            Self::Whole(parser) => parser.close(),
            Self::Selected(parser) => parser.close(),
            Self::WholeSummary(parser) => parser.close(),
            Self::SelectedSummary(parser) => parser.close(),
            Self::Fragments(parser) => parser.close(),
            Self::FragmentSummary(parser) => parser.close(),
            Self::WholeView(parser) => parser.close(),
            Self::SelectedView(parser) => parser.close(),
            Self::WholeSummaryView(parser) => parser.close(),
            Self::SelectedSummaryView(parser) => parser.close(),
        }
    }

    fn chunk(&mut self, request: &[u8]) -> Vec<u8> {
        let [version, final_slice, encoding, source @ ..] = request else {
            return invalid(0);
        };
        if *version != VERSION {
            return invalid(1);
        }
        if *final_slice > 1 {
            return invalid(0);
        }
        match encoding {
            0 => self.feed_input(InputSlice::new(Input::Bytes(source), *final_slice != 0)),
            1 if source.len() % 2 == 0 => {
                let units: Vec<u16> = source
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                self.feed_input(InputSlice::new(Input::Utf16(&units), *final_slice != 0))
            }
            1 => invalid(5),
            _ => invalid(6),
        }
    }

    fn feed_input(&mut self, input: impl partial_json_repair::AsInput) -> Vec<u8> {
        match self {
            Self::Whole(parser) => many(parser.feed(input)),
            Self::Selected(parser) => selected_many(parser.feed(input)),
            Self::WholeSummary(parser) => many_events(parser.feed(input)),
            Self::SelectedSummary(parser) => selected_events(parser.feed(input)),
            Self::Fragments(parser) => fragment_many(parser.feed(input)),
            Self::FragmentSummary(parser) => fragment_events(parser.feed(input)),
            Self::WholeView(parser) => many(parser.feed(input)),
            Self::SelectedView(parser) => selected_many(parser.feed(input)),
            Self::WholeSummaryView(parser) => many_events(parser.feed(input)),
            Self::SelectedSummaryView(parser) => selected_events(parser.feed(input)),
        }
    }

    /// Serializes the current view without advancing the parser.
    #[must_use]
    pub fn snapshot(&mut self) -> Vec<u8> {
        match self {
            Self::WholeView(parser) => snapshot(parser.view()),
            Self::SelectedView(parser) => selected_snapshot(parser.view()),
            Self::WholeSummaryView(parser) => snapshot(parser.view()),
            Self::SelectedSummaryView(parser) => selected_snapshot(parser.view()),
            _ => invalid(7),
        }
    }

    /// Serializes the current source account without ending or advancing the stream.
    #[must_use]
    pub fn summary(&self) -> Vec<u8> {
        match self {
            Self::WholeSummary(parser) => response::summary(&parser.summary()),
            Self::SelectedSummary(parser) => response::summary(&parser.summary()),
            Self::FragmentSummary(parser) => response::summary(&parser.summary()),
            Self::WholeSummaryView(parser) => response::summary(&parser.summary()),
            Self::SelectedSummaryView(parser) => response::summary(&parser.summary()),
            _ => invalid(8),
        }
    }
}

/// One authoritative incremental parser behind a host-owned opaque handle.
#[derive(Default)]
pub struct StreamBoundary {
    parser: ConfiguredStream,
}

impl StreamBoundary {
    /// Feeds one versioned UTF-8 or UTF-16 chunk and returns only values completed by that chunk.
    #[must_use]
    pub fn feed(&mut self, request: &[u8]) -> Vec<u8> {
        self.parser.feed(request)
    }

    /// Finishes the stream once and returns only its remaining tail.
    #[must_use]
    pub fn end(&mut self) -> Vec<u8> {
        self.parser.end()
    }

    /// Abandons unfinished input and releases parser-owned storage.
    pub fn close(&mut self) {
        self.parser.close();
    }
}

/// Parses one owned request and returns one owned, lossless response.
///
/// A request is `version, operation, encoding, source`; operations are whole-input parse or
/// parse-many, and encoding zero is UTF-8 and one is little-endian UTF-16. Every variable response
/// field is length-prefixed, so hosts never scan or guess.
#[must_use]
pub fn parse(request: &[u8]) -> Vec<u8> {
    ConfiguredParser::Whole(Parser::default()).execute(request)
}

/// Parses one request while polling independently observable background cancellation.
#[must_use]
pub fn parse_controlled(request: &[u8], stop: impl FnMut() -> bool) -> Vec<u8> {
    ConfiguredParser::Whole(Parser::default()).execute_controlled(request, stop)
}

#[cfg(test)]
mod tests {
    use alloc::vec;
    use partial_json_repair::Parser;

    use super::{
        ABORTED, ConfiguredParser, INVALID_BOUNDARY, MANY, NO_JSON, STREAM_CLOSED, SUCCESS,
        StreamBoundary, parse,
    };

    #[test]
    fn preserves_exact_numbers_and_lone_surrogates() {
        let exact = parse(&[
            1, 0, 0, b'[', b'9', b'0', b'0', b'7', b'1', b'9', b'9', b'2', b'5', b'4', b'7', b'4',
            b'0', b'9', b'9', b'3', b']',
        ]);
        assert_eq!(&exact[..3], &[1, SUCCESS, 8]);
        assert!(exact.windows(16).any(|part| part == b"9007199254740993"));
        let mut request = vec![1, 0, 1];
        for unit in [0x5b, 0x22, 0xd800, 0x22, 0x5d] {
            request.extend(u16::to_le_bytes(unit));
        }
        assert!(parse(&request).windows(2).any(|part| part == [0x00, 0xd8]));
    }

    #[test]
    fn distinguishes_parse_and_boundary_failures() {
        assert_eq!(parse(&[1, 0, 0]), [1, NO_JSON, 0]);
        assert_eq!(parse(&[1, 0, 1, 0]), [1, INVALID_BOUNDARY, 5]);
        assert_eq!(parse(&[0, 0, 0]), [1, INVALID_BOUNDARY, 1]);
    }

    #[test]
    fn returns_every_root_in_one_response() {
        let response = parse(b"\x01\x01\x00{\"a\":1}\n{\"b\":2}");
        assert_eq!(&response[..10], &[1, MANY, 2, 0, 0, 0, 0, 0, 0, 0]);
        assert!(response.len() > 30);
        assert_eq!(
            response
                .windows(2)
                .filter(|part| *part == [SUCCESS, 9])
                .count(),
            2
        );
    }

    #[test]
    fn controlled_work_stops_without_finishing_open_input() {
        let parser = ConfiguredParser::Whole(Parser::default());
        let request = [b"\x01\x00\x00{\"open\":\"".as_slice(), &vec![b'x'; 10_000]].concat();
        let mut checks = 0;
        let response = parser.execute_controlled(&request, || {
            checks += 1;
            checks > 1
        });

        assert_eq!(&response[..3], &[1, ABORTED, 1]);
    }

    #[test]
    fn stream_returns_chunk_deltas_and_one_tail() {
        let mut stream = StreamBoundary::default();
        let chunk = |source: &[u8]| {
            let mut request = alloc::vec![1, 1];
            request.push(0);
            request.extend(source);
            request
        };
        assert_eq!(
            &stream.feed(&chunk(b"{\"a\":"))[..10],
            &[1, MANY, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(
            &stream.feed(&chunk(b"1}"))[..10],
            &[1, MANY, 1, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(&stream.end()[..10], &[1, MANY, 0, 0, 0, 0, 0, 0, 0, 0]);
        let closed = stream.end();
        assert_eq!(
            &closed[..11],
            &[1, MANY, 1, 0, 0, 0, 0, 0, 0, 0, STREAM_CLOSED]
        );
    }
}
