//! What a caller sets, and what everything internal reads. One type, not two.
//!
//! The module is `options` and the type is [`Parser`], because the settings ARE the parser: it holds
//! nothing else, and the verbs read it. `parser.rs` beside `parse.rs` would be one letter apart on
//! the two halves of the same word, so the module keeps the name of what it defines.
//!
//! `src/options.ts` has a caller shape, a resolved shape and a typed configuration failure because a
//! JavaScript caller — or a value read from a config file — can supply `maxDepth: -1`, and that has
//! to be caught and named at run time. None of those three survives the port, and the reason is a
//! property of the language rather than a shortcut: `..Default::default()` already means "everything
//! I did not write", and [`NonZeroUsize`] already means "at least one", so the resolution step has
//! nothing to compute and the failure has nothing to report. What TypeScript detects, Rust refuses
//! to spell.
//!
//! **Only options that are WIRED live here.** The package this was extracted from advertised
//! `customDangerousKeys` and connected it to nothing — the validator that consumed it was dead code
//! whose only occurrence in the whole package was its own definition. An option a caller can set and
//! the parser never reads is worse than a missing feature: it reads as a security control being
//! configured. So this file grows only when the code that acts on a field does.
//!
//! # Fields absent, and what each waits for
//!
//! - `engine` — a JavaScript-side route choice between `JSON.parse` and the scanner. This crate has
//!   one reader, and `HLD.md` P3 rules every route gives the same answer, so both of its values name
//!   the same behaviour here.

use alloc::vec::Vec;
use core::num::NonZeroUsize;

use crate::report::SwitchableRepair;
use crate::selector::{
    Compiled, Selection, SelectorFailure, SelectorField, SelectorPath, SelectorReason,
};
use crate::value::JsonString;

/// Which recognised repairs the caller accepts, one bit per [`SwitchableRepair`].
///
/// **A bit being off does NOT mean the construct goes unrecognised.** The scan still consumes it and
/// still builds the same value; only the bookkeeping changes, from a repair into an `unparsable-span`
/// error that names the refused kind, and the outcome then fails because a policy error exists at
/// all. Recognising conditionally would build a DIFFERENT tree per configuration from the same
/// bytes, so tightening a switch would silently change values rather than only reports.
///
/// `src/options.ts` reaches the same decisions through coarse flags — `allowComments`,
/// `allowSingleQuotes`, `allowTrailingComma`, `allowUnquotedKeys`, `allowJavaScript`,
/// `repairBroken` — resolved into a per-kind map before anything reads them. Only the map is
/// carried here: the flags are an input spelling for a JavaScript caller, and a second way to say
/// the same thing is a second thing that can disagree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Recovery(u32);

impl Default for Recovery {
    /// Everything on, matching the shipped TypeScript defaults.
    fn default() -> Self {
        Self::ALL
    }
}

impl Recovery {
    /// Accept every repair.
    pub const ALL: Self = Self(u32::MAX);
    /// Accept none: every recognised construct is reported as a refusal.
    pub const NONE: Self = Self(0);

    const fn bit(kind: SwitchableRepair) -> u32 {
        1 << (kind as u32)
    }

    /// Whether this kind may be repaired rather than refused.
    #[must_use]
    pub const fn allows(self, kind: SwitchableRepair) -> bool {
        self.0 & Self::bit(kind) != 0
    }

    /// The same set with one kind accepted.
    #[must_use]
    pub const fn with(self, kind: SwitchableRepair) -> Self {
        Self(self.0 | Self::bit(kind))
    }

    /// The same set with one kind refused. `Recovery::ALL.without(SingleQuote)` is how every
    /// single-kind corpus profile is spelled, so the call reads as the configuration it names.
    #[must_use]
    pub const fn without(self, kind: SwitchableRepair) -> Self {
        Self(self.0 & !Self::bit(kind))
    }
}

/// What to do with a key that can reach `Object.prototype`.
///
/// Prototype pollution is unrepresentable in this crate's value shape — there is no prototype to
/// walk — but the policy still decides what the recovered value CONTAINS, so it is behaviour both
/// implementations must agree on rather than a JavaScript safety detail.
///
/// The package this was extracted from had no option and destroyed the ENTIRE object:
/// `{"__proto__":{"x":1},"safe":2}` returned `{}`, so a consumer could not tell the result from
/// empty input. That is neither [`Drop`](Self::Drop) nor [`Reject`](Self::Reject) — it is the worst
/// of both, and it is why the risk here is over-destruction rather than under-protection.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DangerousKeyPolicy {
    /// Omit the key. The object keeps its other members.
    Drop,
    /// Keep it as ordinary data. The right answer when the key IS data — `{"constructor": "Acme
    /// Ltd"}` is a company, not an attack.
    #[default]
    Keep,
    /// Refuse the whole object and report it. For callers who must fail closed.
    Reject,
}

/// How much reporting the caller asked for.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DiagnosticsMode {
    /// No report. The ordinary caller wants the data, and recording costs an allocation per repair.
    #[default]
    Off,
    /// Report the candidate.
    On,
    /// Also audit skipped and unselected content.
    All,
}

impl DiagnosticsMode {
    /// Whether a report is built at all.
    #[must_use]
    pub const fn reporting(self) -> bool {
        !matches!(self, Self::Off)
    }

    /// Whether content the caller's selectors declined is reported too.
    ///
    /// The default is not to: a caller who wrote `skip` asked not to receive that content, so a
    /// `confidence` lowered by damage inside it would describe data they never get. `All` is for
    /// the caller who wants to know what was in there anyway.
    #[must_use]
    pub const fn audits(self) -> bool {
        matches!(self, Self::All)
    }
}

/// The keys that can reach `Object.prototype` on the JavaScript side.
///
/// One definition, one insertion point. A fact about the PROBLEM rather than about either
/// implementation, so the two cannot drift — root `AGENTS.md` §Contract facts holds the same list.
pub const DANGEROUS_KEYS: [&str; 6] = [
    "__proto__",
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// A configured parser: everything the reader consults, and the verbs that consult it.
///
/// **The configuration IS the parser, and there is no builder.** Struct-update syntax already gives
/// what a builder gives — `Parser { exact_numbers: true, ..Parser::default() }` — and every field is
/// independently valid, so a `build()` returning `Result` would be a call that can never fail. The
/// TypeScript side needs `initParser` because it validates a caller's literal at runtime and charges
/// ~900 ns for it; Rust's types do that at compile time, so the same object here holds no validation
/// and no cached work, only the settings.
///
/// Each verb exists twice: as a method here, and as a free function of the SAME name reading the
/// shipped defaults. That pairing is `HLD.md` D2 and D3 — the common task needs no setup, and one
/// action never answers to two names.
///
/// **Reports are selected at RUNTIME, not by type.** A `Parser<Reporting>` could make
/// `diagnostics` non-optional and remove the `expect` a reporting caller writes today. It is not
/// worth it: every binding this crate feeds — native, WASM, the C header — crosses one byte-buffer
/// boundary carrying options as DATA, so a type-level choice would mean compiling both engines into
/// every artifact and a C header that cannot express either. The cost is stated rather than hidden:
/// a caller who asked for a report still unwraps an `Option` the type could have guaranteed.
#[derive(Clone, Debug)]
pub struct Parser {
    /// Whether a result carries the report of what was repaired, refused and lost.
    pub diagnostics: DiagnosticsMode,
    /// Add each successful value's source span to its result. Positions cost nothing until asked for.
    pub locations: bool,
    /// Maximum container nesting. Exceeding it is a recoverable `limit-reached`, never a panic.
    ///
    /// There is deliberately no upper cap. The package this came from hardcoded 50 as a private
    /// field, which was a stack-safety guard misread as a preference.
    ///
    /// **The SCAN is iterative, but the VALUE it returns is not.** Dropping, cloning or comparing a
    /// [`crate::Value`] descends one stack frame per level, so raising this far enough makes a
    /// recovered value impossible to release — measured to abort the process at 100 000. The bound
    /// is the stack, not memory; see the note on `Value`.
    pub max_depth: NonZeroUsize,
    /// What happens to `__proto__` and its five siblings.
    pub on_dangerous_key: DangerousKeyPolicy,
    /// Whether the JavaScript side would build objects with `Object.create(null)`.
    ///
    /// Meaningless to a Rust consumer and carried anyway, because the canonical form the conformance
    /// corpus compares spells a null-prototype object differently. Dropping it would make every such
    /// row unobservable from this side.
    pub null_prototype: bool,
    /// Extra keys treated as dangerous, beyond the six built in. Matched exactly, like the built-ins.
    pub custom_dangerous_keys: Vec<JsonString<'static>>,
    /// Which repairs are accepted rather than refused.
    pub recover: Recovery,
    /// Decoder and policy errors allowed before the scan stops and returns its recovered prefix.
    ///
    /// A refusal does not otherwise end the scan — the construct is consumed and the value keeps
    /// building — so this is the only thing that makes a strict configuration stop early, and it is
    /// observable: at `1` the recovered value is the prefix read so far and the report says the scan
    /// did not complete; above it, the same input recovers whole and reports every refusal.
    pub max_errors: NonZeroUsize,
    /// How many report ENTRIES a scan keeps — repairs and errors together, sharing one budget.
    ///
    /// A bound on what is STORED, never on what happened: past it the counts still rise, the
    /// confidence still falls, and `entries_complete` says entries were left out. A cap that raised
    /// the score would make a hostile document look clean by being damaged enough.
    ///
    /// It bounds memory because a repair carries a heap-allocated path; the kinds behind the score
    /// are kept whatever it says, at a byte apiece.
    pub max_diagnostics: usize,
    /// Maximum source bytes a stream may still need. Completed prefixes do not spend this budget.
    pub max_buffer: NonZeroUsize,
    /// Maximum units in one unfinished scalar token while streaming.
    pub max_scalar: NonZeroUsize,
    /// Maximum logical units the stream retains in its in-progress value tree.
    pub max_retained: NonZeroUsize,
    /// Keep EVERY number as the digits the source wrote, not only the ones a double would change.
    ///
    /// Off, a number is exact wherever a double would be a DIFFERENT value — overflow, underflow, an
    /// integer losing digits — which is the ruled guarantee. On, the caller is saying that ordinary
    /// binary rounding is loss too: `0.1` comes back as its own token rather than as the nearest
    /// double. Only they can judge that, so it is a flag rather than a widened default.
    pub exact_numbers: bool,
    /// Accept only object roots. Earlier non-object roots are scanned and skipped.
    pub object_only: bool,
    /// Accept only object roots containing every named own key.
    pub required_keys: Vec<JsonString<'static>>,
    /// Paths naming the parts to REMOVE. Every path must end in a key.
    ///
    /// Owned rather than borrowed so a `Parser` outlives the call that built it — the free verbs
    /// hand out a reference to a `static` default, and a lifetime here would spread to every caller
    /// that holds one. A selector list is written once and read for the life of the parser, so the
    /// allocation is not on any hot path.
    ///
    /// A path ending in a wildcard or an index could name an array element, and removing one shifts
    /// every later index — which the contract refuses to do silently. Compilation rejects it.
    pub skip: Vec<SelectorPath<'static>>,
    /// Whether damage may be repaired at all, as opposed to reported.
    ///
    /// The per-kind entries in `recover` already carry this flag's effect for every repair it
    /// governs, so nothing reads it to decide a repair. It is here for the constructs that are not
    /// repairs and have no switch: a string holding a raw control character, or one whose escapes
    /// leave the source's own bytes unable to spell the value. Those are still READ — the value is
    /// what the source wrote — but with this off they fail the outcome, because the caller has said
    /// they want text that was already JSON.
    pub repair_broken: bool,
}

/// A parser whose selection paths were validated and compiled once.
#[derive(Clone, Debug)]
pub struct SelectedParser {
    pub(crate) parser: Parser,
    pub(crate) selection: Selection<'static>,
}

/// A selected parser that streams scalar source occurrences without retaining their values.
#[derive(Clone, Debug)]
pub struct FragmentedParser {
    pub(crate) parser: Parser,
    pub(crate) selection: Selection<'static>,
}

/// The shipped defaults, matching `src/options.ts` value for value.
///
/// A `static` rather than only a [`Default`] impl, because the zero-config free verbs hand out a
/// REFERENCE to it: `parse_many` returns an iterator that borrows its parser, so a local built per
/// call would not outlive what it returns. Every field is const-constructible, so this costs nothing
/// at run time and `Default` is derived from it — one table of defaults, not two that can drift.
/// A literal bound, in const context. `unwrap_or` is not const, and a `match` inline twice reads
/// worse than naming it once.
const fn nonzero(n: usize) -> NonZeroUsize {
    match NonZeroUsize::new(n) {
        Some(value) => value,
        None => NonZeroUsize::MIN,
    }
}

pub(crate) static DEFAULTS: Parser = Parser {
    diagnostics: DiagnosticsMode::Off,
    locations: false,
    max_depth: nonzero(512),
    on_dangerous_key: DangerousKeyPolicy::Keep,
    null_prototype: false,
    custom_dangerous_keys: Vec::new(),
    recover: Recovery::ALL,
    max_errors: nonzero(1000),
    max_diagnostics: 1000,
    max_buffer: nonzero(10 * 1024 * 1024),
    max_scalar: nonzero(1024),
    max_retained: nonzero(10 * 1024 * 1024),
    exact_numbers: false,
    object_only: false,
    required_keys: Vec::new(),
    skip: Vec::new(),
    repair_broken: true,
};

impl Default for Parser {
    fn default() -> Self {
        DEFAULTS.clone()
    }
}

impl Parser {
    pub(crate) fn filters_roots(&self) -> bool {
        self.object_only || !self.required_keys.is_empty()
    }

    /// Compiles paths naming the values this parser should return.
    ///
    /// The returned parser keeps the ordinary verb names and returns typed matches, while a parser
    /// without selection keeps its simpler whole-value result and pays no matcher cost.
    ///
    /// # Errors
    /// Returns which selector field was invalid and why.
    pub fn select(
        self,
        paths: Vec<SelectorPath<'static>>,
    ) -> Result<SelectedParser, SelectorFailure> {
        let select = Compiled::compile(SelectorField::Select, paths)?;
        let skip = if self.skip.is_empty() {
            None
        } else {
            Some(Compiled::compile(
                SelectorField::Skip,
                self.skip.iter().cloned(),
            )?)
        };
        Ok(SelectedParser {
            parser: self,
            selection: Selection::new(Some(select), skip),
        })
    }

    /// Compiles the selectors this parser carries, or `None` when it carries none.
    ///
    /// Separate from the scan so the failure surfaces BEFORE any input is read: options that cannot
    /// be compiled describe a parser that cannot exist, and reading bytes under them would answer a
    /// question nobody asked. The TypeScript side reaches the same point through `initParser`.
    ///
    /// # Errors
    /// A `skip` path that does not end in a key. See [`SelectorReason`](crate::selector::SelectorReason).
    pub fn selection(&self) -> Result<Option<Selection<'static>>, SelectorFailure> {
        if self.skip.is_empty() {
            return Ok(None);
        }
        let skip = Compiled::compile(SelectorField::Skip, self.skip.iter().cloned())?;
        Ok(Some(Selection::new(None, Some(skip))))
    }

    /// Whether this key is one the dangerous-key policy governs.
    ///
    /// Matched exactly, as the built-ins are: a prefix or case-insensitive match would refuse
    /// ordinary data.
    #[must_use]
    pub fn is_dangerous_key(&self, key: &str) -> bool {
        self.is_dangerous_string(&JsonString::from(key))
    }

    pub(crate) fn is_dangerous_string(&self, key: &JsonString<'_>) -> bool {
        DANGEROUS_KEYS
            .iter()
            .any(|name| JsonString::from(*name) == *key)
            || self.custom_dangerous_keys.iter().any(|name| name == key)
    }
}

impl SelectedParser {
    /// Changes stream delivery from complete selected values to bounded scalar fragments.
    pub fn fragments(self) -> Result<FragmentedParser, SelectorFailure> {
        if self.parser.filters_roots() {
            return Err(SelectorFailure {
                field: SelectorField::Fragments,
                reason: SelectorReason::RootFilter,
            });
        }
        Ok(FragmentedParser {
            parser: self.parser,
            selection: self.selection,
        })
    }
}
