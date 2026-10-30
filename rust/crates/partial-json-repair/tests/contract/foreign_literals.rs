//! Recover complete foreign literals without changing quoted text or unfinished words.

use partial_json_repair::{
    DiagnosticsMode, ParseFailure, Parser, RepairKind, StreamParser, SwitchableRepair, canonical_of,
};

#[test]
fn reports_and_refuses_each_literal_without_changing_its_value() {
    for (token, expected, kind) in [
        ("True", "true", SwitchableRepair::LiteralCase),
        ("fAlSe", "false", SwitchableRepair::LiteralCase),
        ("NULL", "null", SwitchableRepair::LiteralCase),
        ("None", "null", SwitchableRepair::NullAlias),
        ("NiL", "null", SwitchableRepair::NullAlias),
    ] {
        for diagnostics in [DiagnosticsMode::Off, DiagnosticsMode::On] {
            let parser = Parser {
                diagnostics,
                ..Parser::default()
            };
            let recovered = parser.parse(token).expect("standalone literal");
            assert_eq!(canonical_of(&recovered.value), expected);
            assert_eq!(
                recovered.diagnostics.is_some(),
                diagnostics == DiagnosticsMode::On
            );
            if let Some(report) = &recovered.diagnostics {
                assert_eq!(report.repairs.len(), 1);
                assert_eq!(report.repairs[0].kind, RepairKind::Switchable(kind));
                assert_eq!(report.confidence, 0.97);
            }
            let input = format!("{{\"a\": {token} , \"tail\":1}}");
            assert_eq!(
                parser
                    .repair(input.as_str())
                    .expect("canonical JSON")
                    .value
                    .as_str(),
                Some(format!("{{\"a\": {expected} , \"tail\":1}}").as_str())
            );
            let refused = Parser {
                recover: parser.recover.without(kind),
                ..parser
            };
            let failed = refused.parse(token).expect_err("disabled kind must refuse");
            assert_eq!(
                failed.diagnostics.is_some(),
                diagnostics == DiagnosticsMode::On
            );
            match failed.failure {
                ParseFailure::PolicyRefused {
                    recovered: Some(value),
                    issue,
                } => {
                    assert_eq!(canonical_of(&value), expected);
                    assert_eq!(issue.refused, Some(kind));
                }
                failure => panic!("wrong refusal: {failure:?}"),
            }
            assert!(
                refused.repair(token).is_err(),
                "refused JSON cannot be success"
            );
        }
    }
}

#[test]
fn split_words_are_decided_only_when_the_token_ends() {
    for input in [
        "[True,None]",
        "[FALSE,NiL,NULL]",
        "[Trueish,NoneValue,nilx]",
    ] {
        for diagnostics in [DiagnosticsMode::Off, DiagnosticsMode::On] {
            for refused in [
                None,
                Some(SwitchableRepair::LiteralCase),
                Some(SwitchableRepair::NullAlias),
            ] {
                let mut parser = Parser {
                    diagnostics,
                    ..Parser::default()
                };
                if let Some(kind) = refused {
                    parser.recover = parser.recover.without(kind);
                }
                let expected = parser.parse(input);
                for split in 0..=input.len() {
                    let mut stream = StreamParser::new(parser.clone());
                    let mut items = Vec::new();
                    for chunk in [&input[..split], &input[split..]] {
                        for item in stream.feed(chunk) {
                            items.push(
                                item.map(|value| value.into_owned())
                                    .map_err(|value| value.into_owned()),
                            );
                        }
                    }
                    for item in stream.end() {
                        items.push(
                            item.map(|value| value.into_owned())
                                .map_err(|value| value.into_owned()),
                        );
                    }
                    assert_eq!(items.len(), 1, "{input} split at {split}");
                    match (&items[0], &expected) {
                        (Ok(actual), Ok(expected)) => {
                            assert_eq!(actual.value, expected.value);
                            assert_eq!(
                                actual
                                    .diagnostics
                                    .as_ref()
                                    .map(|d| (d.counts, d.confidence)),
                                expected
                                    .diagnostics
                                    .as_ref()
                                    .map(|d| (d.counts, d.confidence))
                            );
                        }
                        (Err(actual), Err(expected)) => {
                            match (&actual.failure, &expected.failure) {
                                (
                                    ParseFailure::PolicyRefused {
                                        recovered: actual,
                                        issue: a,
                                    },
                                    ParseFailure::PolicyRefused {
                                        recovered: expected,
                                        issue: e,
                                    },
                                ) => {
                                    assert_eq!(actual, expected);
                                    assert_eq!(a.refused, e.refused);
                                }
                                failures => panic!("wrong failures: {failures:?}"),
                            }
                        }
                        outcomes => panic!("{input} split at {split}: {outcomes:?}"),
                    }
                }
            }
        }
    }
}

#[test]
fn canonical_literals_quotes_keys_and_longer_words_keep_their_meaning() {
    let input =
        r#"{True:"None",nil:"FALSE",plain:[true,false,null],words:[Trueish,NoneValue,nilx]}"#;
    let parser = Parser {
        diagnostics: DiagnosticsMode::On,
        ..Parser::default()
    };
    let parsed = parser.parse(input).expect("ordinary keys and strings");
    assert_eq!(
        canonical_of(&parsed.value),
        r#"{"True":"None","nil":"FALSE","plain":[true,false,null],"words":["Trueish","NoneValue","nilx"]}"#
    );
    assert!(
        parsed
            .diagnostics
            .expect("requested report")
            .repairs
            .iter()
            .all(|repair| {
                !matches!(
                    repair.kind,
                    RepairKind::Switchable(
                        SwitchableRepair::LiteralCase | SwitchableRepair::NullAlias
                    )
                )
            })
    );
}
