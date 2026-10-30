//! What was changed, refused or lost while recovering a value.
//!
//! The Rust half of `src/types.ts`'s reporting vocabulary. Nothing here is prose: every tag is an
//! enum, because English is a formatter's job at the edge and a caller branching on wording is a
//! caller whose code breaks when the wording improves.
//!
//! **Every canonical form here spells a JavaScript OBJECT LITERAL, field order included.** The
//! contract corpus compares `canonical()` of the JavaScript result, and `canonical()` walks
//! `Object.keys`, which is insertion order — so the order the fields are written below is part of
//! the contract, not a layout choice. It was read off the recorded rows rather than off the
//! TypeScript type, which declares the fields but not their order.

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write as _;

use crate::canonical::{Canonical, write_f64, write_str};
use crate::value::JsonString;

/// Every repair a caller may govern individually.
///
/// Split from [`RepairKind`] rather than excluded from it, so "you cannot switch `dangerous-key`
/// off" is unrepresentable instead of merely documented: its policy is already richer than a
/// disposition — `keep`, `drop` or `reject` under `on_dangerous_key` — and a second control would be
/// a second way to say the same thing that could disagree with the first. It is also why
/// [`ParseError::refused`] can only ever name a kind that HAS a switch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SwitchableRepair {
    // Structure the input opened and never closed. The parser finishes it.
    /// A string the text left open.
    UnclosedString,
    /// An object the text left open.
    UnclosedObject,
    /// An array the text left open.
    UnclosedArray,
    // Punctuation the input omitted or added.
    /// A comma before a closer.
    TrailingComma,
    /// A comma the input omitted between two members or elements.
    MissingComma,
    /// A colon the input omitted between a key and its value.
    MissingColon,
    // Spellings JSON forbids and models emit anyway.
    /// A string or key written with `'`.
    SingleQuote,
    /// A key written with no quotes at all.
    UnquotedKey,
    /// A string opened with one quote style and closed with the other.
    QuoteMismatch,
    /// A container closed by the other shape of bracket — `[{"b":2]`. Named for what the input did,
    /// not for what was inferred: the object is not unclosed, it was closed by the wrong character.
    BracketMismatch,
    /// A `//` or `/* */` comment, which JSON has no syntax for.
    CommentRemoved,
    /// `undefined`, `NaN` or `Infinity` where a value belongs.
    JsLiteral,
    /// An escape JSON does not define, or a `\u` with too few hex digits. The character it
    /// introduced is kept, which is what a model writing `\d` in a regex means.
    InvalidEscape,
    /// Unquoted text kept as a string — `{"a": foo}`, `{"a": @#$}` and `{"a": tru}` alike. ONE kind,
    /// and the name is true of all of them: the distinction between a broken word and non-word junk
    /// is about the input's characters, not about what the parser did, and the caller's action is
    /// identical either way.
    UnquotedString,
    /// A number JSON does not spell that way, beyond the three non-decimal bases below.
    InvalidNumber,
    /// `0xFF`.
    HexNumber,
    /// `0b1010`.
    BinaryNumber,
    /// A leading-zero integer, `0123`.
    OctalNumber,
    /// A byte-order mark, which is an encoding declaration rather than content.
    BomRemoved,
    /// A key the input gave twice. Reports what the input did rather than changing how it is read.
    DuplicateKey,
    /// A member no reading could place, dropped with the loss recorded.
    DroppedMember,
    /// A complete JSON boolean or null token with noncanonical letter case.
    LiteralCase,
    /// A complete `None` or `nil` token, in any ASCII letter case, recovered as null.
    NullAlias,
    /// A decimal fraction without an integer digit, including signed forms.
    LeadingDotNumber,
    /// An explicit positive sign; may combine with another numeric spelling repair.
    LeadingPlusNumber,
    /// A backslash before structural punctuation between tokens.
    EscapedDelimiter,
    /// Non-JSON whitespace between tokens, preserved when it is part of a value.
    NonJsonWhitespace,
}

impl SwitchableRepair {
    /// The wire name, identical to the TypeScript union member.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnclosedString => "unclosed-string",
            Self::UnclosedObject => "unclosed-object",
            Self::UnclosedArray => "unclosed-array",
            Self::TrailingComma => "trailing-comma",
            Self::MissingComma => "missing-comma",
            Self::MissingColon => "missing-colon",
            Self::SingleQuote => "single-quote",
            Self::UnquotedKey => "unquoted-key",
            Self::QuoteMismatch => "quote-mismatch",
            Self::BracketMismatch => "bracket-mismatch",
            Self::CommentRemoved => "comment-removed",
            Self::JsLiteral => "js-literal",
            Self::InvalidEscape => "invalid-escape",
            Self::UnquotedString => "unquoted-string",
            Self::InvalidNumber => "invalid-number",
            Self::HexNumber => "hex-number",
            Self::BinaryNumber => "binary-number",
            Self::OctalNumber => "octal-number",
            Self::BomRemoved => "bom-removed",
            Self::DuplicateKey => "duplicate-key",
            Self::DroppedMember => "dropped-member",
            Self::LiteralCase => "literal-case",
            Self::NullAlias => "null-alias",
            Self::LeadingDotNumber => "leading-dot-number",
            Self::LeadingPlusNumber => "leading-plus-number",
            Self::EscapedDelimiter => "escaped-delimiter",
            Self::NonJsonWhitespace => "non-json-whitespace",
        }
    }

    /// Every kind, so a caller can name them all without this list being written twice.
    pub const ALL: [Self; 27] = [
        Self::UnclosedString,
        Self::UnclosedObject,
        Self::UnclosedArray,
        Self::TrailingComma,
        Self::MissingComma,
        Self::MissingColon,
        Self::SingleQuote,
        Self::UnquotedKey,
        Self::QuoteMismatch,
        Self::BracketMismatch,
        Self::CommentRemoved,
        Self::JsLiteral,
        Self::InvalidEscape,
        Self::UnquotedString,
        Self::InvalidNumber,
        Self::HexNumber,
        Self::BinaryNumber,
        Self::OctalNumber,
        Self::BomRemoved,
        Self::DuplicateKey,
        Self::DroppedMember,
        Self::LiteralCase,
        Self::NullAlias,
        Self::LeadingDotNumber,
        Self::LeadingPlusNumber,
        Self::EscapedDelimiter,
        Self::NonJsonWhitespace,
    ];

    /// The kind a wire name denotes, if it denotes one.
    ///
    /// Derived from [`as_str`](Self::as_str) rather than written as a second table, so the two
    /// cannot disagree about a name — a reverse table that drifts turns an unknown kind into a
    /// switch silently left ON, which is a wrong answer rather than a missing one.
    #[must_use]
    pub fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == name)
    }
}

/// Every way the parser can alter what the input said.
///
/// **The single source of truth**: counts are `count by kind`, [`penalty`](RepairKind::penalty) is
/// keyed by it, and the conformance corpus records it. The package this was extracted from kept 17
/// hand-maintained counters beside the repairs and they could disagree, which is a defect one
/// enumeration cannot have.
///
/// A repair is NOT an error: the parse succeeded, and the caller is being told what it cost.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepairKind {
    /// One of the kinds a caller may govern individually.
    Switchable(SwitchableRepair),
    /// A key that can reach `Object.prototype` on the JavaScript side. Governed by
    /// `on_dangerous_key` rather than by a switch, which is why it sits outside
    /// [`SwitchableRepair`].
    DangerousKey,
}

impl RepairKind {
    /// The wire name, identical to the TypeScript union member.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Switchable(kind) => kind.as_str(),
            Self::DangerousKey => "dangerous-key",
        }
    }

    /// How much this repair costs `confidence`, as a fraction of remaining certainty.
    ///
    /// **Formatting repairs are free, and that is the whole design.** A trailing comma, a single
    /// quote or a comment says the input was sloppy, not that anything was GUESSED — the value is
    /// exactly what the author wrote. Only repairs that invented, dropped or reinterpreted data
    /// reduce confidence.
    #[must_use]
    pub const fn penalty(self) -> f64 {
        use SwitchableRepair as S;
        match self {
            // Something was manufactured to close a structure the input left open.
            Self::Switchable(S::UnclosedString | S::UnclosedObject | S::UnclosedArray) => 0.1,
            // Data was LOST, which a consumer most needs to know about.
            Self::Switchable(S::DuplicateKey | S::DroppedMember) | Self::DangerousKey => 0.1,
            // Free: nothing was guessed, so nothing is less certain.
            Self::Switchable(
                S::TrailingComma
                | S::SingleQuote
                | S::CommentRemoved
                | S::BomRemoved
                | S::EscapedDelimiter
                | S::NonJsonWhitespace,
            ) => 0.0,
            // Punctuation was inferred, or a token reinterpreted rather than invented.
            Self::Switchable(_) => 0.03,
        }
    }
}

/// `confidence` for a set of repairs: `∏(1 - penalty)`, never additive.
///
/// Multiplicative because that is what the published thresholds were calibrated against — 1.0 clean,
/// below 0.7 consider retrying the model, below 0.5 likely garbled — and because it degrades
/// smoothly, where an additive sum needs a clamp and reaches zero after enough small repairs, which
/// is a different promise to consumers. Those thresholds are a PUBLISHED PROMISE, so this is the
/// only place the number is produced: a second computation anywhere would be a second promise.
pub fn confidence_of(kinds: impl IntoIterator<Item = RepairKind>) -> f64 {
    kinds
        .into_iter()
        .fold(1.0, |acc, kind| acc * (1.0 - kind.penalty()))
}

/// Which alphabet an offset counts. A string's offsets are UTF-16 code units because that is what a
/// JavaScript caller indexes their own string with; a byte view's are bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unit {
    /// UTF-16 code units, as a JavaScript string is measured.
    Utf16,
    /// Bytes, as a caller's byte view is measured.
    Byte,
}

/// Where something sits in the input the caller handed us.
///
/// The offset counts the units that input is made of, so it indexes the caller's own data without a
/// second representation. `chunk` says which chunk the offset indexes: chunks may switch between
/// text and bytes, so an offset means nothing without the chunk it belongs to, and it is absent for
/// a one-shot parse where there is only one source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Position {
    /// Offset in `unit`, local to `chunk` when there is one.
    pub offset: usize,
    /// The alphabet `offset` counts.
    pub unit: Unit,
    /// Which chunk of a stream, counted from 0. Absent for a one-shot parse.
    pub chunk: Option<usize>,
}

impl Canonical for Position {
    fn write_canonical(&self, out: &mut String) {
        let _ = write!(out, "{{\"offset\":{},\"unit\":\"", self.offset);
        out.push_str(match self.unit {
            Unit::Utf16 => "utf16",
            Unit::Byte => "byte",
        });
        out.push('"');
        if let Some(chunk) = self.chunk {
            let _ = write!(out, ",\"chunk\":{chunk}");
        }
        out.push('}');
    }
}

/// Half-open `[start, end)` in the source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Span {
    /// First unit of the value.
    pub start: Position,
    /// One past its last unit.
    pub end: Position,
}

impl Canonical for Span {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"start\":");
        self.start.write_canonical(out);
        out.push_str(",\"end\":");
        self.end.write_canonical(out);
        out.push('}');
    }
}

/// One step of a path from a root down to a value: an object key or an array index.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PathStep<'a> {
    /// An object member's key.
    Key(JsonString<'a>),
    /// An array element's index.
    Index(usize),
}

impl Canonical for PathStep<'_> {
    fn write_canonical(&self, out: &mut String) {
        match self {
            Self::Key(key) => key.write_canonical(out),
            Self::Index(at) => {
                let _ = write!(out, "{at}");
            }
        }
    }
}

/// Where a value sits in its root: keys and indexes from the root down. Empty at the root.
pub type SourcePath<'a> = Vec<PathStep<'a>>;

impl PathStep<'_> {
    /// Detaches from the source. See [`crate::value::Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> PathStep<'static> {
        match self {
            Self::Key(k) => PathStep::Key(k.into_owned()),
            Self::Index(at) => PathStep::Index(at),
        }
    }
}

/// Writes a list of canonical values as a JSON array, which is how every list in a report is spelled.
pub(crate) fn write_list(items: &[impl Canonical], out: &mut String) {
    out.push('[');
    for (at, item) in items.iter().enumerate() {
        if at > 0 {
            out.push(',');
        }
        item.write_canonical(out);
    }
    out.push(']');
}

/// A single alteration, located in the SOURCE and inside the VALUE, so a caller can act on either.
#[derive(Clone, Debug, PartialEq)]
pub struct Repair<'a> {
    /// What was altered.
    pub kind: RepairKind,
    /// Where in the source, so the caller can show a user what was changed.
    pub at: Position,
    /// Where inside the value. Empty at the root.
    pub path: SourcePath<'a>,
    /// WHICH top-level value this belongs to, counted from 0 across the whole parse or stream. A
    /// streaming consumer has already rendered value 0 by the time value 1 is repaired; without this
    /// it cannot tell which rendered object to annotate.
    pub value_index: usize,
}

impl Repair<'_> {
    /// Detaches from the source. See [`crate::value::Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> Repair<'static> {
        Repair {
            kind: self.kind,
            at: self.at,
            path: self.path.into_iter().map(PathStep::into_owned).collect(),
            value_index: self.value_index,
        }
    }
}

impl Canonical for Repair<'_> {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"kind\":");
        write_str(self.kind.as_str(), out);
        out.push_str(",\"at\":");
        self.at.write_canonical(out);
        out.push_str(",\"path\":");
        write_list(&self.path, out);
        let _ = write!(out, ",\"valueIndex\":{}}}", self.value_index);
    }
}

/// Something the scanner observed and could not accept as written.
///
/// What each means for the OUTCOME is decided elsewhere: `unparsable-span` and `dangerous-key` are
/// policy refusals, `depth-budget` is a limit, and `invalid-utf8` decides nothing because the bytes
/// were recovered with replacement characters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorKind {
    /// Nesting past `max_depth`.
    DepthBudget,
    /// A key that can reach `Object.prototype`, under a policy that refuses it.
    DangerousKey,
    /// Bytes that are not valid UTF-8, recovered with replacement characters.
    InvalidUtf8,
    /// A construct the configured policy does not accept.
    UnparsableSpan,
}

impl ErrorKind {
    /// The wire name, identical to the TypeScript union member.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DepthBudget => "depth-budget",
            Self::DangerousKey => "dangerous-key",
            Self::InvalidUtf8 => "invalid-utf8",
            Self::UnparsableSpan => "unparsable-span",
        }
    }
}

/// How much source a report quotes around an error, in UTF-16 code units on each side.
///
/// Bounded deliberately: the error budget defaults to 1000, and 1000 unbounded context strings is
/// the memory hazard, not the error count.
pub const CONTEXT_RADIUS: usize = 20;

/// One refusal, located in the source and inside the value.
///
/// Field order is the contract: it is the order the JavaScript object literal is built in, which is
/// the order `canonical()` walks. `refused` sits between `context` and `path` for that reason alone,
/// and is written even when absent — the JavaScript side sets the property to `undefined` rather
/// than omitting it, so the recorded string carries `"refused":#undef`.
#[derive(Clone, Debug, PartialEq)]
pub struct ParseError<'a> {
    /// What kind of refusal this is.
    pub kind: ErrorKind,
    /// Where in the source.
    pub at: Position,
    /// 1-based line of `at`, for humans.
    pub line: usize,
    /// 1-based column of `at`, for humans.
    pub column: usize,
    /// Lossless source around `at`, bounded to [`CONTEXT_RADIUS`] units each side.
    pub context: JsonString<'a>,
    /// The recovery this error is a refusal OF, when one was declined here.
    ///
    /// Every refusal reports as `unparsable-span`, so without this a caller who switched two kinds
    /// off learns that something at an offset was refused but not WHICH assumption about their input
    /// broke — the only thing they can act on. Absent where no recovery was declined: a stray closer
    /// or a second colon inside a container alters no value, so no kind names it.
    pub refused: Option<SwitchableRepair>,
    /// Where inside the recovered value the scanner was when it refused.
    pub path: SourcePath<'a>,
    /// Top-level value this belongs to, counted from 0 across the parse or stream.
    pub value_index: usize,
}

impl ParseError<'_> {
    /// Detaches from the source. See [`crate::value::Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> ParseError<'static> {
        ParseError {
            kind: self.kind,
            at: self.at,
            line: self.line,
            column: self.column,
            context: self.context.into_owned(),
            refused: self.refused,
            path: self.path.into_iter().map(PathStep::into_owned).collect(),
            value_index: self.value_index,
        }
    }
}

impl Canonical for ParseError<'_> {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"kind\":");
        write_str(self.kind.as_str(), out);
        out.push_str(",\"at\":");
        self.at.write_canonical(out);
        let _ = write!(out, ",\"line\":{},\"column\":{}", self.line, self.column);
        out.push_str(",\"context\":");
        self.context.write_canonical(out);
        out.push_str(",\"refused\":");
        match self.refused {
            Some(kind) => write_str(kind.as_str(), out),
            None => out.push_str("#undef"),
        }
        out.push_str(",\"path\":");
        write_list(&self.path, out);
        let _ = write!(out, ",\"valueIndex\":{}}}", self.value_index);
    }
}

/// What a report covers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scope {
    /// The whole candidate.
    All,
    /// The selected values and the recovery on the way to them.
    Selected,
}

/// What was changed, refused or lost while recovering a value.
///
/// Present on a result only when the caller asked for it, on success and failure alike. `counts` are
/// totals; `repairs` and `errors` hold at most `max_diagnostics` entries BETWEEN them, and
/// `entries_complete` says whether anything was left out. `confidence` is computed from EVERY
/// repair, retained or not, because a cap on what is stored must not raise the score.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostics<'a> {
    /// The retained repairs, in the order they were made.
    pub repairs: Vec<Repair<'a>>,
    /// Retained decoder errors and policy refusals, in observation order.
    pub errors: Vec<ParseError<'a>>,
    /// How many of each were MADE, retained or not.
    pub counts: Counts,
    /// Whether every made entry is retained above.
    pub entries_complete: bool,
    /// False when a limit stopped the scanner before the end of the input.
    pub scan_complete: bool,
    /// What the report covers.
    pub scope: Scope,
    /// `∏(1 - penalty)` over every repair; 1 is untouched input.
    pub confidence: f64,
}

/// How many repairs and errors were made, retained or not.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Counts {
    /// Repairs made.
    pub repairs: usize,
    /// Refusals observed.
    pub errors: usize,
}

impl Diagnostics<'_> {
    /// Detaches from the source. See [`crate::value::Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> Diagnostics<'static> {
        Diagnostics {
            repairs: self.repairs.into_iter().map(Repair::into_owned).collect(),
            errors: self
                .errors
                .into_iter()
                .map(ParseError::into_owned)
                .collect(),
            counts: self.counts,
            entries_complete: self.entries_complete,
            scan_complete: self.scan_complete,
            scope: self.scope,
            confidence: self.confidence,
        }
    }
}

impl Canonical for Diagnostics<'_> {
    fn write_canonical(&self, out: &mut String) {
        out.push_str("{\"repairs\":");
        write_list(&self.repairs, out);
        out.push_str(",\"errors\":");
        write_list(&self.errors, out);
        let _ = write!(
            out,
            ",\"counts\":{{\"repairs\":{},\"errors\":{}}},\"entriesComplete\":{},\"scanComplete\":{},\"scope\":\"{}\",\"confidence\":",
            self.counts.repairs,
            self.counts.errors,
            self.entries_complete,
            self.scan_complete,
            match self.scope {
                Scope::All => "all",
                Scope::Selected => "selected",
            }
        );
        write_f64(self.confidence, out);
        out.push('}');
    }
}

/// The report a failure that never reached a scanner carries: nothing happened, and saying so is
/// what keeps a caller whose type promises a report from meeting `undefined` on one branch.
#[must_use]
pub fn clean_diagnostics<'a>() -> Diagnostics<'a> {
    Diagnostics {
        repairs: Vec::new(),
        errors: Vec::new(),
        counts: Counts::default(),
        entries_complete: true,
        scan_complete: true,
        scope: Scope::All,
        confidence: 1.0,
    }
}
