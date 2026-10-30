//! Every double must be spelled exactly as JavaScript's `String(n)` spells it, or the shared corpus
//! reports a mismatch that is about the serialiser rather than about the parse.
//!
//! The fixture is RECORDED from the engine, not derived from a reading of the specification: the
//! rule has three separate parts — the shortest round-tripping digits, the exponential window, and
//! the mantissa and exponent spelling — and a plausible reading of any of them still produces a
//! renderer that disagrees on real values. Regenerate it with the `bun` snippet in the repository
//! history if the set ever needs widening; the cases are boundary values plus an LCG over bit
//! patterns, so they are reproducible rather than arbitrary.

use partial_json_repair::{Number, canonical_of};

#[test]
fn matches_javascript_string_conversion() {
    let mut checked = 0;
    let mut wrong = Vec::new();
    for line in include_str!("../js-number-spelling.txt").lines() {
        let Some((bits, expected)) = line.split_once(' ') else {
            continue;
        };
        let value = f64::from_bits(u64::from_str_radix(bits, 16).expect("hex bit pattern"));
        // `-0` and the non-finite values are canonical MARKERS, decided above the number writer, so
        // they are not what this fixture is testing; the fixture holds no non-finite value at all.
        if value == 0.0 && value.is_sign_negative() {
            continue;
        }
        checked += 1;
        let actual = canonical_of(&Number::Double(value));
        if actual != expected {
            wrong.push(format!("{bits}: expected {expected}, got {actual}"));
        }
    }
    assert!(checked > 100, "fixture did not load: only {checked} cases");
    assert!(
        wrong.is_empty(),
        "{} of {checked} disagree:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}
