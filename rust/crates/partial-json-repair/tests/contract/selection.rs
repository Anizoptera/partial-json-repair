//! `skip` on DAMAGED input, which is the input this library exists for.
//!
//! The corpus is the oracle for selection, but `rust:conform` never gates, so a regression here
//! reaches a commit with every gated step green. These two cases are the ones that were actually
//! wrong or actually expensive to get wrong; the corpus still owns the breadth.

use core::num::NonZeroUsize;
use partial_json_repair::{
    DiagnosticsMode, Fragment, JsonString, ParseFailure, Parser, PathSegment, RepairKind,
    ScalarKind, Scanner, SwitchableRepair, canonical_of,
};
use std::borrow::Cow;

/// The recovered value canonically, and each repair as its kind, how deep it was reported, and
/// where. Depth alone cannot tell a repair inside the skipped member from one beside it, and that
/// is the distinction both cases below turn on.
fn skipping_a(src: &str) -> (String, Vec<(RepairKind, usize, usize)>) {
    let options = Parser {
        diagnostics: DiagnosticsMode::On,
        skip: vec![vec![PathSegment::Key("a".into())]],
        ..Parser::default()
    };
    let outcome = options.parse(src).expect("damaged input still recovers");
    let report = outcome.diagnostics.expect("asked for above");
    (
        canonical_of(&outcome.value),
        report
            .repairs
            .iter()
            .map(|r| (r.kind, r.path.len(), r.at.offset))
            .collect(),
    )
}

/// A skipped subtree the input ended inside is still skipped.
///
/// It reaches the tree by a different door: its closer never arrives, so the placement site in the
/// unwind never sees it and the end-of-input finaliser closes it instead. That door did not ask,
/// which left `skip` correct on well-formed documents and silently ignored on damaged ones.
///
/// The repairs are half the assertion. Each frame inside the skip would otherwise report its own
/// `unclosed-*`, describing content the caller declined and dropping `confidence` for it — and the
/// surviving one is reported at the ROOT, which only holds while the skipped member's key is
/// consumed rather than left waiting.
#[test]
fn a_truncated_skipped_subtree_leaves_nothing_behind() {
    let (value, repairs) = skipping_a(r#"{"a": {"b": [1, 2"#);
    assert_eq!(value, "{}");
    assert_eq!(
        repairs,
        vec![(
            RepairKind::Switchable(SwitchableRepair::UnclosedObject),
            0,
            17
        )],
        "only the root is unclosed in the caller's scope, and it is reported AT the root"
    );
}

/// A skipped member's own repairs STAY, and confidence still falls for them.
///
/// Measured on the reference, and the reason is that they describe the SOURCE, which still holds
/// the member — `repair()` hands back text that includes it. Retracting them instead was tried and
/// moved 27 recorded rows, so this is a guard against a plausible-looking simplification, not a
/// restatement of the code.
#[test]
fn a_skipped_member_keeps_the_repairs_its_source_earned() {
    let (value, repairs) = skipping_a(r#"{'a': 'b', 'c': 'd'}"#);
    assert_eq!(value, r#"{"c":"d"}"#);
    let quote = RepairKind::Switchable(SwitchableRepair::SingleQuote);
    // All four quoted tokens, the skipped member's key AND its value among them. Offset 6 is `'b'`,
    // reported one level deep at `["a"]` — the entry retraction would take and the one that decides
    // this test. Compared whole rather than counted, so a fifth repair or a moved offset also fails.
    assert_eq!(
        repairs,
        vec![(quote, 0, 1), (quote, 1, 6), (quote, 0, 11), (quote, 1, 16)]
    );
}

/// Skipping changes what a report describes, not what the scanner must examine. A refused spelling
/// in the removed subtree therefore spends the error budget and fails the outcome, while ordinary
/// diagnostics remain empty because the caller declined that content.
#[test]
fn a_refusal_inside_skipped_content_spends_the_budget_without_entering_the_report() {
    let source = r#"{"a": {'b': 1}, "c": 2}"#;
    let parser = Parser {
        diagnostics: DiagnosticsMode::On,
        skip: vec![vec![PathSegment::Key("a".into())]],
        recover: Parser::default()
            .recover
            .without(SwitchableRepair::SingleQuote),
        max_errors: NonZeroUsize::MIN,
        ..Parser::default()
    };
    let mut scanner = Scanner::new(source.as_bytes(), &parser)
        .with_selection(parser.selection().expect("valid selector"));
    let _ = scanner.next_value();
    assert_eq!(scanner.issues().len(), 1);
    assert!(!scanner.issues()[0].scoped);
    let failed = parser
        .parse(source)
        .expect_err("strict policy refuses the skipped spelling");
    assert!(matches!(failed.failure, ParseFailure::PolicyRefused { .. }));
    let report = failed.diagnostics.expect("asked for above");
    assert!(
        report.errors.is_empty(),
        "hidden errors: {:?}",
        report.errors
    );
    assert_eq!(report.counts.errors, 0);
    assert!(
        !report.scan_complete,
        "the hidden refusal still spent max_errors"
    );
}

#[test]
fn selected_parser_returns_typed_matches_with_source_identity() {
    let parser = Parser {
        locations: true,
        ..Parser::default()
    }
    .select(vec![vec![PathSegment::Key("a".into())]])
    .expect("valid selector");
    let outcome = parser
        .parse(r#"{"a": {"b": 1}, "c": 2}"#)
        .expect("valid JSON matches");
    assert_eq!(outcome.value.len(), 1);
    let matched = &outcome.value[0];
    assert_eq!(canonical_of(&matched.value), r#"{"b":1}"#);
    assert_eq!(canonical_of(&matched.path), r#"["a"]"#);
    assert_eq!(matched.value_index, 0);
    assert_eq!(matched.span.start.offset, 6);
    assert_eq!(matched.span.end.offset, 14);
    assert_eq!(matched.selectors, vec![0]);
}

#[test]
fn selected_string_fragments_cross_chunks_without_repeating_decoded_content() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("msg".into())]])
        .expect("valid selector")
        .fragments()
        .expect("fragment mode is compatible");
    let mut stream = parser.stream_parser();
    let mut fragments = Vec::new();
    for chunk in [r#"{"msg":"hel"#, r#"lo\n"#, "!\"}"] {
        fragments.extend(
            stream
                .feed(chunk)
                .map(Result::unwrap)
                .map(|success| success.value),
        );
    }
    fragments.extend(
        stream
            .end()
            .map(Result::unwrap)
            .map(|success| success.value),
    );

    assert!(matches!(
        &fragments[0],
        Fragment::Start {
            id: 0,
            value_index: 0,
            scalar: ScalarKind::String,
            ..
        }
    ));
    let text: Vec<JsonString<'static>> = fragments
        .iter()
        .filter_map(|fragment| match fragment {
            Fragment::Data { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        text,
        vec![
            JsonString::Text(Cow::Owned("hel".into())),
            JsonString::Text(Cow::Owned("lo".into())),
            JsonString::Text(Cow::Owned("\n".into())),
            JsonString::Text(Cow::Owned("!".into()))
        ]
    );
    assert!(matches!(
        fragments.last(),
        Some(Fragment::End { id: 0, .. })
    ));
}

#[test]
fn bare_fragments_keep_source_spelling_and_bound_each_piece() {
    let parser = Parser {
        exact_numbers: true,
        max_scalar: NonZeroUsize::new(8192).expect("bound"),
        ..Parser::default()
    }
    .select(vec![vec![PathSegment::Key("value".into())]])
    .expect("selector")
    .fragments()
    .expect("fragment mode is compatible");
    for (spelling, scalar) in [
        ("01".to_string(), ScalarKind::Number),
        ("True".to_string(), ScalarKind::Literal),
        ("7".repeat(5000), ScalarKind::Number),
    ] {
        let input = format!("{{\"value\":{spelling}}}");
        let mut stream = parser.stream_parser();
        let fragments: Vec<_> = stream
            .feed(input)
            .map(|item| item.expect("fragment").value)
            .collect();
        assert!(matches!(
            &fragments[0],
            Fragment::Start { scalar: actual, .. } if *actual == scalar
        ));
        let pieces: Vec<_> = fragments
            .iter()
            .filter_map(|fragment| match fragment {
                Fragment::Data { text, .. } => Some(text.as_str().expect("ASCII spelling")),
                _ => None,
            })
            .collect();
        if spelling.len() > 4096 {
            assert!(
                pieces.len() > 1,
                "large spelling must be delivered in pieces"
            );
        }
        assert_eq!(pieces.concat(), spelling);
        assert!(matches!(fragments.last(), Some(Fragment::End { .. })));
    }
}

#[test]
fn fragments_preserve_escapes_after_a_lone_surrogate() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("msg".into())]])
        .expect("selector")
        .fragments()
        .expect("fragment mode is compatible");
    let input = r#"{"msg":"\ud800\n\u0061\ud801\u0062\ud83d\ude00"}"#;
    for split in 0..=input.len() {
        let mut stream = parser.stream_parser();
        let mut units = Vec::new();
        for chunk in [&input[..split], "", &input[split..]] {
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
            [0xd800, 10, 0x61, 0xd801, 0x62, 0xd83d, 0xde00],
            "split {split}"
        );
    }
}

#[test]
fn fragment_reports_deliver_entries_once_and_keep_root_totals() {
    let parser = Parser {
        diagnostics: DiagnosticsMode::On,
        ..Parser::default()
    }
    .select(vec![vec![PathSegment::Key("msg".into())]])
    .expect("valid selector")
    .fragments()
    .expect("fragment mode is compatible");
    let mut stream = parser.stream_parser();
    let items: Vec<_> = stream.feed(r#"{"msg":'hello'}"#).collect();

    assert!(items.len() >= 3, "start, data, and end must be delivered");
    for (index, item) in items.into_iter().enumerate() {
        let report = item
            .expect("the selected scalar is recoverable")
            .diagnostics
            .expect("diagnostics were requested");
        assert_eq!(report.counts.repairs, 1);
        if index == 0 {
            assert_eq!(report.repairs.len(), 1);
            assert_eq!(
                report.repairs[0].kind,
                RepairKind::Switchable(SwitchableRepair::SingleQuote)
            );
            assert!(report.entries_complete);
        } else {
            assert!(report.repairs.is_empty());
            assert!(!report.entries_complete);
        }
    }
}

#[test]
fn fragment_mode_refuses_a_selected_container() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("valid selector")
        .fragments()
        .expect("fragment mode is compatible");
    let mut stream = parser.stream_parser();
    let items: Vec<_> = stream.feed(r#"{"a":[1]}"#).collect();
    assert!(items.iter().any(|item| matches!(
        item,
        Err(failed) if matches!(failed.failure, ParseFailure::NonScalarSelection { .. })
    )));
}
