//! Malformed bytes must preserve recoverable content, source positions, and terminal outcomes.

use core::num::NonZeroUsize;
use partial_json_repair::{
    DiagnosticsMode, ParseFailure, Parser, Resource, StreamParser, SwitchableRepair, canonical_of,
};

#[test]
fn continued_keys_keep_decoder_paths_and_do_not_repeat_errors() {
    let parser = Parser {
        diagnostics: DiagnosticsMode::On,
        ..Parser::default()
    };
    let input = b"{\"a\x81\\tb\":1}";
    let whole = parser
        .parse(input.as_slice())
        .expect("recover malformed key");
    let expected = whole.diagnostics.expect("requested report").errors;
    for split in 1..input.len() {
        let mut stream = StreamParser::new(parser.clone());
        let mut items: Vec<_> = stream.feed(&input[..split]).collect();
        items.extend(stream.feed(&input[split..]));
        items.extend(stream.end());
        assert_eq!(items.len(), 1);
        let outcome = items.pop().expect("one value").expect("recover key");
        assert_eq!(canonical_of(&outcome.value), canonical_of(&whole.value));
        let errors = outcome.diagnostics.expect("requested report").errors;
        assert_eq!(errors.len(), expected.len(), "split {split}");
        for (actual, expected) in errors.iter().zip(&expected) {
            assert_eq!(actual.path, expected.path, "split {split}");
            assert_eq!(
                (actual.line, actual.column),
                (expected.line, expected.column)
            );
        }
    }
}

#[test]
fn replacement_preserves_following_characters_and_decoded_columns() {
    let parser = Parser {
        diagnostics: DiagnosticsMode::On,
        ..Parser::default()
    };
    for (bytes, expected, offsets) in [
        (b"[foo\x81]".as_slice(), "[\"foo�\"]", vec![4]),
        (b"{a\x81:1}".as_slice(), "{\"a�\":1}", vec![2]),
        (b"[1\x81,2]".as_slice(), "[1,\"�\",2]", vec![2]),
        (b"[\"\xe1\x80A\"]".as_slice(), "[\"�A\"]", vec![2]),
        (b"[\"\xed\xa0\x80\"]".as_slice(), "[\"���\"]", vec![2, 3, 4]),
        (
            b"[\"\xf0\x9f\x98\x80\xe1\x80A\x81\"]".as_slice(),
            "[\"😀�A�\"]",
            vec![6, 9],
        ),
        (b"[\"\xef\xbf\xbd\"]".as_slice(), "[\"�\"]", vec![]),
    ] {
        let result = parser.parse(bytes).expect("recover string bytes");
        assert_eq!(canonical_of(&result.value), expected);
        let report = result.diagnostics.expect("requested report");
        assert_eq!(
            report
                .errors
                .iter()
                .map(|error| error.at.offset)
                .collect::<Vec<_>>(),
            offsets
        );
        if offsets == [6, 9] {
            assert_eq!(
                report
                    .errors
                    .iter()
                    .map(|error| error.column)
                    .collect::<Vec<_>>(),
                [5, 7]
            );
        }
        assert_eq!(
            parser.repair(bytes).expect("repair bytes").value.as_str(),
            Some(expected)
        );
    }
    assert_eq!(
        parser
            .repair(b"[foo\x81 ]".as_slice())
            .expect("preserve trailing space")
            .value
            .as_str(),
        Some("[\"foo�\" ]")
    );
}

#[test]
fn refusal_context_keeps_its_capture_point_across_decoder_pieces() {
    for (bytes, kind, context) in [
        (
            b"[foo\x81 ]".as_slice(),
            SwitchableRepair::UnquotedString,
            "[foo�",
        ),
        (
            b"[\"\\u\x81\"]".as_slice(),
            SwitchableRepair::InvalidEscape,
            "[\"\\u�\"]",
        ),
    ] {
        let mut parser = Parser::default();
        parser.recover = parser.recover.without(kind);
        let failed = parser.parse(bytes).expect_err("policy refusal");
        let ParseFailure::PolicyRefused { issue, .. } = failed.failure else {
            panic!("expected policy refusal");
        };
        assert_eq!(issue.context.as_str(), Some(context));
        assert!(failed.diagnostics.is_none());
    }
}

#[test]
fn context_clips_utf16_units_without_replacing_split_surrogates() {
    let mut parser = Parser::default();
    parser.recover = parser.recover.without(SwitchableRepair::UnquotedString);
    for (input, at) in [
        ("[x]".into(), 1_usize),
        (format!("[{}]", "😀".repeat(25)), 1),
        (format!("[x{}]", "😀".repeat(25)), 1),
        (format!("[\"{}\",x]", "😀".repeat(25)), 54),
        (format!("[\"{}\", x]", "😀".repeat(25)), 55),
    ] {
        let failed = parser.parse(input.as_str()).expect_err("policy refusal");
        let ParseFailure::PolicyRefused { issue, .. } = failed.failure else {
            panic!("expected policy refusal");
        };
        // The reference slices in UTF-16, preserving a high or low surrogate at either edge.
        let expected: Vec<_> = input
            .encode_utf16()
            .take(at + 20)
            .skip(at.saturating_sub(20))
            .collect();
        assert_eq!(issue.context.code_units().collect::<Vec<_>>(), expected);
    }
}

#[test]
fn decoder_budget_preserves_prefix_and_does_not_restart_after_exhaustion() {
    let parser = Parser {
        max_errors: NonZeroUsize::MIN,
        ..Parser::default()
    };
    for (bytes, expected) in [
        (b"[1,\"\xe1\x80A\",2]".as_slice(), "[1]"),
        (b"[foo\x81bar,2]".as_slice(), "[\"foo�bar\"]"),
        (b"[foo\x81bar\x81baz,2]".as_slice(), "[\"foo�bar�\"]"),
        (b"{abc\x81def:1}".as_slice(), "{}"),
    ] {
        let failed = parser.parse(bytes).expect_err("decoder budget");
        let ParseFailure::LimitReached {
            resource,
            at,
            recovered,
            ..
        } = failed.failure
        else {
            panic!("expected typed error limit");
        };
        assert_eq!(resource, Resource::Errors);
        assert_eq!(at.expect("original byte position").offset, 4);
        assert_eq!(
            canonical_of(&recovered.expect("completed prefix")),
            expected
        );
        assert!(failed.diagnostics.is_none());
    }

    let mut values = parser.parse_many(b"/*\x81*/42".as_slice());
    assert!(matches!(
        values
            .next()
            .expect("terminal result")
            .expect_err("no candidate")
            .failure,
        ParseFailure::NoJsonFound
    ));
    assert!(values.next().is_none());
    assert!(values.next().is_none());
}

#[test]
fn malformed_root_bytes_spend_the_decoder_budget_before_candidate_rejection() {
    let parser = Parser {
        max_scalar: NonZeroUsize::new(2048).expect("non-zero scalar limit"),
        ..Parser::default()
    };
    let input = vec![0xff_u8; 1024];
    let failed = parser.parse(input.as_slice()).expect_err("decoder budget");
    let ParseFailure::LimitReached {
        resource,
        at,
        recovered,
        ..
    } = failed.failure
    else {
        panic!("expected typed error limit, got {:?}", failed.failure);
    };
    assert_eq!(resource, Resource::Errors);
    assert_eq!(at.expect("original byte position").offset, 999);
    assert_eq!(
        canonical_of(&recovered.expect("decoded prefix")),
        format!("\"{}\"", "�".repeat(1001))
    );
}
