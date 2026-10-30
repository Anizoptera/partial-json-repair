//! What `stringify` writes, and what it refuses to write.
//!
//! Every row parses damaged input and encodes what came back, because that is the only value a
//! caller of this ever has. The pairs pin the SPELLING — a round trip alone would pass on text no
//! other parser accepts, which is the failure mode that matters here.

use core::num::NonZeroUsize;
use partial_json_repair::{EncodingFailure, Parser, StringifyOptions, canonical_of, stringify};

fn encoded(input: &str) -> String {
    let options = Parser::default();
    let value = options.parse(input).expect("input recovers").value;
    stringify(&value).expect("value has a JSON spelling")
}

/// The text is JSON, and reading it back gives the same value.
fn round_trips(input: &str) {
    let options = Parser::default();
    let once = options.parse(input).expect("input recovers").value;
    let text = stringify(&once).expect("value has a JSON spelling");
    let twice = options
        .parse(text.as_str())
        .expect("encoded text recovers")
        .value;
    assert_eq!(canonical_of(&once), canonical_of(&twice), "for {input:?}");
}

#[test]
fn writes_recovered_documents() {
    for (input, expected) in [
        ("{\"a\":1}", "{\"a\":1}"),
        // Repairs are invisible in the output: the point of encoding is that the damage is gone.
        ("{'a': 1, 'b': [2,3,],}", "{\"a\":1,\"b\":[2,3]}"),
        ("{\"a\": \"unclosed", "{\"a\":\"unclosed\"}"),
        ("[]", "[]"),
        ("{}", "{}"),
        ("[[],{},[{}]]", "[[],{},[{}]]"),
        // A last duplicate wins at the first position, which the encoded text must preserve.
        ("{\"a\":1,\"b\":2,\"a\":3}", "{\"a\":3,\"b\":2}"),
        // An integer past a double's reach keeps its digits rather than rounding.
        (
            "{\"n\":123456789012345678901}",
            "{\"n\":123456789012345678901}",
        ),
        ("[1e400,-1e400]", "[1e400,-1e400]"),
        // Escapes are rewritten to the shortest form that spells the same string.
        ("[\"\\u0041\\n\\t\\\"\"]", "[\"A\\n\\t\\\"\"]"),
        ("[\"\\ud83d\\ude00\"]", "[\"\u{1f600}\"]"),
        // A lone surrogate has no `str` to hold it and is escaped rather than replaced.
        ("[\"\\ud800\"]", "[\"\\ud800\"]"),
        // A lone surrogate must not change how adjacent valid pairs are emitted.
        ("[\"\\ud800\\ud83d\\ude00\"]", "[\"\\ud800😀\"]"),
        ("[\"\\ud83d\\ude00\\ud800\"]", "[\"😀\\ud800\"]"),
        ("[1e21,1e-7,0.1]", "[1e+21,1e-7,0.1]"),
    ] {
        assert_eq!(encoded(input), expected, "for {input:?}");
        round_trips(input);
    }
}

/// The one value that does NOT round-trip: JSON cannot spell a negative zero, so the sign goes.
///
/// Not a refusal, because no data JSON could have carried is lost — but it is the single place the
/// encoded text and the parsed value stop agreeing, so it is pinned rather than left to be
/// rediscovered.
#[test]
fn negative_zero_loses_its_sign() {
    assert_eq!(encoded("[-0]"), "[0]");
    let options = Parser::default();
    let once = options.parse("[-0]").expect("recovers").value;
    let twice = options.parse("[0]").expect("recovers").value;
    assert_eq!(canonical_of(&once), "[#-0]");
    assert_eq!(canonical_of(&twice), "[0]");
}

/// A value JavaScript has and JSON does not is refused, at the path where it sits.
#[test]
fn refuses_what_json_cannot_spell() {
    let options = Parser::default();
    for (input, kind, path) in [
        ("undefined", "undefined", ""),
        ("[NaN]", "nan", "0"),
        ("{\"a\":[1,-Infinity]}", "infinity", "\"a\",1"),
    ] {
        let value = options.parse(input).expect("input recovers").value;
        let failure = stringify(&value).expect_err("no JSON spelling");
        let EncodingFailure::NonJsonValue {
            value_kind,
            path: actual_path,
        } = failure
        else {
            panic!("expected a non-JSON refusal for {input:?}");
        };
        assert_eq!(value_kind.as_str(), kind, "for {input:?}");
        assert_eq!(
            actual_path
                .iter()
                .map(canonical_of)
                .collect::<Vec<_>>()
                .join(","),
            path,
            "for {input:?}"
        );
    }
}

#[test]
fn bounds_encoded_units_before_returning_text() {
    let parser = Parser::default();
    for input in [
        "null",
        "false",
        "123456789012345678901",
        "1e21",
        "\"é😀\"",
        "\"\\u0000\\n\\ud800😀\"",
        "{\"😀\\n\":[true,1]}",
    ] {
        let value = parser.parse(input).expect("recover input").value;
        let expected = stringify(&value).expect("JSON value");
        let units = expected.encode_utf16().count();
        for limit in 1..=units + 1 {
            let result = StringifyOptions {
                max_output: NonZeroUsize::new(limit).expect("positive limit"),
            }
            .stringify(&value);
            if limit < units {
                assert_eq!(
                    result,
                    Err(EncodingFailure::LimitReached { limit }),
                    "{input}, limit {limit}"
                );
            } else {
                assert_eq!(
                    result.as_deref(),
                    Ok(expected.as_str()),
                    "{input}, limit {limit}"
                );
            }
        }
    }
    // A later non-JSON value must not be visited once output is already exhausted.
    let value = parser
        .parse("[\"abcdef\",undefined]")
        .expect("recover extensions")
        .value;
    assert_eq!(
        StringifyOptions {
            max_output: NonZeroUsize::new(3).expect("positive")
        }
        .stringify(&value),
        Err(EncodingFailure::LimitReached { limit: 3 }),
    );
}
