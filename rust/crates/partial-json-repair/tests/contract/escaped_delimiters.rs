//! Escaped structural delimiters retain values and refuse through the ordinary recovery policy.

use partial_json_repair::{ParseFailure, Parser, SwitchableRepair, canonical_of};

#[test]
fn escaped_delimiters_preserve_members_and_source_spelling() {
    let parser = Parser::default();
    for (input, expected) in [
        (r#"{"a": "x"\, "b"\: "z"}"#, r#"{"a": "x", "b": "z"}"#),
        (r#"{"a":\[1,2\]\}"#, r#"{"a":[1,2]}"#),
        (r#"[true\,false\,null\]"#, "[true,false,null]"),
    ] {
        assert_eq!(
            parser.repair(input).expect(input).value.as_str(),
            Some(expected)
        );
        assert_eq!(
            parser.parse(input).expect(input).value,
            parser.parse(expected).expect(expected).value
        );
        let refused = Parser {
            recover: parser.recover.without(SwitchableRepair::EscapedDelimiter),
            ..parser.clone()
        };
        match refused.parse(input).expect_err("disabled repair").failure {
            ParseFailure::PolicyRefused {
                recovered: Some(value),
                issue,
            } => {
                assert_eq!(
                    canonical_of(&value),
                    canonical_of(&parser.parse(expected).expect(expected).value)
                );
                assert_eq!(issue.refused, Some(SwitchableRepair::EscapedDelimiter));
            }
            other => panic!("wrong refusal: {other:?}"),
        }
        assert!(refused.repair(input).is_err());
    }
}

#[test]
fn dropping_a_member_does_not_restore_trivia_or_delete_a_neighbor() {
    let parser = Parser::default();
    for (input, expected) in [
        (r#"{\:}"#, "{}"),
        ("{ /*x*/ :}", "{ }"),
        ("{a:1,b:2 c}", r#"{"a":1,"b":2 }"#),
    ] {
        assert_eq!(
            parser.repair(input).expect(input).value.as_str(),
            Some(expected)
        );
    }
}
