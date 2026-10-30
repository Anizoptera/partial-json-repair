//! Summaries distinguish examined input from stopped input without extra source reads or results.

use core::num::NonZeroUsize;
use partial_json_repair::stream::{StreamEvent, StreamSummary};
use partial_json_repair::{Fragment, Parser, PathSegment, SwitchableRepair};

#[test]
fn manual_drains_summarize_the_source_not_each_chunk() {
    let mut stream = partial_json_repair::StreamParser::default().with_summary();
    assert!(stream.feed("{\"a\":").next().is_none());
    assert!(stream.feed("").next().is_none());
    assert!(matches!(
        stream.feed("1}").collect::<Vec<_>>().as_slice(),
        [StreamEvent::Item(Ok(_))]
    ));
    assert_eq!(
        stream.end().collect::<Vec<_>>(),
        [StreamEvent::Summary(StreamSummary {
            complete: true,
            roots: 1,
            matches: 0,
            unmatched: vec![],
        })]
    );
    assert!(matches!(
        stream.end().collect::<Vec<_>>().as_slice(),
        [StreamEvent::Item(Err(_))]
    ));
}

#[test]
fn abandoning_a_terminal_drain_suppresses_its_summary_permanently() {
    let mut stream = partial_json_repair::StreamParser::new(Parser {
        max_buffer: NonZeroUsize::MIN,
        ..Parser::default()
    })
    .with_summary();
    let mut drain = stream.feed("[1,/*");
    assert!(matches!(drain.next(), Some(StreamEvent::Item(Err(_)))));
    drop(drain);
    assert!(matches!(
        stream.end().collect::<Vec<_>>().as_slice(),
        [StreamEvent::Item(Err(_))]
    ));
}

#[test]
fn completion_and_failure_keep_root_counts_and_emit_once() {
    let refused = Parser {
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::UnquotedKey),
        ..Parser::default()
    };
    let bounded = Parser {
        max_buffer: NonZeroUsize::MIN,
        ..Parser::default()
    };
    let cases = [
        (Parser::default(), vec![Ok("{\"a\":1} {\"b\":2}")], true, 2),
        (refused, vec![Ok("{a:1} {\"b\":2}")], true, 2),
        (bounded, vec![Ok("[1,/*"), Ok(" note */2]")], false, 1),
        (
            Parser::default(),
            vec![Ok("{\"a\":1"), Err("offline")],
            false,
            1,
        ),
        (Parser::default(), vec![Err("offline")], false, 0),
        (Parser::default(), vec![], true, 0),
    ];
    for (parser, chunks, complete, roots) in cases {
        let mut stream = parser.parse_stream(chunks.into_iter()).with_summary();
        let items: Vec<_> = stream.by_ref().collect();
        assert_eq!(
            items.last(),
            Some(&StreamEvent::Summary(StreamSummary {
                complete,
                roots,
                matches: 0,
                unmatched: vec![],
            }))
        );
        assert!(
            items[..items.len() - 1]
                .iter()
                .all(|item| matches!(item, StreamEvent::Item(_)))
        );
        assert!(stream.next().is_none(), "a summary must not repeat");
    }
}

#[test]
fn abandoning_summary_iteration_does_not_drain_the_source() {
    let mut reads = 0;
    let chunks = [Ok::<_, ()>("{\"a\":1}"), Ok("{\"b\":2}")];
    let mut source = chunks.into_iter().inspect(|_| reads += 1);
    let mut stream = Parser::default()
        .parse_stream(source.by_ref())
        .with_summary();
    assert!(matches!(stream.next(), Some(StreamEvent::Item(Ok(_)))));
    drop(stream);
    drop(source);
    assert_eq!(reads, 1);
}

#[test]
fn selected_summary_counts_delivered_matches_and_unmatched_paths() {
    let selected = Parser::default()
        .select(vec![
            vec![PathSegment::Key("items".into()), PathSegment::Any],
            vec![PathSegment::Key("missing".into())],
        ])
        .expect("selectors");
    let mut stream = selected.stream_parser().with_summary();
    assert_eq!(stream.feed(r#"{"items":[1,2]}"#).count(), 2);
    assert_eq!(
        stream.end().collect::<Vec<_>>(),
        [StreamEvent::Summary(StreamSummary {
            complete: true,
            roots: 1,
            matches: 2,
            unmatched: vec![1],
        })]
    );
}

#[test]
fn fragment_summary_counts_occurrences_instead_of_pieces() {
    let selected = Parser::default()
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("selector")
        .fragments()
        .expect("fragment mode is compatible");
    let mut stream = selected.stream_parser().with_summary();
    let events = stream
        .feed(r#"{"a":"one"} {"a":"two"}"#)
        .collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, StreamEvent::Item(Ok(item)) if matches!(item.value, Fragment::Start { .. })))
            .count(),
        2
    );
    assert_eq!(
        stream.end().collect::<Vec<_>>(),
        [StreamEvent::Summary(StreamSummary {
            complete: true,
            roots: 2,
            matches: 2,
            unmatched: vec![],
        })]
    );
}
