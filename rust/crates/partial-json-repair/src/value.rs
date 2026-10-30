//! The recovered value, borrowed from the source wherever the source spelled it.
//!
//! Borrowing is the point: recovery reads a document once and most strings and numbers appear in it
//! verbatim, so copying them would double the work for every clean document — and clean documents
//! are the ordinary case this package is measured on. `into_owned()` is how a caller keeps a value
//! past the input.

use alloc::borrow::Cow;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use core::cmp::Ordering;

use crate::canonical::{Canonical, write_f64, write_str, write_units};

/// A JSON string, or a JavaScript one that JSON cannot spell.
///
/// Two representations because a lone surrogate is a valid parse result and Rust's `str` cannot
/// hold one. `HLD.md` rules that lone surrogates are preserved across engines, so refusing to
/// represent them would lose data the JavaScript side keeps. Both encodings can borrow source
/// storage; escapes own their decoded content. Equality follows content, not its storage encoding.
#[derive(Clone, Debug, Eq)]
pub enum JsonString<'a> {
    /// Valid UTF-8, borrowed from the source when no escape needed rewriting it.
    Text(Cow<'a, str>),
    /// Lossless UTF-16, borrowed from source or owned after decoding escapes.
    Units(Cow<'a, [u16]>),
}

impl JsonString<'_> {
    /// Borrow a UTF-8 view when available; use `code_units()` when the string has no such view.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Units(_) => None,
        }
    }

    /// Read every UTF-16 code unit without allocation, including unpaired surrogates.
    pub fn code_units(&self) -> impl Iterator<Item = u16> + Clone + '_ {
        let (text, units): (&str, &[u16]) = match self {
            Self::Text(text) => (text, &[]),
            Self::Units(units) => ("", units),
        };
        text.encode_utf16().chain(units.iter().copied())
    }

    /// Detaches from the source so the value can outlive the input.
    #[must_use]
    pub fn into_owned(self) -> JsonString<'static> {
        match self {
            Self::Text(t) => JsonString::Text(Cow::Owned(t.into_owned())),
            Self::Units(u) => JsonString::Units(Cow::Owned(u.into_owned())),
        }
    }
}

impl<'a> From<&'a str> for JsonString<'a> {
    fn from(text: &'a str) -> Self {
        Self::Text(Cow::Borrowed(text))
    }
}

impl From<String> for JsonString<'static> {
    fn from(text: String) -> Self {
        Self::Text(Cow::Owned(text))
    }
}

impl<'a> From<&'a [u16]> for JsonString<'a> {
    fn from(units: &'a [u16]) -> Self {
        Self::Units(Cow::Borrowed(units))
    }
}

impl From<Vec<u16>> for JsonString<'static> {
    fn from(units: Vec<u16>) -> Self {
        Self::Units(Cow::Owned(units))
    }
}

impl PartialEq for JsonString<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => a == b,
            (Self::Units(a), Self::Units(b)) => a == b,
            _ => self.code_units().eq(other.code_units()),
        }
    }
}

impl Ord for JsonString<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        // Preserve the native UTF-8 comparison on the ordinary path. Mixed encodings compare
        // Unicode scalars, retaining lone surrogates as their own values rather than replacing them.
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => a.cmp(b),
            _ => {
                let scalar = |unit: Result<char, core::char::DecodeUtf16Error>| {
                    unit.map_or_else(|error| u32::from(error.unpaired_surrogate()), u32::from)
                };
                core::char::decode_utf16(self.code_units())
                    .map(scalar)
                    .cmp(core::char::decode_utf16(other.code_units()).map(scalar))
            }
        }
    }
}

impl PartialOrd for JsonString<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Canonical for JsonString<'_> {
    fn write_canonical(&self, out: &mut String) {
        match self {
            Self::Text(t) => write_str(t, out),
            Self::Units(u) => write_units(u, out),
        }
    }
}

/// A number, kept exact when a double cannot hold what the source wrote.
///
/// `HLD.md`: overflow, underflow and integers that cannot be represented exactly return an exact
/// number rather than a rounded one, because silently rounding a value the source spelled correctly
/// is the one loss this package must never inflict.
#[derive(Clone, Debug, PartialEq)]
pub enum Number<'a> {
    /// Ordinary fractional arithmetic. Also carries `NaN` and `±Infinity`, which the JavaScript
    /// leniency can produce and which canonicalise as markers rather than as numbers.
    Double(f64),
    /// The digits as the source spelled them, because rounding them would lose data.
    Exact(Cow<'a, str>),
}

impl Number<'_> {
    /// Detaches from the source. See [`Value::into_owned`].
    #[must_use]
    pub fn into_owned(self) -> Number<'static> {
        match self {
            Self::Double(d) => Number::Double(d),
            Self::Exact(t) => Number::Exact(Cow::Owned(t.into_owned())),
        }
    }
}

impl Canonical for Number<'_> {
    fn write_canonical(&self, out: &mut String) {
        match self {
            Self::Exact(text) => {
                out.push_str("#exact:");
                out.push_str(text);
            }
            Self::Double(n) if n.is_nan() => out.push_str("#nan"),
            Self::Double(n) if n.is_infinite() => {
                out.push_str(if *n > 0.0 { "#inf" } else { "#-inf" });
            }
            // `-0.0 == 0.0`, so the sign has to be read off the bit pattern. `JSON.parse` preserves
            // it, therefore so must this.
            Self::Double(n) if *n == 0.0 && n.is_sign_negative() => out.push_str("#-0"),
            Self::Double(n) => write_f64(*n, out),
        }
    }
}

/// An object, in source order, with the prototype disposition the options asked for.
///
/// A vector of pairs rather than a map: insertion order is observable behaviour that the corpus
/// compares, and the documents this package parses are small enough that a linear duplicate check
/// beats the allocation a hash map costs on every object. Prototype pollution is unrepresentable
/// here — there is no prototype to walk — which is a property of the Rust value shape, not a guard
/// that could be forgotten.
///
/// **Source order is kept even where JavaScript cannot keep it, and the CONFORMANCE COMPARISON is
/// what gives way.** JavaScript reorders integer-like keys by specification — integer indices
/// ascending, then the rest in insertion order — so `{"2":"b","1":"a"}` is `1,2` there on every
/// engine and under every object shape; only a `Map` preserves it, and the shipped JavaScript value
/// is a plain object. The two implementations therefore cannot both be faithful and identical.
///
/// This is not a free choice. `HLD.md` Impact fixes plain objects for the JavaScript side, which
/// rules out returning `Map`s; Topology rules that Rust programs use this as an ordinary Rust
/// library, which rules out reordering here for a reason that exists only in JavaScript. One option
/// is left: the canonical form adopts JavaScript's order for integer-like keys, computed for the
/// comparison alone, and neither API changes. The cost is stated rather than hidden — the corpus
/// stops watching key order for exactly those keys, which is the one ordering JavaScript cannot
/// express anyway.
#[derive(Clone, Debug, Default)]
pub struct Object<'a> {
    entries: Vec<(JsonString<'a>, Value<'a>)>,
    /// Key to position, built only once an object outgrows [`LINEAR_SCAN_LIMIT`].
    ///
    /// Pure acceleration: it holds nothing `entries` does not, and is therefore excluded from
    /// equality, which compares the members a consumer can observe. Deriving `PartialEq` would
    /// make two objects with identical members compare UNEQUAL when one had crossed the threshold
    /// and the other had not — a difference in how the value was built leaking into what it is.
    index: Option<BTreeMap<JsonString<'a>, usize>>,
    /// Whether the JavaScript side would have produced a null-prototype object for these options.
    /// Carried so the canonical form matches; it means nothing to a Rust consumer.
    null_prototype: bool,
}

impl Object<'_> {
    /// Detaches from the source. See [`Value::into_owned`].
    ///
    /// The index is carried across rather than rebuilt: it is pure acceleration, and dropping it
    /// would silently re-tax the next insertions on an object that had already earned one.
    #[must_use]
    pub fn into_owned(self) -> Object<'static> {
        Object {
            entries: self
                .entries
                .into_iter()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect(),
            index: self
                .index
                .map(|i| i.into_iter().map(|(k, at)| (k.into_owned(), at)).collect()),
            null_prototype: self.null_prototype,
        }
    }
}

impl PartialEq for Object<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries && self.null_prototype == other.null_prototype
    }
}

/// Members below which a duplicate check scans linearly instead of consulting an index.
///
/// Duplicate detection needs a set, and the two ways of having one trade against opposite inputs.
/// A linear scan costs nothing to set up and O(n) per insertion; an index costs an allocation and
/// a key clone per object and O(log n) per insertion. This package's documents are overwhelmingly
/// small — the recorded corpus has a median of 25 bytes — so charging every two-member object for a
/// `BTreeMap` to protect the rare wide one would tax the ordinary case to fix the exception.
///
/// The threshold is not a taste: MEASURED on an M4 Max against `serde_json`, a pure linear scan is
/// 26x slower on a 4096-key object because each step compares STRINGS, and 51 KB of object took
/// 12 ms. That is quadratic on attacker-controllable input, which `SECURITY.md`'s resource bounds
/// exist to prevent, and it is a Rust-only regression: the JavaScript side inserts through
/// `Object.defineProperty` into an engine hash map and has no such cliff.
const LINEAR_SCAN_LIMIT: usize = 16;

impl<'a> Object<'a> {
    /// An empty object with the given prototype disposition.
    #[must_use]
    pub fn new(null_prototype: bool) -> Self {
        Self {
            entries: Vec::new(),
            index: None,
            null_prototype,
        }
    }

    /// Where this key already sits, by the index once one exists and by scan until then.
    ///
    /// One lookup rule for both callers: the scanner asks BEFORE inserting, to report the duplicate,
    /// and a second copy of this is how the report and the tree come to disagree about what counted
    /// as the same key.
    fn position_of(&self, key: &JsonString<'_>) -> Option<usize> {
        match &self.index {
            Some(index) => index.get(key).copied(),
            None => self.entries.iter().position(|(k, _)| k == key),
        }
    }

    /// Whether a member under this key is already here — a duplicate the caller is owed a report of.
    #[must_use]
    pub fn contains_key(&self, key: &JsonString<'a>) -> bool {
        self.position_of(key).is_some()
    }

    /// Borrow a member by UTF-8 text or UTF-16 code units, without allocating a lookup key.
    /// The same key comparison serves lookup and duplicate replacement, including lone surrogates.
    #[must_use]
    pub fn get<'key>(&self, key: impl Into<JsonString<'key>>) -> Option<&Value<'a>> {
        self.position_of(&key.into()).map(|at| &self.entries[at].1)
    }

    /// Inserts a member, LAST value winning at the FIRST position.
    ///
    /// That is what `obj[k] = v` does in JavaScript and `HLD.md` rules the last duplicate value is
    /// kept; the position is the other half of the same rule and is easy to get wrong by pushing,
    /// which would move the key and change an order the corpus compares.
    pub fn insert(&mut self, key: JsonString<'a>, value: Value<'a>) {
        if let Some(at) = self.position_of(&key) {
            self.entries[at].1 = value;
            return;
        }
        let at = self.entries.len();
        if let Some(index) = &mut self.index {
            index.insert(key.clone(), at);
        }
        self.entries.push((key, value));
        if self.index.is_none() && self.entries.len() > LINEAR_SCAN_LIMIT {
            self.index = Some(
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(at, (k, _))| (k.clone(), at))
                    .collect(),
            );
        }
    }

    /// The members, in source order.
    #[must_use]
    pub fn entries(&self) -> &[(JsonString<'a>, Value<'a>)] {
        &self.entries
    }
}

/// One recovered value.
///
/// **Every walk of this type recurses, so its DEPTH is bounded by the call stack.** `Drop`, `Clone`,
/// `PartialEq`, [`Self::into_owned`], the canonical writer and `stringify` all descend one frame per
/// level, and the derived ones cannot be written any other way while the tree owns its children.
/// MEASURED on a 100 000-deep array of arrays: the encoder finishes and `drop` aborts the process,
/// which is why making any single walk iterative buys nothing — the value still has to be released.
///
/// `max_depth` is what keeps a PARSED value inside that bound; at its default of 512 no input can
/// approach it. A caller raising it far, or assembling a deep value by hand, owns the risk. Removing
/// it entirely means a flat node arena, which changes this type's shape and is a maintainer decision.
#[derive(Clone, Debug, PartialEq)]
pub enum Value<'a> {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number, exact where a double would round.
    Number(Number<'a>),
    /// A string or key.
    String(JsonString<'a>),
    /// An array, in source order.
    Array(Vec<Value<'a>>),
    /// An object, in source order.
    Object(Object<'a>),
    /// JavaScript's `undefined`, reachable only under `allowJavaScript`. It is a distinct value
    /// from `null` and from the string `"undefined"`, and collapsing it would invent data.
    Undefined,
}

impl Value<'_> {
    /// Detaches from the source so the value can outlive the input.
    ///
    /// What a consumer keeping a value past the parse needs, and what a STREAM needs at every chunk
    /// boundary: the buffer grows, so nothing may still borrow it when it does. Already-owned parts
    /// move rather than copy, so a value crossing many boundaries is copied once, not once per
    /// chunk.
    #[must_use]
    pub fn into_owned(self) -> Value<'static> {
        match self {
            Self::Null => Value::Null,
            Self::Undefined => Value::Undefined,
            Self::Bool(b) => Value::Bool(b),
            Self::Number(n) => Value::Number(n.into_owned()),
            Self::String(s) => Value::String(s.into_owned()),
            Self::Array(items) => Value::Array(items.into_iter().map(Self::into_owned).collect()),
            Self::Object(o) => Value::Object(o.into_owned()),
        }
    }
}

impl Canonical for Value<'_> {
    fn write_canonical(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Undefined => out.push_str("#undef"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Number(n) => n.write_canonical(out),
            Self::String(s) => s.write_canonical(out),
            Self::Array(items) => {
                out.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    item.write_canonical(out);
                }
                out.push(']');
            }
            Self::Object(object) => {
                out.push_str(if object.null_prototype { "#np{" } else { "{" });
                for (at, (key, value)) in object.entries().iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    key.write_canonical(out);
                    out.push(':');
                    value.write_canonical(out);
                }
                out.push('}');
            }
        }
    }
}

/// The canonical form of any observable value, as one string.
#[must_use]
pub fn canonical_of(value: &impl Canonical) -> String {
    let mut out = String::new();
    value.write_canonical(&mut out);
    out
}
