//! Rust views expose the current root through a borrow and retain no stream history.

use core::num::NonZeroUsize;

use partial_json_repair::{
    ParseFailure, Parser, PathSegment, PathStep, StreamParser, SwitchableRepair, Value,
    canonical_of,
};

#[test]
fn view_distinguishes_absence_null_and_an_open_string() {
    let mut stream = StreamParser::default().viewed();
    assert_eq!(stream.view().expect("view"), None);

    stream.feed("null").for_each(drop);
    stream.end().for_each(drop);
    let complete = stream.view().expect("view").expect("root");
    assert!(complete.complete);
    assert_eq!(complete.value, Value::Null);

    let mut stream = StreamParser::default().viewed();
    stream.feed(r#"{"a":[1,"par"#).for_each(drop);
    let open = stream.view().expect("view").expect("root");
    assert!(!open.complete);
    assert_eq!(canonical_of(&open.value), r#"{"a":[1,"par"]}"#);
    assert_eq!(
        open.partial_path.as_deref(),
        Some(&[PathStep::Key("a".into()), PathStep::Index(1),][..])
    );
}

#[test]
fn an_owned_snapshot_survives_later_input() {
    let mut stream = StreamParser::default().viewed();
    stream.feed(r#"{"a":[1,"#).for_each(drop);
    let held = stream.view().expect("view").expect("root").clone();
    stream.feed("2]}").for_each(drop);
    assert_eq!(canonical_of(&held.value), r#"{"a":[1]}"#);
    assert_eq!(
        canonical_of(&stream.view().expect("view").expect("root").value),
        r#"{"a":[1,2]}"#
    );
}

#[test]
fn selected_view_contains_the_open_match_once() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("selector");
    let mut stream = parser.stream_parser().viewed();
    stream.feed(r#"{"z":0,"a":{"b":"par"#).for_each(drop);
    let view = stream.view().expect("view").expect("root");
    assert_eq!(view.value.len(), 1);
    assert_eq!(canonical_of(&view.value[0].value), r#"{"b":"par"}"#);
    assert_eq!(
        view.partial_path.as_deref(),
        Some(&[PathStep::Key("a".into()), PathStep::Key("b".into()),][..])
    );
}

#[test]
fn refusal_remains_a_failure_with_its_recovered_view() {
    let mut stream = StreamParser::new(Parser {
        max_errors: NonZeroUsize::MIN,
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::UnquotedKey),
        ..Parser::default()
    })
    .viewed();
    let items: Vec<_> = stream.feed(r#"{"a":1,b:2}"#).collect();
    assert!(matches!(
        &items[..],
        [Err(failed)] if matches!(failed.failure, ParseFailure::PolicyRefused { .. })
    ));
    let failed = stream.view().expect_err("view preserves refusal");
    assert!(matches!(failed.failure, ParseFailure::PolicyRefused { .. }));
    assert_eq!(
        canonical_of(&failed.recovered.expect("recovered view").value),
        r#"{"a":1}"#
    );

    stream.close();
    assert_eq!(stream.view().expect("closed view"), None);
}

#[test]
fn selected_close_releases_held_matches() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("selector");
    let mut stream = parser.stream_parser().viewed();
    stream.feed(r#"{"a":1}"#).for_each(drop);
    assert_eq!(stream.view().expect("view").expect("root").value.len(), 1);
    stream.close();
    assert_eq!(stream.view().expect("closed view"), None);
}

#[test]
fn selected_refusal_keeps_completed_matches_under_the_failure() {
    let parser = Parser {
        max_errors: NonZeroUsize::MIN,
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::SingleQuote),
        ..Parser::default()
    }
    .select(vec![vec![]])
    .expect("selector");
    let mut stream = parser.stream_parser().viewed();
    let items: Vec<_> = stream.feed(r#"{"a":1,'b':2}"#).collect();
    assert!(
        items.iter().any(|item| matches!(
            item,
            Err(failed) if matches!(failed.failure, ParseFailure::PolicyRefused { .. })
        )),
        "{items:?}"
    );
    let failed = stream.view().expect_err("view preserves refusal");
    let recovered = failed.recovered.expect("selected recovery");
    assert_eq!(recovered.value.len(), 1);
    assert!(recovered.value[0].path.is_empty());
    assert_eq!(canonical_of(&recovered.value[0].value), r#"{"a":1}"#);
}
