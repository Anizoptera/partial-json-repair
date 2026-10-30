//! Values out of a stream of chunks, each delivered by the chunk that completed it.
//!
//! **The core takes chunks by PUSH, never by async iteration.** `feed` and `end` are the whole
//! machine; async sources, web streams and cancellation are wrappers over them. A `no_std` core
//! with one host's concurrency model in its middle would be the same mistake as one with that
//! host's calling convention there — and the push form is what every wrapper can be written from,
//! while the reverse does not hold.
//!
//! **Nothing here is a second parser.** A chunk is appended to the buffer and the SAME
//! [`crate::parse::Reader`] every whole-input verb uses reads it, so values, spans and reports come
//! out shaped one way rather than two that drift. The reader's iterator stops at a pause exactly as
//! it stops at the end of input, which is why what it yields is already the delta.

use crate::options::{DEFAULTS, FragmentedParser, Parser, SelectedParser};
use crate::outcome::{Fragment, Match, Outcome, ParseFailure};
use crate::parse::{Marks, PausedReader};
use crate::value::Value;

mod encoding;
mod fragments;
mod input;
mod selected;
mod storage;
mod summary;
mod transport;
mod values;
mod views;
use input::Buffer;
pub use summary::{StreamEvent, StreamSummary, Summarized};

pub use transport::{OwnedStreamItem, ParsedStream, StreamFailure, parse_stream};
#[cfg(feature = "async")]
pub use transport::{ParsedAsyncStream, parse_stream_async};
pub use views::{
    SelectedSnapshot, SelectedViewResult, Snapshot, ViewFailure, ViewedSelectedStreamParser,
    ViewedStreamParser,
};

/// One value a stream produced, with the same shape a whole-input parse gives.
pub type StreamItem<'a> = Outcome<'a, Value<'a>, ParseFailure<'a>>;

/// One selected value a stream produced.
pub type SelectedStreamItem<'a> = Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>;

/// One selected scalar fragment a stream produced.
pub type FragmentStreamItem<'a> = Outcome<'a, Fragment, ParseFailure<'a>>;

/// Completion and stopped processing differ even after their source storage is released.
/// Abandonment suppresses terminal delivery; it must not later look like source exhaustion.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum EndState {
    #[default]
    Open,
    Complete,
    Stopped,
    Abandoned,
}

/// Reads JSON out of chunks as they arrive.
///
/// Completed prefixes are released; positions remain local to the original source chunk.
///
/// Results own their contents. Each lazy drain borrows the stream mutably until it finishes,
/// so another chunk cannot replace input that the active drain still needs.
///
/// The scan cannot borrow the buffer ACROSS chunks, because appending may move it. So the retained
/// state and needed error locations are detached at each boundary and restored into a reader over the
/// retained window next time; compaction rebases scanner and source coordinates together. Three alternatives
/// were rejected: rescanning per chunk is quadratic on a real stream, a self-referential buffer
/// needs `unsafe`, which this workspace forbids, and an owning-reference crate is a dependency the
/// core is ruled not to have.
pub struct StreamParser {
    /// Owned, not borrowed. A `StreamParser<'o>` made every caller keep a second binding alive for
    /// as long as the stream — the classic borrow that spreads into whatever struct holds the
    /// stream. A `Parser` clone is a handful of scalars and an empty `Vec`, paid once per stream
    /// against a scan that allocates per value.
    parser: Parser,
    /// Retained input and original-chunk coordinates move together during prefix release.
    buffer: Buffer,
    /// The scan, paused between chunks and detached from the buffer it read. Empty means nothing
    /// has been read yet, which is exactly what a fresh scan is.
    scan: PausedReader,
    /// How many values the stream has delivered. Continues the value index across chunks, because a
    /// consumer that rendered value 0 two chunks ago still needs to know which value a repair names.
    delivered: usize,
    delivered_occurrence: usize,
    /// Whether the stream has handed back nothing at all, across every chunk so far.
    ///
    /// A stream that ends having said nothing must answer `no-json-found` rather than run dry in
    /// silence, exactly as a whole-input many-value read does: a consumer draining it cannot
    /// otherwise tell "there was no JSON in this stream" from "there is none LEFT". Cleared by the
    /// first item of either kind, since a refusal is an answer too and a stopped stream is not also
    /// an empty one.
    silent: bool,
    end_state: EndState,
}

/// Reads selected matches from text chunks as they arrive.
pub struct SelectedStreamParser {
    stream: StreamParser,
    selectors: usize,
    occurrences: bool,
}

/// Reads selected scalar contents without retaining the complete scalar values.
pub struct FragmentStreamParser {
    stream: StreamParser,
    reported: Marks,
    selectors: usize,
}

impl Default for StreamParser {
    /// A stream under the shipped defaults, so the common case needs no setup.
    fn default() -> Self {
        Self::new(DEFAULTS.clone())
    }
}

impl StreamParser {
    fn is_closed(&self) -> bool {
        self.end_state != EndState::Open
    }

    /// A stream reading text chunks under `options`.
    #[must_use]
    pub fn new(parser: Parser) -> Self {
        Self {
            parser,
            buffer: Buffer::default(),
            scan: PausedReader::default(),
            delivered: 0,
            delivered_occurrence: 0,
            silent: true,
            end_state: EndState::Open,
        }
    }

    /// Enables pull-based borrowed views without charging ordinary streams for retained snapshots.
    #[must_use]
    pub fn viewed(self) -> ViewedStreamParser {
        ViewedStreamParser::new(self)
    }

    /// Stops the stream and releases retained input. Repeated calls have no further effect.
    pub fn close(&mut self) {
        values::close(self, EndState::Abandoned);
    }
}

impl SelectedStreamParser {
    /// A stream carrying the selectors already compiled by `parser`.
    #[must_use]
    pub fn new(parser: SelectedParser) -> Self {
        let selectors = parser.selection.selectors;
        let mut stream = StreamParser::new(parser.parser);
        stream.scan = stream.scan.with_selection(parser.selection);
        Self {
            stream,
            selectors,
            occurrences: false,
        }
    }

    /// Delivers selected source occurrences as soon as they close, before ancestor finality.
    #[must_use]
    pub fn occurrences(mut self) -> Self {
        self.occurrences = true;
        self
    }

    /// Enables pull-based borrowed views of selected matches.
    #[must_use]
    pub fn viewed(self) -> ViewedSelectedStreamParser {
        ViewedSelectedStreamParser::new(self)
    }

    /// Stops the stream and releases retained input. Repeated calls have no further effect.
    pub fn close(&mut self) {
        self.stream.close();
    }
}

impl SelectedParser {
    /// Creates a manual selected stream from this validated parser configuration.
    #[must_use]
    pub fn stream_parser(&self) -> SelectedStreamParser {
        SelectedStreamParser::new(self.clone())
    }
}

impl FragmentStreamParser {
    /// A stream carrying validated selectors in scalar-fragment mode.
    #[must_use]
    pub fn new(parser: FragmentedParser) -> Self {
        let selectors = parser.selection.selectors;
        let mut stream = StreamParser::new(parser.parser);
        stream.scan = stream.scan.with_fragments(parser.selection);
        Self {
            stream,
            reported: Marks::default(),
            selectors,
        }
    }

    /// Stops the stream and releases retained input. Repeated calls have no further effect.
    pub fn close(&mut self) {
        self.stream.close();
    }
}

impl FragmentedParser {
    /// Creates a manual scalar-fragment stream.
    #[must_use]
    pub fn stream_parser(&self) -> FragmentStreamParser {
        FragmentStreamParser::new(self.clone())
    }
}
