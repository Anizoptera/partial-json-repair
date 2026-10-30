//! Ending a stream is terminal even when it produced no value or repaired an unfinished one.

use partial_json_repair::{ParseFailure, Parser, PathSegment, StreamParser};

// The delivery types differ; each public parser must obey the same terminal transition.
macro_rules! closes_after_end {
    ($name:ident, $parser:expr) => {
        #[test]
        fn $name() {
            for input in ["", r#"{"a":"x"}"#, r#"{"a":"x"#] {
                let mut stream = $parser;
                stream.feed(input).into_iter().for_each(drop);
                stream.end().into_iter().for_each(drop);
                assert!(matches!(
                    stream.end().into_iter().collect::<Vec<_>>().as_slice(),
                    [Err(failed)] if failed.failure == ParseFailure::StreamClosed
                ));
                for chunk in ["", r#"{"a":"later"}"#] {
                    assert!(matches!(
                        stream.feed(chunk).into_iter().collect::<Vec<_>>().as_slice(),
                        [Err(failed)] if failed.failure == ParseFailure::StreamClosed
                    ));
                }
            }
        }
    };
}

closes_after_end!(values_close, StreamParser::default());
closes_after_end!(
    selected_values_close,
    Parser::default()
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("selector")
        .stream_parser()
);
closes_after_end!(
    scalar_fragments_close,
    Parser::default()
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("selector")
        .fragments()
        .expect("fragment mode is compatible")
        .stream_parser()
);
