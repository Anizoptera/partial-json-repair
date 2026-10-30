//! One number token: where it ends, and what JSON spelling it should have had.
//!
//! Apart from the scanner because none of it needs scan state — a token's extent and its meaning are
//! functions of the bytes alone, which is what lets them be tested without building a document. The
//! scanner keeps the DISPOSITION: whether a spelling is a repair or a refusal is the caller's
//! policy, and this module only says which one is in question.
//!
//! **The token grammar is deliberately greedier than JSON's.** It consumes every digit, point and
//! exponent character in a row, so `1.2.3` and `01` arrive here WHOLE rather than as a valid prefix
//! and a mystery tail. A reader that stopped at the first character JSON forbids would return `1`
//! for `1.2.3` — a value the source never wrote — and leave `.2.3` to become an invented member.

use alloc::borrow::Cow;
use alloc::string::String;
use alloc::vec::Vec;

use crate::chars::{digit_value, unit};
use crate::report::SwitchableRepair;
use crate::value::Number;

/// What a number token turned out to be.
pub struct Spelling<'a> {
    /// The sign repair followed by the magnitude repair. Each can be refused independently;
    /// a combined spelling such as `+.5` must not hide either change.
    pub kinds: [Option<SwitchableRepair>; 2],
    /// The JSON spelling, equal to the raw token when it was already JSON. A caller compares the two
    /// to know whether the repaired TEXT needs a splice.
    pub text: Cow<'a, str>,
    /// The value, or `None` when the token is not a number at all — then the raw text is the value,
    /// as a string, because reading `1.2.3` as `1` would invent a number the source never wrote.
    pub value: Option<Number<'a>>,
}

/// Where the number token starting at `start` ends, in the input's own units.
///
/// `start` names a digit, sign or decimal point; `next` is either `start` or the end of a previously
/// undelimited prefix. The caller decides whether reaching the input end means pause or completion.
/// Recheck the fixed opening radix probe until its first digit arrives, then scan only new units.
#[must_use]
#[cfg(test)]
pub(crate) fn token_end_from<T: Copy + Into<u32>>(input: &[T], start: usize, next: usize) -> usize {
    token_end_with(input.len(), start, next, |i| {
        input.get(i).map_or(0, |&value| value.into())
    })
}

/// The getter joins saved numeric spelling and active source without copying the active chunk.
pub(crate) fn token_end_with(
    end: usize,
    start: usize,
    next: usize,
    code_unit: impl Fn(usize) -> u32,
) -> usize {
    let mut at = start;
    if matches!(code_unit(at), unit::MINUS | unit::PLUS) {
        at += 1;
    }
    // A radix prefix is decided before anything is consumed, and only counts when a digit OF THAT
    // RADIX follows it: `0x` alone is not a hex number, and `0b` followed by `9` is not a binary one.
    if code_unit(at) == unit::ZERO {
        let marker = code_unit(at + 1) | 0x20;
        let radix = match marker {
            unit::LOWER_X => 16,
            unit::LOWER_B => 2,
            _ => 0,
        };
        if radix != 0 && digit_value(code_unit(at + 2)) < radix {
            at = (at + 2).max(next);
            while digit_value(code_unit(at)) < radix {
                at += 1;
            }
            return at;
        }
    }
    // The decimal alphabet. A sign is consumed only straight after an exponent marker, which is what
    // keeps `1-2` two tokens while `1e-2` is one.
    at = at.max(next);
    let mut after_exponent =
        at > start && matches!(code_unit(at - 1), unit::LOWER_E | unit::UPPER_E);
    while at < end {
        let c = code_unit(at);
        if (unit::ZERO..=unit::NINE).contains(&c)
            || c == unit::DOT
            || c == unit::LOWER_E
            || c == unit::UPPER_E
        {
            at += 1;
            after_exponent = c == unit::LOWER_E || c == unit::UPPER_E;
            continue;
        }
        if after_exponent && (c == unit::MINUS || c == unit::PLUS) {
            at += 1;
            after_exponent = false;
            continue;
        }
        break;
    }
    at
}

/// What the token means, and which spelling it used to say it.
#[must_use]
pub fn read(raw: &str, exact_numbers: bool) -> Spelling<'_> {
    let bytes = raw.as_bytes();
    let byte = |i: usize| bytes.get(i).map_or(0, |&b| u32::from(b));
    let negative = byte(0) == unit::MINUS;
    let positive = byte(0) == unit::PLUS;
    let sign = positive.then_some(SwitchableRepair::LeadingPlusNumber);
    let digits_at = usize::from(negative || positive);
    let marker = byte(digits_at + 1) | 0x20;
    let radix = match marker {
        unit::LOWER_X if byte(digits_at) == unit::ZERO => 16,
        unit::LOWER_B => 2,
        _ => 0,
    };
    if radix != 0 && raw.len() > digits_at + 2 {
        // The grammar admitted only digits of this radix after the prefix, so the conversion cannot
        // meet one it does not understand.
        let mut text = String::new();
        if negative {
            text.push('-');
        }
        to_decimal(&bytes[digits_at + 2..], radix, &mut text);
        let value = exactness(&text, exact_numbers);
        return Spelling {
            kinds: [
                sign,
                Some(match radix {
                    16 => SwitchableRepair::HexNumber,
                    _ => SwitchableRepair::BinaryNumber,
                }),
            ],
            text: Cow::Owned(text),
            value: Some(value),
        };
    }
    // Not a number at all — two decimal points, an exponent with no digits, a lone minus. The token
    // is kept as the string the source wrote, which is the only reading that loses nothing.
    if raw.parse::<f64>().is_err() {
        return Spelling {
            kinds: [None, Some(SwitchableRepair::InvalidNumber)],
            text: Cow::Borrowed(raw),
            value: None,
        };
    }
    let text = json_spelling(raw);
    let kind = match text == raw[usize::from(positive)..] {
        true => None,
        false if byte(digits_at) == unit::DOT => Some(SwitchableRepair::LeadingDotNumber),
        // Keep the existing leading-zero policy; remaining edits remove a trailing decimal point.
        false => Some(
            match byte(digits_at) == unit::ZERO && digit_value(byte(digits_at + 1)) <= 9 {
                true => SwitchableRepair::OctalNumber,
                false => SwitchableRepair::InvalidNumber,
            },
        ),
    };
    let value = exactness(&text, exact_numbers);
    Spelling {
        kinds: [sign, kind],
        text,
        value: Some(value),
    }
}

/// The JSON spelling of a number that parses but that the grammar does not admit: leading zeros
/// dropped, a leading plus removed, a leading point given its zero, a trailing point removed.
/// Returns the input unchanged when it was already JSON, so the caller knows whether an edit is due.
fn json_spelling(raw: &str) -> Cow<'_, str> {
    let bytes = raw.as_bytes();
    let byte = |i: usize| bytes.get(i).map_or(0, |&b| u32::from(b));
    let negative = byte(0) == unit::MINUS;
    let mut start = usize::from(negative || byte(0) == unit::PLUS);
    while byte(start) == unit::ZERO && digit_value(byte(start + 1)) <= 9 {
        start += 1;
    }
    let mut body = &raw[start..];
    let owned;
    match body.find('.') {
        Some(0) => {
            owned = alloc::format!("0{body}");
            body = &owned;
        }
        Some(dot) if digit_value(byte(start + dot + 1)) > 9 => {
            owned = alloc::format!("{}{}", &body[..dot], &body[dot + 1..]);
            body = &owned;
        }
        _ => {}
    }
    if start == usize::from(negative) && body.len() == raw.len() - usize::from(negative) {
        return Cow::Borrowed(raw);
    }
    let mut text = String::with_capacity(usize::from(negative) + body.len());
    if negative {
        text.push('-');
    }
    text.push_str(body);
    Cow::Owned(text)
}

/// The value a JSON-spelled token denotes, kept exact where a double would be a DIFFERENT value.
///
/// Three ways that happens, and only three: the magnitude overflows to infinity, a nonzero magnitude
/// underflows to zero, or an integer loses digits. A fraction that merely ROUNDS is ordinary
/// floating-point arithmetic and stays a double — protecting it would make every `0.1` an exact
/// string, and the guarantee is about digits the source wrote, not about binary fractions.
///
/// The integer case is decided by re-spelling rather than by counting digits: the boundary is not
/// 2^53 but whether THIS literal survives the round trip, and a digit count answers a different
/// question.
fn exactness(text: &str, exact_numbers: bool) -> Number<'static> {
    let exact = || Number::Exact(Cow::Owned(text.into()));
    // `exact_numbers` widens the guarantee below to every number: the caller has said that ordinary
    // binary rounding is loss too, which is the one judgement this function cannot make for them.
    if exact_numbers {
        return exact();
    }
    let Ok(double) = text.parse::<f64>() else {
        return exact();
    };
    if !double.is_finite() {
        return exact();
    }
    if double == 0.0 {
        // Zero of either sign is exactly representable — unless the token was not zero and the
        // exponent sank it, in which case every digit the source wrote has been lost.
        return match text.bytes().any(|b| (b'1'..=b'9').contains(&b)) {
            true => exact(),
            false => Number::Double(double),
        };
    }
    if !text.contains(['e', 'E']) {
        let unsigned = text.strip_prefix('-').unwrap_or(text);
        match unsigned.split_once('.') {
            Some((_, fraction)) if fraction.bytes().any(|b| b != b'0') => {
                return Number::Double(double);
            }
            Some((whole, _)) if whole.len() <= 15 => return Number::Double(double),
            None if unsigned.len() <= 15 => return Number::Double(double),
            _ => {}
        }
    }
    // Only an INTEGER can be a value the double gets wrong in the sense this guarantee is about: a
    // fraction that merely rounds is ordinary binary arithmetic, and `1e308` is as much an integer
    // the source wrote as `123` is. Testing for a point or an exponent instead reported `1e308` as
    // the double 1e+308, which is a hundred-odd digits away from the ten-to-the-308 that was written.
    let Some(integer) = denoted_integer(text) else {
        return Number::Double(double);
    };
    // `double` is the nearest one to that integer, so the two agree exactly when the integer is
    // representable and differ otherwise — no rounding rule to restate. Compared as decimal text
    // because the integer reaches 10^308 and no primitive holds it, and `{:.0}` prints a finite
    // double's EXACT value: `1e23` prints 99999999999999991611392, never `1e23`.
    match alloc::format!("{double:.0}") == integer {
        true => Number::Double(double),
        false => exact(),
    }
}

/// The integer a JSON number token denotes, spelled in decimal, or `None` when it denotes a fraction.
///
/// The token is `coefficient × 10^scale`, so this is digit surgery and not arithmetic: a
/// non-negative scale appends zeros, and a negative one may only take back zeros the source wrote.
/// Any other trailing digit IS the fractional part, and there is no integer to compare.
///
/// Callers reach here only for a token that parsed to a finite nonzero double, which bounds `scale`
/// at 308: the coefficient is at least 1, so a larger one would have overflowed.
fn denoted_integer(text: &str) -> Option<String> {
    let negative = text.starts_with('-');
    let body = &text[usize::from(negative)..];
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], body[at + 1..].parse::<i32>().ok()?),
        None => (body, 0),
    };
    let (whole, fraction) = match mantissa.find('.') {
        Some(dot) => (&mantissa[..dot], &mantissa[dot + 1..]),
        None => (mantissa, ""),
    };
    let mut digits = String::with_capacity(1 + whole.len() + fraction.len());
    digits.push_str(whole);
    digits.push_str(fraction);
    let scale = exponent - i32::try_from(fraction.len()).ok()?;
    match usize::try_from(scale) {
        Ok(zeros) => digits.extend(core::iter::repeat_n('0', zeros)),
        Err(_) => {
            let keep = digits.len().checked_sub(usize::try_from(-scale).ok()?)?;
            if digits[keep..].bytes().any(|b| b != b'0') {
                return None;
            }
            digits.truncate(keep);
        }
    }
    let significant = digits.trim_start_matches('0');
    let mut out = String::with_capacity(1 + significant.len());
    if negative {
        out.push('-');
    }
    out.push_str(match significant {
        "" => "0",
        rest => rest,
    });
    Some(out)
}

/// Appends the decimal digits of a base-`radix` integer, exactly however long it is.
///
/// Long division in software rather than through a float: `0xffffffffffffffff` is a value a double
/// cannot hold, and `HLD.md` rules that digits the source wrote are never returned rounded. The
/// accumulator holds one decimal digit per byte, least significant first, so a carry is a walk from
/// the bottom rather than a rescan.
fn to_decimal(digits: &[u8], radix: u32, out: &mut String) {
    let mut decimal: Vec<u8> = Vec::with_capacity(digits.len() * 2);
    for &d in digits {
        let mut carry = digit_value(u32::from(d));
        for place in &mut decimal {
            let n = u32::from(*place) * radix + carry;
            *place = u8::try_from(n % 10).unwrap_or(0);
            carry = n / 10;
        }
        while carry > 0 {
            decimal.push(u8::try_from(carry % 10).unwrap_or(0));
            carry /= 10;
        }
    }
    if decimal.is_empty() {
        out.push('0');
        return;
    }
    for &place in decimal.iter().rev() {
        out.push(char::from(b'0' + place));
    }
}

#[cfg(test)]
mod input_units_tests {
    use super::token_end_from;
    use alloc::vec::Vec;

    #[test]
    fn numeric_extent_reads_grow_with_new_input_not_prefix_length() {
        use core::sync::atomic::{AtomicUsize, Ordering};
        static READS: AtomicUsize = AtomicUsize::new(0);
        #[derive(Clone, Copy)]
        struct Counted(u8);
        impl From<Counted> for u32 {
            fn from(value: Counted) -> Self {
                READS.fetch_add(1, Ordering::Relaxed);
                Self::from(value.0)
            }
        }
        let input = [Counted(b'1'); 512];
        let mut next = 0;
        for end in 1..=input.len() {
            next = token_end_from(&input[..end], 0, next);
            assert_eq!(next, end);
        }
        // One new unit plus the fixed sign/radix/exponent probes; no prefix-length term.
        assert!(READS.load(Ordering::Relaxed) <= input.len() * 8);
    }

    #[test]
    fn token_boundaries_use_original_units() {
        for (input, token) in [
            ("-1.2e+3!", "-1.2e+3"),
            ("0xFF!", "0xFF"),
            ("+0b102", "+0b10"),
            ("1-2", "1"),
            ("0x", "0"),
            ("1İ", "1"),
        ] {
            assert_eq!(token_end_from(input.as_bytes(), 0, 0), token.len());
            let units: Vec<_> = input.encode_utf16().collect();
            assert_eq!(token_end_from(&units, 0, 0), token.len());
            for split in 0..=token.len() {
                let next = token_end_from(&input.as_bytes()[..split], 0, 0);
                if next == split {
                    assert_eq!(
                        token_end_from(input.as_bytes(), 0, next),
                        token.len(),
                        "split {split}: {input}"
                    );
                    assert_eq!(token_end_from(&units, 0, next), token.len());
                }
            }
        }
        // A preceding surrogate occupies one UTF-16 unit, not three replacement bytes.
        assert_eq!(token_end_from(&[0xd800_u16, 0x31, 0x0130], 1, 1), 2);
    }
}
