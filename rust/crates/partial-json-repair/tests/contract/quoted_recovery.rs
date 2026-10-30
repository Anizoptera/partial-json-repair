//! Escapes must not erase prior string damage or commit an undecided quote as content.

use partial_json_repair::{
    DiagnosticsMode, Fragment, ParseFailure, Parser, PathSegment, StreamParser, canonical_of,
};

#[test]
fn controls_before_escapes_are_repaired_or_refused_with_recovery() {
    let input = "[\"a\nb\\tc\"]";
    let repaired = r#"["a\nb\tc"]"#;
    let parser = Parser::default();
    assert_eq!(
        parser.repair(input).expect("repair").value.as_str(),
        Some(repaired)
    );
    for diagnostics in [DiagnosticsMode::Off, DiagnosticsMode::On] {
        let strict = Parser {
            repair_broken: false,
            diagnostics,
            ..parser.clone()
        };
        for split in 0..=input.len() {
            let mut stream = StreamParser::new(strict.clone());
            let mut items: Vec<_> = stream.feed(&input[..split]).collect();
            items.extend(stream.feed(&input[split..]));
            items.extend(stream.end());
            assert_eq!(items.len(), 1, "split {split}");
            let failed = items
                .pop()
                .expect("outcome")
                .expect_err("raw control refused");
            let ParseFailure::PolicyRefused {
                recovered: Some(value),
                issue,
            } = failed.failure
            else {
                panic!("typed refusal with recovered content");
            };
            assert_eq!(canonical_of(&value), repaired, "split {split}");
            assert_eq!(issue.refused, None);
        }
        assert!(strict.parse(input).is_err());
        assert!(strict.repair(input).is_err());
    }
}

#[test]
fn escapes_on_either_side_of_a_wrong_closer_preserve_recovery() {
    let parser = Parser::default();
    for (input, expected) in [
        (r#"["a',b\tc" x]"#, r#"["a","b\\tc"," x]"]"#),
        (r#"["a\tb',c" x]"#, r#"["a\tb","c"," x]"]"#),
        (r#"["a\tb',c"]"#, r#"["a\tb',c"]"#),
    ] {
        assert_eq!(
            canonical_of(&parser.parse(input).expect(input).value),
            expected
        );
        assert_eq!(
            parser.repair(input).expect(input).value.as_str(),
            Some(expected)
        );
        for split in 0..=input.len() {
            let mut stream = StreamParser::new(parser.clone());
            let mut items: Vec<_> = stream.feed(&input[..split]).collect();
            items.extend(stream.feed(&input[split..]));
            items.extend(stream.end());
            assert_eq!(items.len(), 1, "{input}, split {split}");
            assert_eq!(
                canonical_of(&items[0].as_ref().expect(input).value),
                expected
            );
        }
    }
}

#[test]
fn fragments_do_not_deliver_a_suffix_that_may_belong_to_another_member() {
    for (segment, input, expected) in [
        (PathSegment::Index(0), r#"["a',b\tc" x]"#, "a"),
        (PathSegment::Index(0), r#"["a\tb',c" x]"#, "a\tb"),
        (PathSegment::Index(0), r#"["a\tb',c"]"#, "a\tb',c"),
        (
            PathSegment::Key("msg".into()),
            r#"{"msg":"a',b\tc" x}"#,
            "a",
        ),
        (
            PathSegment::Key("msg".into()),
            r#"{"msg":"a\tb',c" x}"#,
            "a\tb",
        ),
        (
            PathSegment::Key("msg".into()),
            r#"{"msg":"a\tb',c"}"#,
            "a\tb',c",
        ),
    ] {
        let parser = Parser::default()
            .select(vec![vec![segment]])
            .expect("selector")
            .fragments()
            .expect("fragment mode is compatible");
        for split in 0..=input.len() {
            let mut stream = parser.stream_parser();
            let mut units = Vec::new();
            for chunk in [&input[..split], &input[split..]] {
                for item in stream.feed(chunk) {
                    if let Fragment::Data { text, .. } = item.expect("fragment").value {
                        units.extend(text.code_units());
                    }
                }
            }
            for item in stream.end() {
                if let Fragment::Data { text, .. } = item.expect("tail").value {
                    units.extend(text.code_units());
                }
            }
            assert_eq!(
                units,
                expected.encode_utf16().collect::<Vec<_>>(),
                "{input}, split {split}"
            );
        }
    }
}
