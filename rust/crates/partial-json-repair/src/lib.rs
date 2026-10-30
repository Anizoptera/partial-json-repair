//! Recover usable data from JSON that is damaged, cut off, or buried in other text.
//!
//! The Rust half of the `partial-json-repair` package, and an ordinary Rust library in its own
//! right rather than only the engine behind the JavaScript one. Both implementations are held to
//! the recorded contract, compared as canonical strings so neither needs the other's type system.
//!
//! `no_std` plus `alloc`: the bottom WASM rung cannot be built any other way, and every binding —
//! native, WASI, browser — is a thin wrapper over this core rather than a variant of it.
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

mod builder;
pub(crate) mod candidate;
pub mod canonical;
pub mod chars;
/// Application-type conversion. Behind the `serde` feature, which `HLD.md` rules optional so the
/// recovery core keeps no required third-party dependency.
#[cfg(feature = "serde")]
pub mod de;
pub(crate) mod number;
pub mod options;
pub mod outcome;
pub mod parse;
pub mod report;
pub(crate) mod scalars;
pub mod scan;
pub mod selector;
pub mod stream;
pub mod stringify;
pub mod value;

pub use canonical::Canonical;
#[cfg(feature = "serde")]
pub use de::ConversionFailure;
pub use options::{
    DangerousKeyPolicy, DiagnosticsMode, FragmentedParser, Parser, Recovery, SelectedParser,
};
pub use outcome::{
    Encoding, Failed, Fragment, Match, NonJsonKind, Outcome, ParseFailure, RepairFailure, Resource,
    ScalarKind, Success,
};
pub use parse::{AsInput, Input, find_json_span, parse, parse_many, repair};
pub use report::{
    Diagnostics, ParseError, PathStep, Position, Repair, RepairKind, SourcePath, Span,
    SwitchableRepair, Unit,
};
pub use scan::{ScanError, ScanErrorKind, Scanner};
pub use selector::{PathSegment, SelectorFailure, SelectorField, SelectorPath, SelectorReason};
pub use stream::{
    FragmentStreamItem, FragmentStreamParser, OwnedStreamItem, ParsedStream, SelectedSnapshot,
    SelectedStreamItem, SelectedStreamParser, SelectedViewResult, Snapshot, StreamEvent,
    StreamFailure, StreamItem, StreamParser, StreamSummary, Summarized, ViewFailure,
    ViewedSelectedStreamParser, ViewedStreamParser, parse_stream,
};
#[cfg(feature = "async")]
pub use stream::{ParsedAsyncStream, parse_stream_async};
pub use stringify::{EncodingFailure, StringifyOptions, stringify};
pub use value::{JsonString, Number, Object, Value, canonical_of};
