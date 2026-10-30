//! What `parse_stream` decides that driving `StreamParser` by hand does not.
//!
//! The two doors share the drain, so agreeing on ordinary chunks is true by construction and worth
//! no test. What only the DRIVE can get wrong is where it stops pulling and what it does with a
//! source that fails, and each case below fixes one of those.

use core::num::NonZeroUsize;
use partial_json_repair::stream::StreamFailure;
use partial_json_repair::{ParseFailure, Parser, Resource, Value};

/// A source that counts how many chunks were asked for, and can fail on demand.
struct Source {
    chunks: core::slice::Iter<'static, &'static str>,
    /// Chunks handed out so far. Read after the consumer leaves, to prove nothing was pulled since.
    pulled: usize,
    /// Fail instead of yielding the chunk at this index.
    fail_at: Option<usize>,
}

impl Source {
    fn new(chunks: &'static [&'static str]) -> Self {
        Self {
            chunks: chunks.iter(),
            pulled: 0,
            fail_at: None,
        }
    }

    fn failing_at(chunks: &'static [&'static str], at: usize) -> Self {
        Self {
            fail_at: Some(at),
            ..Self::new(chunks)
        }
    }
}

impl Iterator for Source {
    type Item = Result<&'static str, &'static str>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.fail_at == Some(self.pulled) {
            self.pulled += 1;
            return Some(Err("transport"));
        }
        let chunk = *self.chunks.next()?;
        self.pulled += 1;
        Some(Ok(chunk))
    }
}

fn values(items: Vec<partial_json_repair::OwnedStreamItem<&'static str>>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| match item {
            Ok(success) => partial_json_repair::canonical_of(&success.value),
            Err(failed) => match &failed.failure {
                StreamFailure::Parse(_) => "parse-failed".to_string(),
                StreamFailure::SourceFailed { cause, recovered } => format!(
                    "source-failed:{cause}:{}",
                    recovered
                        .as_ref()
                        .map_or_else(|| "none".to_string(), partial_json_repair::canonical_of)
                ),
            },
        })
        .collect()
}

/// A value split across chunks is delivered once, by the chunk that finished it.
#[test]
fn delivers_each_root_once() {
    let options = Parser::default();
    let items = options
        .parse_stream(Source::new(&["{\"a\":", "1} [2,", "3]"]))
        .collect();
    assert_eq!(values(items), ["{\"a\":1}", "[2,3]"]);
}

/// The tail is closed when the source runs dry, so an unfinished root is still recovered.
#[test]
fn closes_the_tail_at_exhaustion() {
    let options = Parser::default();
    let items = options
        .parse_stream(Source::new(&["{\"a\":1, \"b\":\"cu"]))
        .collect();
    assert_eq!(values(items), ["{\"a\":1,\"b\":\"cu\"}"]);
}

#[test]
fn an_unfinished_scalar_stops_at_its_stream_bound() {
    let parser = Parser {
        max_scalar: NonZeroUsize::new(4).expect("nonzero"),
        ..Parser::default()
    };
    let mut stream = partial_json_repair::StreamParser::new(parser);
    let items: Vec<_> = stream.feed("hello").collect();
    assert!(matches!(
        &items[0],
        Err(failed)
            if matches!(
                failed.failure,
                ParseFailure::LimitReached {
                    resource: Resource::Scalar,
                    limit: 4,
                    ..
                }
            )
    ));
}

#[test]
fn a_completed_scalar_stops_at_the_same_bound() {
    let parser = Parser {
        max_scalar: NonZeroUsize::new(4).expect("nonzero"),
        ..Parser::default()
    };
    let result = parser.parse("12345");
    assert!(matches!(
        result.expect_err("scalar bound").failure,
        ParseFailure::LimitReached {
            resource: Resource::Scalar,
            limit: 4,
            ..
        }
    ));
}

#[test]
fn the_buffer_bound_limits_undecided_syntax_not_open_roots() {
    let parser = Parser {
        max_buffer: NonZeroUsize::new(8).expect("nonzero"),
        locations: true,
        ..Parser::default()
    };
    let mut stream = partial_json_repair::StreamParser::new(parser.clone());
    assert_eq!(stream.feed(r#"{"a":1}"#).count(), 1);
    let second: Vec<_> = stream.feed(r#"{"b":2}"#).collect();
    assert_eq!(second.len(), 1);
    let span = second[0]
        .as_ref()
        .expect("second root")
        .span
        .expect("locations requested");
    assert_eq!(span.start.chunk, Some(1));
    assert_eq!(span.start.offset, 0);

    let mut open = partial_json_repair::StreamParser::new(parser.clone());
    assert!(open.feed(r#"{"a":"123456"#).next().is_none());
    assert!(
        open.feed("\"}")
            .next()
            .expect("decoded prefix survives")
            .is_ok()
    );

    let mut open = partial_json_repair::StreamParser::new(parser);
    let items: Vec<_> = open.feed(r#"{"a":1,/*123456"#).collect();
    assert!(matches!(
        items.last(),
        Some(Err(failed))
            if matches!(
                failed.failure,
                ParseFailure::LimitReached {
                    resource: Resource::Buffer,
                    limit: 8,
                    ..
                }
            )
    ));
    assert!(matches!(
        open.feed("more").collect::<Vec<_>>().as_slice(),
        [Err(failed)] if failed.failure == ParseFailure::StreamClosed
    ));
}

#[test]
fn recovered_content_stops_at_the_stream_retained_bound() {
    let parser = Parser {
        max_buffer: NonZeroUsize::new(1024).expect("nonzero"),
        max_retained: NonZeroUsize::new(8).expect("nonzero"),
        ..Parser::default()
    };
    let mut stream = partial_json_repair::StreamParser::new(parser);
    let items: Vec<_> = stream.feed(r#"{"a":"xxxxxxxx"}"#).collect();
    assert!(matches!(
        items.last(),
        Some(Err(failed))
            if matches!(
                failed.failure,
                ParseFailure::LimitReached {
                    resource: Resource::Retained,
                    limit: 8,
                    ..
                }
            )
    ));
}

/// A paused string spends its cumulative decoded size, not its byte size or latest chunk size.
#[test]
fn unfinished_string_retention_counts_utf16_units_across_chunks() {
    use partial_json_repair::{Input, StreamParser};

    let units: Vec<_> = "é😀".encode_utf16().collect();
    for chunk in [Input::Text("é😀"), Input::Utf16(&units)] {
        let parser = Parser {
            max_retained: NonZeroUsize::new(8).expect("nonzero"),
            ..Parser::default()
        };
        let mut stream = StreamParser::new(parser);
        assert_eq!(stream.feed(r#"{"a":""#).count(), 0);
        for _ in 0..4 {
            assert_eq!(stream.feed(chunk).count(), 0);
        }
        assert!(matches!(
            stream.feed(chunk).next(),
            Some(Err(failed)) if matches!(failed.failure,
                ParseFailure::LimitReached { resource: Resource::Retained, limit: 8, .. })
        ));
    }
}

/// A source that says nothing answers `no-json-found` rather than running dry in silence.
#[test]
fn an_empty_source_is_not_silent() {
    let options = Parser::default();
    let items = options.parse_stream(Source::new(&[])).collect();
    assert_eq!(values(items), ["parse-failed"]);
}

/// A failed source keeps its cause and hands back the root it left open — and never repeats the
/// roots it had already delivered.
#[test]
fn a_failed_source_exposes_its_prefix() {
    let options = Parser::default();
    let items = options
        .parse_stream(Source::failing_at(&["{\"a\":1} {\"b\":", "2"], 2))
        .collect();
    assert_eq!(
        values(items),
        ["{\"a\":1}", "source-failed:transport:{\"b\":2}"]
    );
}

/// Nothing is pulled after the failure: a failed iterator owes nothing beyond its error.
#[test]
fn a_failure_ends_the_pulling() {
    let options = Parser::default();
    let mut stream = options.parse_stream(Source::failing_at(&["{\"a\":1}", "{\"b\":2}"], 0));
    let drained: Vec<_> = stream.by_ref().collect();
    assert_eq!(values(drained), ["source-failed:transport:none"]);
    assert!(stream.next().is_none());
}

/// A parser limit is terminal even when the source still has chunks ready.
#[test]
fn a_parser_limit_stops_source_pulling() {
    let parser = Parser {
        max_buffer: NonZeroUsize::MIN,
        ..Parser::default()
    };
    let mut source = Source::new(&["[1,/*", " note */2]", "{\"later\":true}"]);
    let items: Vec<_> = parser.parse_stream(source.by_ref()).collect();
    assert_eq!(items.len(), 1);
    assert!(matches!(&items[0], Err(failed) if matches!(failed.failure,
        StreamFailure::Parse(ParseFailure::LimitReached { resource: Resource::Buffer, .. }))));
    assert_eq!(source.pulled, 1);
}

/// Leaving the loop early stops the work, with no `close` for the caller to remember. The count is
/// the evidence: a drive that read ahead would have pulled more chunks than the consumer took.
#[test]
fn dropping_stops_the_source() {
    let options = Parser::default();
    let mut source = Source::new(&["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
    {
        let mut stream = options.parse_stream(source.by_ref());
        let first = stream.next().expect("a value from the first chunk");
        assert_eq!(values(vec![first]), ["{\"a\":1}"]);
    }
    assert_eq!(source.pulled, 1);
}

/// Spending the error budget stops source reads even when the last result is a policy refusal.
#[test]
fn a_refusal_that_spends_the_budget_stops_source_pulling() {
    for budget in [1, 2] {
        let parser = Parser {
            max_errors: NonZeroUsize::new(budget).expect("positive budget"),
            recover: Parser::default()
                .recover
                .without(partial_json_repair::SwitchableRepair::UnquotedKey),
            ..Parser::default()
        };
        let mut source = Source::new(&["{a:1}", "{\"later\":true}"]);
        let items: Vec<_> = parser.parse_stream(source.by_ref()).collect();
        assert_eq!(source.pulled, budget, "only a spent budget stops pulling");
        assert_eq!(items.len(), budget);
        assert!(matches!(&items[0], Err(failed) if matches!(failed.failure,
            StreamFailure::Parse(ParseFailure::PolicyRefused { recovered: Some(_), .. }))));
        if budget == 2 {
            assert!(items[1].is_ok(), "a local refusal permits the next root");
        }
    }
}

/// Values are owned, so they outlive the chunks that carried them.
#[test]
fn items_outlive_the_source() {
    let options = Parser::default();
    let held: Vec<Value<'static>> = {
        let chunk = String::from("{\"a\":\"text\"}");
        options
            .parse_stream([Ok::<_, &str>(chunk.as_str())].into_iter())
            .filter_map(Result::ok)
            .map(|s| s.value)
            .collect()
    };
    assert_eq!(
        partial_json_repair::canonical_of(&held[0]),
        "{\"a\":\"text\"}"
    );
}

/// Empty chunks still count as source chunks after completed input has been released.
#[test]
fn sparse_boundaries_preserve_positions_after_compaction() {
    let mut stream = partial_json_repair::StreamParser::new(Parser {
        locations: true,
        ..Parser::default()
    });
    assert_eq!(stream.feed(r#"{"a":1}"#).count(), 1);
    for _ in 0..32 {
        assert_eq!(stream.feed("").count(), 0);
    }
    assert_eq!(stream.feed(r#"{"b":"#).count(), 0);
    for _ in 0..32 {
        assert_eq!(stream.feed("").count(), 0);
    }
    let items: Vec<_> = stream.feed("2}").collect();
    let span = items[0].as_ref().expect("root").span.expect("locations");
    assert_eq!((span.start.chunk, span.start.offset), (Some(33), 0));
    assert_eq!((span.end.chunk, span.end.offset), (Some(66), 2));
}
