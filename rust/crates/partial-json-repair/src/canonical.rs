//! One documented spelling per value, so a Rust run and a TypeScript run compare as STRINGS.
//!
//! This is the Rust half of `scripts/corpus/canonical.ts`; the two must agree byte for byte or the
//! shared corpus cannot judge either. It exists instead of `serde_json` output for the same reason
//! the TypeScript side does not use `JSON.stringify`: the values carry things JSON has no spelling
//! for — `undefined`, `NaN`, `±Infinity`, `-0`, an exact number too large for a double, a lone
//! surrogate — and a serialiser that renders those as `null` erases the behaviour under test.
//!
//! `#` opens every marker because it cannot begin a JSON token, so a marker can never collide with
//! a value that spells itself.
//!
//! **Key order is preserved, never sorted.** Insertion order is observable behaviour, and sorting
//! here would hide exactly the differences this comparison exists to find.
//!
//! Written through a `&mut String` rather than returned per node: a canonical form is produced once
//! per observation and read once, so building one string is the whole job and intermediate
//! allocations per node would be pure cost.

use alloc::string::String;
use core::fmt::{self, Write};

/// Anything a conformance record can hold. One method, so a new observable type cannot be added
/// without deciding its canonical spelling.
pub trait Canonical {
    /// Appends this value's canonical form to `out`.
    fn write_canonical(&self, out: &mut String);
}

/// Appends a JSON string literal, escaping exactly as the TypeScript side's `JSON.stringify` does.
///
/// Takes UTF-16 code units rather than `&str` because that is the alphabet the contract is written
/// in: a lone surrogate is a valid parse result on the JavaScript side and has no `char` to be. The
/// escape set is `JSON.stringify`'s — the two ASCII shorthands it uses, the C0 range as `\u00xx`,
/// and any surrogate as `\udxxx` — because a record differing only in escape spelling would report
/// a mismatch that is about the serialiser rather than the parse.
pub fn write_units(units: &[u16], out: &mut String) {
    let _ = write_units_to(units, out);
}

/// Streams escaped code units into the caller's writer, stopping on its first refusal.
pub(crate) fn write_units_to(units: &[u16], out: &mut impl Write) -> fmt::Result {
    out.write_char('"')?;
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => write_char(c, out)?,
            Err(lone) => {
                write!(out, "\\u{:04x}", lone.unpaired_surrogate())?;
            }
        }
    }
    out.write_char('"')
}

/// Appends a JSON string literal for text that is already valid UTF-8.
///
/// The common case: no surrogate can be lone in a `&str`, so the units are derived rather than
/// stored. Kept separate from [`write_units`] so ordinary strings never pay for a UTF-16 buffer.
pub fn write_str(text: &str, out: &mut String) {
    let _ = write_str_to(text, out);
}

/// Streams escaped text without first allocating its complete JSON spelling.
pub(crate) fn write_str_to(text: &str, out: &mut impl Write) -> fmt::Result {
    out.write_char('"')?;
    for c in text.chars() {
        write_char(c, out)?;
    }
    out.write_char('"')
}

/// Both string representations use the same escaping after valid pairs become scalar values.
fn write_char(c: char, out: &mut impl Write) -> fmt::Result {
    match c {
        '"' => out.write_str("\\\""),
        '\\' => out.write_str("\\\\"),
        '\u{8}' => out.write_str("\\b"),
        '\u{c}' => out.write_str("\\f"),
        '\n' => out.write_str("\\n"),
        '\r' => out.write_str("\\r"),
        '\t' => out.write_str("\\t"),
        '\u{0}'..='\u{1f}' => write!(out, "\\u{:04x}", c as u32),
        _ => out.write_char(c),
    }
}

/// Appends a double exactly as JavaScript's `String(number)` spells it.
///
/// The shortest round-tripping form is what both sides must produce, and Rust's `{}` for `f64`
/// already emits it — but the two disagree on three shapes, each of which JavaScript spells without
/// a fractional part or with an exponent where Rust does not. The non-finite cases never reach
/// here: they are markers, decided by the caller.
pub fn write_f64(value: f64, out: &mut String) {
    let _ = write_f64_to(value, out);
}

/// Emits the same numeric spelling through a fallible output sink.
pub(crate) fn write_f64_to(value: f64, out: &mut impl Write) -> fmt::Result {
    debug_assert!(
        value.is_finite(),
        "non-finite doubles are markers, not numbers"
    );
    if value == 0.0 {
        // `-0.0` is a marker decided by the caller; this is the positive zero.
        return out.write_char('0');
    }
    // JavaScript spells a magnitude inside this window positionally and everything outside it
    // exponentially; Rust's `{}` never switches. Inside the window the two agree exactly, including
    // on integral values, which `{}` prints for `f64` without a trailing `.0`. The bounds are not a
    // reading of the specification — `tests/number_spelling.rs` holds them against the engine, and
    // moving either end by one decade makes it fail.
    if !(1e-6..1e21).contains(&value.abs()) {
        write_exponential(value, out)
    } else {
        write!(out, "{value}")
    }
}

/// Spells a double in JavaScript's exponential form: `1e+30`, `1.5e-7`, mantissa without a trailing
/// `.0`, exponent always signed.
fn write_exponential(value: f64, out: &mut impl Write) -> fmt::Result {
    let mut buf = String::new();
    let _ = write!(buf, "{value:e}");
    let (mantissa, exponent) = buf.split_once('e').unwrap_or((buf.as_str(), "0"));
    out.write_str(mantissa.trim_end_matches(".0"))?;
    out.write_char('e')?;
    if !exponent.starts_with('-') {
        out.write_char('+')?;
    }
    out.write_str(exponent)
}
