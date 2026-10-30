//! The strict path must produce the same value as `JSON.parse`, spelled the same way.
//!
//! The fixture is RECORDED from the JavaScript side rather than written by hand: hand-written
//! expectations encode what the author believed the other implementation does, which is exactly the
//! belief under test. Each line is the document as a JSON string literal, a tab, and the canonical
//! form the TypeScript serialiser produced for `JSON.parse` of it.
//!
//! The documents are every strictly-valid input in the corpus, plus a handful of grammar shapes the
//! corpus is thin on — a duplicate key, integer-like keys, a surrogate pair, controls, an integer
//! past a double's reach, and the exponential boundaries.

use core::num::NonZeroUsize;
use partial_json_repair::{
    DiagnosticsMode, ParseFailure, Parser, Scanner, SwitchableRepair, canonical_of,
};

#[test]
fn matches_json_parse() {
    let options = Parser::default();
    let mut checked = 0;
    let mut wrong = Vec::new();
    for line in include_str!("../js-strict-values.txt").lines() {
        let Some((literal, expected)) = line.split_once('\t') else {
            continue;
        };
        // The literal is unescaped by this crate's own string reader; a failure there is reported
        // as a fixture problem rather than mistaken for a value mismatch.
        let document = serde_free_unquote(literal);
        checked += 1;
        match Scanner::new(document.as_bytes(), &options).parse() {
            Ok(value) => {
                let actual = canonical_of(&value);
                if actual != expected {
                    wrong.push(format!(
                        "{literal}\n  expected {expected}\n  actual   {actual}"
                    ));
                }
            }
            Err(e) => wrong.push(format!(
                "{literal}\n  expected {expected}\n  refused  {e:?}"
            )),
        }
    }
    assert!(
        checked > 50,
        "fixture did not load: only {checked} documents"
    );
    assert!(
        wrong.is_empty(),
        "{} of {checked} disagree:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

#[test]
fn a_strict_stop_keeps_the_container_prefix() {
    let parser = Parser {
        diagnostics: DiagnosticsMode::On,
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::UnclosedObject),
        max_errors: NonZeroUsize::MIN,
        ..Parser::default()
    };
    let failed = parser
        .parse(r#"[{"name": "John""#)
        .expect_err("the unclosed object is refused");
    let ParseFailure::PolicyRefused {
        recovered: Some(value),
        ..
    } = failed.failure
    else {
        panic!("expected a refused prefix, got {:?}", failed.failure);
    };
    assert_eq!(canonical_of(&value), r#"[{"name":"John"}]"#);
}

/// Reads a JSON string literal into the text it denotes, without a JSON library.
///
/// The crate's own reader would be circular here — a bug in it would corrupt the input and the
/// expectation at once, and the test would pass. This handles only what the fixture generator
/// emits: `JSON.stringify` of a string.
fn serde_free_unquote(literal: &str) -> String {
    let inner = literal
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .expect("fixture column is a quoted literal");
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next().expect("escape has a body") {
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'u' => {
                let hex: String = chars.by_ref().take(4).collect();
                let code = u32::from_str_radix(&hex, 16).expect("four hex digits");
                // A surrogate reaching here is one the generator escaped; it is re-emitted as the
                // same escape so the document handed to the scanner is byte-identical to the source.
                match char::from_u32(code) {
                    Some(ch) => out.push(ch),
                    None => out.push_str(&format!("\\u{hex}")),
                }
            }
            other => out.push(other),
        }
    }
    out
}
