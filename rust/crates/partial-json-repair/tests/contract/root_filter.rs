//! Root filters select complete object candidates without hiding earlier parser failures.

use partial_json_repair::{
    ParseFailure, Parser, PathSegment, SelectorField, SelectorReason, StreamParser, canonical_of,
};

fn parser() -> Parser {
    Parser {
        required_keys: vec!["id".into()],
        ..Parser::default()
    }
}

#[test]
fn whole_input_verbs_use_the_first_matching_root() {
    let input = r#"prefix [0] {"kind":"skip"} {kind:"take",id:7} suffix"#;
    let parser = parser();
    assert_eq!(
        canonical_of(&parser.parse(input).expect("matching object").value),
        r#"{"kind":"take","id":7}"#
    );
    let span = parser.find_json_span(input).expect("matching span").value;
    assert_eq!(
        &input[span.start.offset..span.end.offset],
        r#"{kind:"take",id:7}"#
    );
    assert_eq!(
        parser
            .repair(input)
            .expect("matching repair")
            .value
            .as_str(),
        Some(r#"{"kind":"take","id":7}"#)
    );
}

#[test]
fn no_match_retains_the_first_compatible_object() {
    let parser = parser();
    let failure = parser
        .parse(r#"[0] {"kind":"first"} {"kind":"second"}"#)
        .expect_err("no object has id");
    let ParseFailure::NoMatch {
        required_keys,
        recovered: Some(recovered),
    } = failure.failure
    else {
        panic!("expected no-match with a recovered object");
    };
    assert_eq!(required_keys, ["id".into()]);
    assert_eq!(canonical_of(&recovered), r#"{"kind":"first"}"#);
}

#[test]
fn streams_skip_rejected_roots_and_end_with_no_match() {
    let mut matching = StreamParser::new(parser());
    let rejected: Vec<_> = matching.feed(r#"[0] {"kind":"skip"} "#).collect();
    assert!(rejected.is_empty(), "rejected roots escaped: {rejected:?}");
    assert!(
        matching
            .feed(r#"{"id":7}"#)
            .next()
            .expect("accepted root")
            .is_ok()
    );

    let mut rejected = StreamParser::new(parser());
    rejected.feed(r#"[0] {"kind":"skip"}"#).for_each(drop);
    let last = rejected.end().next().expect("terminal no-match");
    assert!(matches!(last, Err(failed) if matches!(failed.failure, ParseFailure::NoMatch { .. })));
}

#[test]
fn fragment_delivery_refuses_root_filters_before_input_is_read() {
    let selected = parser()
        .select(vec![vec![PathSegment::Key("id".into())]])
        .expect("valid selector");
    let failure = selected
        .fragments()
        .expect_err("fragments escape before root acceptance");
    assert_eq!(failure.field, SelectorField::Fragments);
    assert_eq!(failure.reason, SelectorReason::RootFilter);
}

#[test]
fn selection_cannot_leak_matches_from_rejected_roots() {
    let selected = parser()
        .select(vec![vec![PathSegment::Key("name".into())]])
        .expect("valid selector");
    let matches = selected
        .parse(r#"{"name":"leak"} {"id":7,"name":"keep"}"#)
        .expect("first matching root")
        .value;
    assert_eq!(matches.len(), 1);
    assert_eq!(canonical_of(&matches[0].value), r#""keep""#);

    let failure = selected
        .parse(r#"{"name":"skip"}"#)
        .expect_err("no matching root");
    assert!(matches!(failure.failure, ParseFailure::NoMatch { .. }));
}
