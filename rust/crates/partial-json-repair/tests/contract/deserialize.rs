//! What survives the trip from a damaged document into an application type, and what refuses to.
//!
//! Every case here is a number or a string the OBVIOUS implementation gets wrong. Deserializing a
//! `Value` is mostly mechanical; the defects all live in the handful of places where JSON's value
//! domain and Rust's do not line up, so those are what these tests attack. A round trip through
//! `serde_json` would fail most of them, which is the reason this module exists at all.

#![cfg(feature = "serde")]

use partial_json_repair::{JsonString, Object, Value, parse};
use serde::Deserialize;

#[test]
fn utf16_content_converts_without_replacing_surrogates() {
    let units: Vec<_> = "Ada😀".encode_utf16().collect();
    let value = Value::String(JsonString::from(units.as_slice()));
    assert_eq!(
        value.deserialize::<String>().expect("valid UTF-16"),
        "Ada😀"
    );
    assert!(
        value.deserialize::<&str>().is_err(),
        "UTF-16 cannot lend UTF-8 storage"
    );
    let mut object = Object::new(false);
    let key: Vec<_> = "name".encode_utf16().collect();
    object.insert(JsonString::from(key.as_slice()), value);
    #[derive(Deserialize)]
    struct Named {
        name: String,
    }
    assert_eq!(
        Value::Object(object)
            .deserialize::<Named>()
            .expect("UTF-16 key")
            .name,
        "Ada😀"
    );
    let lone = Value::String(JsonString::from([0xd800].as_slice()));
    assert!(
        lone.deserialize::<String>()
            .expect_err("unpaired unit")
            .message
            .contains("unpaired surrogate")
    );
}

/// Parses under the shipped defaults. Every case starts from real recovery, not a hand-built value:
/// a `Value` assembled by the test could hold a shape the parser never produces.
///
/// The free verb, not `Parser::default().parse(…)`: the method borrows the parser for as long as the
/// result lives, so a local one cannot outlive this function. The free door reads a `static`.
fn recover(input: &str) -> Value<'_> {
    parse(input).expect("input recovers").value
}

#[derive(Debug, Deserialize, PartialEq)]
struct Record {
    name: String,
    tags: Vec<String>,
}

/// The product claim in one line: damaged text in, application type out.
#[test]
fn a_damaged_document_becomes_a_struct() {
    let value = recover("{'name': 'Ada', 'tags': ['x','y',],");
    let record: Record = value.deserialize().expect("fits the struct");
    assert_eq!(
        record,
        Record {
            name: "Ada".into(),
            tags: vec!["x".into(), "y".into()],
        }
    );
}

/// Integers arrive as doubles, and an integer field must still take them.
///
/// The naive implementation visits every number as `f64`; Serde's integer visitors refuse a float,
/// so `{"n":1}` would not fit `n: u32`. Nothing about the type system catches that.
#[test]
fn whole_doubles_reach_integer_fields() {
    #[derive(Deserialize)]
    struct Counts {
        small: u8,
        negative: i64,
        wide: f64,
    }
    let value = recover("{\"small\":7,\"negative\":-9007199254740993,\"wide\":1.5}");
    let counts: Counts = value.deserialize().expect("fits");
    assert_eq!(counts.small, 7);
    assert_eq!(counts.negative, -9_007_199_254_740_993);
    assert!((counts.wide - 1.5).abs() < f64::EPSILON);
}

/// A number too large for a double keeps every digit on the way into a wide integer.
///
/// `u64::MAX` is the sharp case: as a double it rounds to `2^64`, a different value, so recovery
/// keeps it exact — and this is where a re-parse through any `f64`-based reader loses it silently.
#[test]
fn exact_numbers_are_not_rounded_on_the_way_in() {
    #[derive(Deserialize)]
    struct Wide {
        max: u64,
        huge: i128,
    }
    let value = recover("{\"max\":18446744073709551615,\"huge\":123456789012345678901}");
    let wide: Wide = value.deserialize().expect("fits");
    assert_eq!(wide.max, u64::MAX);
    assert_eq!(wide.huge, 123_456_789_012_345_678_901);
}

/// `2^64` is exactly a double, so it stays one — and the bound that rejects it must be written from
/// the power of two, not from `u64::MAX`, which rounds UP to it. Written the wrong way the
/// saturating cast answers `u64::MAX` and the caller never learns the document said something else.
#[test]
fn a_double_past_the_integer_range_is_refused_not_saturated() {
    let value = recover("18446744073709551616");
    assert!(value.deserialize::<u64>().is_err());
    assert_eq!(
        value.deserialize::<f64>().expect("fits a double"),
        2f64.powi(64)
    );
}

/// A magnitude no double can hold is never rounded to infinity. It reaches a text field intact, and
/// a float field is told it does not fit rather than handed `inf`.
#[test]
fn an_unrepresentable_magnitude_stays_text() {
    let value = recover("1e400");
    assert_eq!(
        value.deserialize::<String>().expect("fits a string"),
        "1e400"
    );
    assert!(value.deserialize::<f64>().is_err());
}

/// `-0.0` is a distinction the parser preserves, so the integer shortcut must not swallow it.
#[test]
fn negative_zero_keeps_its_sign() {
    let zero: f64 = recover("-0").deserialize().expect("fits a double");
    assert!(zero.is_sign_negative(), "the sign was dropped");
}

/// A string Rust cannot hold is a named refusal, never a replacement character.
#[test]
fn a_lone_surrogate_refuses_rather_than_substitutes() {
    #[derive(Debug, Deserialize)]
    struct Held {
        #[allow(dead_code, reason = "the field exists so the conversion is attempted")]
        a: String,
    }
    let value = recover("{\"a\":\"\\ud800\"}");
    let failure = value
        .deserialize::<Held>()
        .expect_err("no Rust string holds it");
    assert!(
        failure.message.contains("unpaired surrogate"),
        "message must name the cause: {}",
        failure.message
    );
}

/// `undefined` is absence, and only where absence has somewhere to go.
#[test]
fn undefined_is_none_and_nothing_else() {
    #[derive(Deserialize)]
    struct Maybe {
        a: Option<u32>,
        b: Option<u32>,
    }
    let value = recover("{\"a\":undefined,\"b\":null}");
    let maybe: Maybe = value.deserialize().expect("fits");
    assert_eq!(maybe.a, None);
    assert_eq!(maybe.b, None);
    assert!(recover("undefined").deserialize::<u32>().is_err());
}

/// Both externally tagged spellings, which is what a model imitating `serde_json` emits.
#[test]
fn enums_read_from_a_bare_tag_and_from_a_wrapper() {
    #[derive(Debug, Deserialize, PartialEq)]
    enum Status {
        Open,
        Failed(String),
    }
    assert_eq!(
        recover("[\"Open\", {\"Failed\": \"timeout\"}]")
            .deserialize::<Vec<Status>>()
            .expect("fits"),
        vec![Status::Open, Status::Failed("timeout".into())]
    );
}

/// A mismatch names WHERE it is. Serde carries no path, so without this a `missing field` on a
/// nested record says which field and never which record — useless on a recovered document, where
/// the caller's next question is always which part of the input was wrong.
#[test]
fn a_failure_names_the_member_that_holds_it() {
    #[derive(Debug, Deserialize)]
    #[allow(dead_code, reason = "the fields exist so the conversion is attempted")]
    struct Doc {
        items: Vec<Item>,
    }
    #[derive(Debug, Deserialize)]
    #[allow(dead_code, reason = "the fields exist so the conversion is attempted")]
    struct Item {
        n: u32,
    }
    let value = recover("{\"items\":[{\"n\":1},{\"n\":\"oops\"}]}");
    let failure = value
        .deserialize::<Doc>()
        .expect_err("the second item lies");
    assert_eq!(
        failure.to_string().split(" at ").last(),
        Some("[\"items\",1,\"n\"]")
    );
}
