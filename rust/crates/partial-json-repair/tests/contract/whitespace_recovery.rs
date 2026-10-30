//! Non-JSON layout must not change string content or bypass the recovery policy.

use core::num::NonZeroUsize;
use partial_json_repair::{ParseFailure, Parser, SwitchableRepair};

#[test]
fn token_spacing_repairs_preserve_content_and_refuse_independently() {
    let parser = Parser::default();
    for (input, expected) in [
        (
            "{\u{a0}\"a\":\u{2000}\"x\u{a0}y\"\u{3000}}",
            "{ \"a\": \"x\u{a0}y\" }",
        ),
        ("{a:foo\u{2000}bar\u{3000}}", "{\"a\":\"foo\u{2000}bar\" }"),
        ("{a:true\u{feff}}", "{\"a\":true }"),
        ("{a\u{b}:1\u{c}}", "{\"a\" :1 }"),
        ("\u{2000}42\u{3000}", "42"),
    ] {
        assert_eq!(
            parser.repair(input).expect(input).value.as_str(),
            Some(expected)
        );
        let expected_value = parser.parse(expected).expect(expected).value;
        assert_eq!(parser.parse(input).expect(input).value, expected_value);
        let refused = Parser {
            recover: parser.recover.without(SwitchableRepair::NonJsonWhitespace),
            ..parser.clone()
        };
        match refused.parse(input).expect_err("disabled recovery").failure {
            ParseFailure::PolicyRefused {
                recovered: Some(value),
                issue,
            } => {
                assert_eq!(value, expected_value);
                assert_eq!(issue.refused, Some(SwitchableRepair::NonJsonWhitespace));
            }
            other => panic!("wrong refusal: {other:?}"),
        }
        assert!(refused.repair(input).is_err());
    }
}

#[test]
fn leading_whitespace_refusal_keeps_the_root_at_the_error_bound() {
    let reference = Parser::default();
    let parser = Parser {
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::NonJsonWhitespace),
        max_errors: NonZeroUsize::MIN,
        ..Parser::default()
    };
    for (input, expected) in [("\u{2000}42\u{3000}", "42"), ("\u{2000}[1]\u{3000}", "[]")] {
        let expected_value = reference.parse(expected).expect(expected).value;
        match parser.parse(input).expect_err("whitespace refusal").failure {
            ParseFailure::PolicyRefused {
                recovered: Some(value),
                issue,
            } => {
                assert_eq!(value, expected_value);
                assert_eq!(issue.refused, Some(SwitchableRepair::NonJsonWhitespace));
            }
            other => panic!("lost root: {other:?}"),
        }
    }
}
