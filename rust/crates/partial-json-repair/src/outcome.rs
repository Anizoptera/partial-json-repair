//! The one outcome shape: the data, or a typed reason there is none.
//!
//! Status lives OUTSIDE the data, so `{"ok":false}` parses to a SUCCESS holding that object and a
//! failure never has a `value` to mistake for one. Recovered data on failure sits INSIDE the
//! failure, never beside it: `HLD.md` rules that a strict refusal or a stopped scan is never an
//! ordinary success, while the caller still gets what was read.
//!
//! A plain [`Result`] carries that, so `?` works and a Rust caller meets no bespoke enum. `span` and
//! `diagnostics` ride on the two arms rather than on a wrapper, which is what makes "a span on a
//! failure" unrepresentable instead of merely undocumented.
//!
//! The canonical forms below spell the JavaScript object literals the contract corpus records, field
//! order included — see the note at the top of [`crate::report`].

use alloc::string::String;
use core::fmt::Write as _;

use crate::canonical::{Canonical, write_str};
use crate::report::{Diagnostics, ParseError, Position, SourcePath, Span, write_list};
use crate::selector::{SelectorField, SelectorReason};
use crate::value::{JsonString, Value};

/// A report, kept behind a pointer so a call that did not ask for one does not carry its weight.
///
/// `HLD.md` P4: diagnostics are opt-in so ordinary calls do not pay for explanations they did not
/// request. A `Diagnostics` is three vectors, two counts and a score — over a hundred bytes moved
/// through every return on the DEFAULT path, where it is always absent. Behind a pointer the
/// default costs eight bytes and no allocation, and the caller who asked pays the one allocation
/// they asked for.
pub type Report<'a> = Option<alloc::boxed::Box<Diagnostics<'a>>>;

/// A value, with whatever the options asked to be reported alongside it.
#[derive(Clone, Debug, PartialEq)]
pub struct Success<'a, T> {
    /// What was recovered.
    pub value: T,
    /// The value's extent in the source. Present exactly when `locations` asked for it.
    pub span: Option<Span>,
    /// Present exactly when `diagnostics` asked for a report.
    pub diagnostics: Report<'a>,
}

/// A selected value with the source identity needed to place or explain it.
#[derive(Clone, Debug, PartialEq)]
pub struct Match<T> {
    /// The selected value, whole when it is a container.
    pub value: T,
    /// Concrete keys and indexes from its recognized root.
    pub path: SourcePath<'static>,
    /// Which recognized root contains this value.
    pub value_index: usize,
    /// Half-open source extent of the selected node.
    pub span: Span,
    /// Indexes of every supplied selector that named this node.
    pub selectors: alloc::vec::Vec<usize>,
}

/// The kind of scalar whose contents a fragment stream is delivering.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScalarKind {
    /// A decoded string.
    String,
    /// A JSON number spelling.
    Number,
    /// `true`, `false`, `null`, or an explicitly enabled JavaScript literal.
    Literal,
}

impl ScalarKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Number => "number",
            Self::Literal => "literal",
        }
    }
}

/// One bounded piece of a selected scalar source occurrence.
#[derive(Clone, Debug, PartialEq)]
pub enum Fragment {
    /// Announces a selected scalar before its contents.
    Start {
        /// Unique within this stream.
        id: usize,
        /// Recognized root containing the scalar.
        value_index: usize,
        /// Location in that root.
        path: SourcePath<'static>,
        /// Selector indexes naming this occurrence.
        selectors: alloc::vec::Vec<usize>,
        /// How the data pieces should be interpreted.
        scalar: ScalarKind,
    },
    /// A nonempty bounded piece of decoded scalar content.
    Data {
        /// The matching start event's identifier.
        id: usize,
        /// Decoded string content or source spelling for numbers and literals.
        text: JsonString<'static>,
    },
    /// Confirms that the source occurrence completed.
    End {
        /// The matching start event's identifier.
        id: usize,
        /// Half-open source extent of the complete scalar.
        span: Span,
    },
}

/// Detaches an optional report from the source it read.
///
/// The box is rebuilt rather than reused: `Box<Diagnostics<'a>>` and `Box<Diagnostics<'static>>` are
/// different types, so there is no cast that keeps the allocation, and detaching is the point at
/// which a caller has already accepted owning the content.
fn own_report(report: Report<'_>) -> Report<'static> {
    report.map(|d| alloc::boxed::Box::new(d.into_owned()))
}

impl<'a> Success<'a, Value<'a>> {
    /// Detaches from the source. See [`crate::value::Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> Success<'static, Value<'static>> {
        Success {
            value: self.value.into_owned(),
            span: self.span,
            diagnostics: own_report(self.diagnostics),
        }
    }
}

/// Why there is no value, with the report if one was asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct Failed<'a, F> {
    /// The typed reason.
    pub failure: F,
    /// Present exactly when `diagnostics` asked for a report. Empty rather than absent for a failure
    /// that reached no scanner, so a caller whose type promises a report finds one on every branch.
    pub diagnostics: Report<'a>,
}

impl<'a> Failed<'a, ParseFailure<'a>> {
    /// Detaches from the source. See [`crate::value::Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> Failed<'static, ParseFailure<'static>> {
        Failed {
            failure: self.failure.into_owned(),
            diagnostics: own_report(self.diagnostics),
        }
    }
}

/// The one outcome shape, for any verb.
///
/// A plain [`Result`], so `?` works and a Rust caller meets no bespoke enum. The failure arm is
/// BOXED because it is the cold one: a `Result` is as large as its widest arm, and a refusal
/// carrying its issue and what was recovered would otherwise be moved through every SUCCESSFUL
/// return. `Box` derefs, so a caller still writes `e.failure` and never sees the indirection.
pub type Outcome<'a, T, F> = Result<Success<'a, T>, alloc::boxed::Box<Failed<'a, F>>>;

/// Byte-order marks this package refuses rather than guesses at.
///
/// `HLD.md`: byte input is UTF-8, and a DECLARED unsupported encoding is refused. Refused rather
/// than transcoded because a transcoder is a second reader of the same bytes, and because a caller
/// who has UTF-16 knows it and can decode it with one call in their own runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Encoding {
    /// `FE FF`.
    Utf16Be,
    /// `FF FE`, not followed by the UTF-32LE tail.
    Utf16Le,
    /// `00 00 FE FF`.
    Utf32Be,
    /// `FF FE 00 00`.
    Utf32Le,
}

impl Encoding {
    const MARKS: &'static [(&'static [u8], Self)] = &[
        (&[0x00, 0x00, 0xfe, 0xff], Self::Utf32Be),
        (&[0xff, 0xfe, 0x00, 0x00], Self::Utf32Le),
        (&[0xfe, 0xff], Self::Utf16Be),
        (&[0xff, 0xfe], Self::Utf16Le),
    ];

    /// A longer declared mark can still change the encoding decision.
    pub(crate) fn declaration_pending(bytes: &[u8]) -> bool {
        Self::MARKS
            .iter()
            .any(|(mark, _)| bytes.len() < mark.len() && mark.starts_with(bytes))
    }

    /// The wire name, identical to the TypeScript union member.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Utf16Be => "utf-16be",
            Self::Utf16Le => "utf-16le",
            Self::Utf32Be => "utf-32be",
            Self::Utf32Le => "utf-32le",
        }
    }

    /// The encoding these bytes declare, if it is one this package refuses.
    ///
    /// UTF-32LE is tested BEFORE UTF-16LE because its mark begins with the UTF-16LE mark: checking
    /// the shorter one first would report every UTF-32LE document as UTF-16LE, which is a wrong
    /// answer rather than a missing one. A UTF-8 mark is not here — it is content-free and stripped
    /// as a repair rather than refused.
    #[must_use]
    pub fn declared_by(bytes: &[u8]) -> Option<Self> {
        Self::MARKS
            .iter()
            .find_map(|(mark, encoding)| bytes.starts_with(mark).then_some(*encoding))
    }
}

/// What a resource bound was bounding when it stopped the scan.
///
/// Every resource whose configured bound can stop recovery.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Resource {
    /// Decoder or policy errors exhausted `max_errors`.
    Errors,
    /// Source bytes a stream still needs.
    Buffer,
    /// Container nesting past `max_depth`.
    Depth,
    /// One unfinished scalar token.
    Scalar,
    /// Logical content held in the in-progress value tree.
    Retained,
}

impl Resource {
    /// The wire name, identical to the TypeScript union member.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Errors => "errors",
            Self::Buffer => "buffer",
            Self::Depth => "depth",
            Self::Scalar => "scalar",
            Self::Retained => "retained",
        }
    }
}

/// Why a parse did not succeed.
///
/// None of these panics, and each says what to do next. `NoJsonFound` is NOT the same as parsing the
/// literal `null`, which succeeds with a null value: absence and a null value stay distinguishable
/// without inspecting the value.
///
/// `InvalidInput` from the TypeScript union has no member here: its only cause is a JavaScript
/// caller passing something that is neither a string nor a byte view, and Rust's types refuse that
/// before a call exists.
#[derive(Clone, Debug, PartialEq)]
pub enum ParseFailure<'a> {
    /// Bytes opened with a UTF-16 or UTF-32 mark. Decode them yourself; only UTF-8 is read here.
    UnsupportedEncoding {
        /// What the mark declared.
        encoding: Encoding,
    },
    /// The text held no candidate value.
    NoJsonFound,
    /// Candidate roots existed, but none satisfied the configured root filter.
    NoMatch {
        /// Own keys every accepted object must contain.
        required_keys: alloc::vec::Vec<JsonString<'static>>,
        /// The first object root, when one existed but lacked required keys.
        recovered: Option<Value<'a>>,
    },
    /// A terminal failure already closed this push stream.
    StreamClosed,
    /// A selector list could not be compiled. Nothing was read: the options describe a parser that
    /// cannot exist, so answering with a value would be answering a different question.
    InvalidOptions {
        /// Which option held the unusable path.
        field: SelectorField,
        /// What was wrong with it.
        reason: SelectorReason,
    },
    /// Fragment delivery selected a container, whose contents cannot be one scalar stream.
    NonScalarSelection {
        /// Concrete selected container path.
        path: SourcePath<'static>,
    },
    /// A construct the configured policy does not accept.
    PolicyRefused {
        /// The FIRST refusal. Later ones are in the report, when one was asked for.
        issue: ParseError<'a>,
        /// What had been built when the refusal happened. The data is real; the status is not
        /// success.
        recovered: Option<Value<'a>>,
    },
    /// A resource bound stopped processing.
    LimitReached {
        /// Which bound.
        resource: Resource,
        /// Its value, so a caller can raise it without consulting the documentation.
        limit: usize,
        /// Where, when the scanner knows.
        at: Option<Position>,
        /// What had been built when it stopped.
        recovered: Option<Value<'a>>,
    },
}

impl ParseFailure<'_> {
    /// Detaches from the source. See [`crate::value::Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> ParseFailure<'static> {
        match self {
            Self::UnsupportedEncoding { encoding } => {
                ParseFailure::UnsupportedEncoding { encoding }
            }
            Self::NoJsonFound => ParseFailure::NoJsonFound,
            Self::NoMatch {
                required_keys,
                recovered,
            } => ParseFailure::NoMatch {
                required_keys,
                recovered: recovered.map(Value::into_owned),
            },
            Self::StreamClosed => ParseFailure::StreamClosed,
            Self::InvalidOptions { field, reason } => {
                ParseFailure::InvalidOptions { field, reason }
            }
            Self::NonScalarSelection { path } => ParseFailure::NonScalarSelection { path },
            Self::PolicyRefused { issue, recovered } => ParseFailure::PolicyRefused {
                issue: issue.into_owned(),
                recovered: recovered.map(Value::into_owned),
            },
            Self::LimitReached {
                resource,
                limit,
                at,
                recovered,
            } => ParseFailure::LimitReached {
                resource,
                limit,
                at,
                recovered: recovered.map(Value::into_owned),
            },
        }
    }
}

impl Canonical for ParseFailure<'_> {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"kind\":");
        match self {
            Self::UnsupportedEncoding { encoding } => {
                write_str("unsupported-encoding", out);
                out.push_str(",\"encoding\":");
                write_str(encoding.as_str(), out);
            }
            Self::NoJsonFound => write_str("no-json-found", out),
            Self::NoMatch {
                required_keys,
                recovered,
            } => {
                write_str("no-match", out);
                out.push_str(",\"expected\":\"object\",\"requiredKeys\":");
                required_keys.write_canonical(out);
                write_recovered(recovered.as_ref(), out);
            }
            Self::StreamClosed => write_str("stream-closed", out),
            Self::InvalidOptions { field, reason } => {
                write_str("invalid-options", out);
                out.push_str(",\"field\":");
                write_str(field.as_str(), out);
                out.push_str(",\"reason\":");
                write_str(reason.as_str(), out);
            }
            Self::NonScalarSelection { path } => {
                write_str("non-scalar-selection", out);
                out.push_str(",\"path\":");
                path.write_canonical(out);
            }
            Self::PolicyRefused { issue, recovered } => {
                write_str("policy-refused", out);
                out.push_str(",\"issue\":");
                issue.write_canonical(out);
                write_recovered(recovered.as_ref(), out);
            }
            Self::LimitReached {
                resource,
                limit,
                at,
                recovered,
            } => {
                write_str("limit-reached", out);
                out.push_str(",\"resource\":");
                write_str(resource.as_str(), out);
                let _ = write!(out, ",\"limit\":{limit}");
                if let Some(at) = at {
                    out.push_str(",\"at\":");
                    at.write_canonical(out);
                }
                write_recovered(recovered.as_ref(), out);
            }
        }
        out.push('}');
    }
}

/// A value the scan recovered that JSON TEXT has no spelling for.
///
/// Reachable only where a leniency produced it: `allowJavaScript` reads `undefined`, `NaN` and
/// `Infinity` as the values JavaScript means by them, and each is a real value a caller may keep.
/// `repair` must hand back text something else can parse, so it refuses rather than inventing a
/// spelling — writing `null` would be a value the source never held, and quoting it a string.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NonJsonKind {
    /// JavaScript's `undefined`.
    Undefined,
    /// A `NaN` double.
    Nan,
    /// A `±Infinity` double.
    Infinity,
}

impl NonJsonKind {
    /// The tag the corpus and a JavaScript caller both spell.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Undefined => "undefined",
            Self::Nan => "nan",
            Self::Infinity => "infinity",
        }
    }
}

/// Why `repair` could not produce text.
///
/// Everything `parse` can fail with, plus the one refusal that belongs to TEXT alone: a value it
/// cannot spell. A type of its own rather than a variant on [`ParseFailure`], because `parse`
/// returns that value happily and a caller matching on it must not have to handle a case it can
/// never see.
#[derive(Clone, Debug, PartialEq)]
pub enum RepairFailure<'a> {
    /// The scan itself failed; the reason is exactly what `parse` would have given.
    Parse(ParseFailure<'a>),
    /// The value was recovered but has no JSON spelling.
    NonJsonValue {
        /// Which unspellable value.
        value_kind: NonJsonKind,
        /// Where it sits in the recovered value.
        path: SourcePath<'a>,
    },
}

impl Canonical for RepairFailure<'_> {
    fn write_canonical(&self, out: &mut String) {
        match self {
            Self::Parse(failure) => failure.write_canonical(out),
            Self::NonJsonValue { value_kind, path } => {
                out.push_str("{\"kind\":");
                write_str("non-json-value", out);
                out.push_str(",\"valueKind\":");
                write_str(value_kind.as_str(), out);
                out.push_str(",\"path\":");
                write_list(path, out);
                out.push('}');
            }
        }
    }
}

/// Data a failed operation still recovered, spelled as the JavaScript `Recovery` wrapper.
///
/// The wrapper exists so that "recovered nothing" and "recovered `null`" stay distinguishable: an
/// absent field is the first, `{"value":null}` the second. Flattening it would make a recovered
/// `null` unrepresentable.
fn write_recovered(value: Option<&Value<'_>>, out: &mut String) {
    if let Some(value) = value {
        out.push_str(",\"recovered\":{\"value\":");
        value.write_canonical(out);
        out.push('}');
    }
}

impl<T: Canonical> Canonical for Success<'_, T> {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"ok\":true,\"value\":");
        self.value.write_canonical(out);
        if let Some(span) = &self.span {
            out.push_str(",\"span\":");
            span.write_canonical(out);
        }
        write_report(&self.diagnostics, out);
        out.push('}');
    }
}

impl<T: Canonical> Canonical for Match<T> {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"value\":");
        self.value.write_canonical(out);
        out.push_str(",\"path\":");
        self.path.write_canonical(out);
        let _ = write!(out, ",\"valueIndex\":{},\"span\":", self.value_index);
        self.span.write_canonical(out);
        out.push_str(",\"selectors\":[");
        for (at, selector) in self.selectors.iter().enumerate() {
            if at > 0 {
                out.push(',');
            }
            let _ = write!(out, "{selector}");
        }
        out.push_str("]}");
    }
}

impl Canonical for Fragment {
    fn write_canonical(&self, out: &mut String) {
        match self {
            Self::Start {
                id,
                value_index,
                path,
                selectors,
                scalar,
            } => {
                out.push_str("{\"kind\":\"start\",\"id\":");
                let _ = write!(out, "{id},\"valueIndex\":{value_index},\"path\":");
                path.write_canonical(out);
                out.push_str(",\"selectors\":[");
                for (at, selector) in selectors.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    let _ = write!(out, "{selector}");
                }
                out.push_str("],\"scalar\":");
                write_str(scalar.as_str(), out);
                out.push('}');
            }
            Self::Data { id, text } => {
                out.push_str("{\"kind\":\"data\",\"id\":");
                let _ = write!(out, "{id},\"text\":");
                text.write_canonical(out);
                out.push('}');
            }
            Self::End { id, span } => {
                out.push_str("{\"kind\":\"end\",\"id\":");
                let _ = write!(out, "{id},\"span\":");
                span.write_canonical(out);
                out.push('}');
            }
        }
    }
}

impl<F: Canonical> Canonical for Failed<'_, F> {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"ok\":false,\"failure\":");
        self.failure.write_canonical(out);
        write_report(&self.diagnostics, out);
        out.push('}');
    }
}

fn write_report(diagnostics: &Report<'_>, out: &mut String) {
    if let Some(report) = diagnostics {
        out.push_str(",\"diagnostics\":");
        report.write_canonical(out);
    }
}

/// A boxed value records as the value. Needed because the failure arm of an [`Outcome`] is boxed:
/// where the pointer lives is a layout decision, and the contract records values.
impl<T: Canonical + ?Sized> Canonical for alloc::boxed::Box<T> {
    fn write_canonical(&self, out: &mut String) {
        (**self).write_canonical(out);
    }
}

/// Either arm of an outcome, so `Result` needs no wrapper to be recorded.
impl<A: Canonical, B: Canonical> Canonical for Result<A, B> {
    fn write_canonical(&self, out: &mut String) {
        match self {
            Ok(value) => value.write_canonical(out),
            Err(failure) => failure.write_canonical(out),
        }
    }
}

/// A list, spelled as a JSON array. What `parse_many` is recorded as.
impl<T: Canonical> Canonical for alloc::vec::Vec<T> {
    fn write_canonical(&self, out: &mut String) {
        out.push('[');
        for (at, item) in self.iter().enumerate() {
            if at > 0 {
                out.push(',');
            }
            item.write_canonical(out);
        }
        out.push(']');
    }
}

/// Repaired source text, which `repair` hands back as a JSON string.
impl Canonical for &str {
    fn write_canonical(&self, out: &mut String) {
        write_str(self, out);
    }
}

/// Repaired text, which is borrowed while nothing has been spliced and owned once something has.
/// Which of the two it is, is a cost the caller may care about and never a difference the contract
/// records, so both spell the same string.
impl Canonical for alloc::borrow::Cow<'_, str> {
    fn write_canonical(&self, out: &mut String) {
        write_str(self, out);
    }
}

impl Canonical for String {
    fn write_canonical(&self, out: &mut String) {
        write_str(self, out);
    }
}
