//! Turns a recovered [`Value`] into an application type, checking it on the way.
//!
//! `HLD.md` rules Serde optional and rules the recovery core free of required third-party
//! dependencies, so the whole module sits behind the `serde` feature and nothing above it knows it
//! exists.
//!
//! **Why not re-parse the repaired text with `serde_json` instead?** That route loses exactly what
//! this package exists to keep. [`crate::stringify()`] writes an exact number as the digits the source
//! spelled, which `serde_json` reads back rounded; a string holding an unpaired surrogate has no
//! round trip through any `&str` reader; and `undefined`, `NaN` and the infinities have no JSON text
//! at all. Reading the VALUE skips the text, so an exact integer reaches an `i128` field with its
//! digits intact and a lone surrogate becomes a named refusal rather than a silent replacement.
//!
//! **Why not deserialize straight off the scan, with no `Value` in between?** `docs/API.md` permits
//! that only if it preserves the same repair, duplicate-key and refusal semantics — and it cannot.
//! Recovery RETRACTS: a member already placed is withdrawn when later bytes reveal what the damage
//! was. A visitor already handed that member cannot be asked to give it back.

use alloc::borrow::Cow;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::fmt;
use core::slice::Iter;

use serde::de::value::{BorrowedStrDeserializer, StringDeserializer};
use serde::de::{
    self, DeserializeSeed, Deserializer, EnumAccess, MapAccess, SeqAccess, Unexpected,
    VariantAccess, Visitor,
};
use serde::forward_to_deserialize_any;

use crate::report::{PathStep, SourcePath, write_list};
use crate::value::{JsonString, Number, Value};

/// Why a recovered value did not fit the application type asked for.
///
/// Deliberately NOT a member of [`crate::ParseFailure`]: `docs/API.md` rules the two kept apart,
/// because recovery succeeding and the result failing a type check are different events — the first
/// is damage in the document, the second is a disagreement between the document and the program, and
/// only the second is fixed by editing the program.
#[derive(Clone, Debug, PartialEq)]
pub struct ConversionFailure<'a> {
    /// What Serde, or this module, objected to.
    pub message: String,
    /// Where in the value it sits, outermost step first. Empty when the whole value is the problem.
    ///
    /// Serde carries no path of its own, so `missing field` on a twenty-field struct would name the
    /// field and never the record that lacked it. The path is assembled as the failure unwinds, at
    /// the two places that know a step: an array element and an object member.
    pub path: SourcePath<'a>,
}

impl<'a> ConversionFailure<'a> {
    /// Records the step that contained the failure. Called while unwinding, so the outermost frame
    /// prepends last and the finished path reads from the root down.
    fn under(mut self, step: PathStep<'a>) -> Self {
        self.path.insert(0, step);
        self
    }

    /// A refusal this module raises itself, at whatever depth the walk had reached.
    fn refuse(message: String) -> Self {
        Self {
            message,
            path: Vec::new(),
        }
    }
}

impl fmt::Display for ConversionFailure<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        if !self.path.is_empty() {
            // The canonical spelling, so a path printed here and one printed in a repair report name
            // the same place the same way.
            let mut path = String::new();
            write_list(&self.path, &mut path);
            write!(f, " at {path}")?;
        }
        Ok(())
    }
}

impl de::StdError for ConversionFailure<'_> {}

impl de::Error for ConversionFailure<'_> {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        Self::refuse(msg.to_string())
    }
}

impl<'a> Value<'a> {
    /// Converts this recovered value into an application type, checking it.
    ///
    /// The borrow is the value's own lifetime, so `&str` fields borrow straight out of the source
    /// with no copy — the same reason the recovered value borrows in the first place. Call
    /// [`Value::into_owned`] first if the target must outlive the input.
    ///
    /// A number kept exact reaches the narrowest integer that holds it, and arrives as its digits
    /// otherwise, so a field declared `String` receives `1e400` unrounded rather than infinity.
    ///
    /// # Errors
    ///
    /// [`ConversionFailure`] when the document does not fit the type: a wrong shape, a missing
    /// field, an out-of-range number, or a value JSON never had — `undefined`, `NaN`, an infinity,
    /// or a string holding an unpaired surrogate, none of which any Rust type can receive as text.
    pub fn deserialize<T: serde::Deserialize<'a>>(&'a self) -> Result<T, ConversionFailure<'a>> {
        T::deserialize(self)
    }
}

/// The value itself is the deserializer: nothing is copied and no intermediate tree is built.
impl<'de> Deserializer<'de> for &'de Value<'de> {
    type Error = ConversionFailure<'de>;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        match self {
            Value::Null => visitor.visit_unit(),
            Value::Bool(b) => visitor.visit_bool(*b),
            Value::Number(Number::Double(n)) => visit_double(*n, visitor),
            Value::Number(Number::Exact(text)) => visit_exact(text, visitor),
            Value::String(s) => visit_string(s, visitor),
            Value::Array(items) => visitor.visit_seq(Elements {
                iter: items.iter(),
                at: 0,
            }),
            Value::Object(object) => visitor.visit_map(Members {
                iter: object.entries().iter(),
                entry: None,
            }),
            // Reachable only under `allow_javascript`, and only `Option` has anywhere to put it —
            // which `deserialize_option` below handles. Anywhere else it is a real mismatch.
            Value::Undefined => Err(de::Error::invalid_type(unexpected(self), &visitor)),
        }
    }

    /// `null` and `undefined` are both absence here. JavaScript distinguishes them and so does
    /// [`Value`]; `Option` has one empty case, and mapping either onto `Some` would hand the caller
    /// a value the document did not contain.
    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        match self {
            Value::Null | Value::Undefined => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    /// A newtype adds no JSON structure, so it reads whatever it wraps.
    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        visitor.visit_newtype_struct(self)
    }

    /// Externally tagged enums — the shape `serde_json` writes and therefore the shape a model
    /// imitating JSON produces: a bare string for a unit variant, a one-member object otherwise.
    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        match self {
            Value::String(tag) => visitor.visit_enum(Variant { tag, value: None }),
            Value::Object(object) => match object.entries() {
                [(tag, value)] => visitor.visit_enum(Variant {
                    tag,
                    value: Some(value),
                }),
                entries => Err(ConversionFailure::refuse(format!(
                    "expected one member naming the variant, found {}",
                    entries.len()
                ))),
            },
            other => Err(de::Error::invalid_type(unexpected(other), &visitor)),
        }
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct seq tuple tuple_struct map struct
        identifier ignored_any
    }
}

/// Exactly `2^64`. `u64::MAX as f64` rounds UP to this, so a bound written from `u64::MAX` would
/// admit `2^64` itself and the saturating cast would then answer `u64::MAX` — a silently wrong
/// number. The literal is exact in a double, so the comparison below is exact.
const POW2_64: f64 = 18_446_744_073_709_551_616.0;
/// `-2^63`, exact in a double, so the cast it guards is exact too.
const I64_MIN: f64 = -9_223_372_036_854_775_808.0;

/// A double, handed to the widest visitor that loses nothing.
///
/// JSON spells `1` and `1.0` as the same double, so a `u32` field must accept the first — visiting
/// every number as `f64` would reject it, because Serde's integer visitors refuse a float. The
/// reverse costs nothing: Serde's float impls accept integer visits. Negative zero is excluded from
/// the integer path because `0u64` would drop the sign the parser was careful to keep.
fn visit_double<'de, V: Visitor<'de>>(
    n: f64,
    visitor: V,
) -> Result<V::Value, ConversionFailure<'de>> {
    // `%` is the only integrality test `core` has: `fract` and `trunc` are `std`, and the tidier
    // `n as u64 as f64 == n` is WRONG at the boundary — the cast saturates, so `2^64` round-trips
    // through `u64::MAX` and passes. Hence the explicit bounds below rather than a cast round trip.
    if n.is_finite() && n % 1.0 == 0.0 {
        if !n.is_sign_negative() && n < POW2_64 {
            return visitor.visit_u64(n as u64);
        }
        if (I64_MIN..0.0).contains(&n) {
            return visitor.visit_i64(n as i64);
        }
    }
    visitor.visit_f64(n)
}

/// A number kept exact because a double would change it.
///
/// It reaches the NARROWEST integer that holds it and otherwise arrives as the digits themselves. It
/// is never handed to a float visitor: rounding here would undo the one decision that made the value
/// exact, so `1e400` fits a `String` field and refuses an `f64` one rather than becoming infinity.
///
/// Narrowest, not widest, because Serde's integer impls WIDEN but never NARROW. MEASURED against
/// serde 1.0.229: a `u64` field handed `visit_i128(u64::MAX)` answers `invalid type: integer … as
/// i128, expected u64` — it does not range-check. Reaching for `i128` first would therefore refuse
/// every exact number that fits an ordinary field, which is most of them.
fn visit_exact<'de, V: Visitor<'de>>(
    text: &'de Cow<'de, str>,
    visitor: V,
) -> Result<V::Value, ConversionFailure<'de>> {
    if let Ok(n) = text.parse::<i64>() {
        return visitor.visit_i64(n);
    }
    if let Ok(n) = text.parse::<u64>() {
        return visitor.visit_u64(n);
    }
    if let Ok(n) = text.parse::<i128>() {
        return visitor.visit_i128(n);
    }
    if let Ok(n) = text.parse::<u128>() {
        return visitor.visit_u128(n);
    }
    visitor.visit_borrowed_str(text)
}

/// Borrow UTF-8 strings; convert UTF-16 only when the requested host string can represent it.
///
/// Both UTF-8 `Cow` arms yield `&'de str` because the borrow is of the VALUE, not of the source text, so
/// even a string whose escapes had to be rewritten reaches a `&str` field without a copy.
///
/// UTF-16 requires an owned conversion. An unpaired surrogate is refused by name; a replacement
/// would fabricate a character the source never wrote, which is the loss `HLD.md` rules against.
fn visit_string<'de, V: Visitor<'de>>(
    text: &'de JsonString<'de>,
    visitor: V,
) -> Result<V::Value, ConversionFailure<'de>> {
    match text {
        JsonString::Text(t) => visitor.visit_borrowed_str(t),
        JsonString::Units(units) => {
            visitor.visit_string(String::from_utf16(units).map_err(|_| lone_surrogate())?)
        }
    }
}

/// The one refusal with no Serde equivalent: Rust has no string type that holds the value.
fn lone_surrogate<'a>() -> ConversionFailure<'a> {
    ConversionFailure::refuse(
        "string holds an unpaired surrogate, which no Rust string type can carry".to_string(),
    )
}

/// How a value describes itself when it is the wrong one, so Serde's message names what it found.
fn unexpected<'v>(value: &'v Value<'v>) -> Unexpected<'v> {
    match value {
        Value::Null => Unexpected::Unit,
        Value::Undefined => Unexpected::Other("undefined"),
        Value::Bool(b) => Unexpected::Bool(*b),
        Value::Number(Number::Double(n)) => Unexpected::Float(*n),
        Value::Number(Number::Exact(text)) => Unexpected::Other(text),
        Value::String(JsonString::Text(t)) => Unexpected::Str(t),
        Value::String(JsonString::Units(_)) => Unexpected::Other("UTF-16 string"),
        Value::Array(_) => Unexpected::Seq,
        Value::Object(_) => Unexpected::Map,
    }
}

/// An object key or an enum tag. Both are strings, so Serde's own string deserializer serves both —
/// it already routes `deserialize_enum` to a unit variant, which a hand-written one would have to
/// reimplement. Only the surrogate refusal is ours.
///
/// Keys therefore read as text only: `HashMap<String, _>`, named struct fields and unit-variant
/// enums. A numeric key is not inferred from digits, because JSON has no numeric key and doing so
/// would make `{"1":…}` and `{"01":…}` one member for one caller and two for another.
fn tag<'de, S: DeserializeSeed<'de>>(
    key: &'de JsonString<'de>,
    seed: S,
) -> Result<S::Value, ConversionFailure<'de>> {
    match key {
        JsonString::Text(t) => seed.deserialize(BorrowedStrDeserializer::new(t)),
        JsonString::Units(units) => seed.deserialize(StringDeserializer::new(
            String::from_utf16(units).map_err(|_| lone_surrogate())?,
        )),
    }
}

/// Array elements, numbered so a failure inside one can say which.
struct Elements<'de> {
    iter: Iter<'de, Value<'de>>,
    at: usize,
}

impl<'de> SeqAccess<'de> for Elements<'de> {
    type Error = ConversionFailure<'de>;

    fn next_element_seed<T: DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, Self::Error> {
        let Some(value) = self.iter.next() else {
            return Ok(None);
        };
        let at = self.at;
        self.at += 1;
        seed.deserialize(value)
            .map(Some)
            .map_err(|failure| failure.under(PathStep::Index(at)))
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.iter.len())
    }
}

/// Object members in source order — the order recovery recorded, with duplicate keys already
/// resolved, so nothing here re-decides which of two same-named members wins.
struct Members<'de> {
    iter: Iter<'de, (JsonString<'de>, Value<'de>)>,
    /// The member whose key was just read, held until its value is asked for.
    entry: Option<&'de (JsonString<'de>, Value<'de>)>,
}

impl<'de> MapAccess<'de> for Members<'de> {
    type Error = ConversionFailure<'de>;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Self::Error> {
        let Some(entry) = self.iter.next() else {
            return Ok(None);
        };
        self.entry = Some(entry);
        tag(&entry.0, seed).map(Some)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(
        &mut self,
        seed: V,
    ) -> Result<V::Value, Self::Error> {
        // Serde's contract is that a value is only ever requested after its key was read.
        let entry = self.entry.take().expect("a key is read before its value");
        seed.deserialize(&entry.1)
            .map_err(|failure| failure.under(PathStep::Key(entry.0.clone())))
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.iter.len())
    }
}

/// One enum variant: its tag, and the payload when the tag came from an object member.
struct Variant<'de> {
    tag: &'de JsonString<'de>,
    value: Option<&'de Value<'de>>,
}

impl<'de> EnumAccess<'de> for Variant<'de> {
    type Error = ConversionFailure<'de>;
    type Variant = Self;

    fn variant_seed<V: DeserializeSeed<'de>>(
        self,
        seed: V,
    ) -> Result<(V::Value, Self), Self::Error> {
        Ok((tag(self.tag, seed)?, self))
    }
}

impl<'de> VariantAccess<'de> for Variant<'de> {
    type Error = ConversionFailure<'de>;

    fn unit_variant(self) -> Result<(), Self::Error> {
        match self.value {
            None => Ok(()),
            Some(_) => Err(ConversionFailure::refuse(
                "expected a bare string naming a unit variant, found one carrying a value"
                    .to_string(),
            )),
        }
    }

    fn newtype_variant_seed<T: DeserializeSeed<'de>>(
        self,
        seed: T,
    ) -> Result<T::Value, Self::Error> {
        seed.deserialize(self.payload()?)
    }

    /// A tuple variant's payload is an array and a struct variant's is an object, which
    /// `deserialize_any` already routes to the right visitor — so both read the payload directly.
    fn tuple_variant<V: Visitor<'de>>(
        self,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.payload()?.deserialize_any(visitor)
    }

    fn struct_variant<V: Visitor<'de>>(
        self,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.payload()?.deserialize_any(visitor)
    }
}

impl<'de> Variant<'de> {
    /// The payload, or the refusal saying a bare tag has none.
    fn payload(&self) -> Result<&'de Value<'de>, ConversionFailure<'de>> {
        self.value.ok_or_else(|| {
            ConversionFailure::refuse(
                "variant carries data, but the document spelled it as a bare string".to_string(),
            )
        })
    }
}
