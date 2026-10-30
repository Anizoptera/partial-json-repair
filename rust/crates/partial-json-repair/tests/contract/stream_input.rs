//! Original code units, decoder boundaries and positions survive every stream delivery path.

use core::num::NonZeroUsize;
use partial_json_repair::outcome::Encoding;
use partial_json_repair::report::Unit;
use partial_json_repair::{
    DiagnosticsMode, Fragment, Input, ParseFailure, Parser, PathSegment, Resource, StreamParser,
    Value,
};

fn member_units(value: &Value<'_>) -> Vec<u16> {
    let Value::Object(object) = value else {
        panic!("object")
    };
    let Value::String(text) = &object.entries()[0].1 else {
        panic!("string")
    };
    text.code_units().collect()
}

#[test]
fn pending_selection_spans_survive_repeated_position_pruning() {
    let parser = Parser {
        locations: true,
        ..Parser::default()
    }
    .select(vec![
        vec![PathSegment::Key("a".into())],
        vec![PathSegment::Key("b".into())],
    ])
    .expect("selectors");
    let mut stream = parser.stream_parser();
    let mut matches = Vec::new();
    for chunk in ["{", "\"a\":", "\"old\",", "\"b\":\""] {
        matches.extend(stream.feed(chunk).map(|item| item.expect("selection")));
    }
    for _ in 0..128 {
        matches.extend(
            stream
                .feed(Input::Utf16(&[120]))
                .map(|item| item.expect("content")),
        );
    }
    matches.extend(stream.feed("\"}").map(|item| item.expect("close")));
    matches.extend(stream.end().map(|item| item.expect("end")));
    assert_eq!(matches.len(), 2);
    for (matched, start, end) in [
        (&matches[0].value, (2, 0), (2, 5)),
        (&matches[1].value, (3, 4), (132, 1)),
    ] {
        assert_eq!(
            (matched.span.start.chunk, matched.span.start.offset),
            (Some(start.0), start.1)
        );
        assert_eq!(
            (matched.span.end.chunk, matched.span.end.offset),
            (Some(end.0), end.1)
        );
    }
}

#[test]
fn fragment_end_keeps_the_released_opening_chunk() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("selector")
        .fragments()
        .expect("fragment mode is compatible");
    let mut stream = parser.stream_parser();
    let mut pieces = Vec::new();
    for chunk in ["{", "\"a\":", "\""] {
        pieces.extend(stream.feed(chunk).map(|item| item.expect("prefix").value));
    }
    for _ in 0..128 {
        pieces.extend(
            stream
                .feed(Input::Utf16(&[120]))
                .map(|item| item.expect("data").value),
        );
    }
    pieces.extend(stream.feed("\"}").map(|item| item.expect("close").value));
    pieces.extend(stream.end().map(|item| item.expect("end").value));
    let ends: Vec<_> = pieces
        .iter()
        .filter_map(|piece| match piece {
            Fragment::End { span, .. } => Some(span),
            _ => None,
        })
        .collect();
    assert_eq!(ends.len(), 1);
    assert_eq!((ends[0].start.chunk, ends[0].start.offset), (Some(2), 0));
    assert_eq!((ends[0].end.chunk, ends[0].end.offset), (Some(131), 1));
    assert_eq!(
        pieces
            .iter()
            .filter_map(|piece| match piece {
                Fragment::Data { text, .. } => Some(text.code_units().count()),
                _ => None,
            })
            .sum::<usize>(),
        128
    );
}

#[test]
fn numeric_spelling_does_not_fill_input_carry() {
    for suffix in ["}", "word}", "\\,b:1}"] {
        let parser = Parser {
            max_buffer: NonZeroUsize::new(8).expect("bound"),
            max_retained: NonZeroUsize::new(1024).expect("bound"),
            ..Parser::default()
        };
        let mut stream = StreamParser::new(parser.clone());
        assert_eq!(stream.feed("{a:").count(), 0);
        for _ in 0..32 {
            assert_eq!(stream.feed("1234").count(), 0);
        }
        let mut outcomes: Vec<_> = stream.feed(suffix).collect();
        outcomes.extend(stream.end());
        let source = format!("{{a:{}{suffix}", "1234".repeat(32));
        assert_eq!(outcomes.len(), 1);
        assert_eq!(
            outcomes[0].as_ref().expect("released carry").value,
            parser.parse(source.as_str()).expect("whole input").value
        );
    }
}

#[test]
fn root_numeric_candidacy_stays_in_bounded_input_carry() {
    let mut stream = StreamParser::new(Parser {
        max_buffer: NonZeroUsize::new(8).expect("carry"),
        ..Parser::default()
    });
    assert_eq!(stream.feed("1234").count(), 0);
    assert!(matches!(
        stream.feed("56789").next(),
        Some(Err(failed)) if matches!(failed.failure,
            ParseFailure::LimitReached { resource: Resource::Buffer, limit: 8, .. })
    ));
}

#[test]
fn exact_numbers_charge_retained_values_but_not_skipped_content() {
    macro_rules! assert_retained_limit {
        ($stream:expr) => {{
            let mut stream = $stream;
            assert_eq!(stream.feed("{a:").count(), 0);
            for _ in 0..32 {
                assert_eq!(stream.feed(Input::Utf16(&[49, 50, 51, 52])).count(), 0);
            }
            assert!(matches!(stream.feed("}").next(), Some(Err(failed)) if matches!(
                failed.failure,
                ParseFailure::LimitReached { resource: Resource::Retained, limit: 8, .. }
            )));
        }};
    }
    let parser = Parser {
        max_buffer: NonZeroUsize::new(8).expect("carry"),
        max_retained: NonZeroUsize::new(8).expect("values"),
        ..Parser::default()
    };
    assert_retained_limit!(StreamParser::new(parser.clone()));
    assert_retained_limit!(
        parser
            .select(vec![vec![PathSegment::Key("a".into())]])
            .expect("selection")
            .stream_parser()
    );

    let parser = Parser {
        max_buffer: NonZeroUsize::new(8).expect("carry"),
        max_retained: NonZeroUsize::new(8).expect("values"),
        skip: vec![vec![PathSegment::Key("a".into())]],
        ..Parser::default()
    }
    .select(vec![vec![PathSegment::Key("b".into())]])
    .expect("selection");
    let mut stream = parser.stream_parser();
    assert_eq!(stream.feed("{a:").count(), 0);
    for _ in 0..32 {
        assert_eq!(stream.feed(Input::Utf16(&[49, 50, 51, 52])).count(), 0);
    }
    let selected: Vec<_> = stream.feed(",b:2}").collect();
    assert!(
        matches!(selected.as_slice(), [Ok(value)] if partial_json_repair::canonical_of(&value.value.value) == "2")
    );
}

#[test]
fn released_numeric_spelling_still_obeys_the_scalar_limit() {
    let mut stream = StreamParser::new(Parser {
        max_scalar: NonZeroUsize::new(8).expect("bound"),
        ..Parser::default()
    });
    assert_eq!(stream.feed("{a:1234").count(), 0);
    let items: Vec<_> = stream.feed("56789").collect();
    assert_eq!(items.len(), 1);
    assert!(matches!(
        items[0].as_ref().expect_err("scalar bound").failure,
        ParseFailure::LimitReached {
            resource: Resource::Scalar,
            ..
        }
    ));
}

#[test]
fn numeric_refusal_keeps_its_released_source_context() {
    use partial_json_repair::SwitchableRepair;

    let mut parser = Parser {
        max_buffer: NonZeroUsize::new(8).expect("carry"),
        ..Parser::default()
    };
    parser.recover = parser.recover.without(SwitchableRepair::UnquotedString);
    let mut stream = StreamParser::new(parser);
    assert_eq!(stream.feed("{a:1234").count(), 0);
    for _ in 0..32 {
        assert_eq!(stream.feed("1234").count(), 0);
    }
    let failed = stream
        .feed("word}")
        .next()
        .expect("terminal outcome")
        .expect_err("unquoted string refusal");
    let ParseFailure::PolicyRefused { issue, .. } = failed.failure else {
        panic!("policy refusal")
    };
    assert_eq!((issue.at.chunk, issue.at.offset), (Some(0), 3));
    assert_eq!((issue.line, issue.column), (1, 4));
    assert_eq!(issue.context.as_str(), Some("{a:1234"));
}

#[test]
fn retained_repairs_keep_original_chunks_after_pruning() {
    let mut stream = StreamParser::new(Parser {
        diagnostics: DiagnosticsMode::On,
        ..Parser::default()
    });
    for chunk in ["{", "a:", "\""] {
        assert_eq!(stream.feed(chunk).count(), 0);
    }
    for _ in 0..128 {
        assert_eq!(stream.feed(Input::Utf16(&[120])).count(), 0);
    }
    let mut outcomes: Vec<_> = stream.feed("\"}").collect();
    outcomes.extend(stream.end());
    assert_eq!(outcomes.len(), 1);
    let report = outcomes[0]
        .as_ref()
        .expect("recovery")
        .diagnostics
        .as_ref()
        .expect("report");
    assert_eq!(report.repairs.len(), 1);
    assert_eq!(
        (report.repairs[0].at.chunk, report.repairs[0].at.offset),
        (Some(1), 0)
    );
}

#[test]
fn late_key_refusal_keeps_its_released_start_position() {
    use partial_json_repair::report::SwitchableRepair;
    let mut stream = StreamParser::new(Parser {
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::UnquotedKey),
        ..Parser::default()
    });
    for chunk in ["{", "bad"] {
        assert_eq!(stream.feed(chunk).count(), 0);
    }
    for _ in 0..128 {
        assert_eq!(stream.feed(Input::Bytes(b"x")).count(), 0);
    }
    let mut outcomes: Vec<_> = stream.feed(":1}").collect();
    outcomes.extend(stream.end());
    let failed = outcomes[0].as_ref().expect_err("unquoted key");
    let ParseFailure::PolicyRefused { issue, .. } = &failed.failure else {
        panic!("refusal");
    };
    assert_eq!(
        (issue.at.chunk, issue.at.offset, issue.at.unit),
        (Some(1), 0, Unit::Byte)
    );
    assert_eq!((issue.line, issue.column), (1, 2));
    assert_eq!(issue.context.as_str(), Some("{bad"));
}

#[test]
fn bare_tokens_preserve_content_across_decoder_and_comment_boundaries() {
    for input in [
        "{a: foo // note\n,b:2}",
        "{a: foo /* note */,b:2}",
        "{url: http://x}",
        "{a: foo\u{2000}bar\u{3000}// note\n,b:2}",
        "{long_key: tru,emoji: 🐈}",
    ] {
        let parser = Parser::default();
        let expected = parser.parse(input).expect("whole input").value;
        let units: Vec<_> = input.encode_utf16().collect();
        let bytes = (0..=input.len()).map(|at| {
            [
                Input::Bytes(&input.as_bytes()[..at]),
                Input::Bytes(&input.as_bytes()[at..]),
            ]
        });
        let native =
            (0..=units.len()).map(|at| [Input::Utf16(&units[..at]), Input::Utf16(&units[at..])]);
        for chunks in bytes.chain(native) {
            let mut stream = StreamParser::new(parser.clone());
            let mut values = Vec::new();
            for chunk in chunks {
                values.extend(stream.feed(chunk));
            }
            values.extend(stream.end());
            assert_eq!(values.len(), 1, "{input:?}");
            assert_eq!(
                values[0].as_ref().expect("root").value,
                expected,
                "{input:?}"
            );
        }
    }
}

#[test]
fn released_roots_preserve_later_error_lines_and_utf16_columns() {
    use partial_json_repair::report::SwitchableRepair;
    let parser = Parser {
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::UnquotedKey),
        ..Parser::default()
    };
    for (prefix, expected) in [
        ("{\"a\":1}\n", (2, 2)),
        ("{\"a\":1} ", (1, 10)),
        ("{\"x\":\"😀\"} ", (1, 13)),
    ] {
        let units: Vec<_> = prefix.encode_utf16().collect();
        for chunks in [
            &[Input::Text(prefix)][..],
            &[Input::Utf16(&units)][..],
            &[Input::Utf16(&units[..3]), Input::Text(&prefix[3..])][..],
        ] {
            let mut stream = StreamParser::new(parser.clone());
            let roots: usize = chunks.iter().map(|chunk| stream.feed(*chunk).count()).sum();
            assert_eq!(roots, 1);
            let failed = stream
                .feed("{b:2}\n")
                .next()
                .expect("root")
                .expect_err("refused key");
            let ParseFailure::PolicyRefused { issue, .. } = failed.failure else {
                panic!("policy refusal");
            };
            assert_eq!((issue.line, issue.column), expected, "prefix {prefix:?}");
            assert_eq!(issue.at.chunk, Some(chunks.len()));
            assert_eq!(issue.at.offset, 1);
        }
    }
}

#[test]
fn a_decoder_budget_keeps_a_bare_word_continued_by_the_next_chunk() {
    let mut stream = StreamParser::new(Parser {
        max_errors: NonZeroUsize::MIN,
        ..Parser::default()
    });
    assert_eq!(stream.feed(b"{\"a\":foo\x81").count(), 0);
    // The delimiter settles the available token; a terminal stop must not wait for source EOF.
    let items: Vec<_> = stream.feed("bar, b:2}").collect();
    assert_eq!(items.len(), 1);
    let failed = items[0].as_ref().expect_err("decoder budget");
    let ParseFailure::LimitReached {
        resource,
        recovered,
        ..
    } = &failed.failure
    else {
        panic!("typed limit: {:?}", failed.failure);
    };
    assert_eq!(*resource, Resource::Errors);
    let value = recovered.as_ref().expect("available prefix");
    assert_eq!(
        partial_json_repair::canonical_of(value),
        "{\"a\":\"foo�bar\"}"
    );
}

#[test]
fn mixed_decoder_limits_keep_the_same_recoverable_prefix() {
    use partial_json_repair::{StreamFailure, canonical_of};
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
        let opener = [u16::from(bytes[0])];
        let mut stream = parser.parse_stream(
            [Input::Utf16(&opener), Input::Bytes(&bytes[1..])]
                .into_iter()
                .map(Ok::<_, ()>),
        );
        let failed = stream
            .next()
            .expect("limit outcome")
            .expect_err("decoder limit");
        let StreamFailure::Parse(ParseFailure::LimitReached {
            resource,
            recovered,
            ..
        }) = failed.failure
        else {
            panic!("typed decoder limit");
        };
        assert_eq!(resource, Resource::Errors);
        assert_eq!(
            canonical_of(&recovered.expect("recoverable prefix")),
            expected
        );
        assert!(stream.next().is_none());
    }
}

#[test]
fn native_units_survive_every_split_in_values_and_fragments() {
    let expected = [0xd800, 0x61, 0xd83d, 0xde00, 0xdc00];
    let mut input: Vec<_> = r#"{"msg":""#.encode_utf16().collect();
    input.extend(expected);
    input.extend("\"}".encode_utf16());
    let selected = Parser::default()
        .select(vec![vec![PathSegment::Key("msg".into())]])
        .expect("selector")
        .fragments()
        .expect("fragment mode is compatible");
    for split in 0..=input.len() {
        let chunks = [&input[..split], &[], &input[split..]];
        let values: Vec<_> = Parser::default()
            .parse_stream(chunks.into_iter().map(Ok::<_, ()>))
            .collect();
        assert_eq!(values.len(), 1, "split {split}");
        assert_eq!(
            member_units(&values[0].as_ref().expect("value").value),
            expected,
            "split {split}"
        );
        let mut stream = selected.stream_parser();
        let mut actual = Vec::new();
        for chunk in chunks {
            for item in stream.feed(chunk) {
                if let Fragment::Data { text, .. } = item.expect("fragment").value {
                    assert!(
                        !actual
                            .last()
                            .is_some_and(|unit| (0xd800..0xdc00).contains(unit))
                            || !text
                                .code_units()
                                .next()
                                .is_some_and(|unit| (0xdc00..0xe000).contains(&unit)),
                        "pair split between fragments at input split {split}"
                    );
                    actual.extend(text.code_units());
                }
            }
        }
        for item in stream.end() {
            if let Fragment::Data { text, .. } = item.expect("tail").value {
                actual.extend(text.code_units());
            }
        }
        assert_eq!(actual, expected, "fragment split {split}");
    }
}

#[test]
fn native_text_finishes_pending_bytes_without_completing_their_sequence() {
    let parser = Parser {
        diagnostics: DiagnosticsMode::On,
        locations: true,
        ..Parser::default()
    };
    let mut stream = StreamParser::new(parser);
    assert_eq!(stream.feed(b"{\"msg\":\"\xf0\x9f").count(), 0);
    assert_eq!(stream.feed("").count(), 0);
    assert_eq!(stream.feed([0x98u16, 0xd800]).count(), 0);
    let items: Vec<_> = stream.feed("\"}").collect();
    let value = items[0].as_ref().expect("mixed root");
    assert_eq!(member_units(&value.value), [0xfffd, 0x98, 0xd800]);
    let span = value.span.expect("locations");
    assert_eq!(
        (span.end.chunk, span.end.offset, span.end.unit),
        (Some(3), 2, Unit::Byte)
    );
}

#[test]
fn byte_fragments_wait_for_continuations_across_empty_chunks() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("msg".into())]])
        .expect("selector")
        .fragments()
        .expect("fragment mode is compatible");
    for split in 1..4 {
        let mut stream = parser.stream_parser();
        stream.feed("{\"msg\":\"").for_each(drop);
        let bytes = [0xf0, 0x9f, 0x98, 0x80];
        assert!(
            stream.feed(&bytes[..split]).all(|item| !matches!(
                item.as_ref().expect("pending").value,
                Fragment::Data { .. }
            ))
        );
        assert_eq!(stream.feed("").count(), 0);
        let mut actual = Vec::new();
        for chunk in [Input::Bytes(&bytes[split..]), Input::Text("\"}")] {
            for item in stream.feed(chunk) {
                if let Fragment::Data { text, .. } = item.expect("fragment").value {
                    actual.extend(text.code_units());
                }
            }
        }
        assert_eq!(actual, [0xd83d, 0xde00], "split {split}");
    }

    let mut stream = parser.stream_parser();
    stream.feed("{\"msg\":\"").for_each(drop);
    for byte in [0xf0_u8, 0x9f, 0x98] {
        assert_eq!(stream.feed([byte]).count(), 0);
    }
    let pieces: Vec<_> = stream
        .feed([0x80_u8])
        .map(|item| item.expect("completed scalar").value)
        .collect();
    assert!(
        pieces
            .iter()
            .any(|piece| matches!(piece, Fragment::Data { .. }))
    );
}

#[test]
fn declared_encodings_are_refused_across_every_mark_split() {
    for (mark, expected) in [
        (&[0xfeu8, 0xff][..], Encoding::Utf16Be),
        (&[0xff, 0xfe][..], Encoding::Utf16Le),
        (&[0, 0, 0xfe, 0xff][..], Encoding::Utf32Be),
        (&[0xff, 0xfe, 0, 0][..], Encoding::Utf32Le),
    ] {
        for split in 0..=mark.len() {
            let items: Vec<_> = Parser::default()
                .parse_stream(
                    [&mark[..split], &[], &mark[split..]]
                        .into_iter()
                        .map(Ok::<_, ()>),
                )
                .collect();
            assert_eq!(items.len(), 1);
            assert!(
                matches!(&items[0], Err(failed) if matches!(failed.failure, partial_json_repair::StreamFailure::Parse(ParseFailure::UnsupportedEncoding { encoding }) if encoding == expected))
            );
        }
    }
}

#[test]
fn utf8_bom_is_removed_when_its_bytes_cross_the_carry_boundary() {
    let input = b"\xef\xbb\xbf{}";
    for split in 1..3 {
        let mut stream = StreamParser::new(Parser {
            locations: true,
            ..Parser::default()
        });
        assert_eq!(stream.feed(&input[..split]).count(), 0);
        assert_eq!(stream.feed(&input[split..]).count(), 0);
        let value = stream
            .end()
            .next()
            .expect("root")
            .expect("BOM-prefixed object");
        let span = value.span.expect("locations");
        assert_eq!((span.start.chunk, span.start.offset), (Some(1), 3 - split));
    }
}

#[test]
fn withheld_decoder_bytes_count_toward_the_input_limit() {
    let mut stream = StreamParser::new(Parser {
        max_buffer: NonZeroUsize::new(1).expect("nonzero"),
        ..Parser::default()
    });
    assert!(
        matches!(stream.feed([0xf0u8, 0x9f]).collect::<Vec<_>>().as_slice(), [Err(failed)] if matches!(failed.failure, ParseFailure::LimitReached { resource: Resource::Buffer, .. }))
    );
}

#[test]
fn source_spans_use_each_original_chunk_alphabet() {
    let parser = Parser {
        locations: true,
        ..Parser::default()
    };
    let mut stream = StreamParser::new(parser.clone());
    let input = "{\"msg\":\"😀\"}";
    let items: Vec<_> = stream.feed(input).collect();
    let span = items[0].as_ref().expect("text").span.expect("locations");
    assert_eq!((span.end.offset, span.end.unit), (input.len(), Unit::Byte));
    let mut stream = StreamParser::new(parser);
    let units: Vec<_> = input.encode_utf16().collect();
    let items: Vec<_> = stream.feed(&units).collect();
    let span = items[0].as_ref().expect("UTF-16").span.expect("locations");
    assert_eq!((span.end.offset, span.end.unit), (units.len(), Unit::Utf16));
}

#[test]
fn mixed_storage_preserves_byte_decoding_after_compaction() {
    for bytes in [
        &[0x80][..],
        &[0xc0, 0xaf],
        &[0xe0, 0x80, 0x80],
        &[0xed, 0xa0, 0x80],
        &[0xf4, 0x90, 0x80, 0x80],
        &[0xf0, 0x9f],
        &[0xef, 0xbf, 0xbd],
        &[0xf0, 0x9f, 0x98, 0x80],
    ] {
        for split in 0..=bytes.len() {
            let mut stream = StreamParser::new(Parser::default());
            assert_eq!(stream.feed("{\"n\":0}").count(), 1);
            let opening: Vec<_> = "{\"msg\":\"".encode_utf16().collect();
            assert_eq!(stream.feed(opening).count(), 0);
            assert_eq!(stream.feed(&bytes[..split]).count(), 0);
            assert_eq!(stream.feed(&bytes[split..]).count(), 0);
            let mut items: Vec<_> = stream
                .feed([0x22u16, 0x7d])
                .map(|item| item.expect("string").into_owned())
                .collect();
            items.extend(stream.end().map(|item| item.expect("tail").into_owned()));
            assert_eq!(items.len(), 1);
            let expected: Vec<_> = String::from_utf8_lossy(bytes).encode_utf16().collect();
            assert_eq!(
                member_units(&items[0].value),
                expected,
                "{bytes:?} split {split}"
            );
        }
    }
}

#[test]
fn mixed_fragments_slice_decoded_content_at_source_boundaries() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("msg".into())]])
        .expect("selector")
        .fragments()
        .expect("fragment mode is compatible");
    let mut stream = parser.stream_parser();
    let opening: Vec<_> = "{\"msg\":\"".encode_utf16().collect();
    stream.feed(opening).for_each(drop);
    let mut actual = Vec::new();
    for chunk in [
        Input::Bytes("😀".as_bytes()),
        Input::Bytes("😀".as_bytes()),
        Input::Text("x\"}"),
    ] {
        for item in stream.feed(chunk) {
            if let Fragment::Data { text, .. } = item.expect("fragment").value {
                actual.extend(text.code_units());
            }
        }
    }
    assert_eq!(actual, "😀😀x".encode_utf16().collect::<Vec<_>>());
}

#[test]
fn mixed_refusal_context_stops_at_the_observed_decoder_piece() {
    let mut parser = Parser::default();
    parser.recover = parser
        .recover
        .without(partial_json_repair::SwitchableRepair::UnquotedString);
    let chunks = [Input::Utf16(&[0x5b]), Input::Bytes(b"foo\x81 ]")];
    let items: Vec<_> = parser
        .parse_stream(chunks.into_iter().map(Ok::<_, ()>))
        .collect();
    let failed = items[0].as_ref().expect_err("policy refusal");
    let partial_json_repair::StreamFailure::Parse(ParseFailure::PolicyRefused { issue, .. }) =
        &failed.failure
    else {
        panic!("refusal")
    };
    assert_eq!(
        issue.context.code_units().collect::<Vec<_>>(),
        "[foo�".encode_utf16().collect::<Vec<_>>()
    );
}
