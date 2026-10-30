//! Numeric prefix repairs preserve digits and refuse independently, including across chunk splits.

use partial_json_repair::{DiagnosticsMode, ParseFailure, Parser, StreamParser, SwitchableRepair};

#[test]
fn repairs_preserve_digits_and_independent_policy() {
    for (raw, json, kinds) in [
        (".50", "0.50", &[SwitchableRepair::LeadingDotNumber][..]),
        ("-.0", "-0.0", &[SwitchableRepair::LeadingDotNumber][..]),
        ("+5", "5", &[SwitchableRepair::LeadingPlusNumber][..]),
        (
            "+.50E+2",
            "0.50E+2",
            &[
                SwitchableRepair::LeadingPlusNumber,
                SwitchableRepair::LeadingDotNumber,
            ][..],
        ),
        (
            "+9007199254740993",
            "9007199254740993",
            &[SwitchableRepair::LeadingPlusNumber][..],
        ),
        (
            ".1e-400",
            "0.1e-400",
            &[SwitchableRepair::LeadingDotNumber][..],
        ),
        (
            "+0x20000000000001",
            "9007199254740993",
            &[
                SwitchableRepair::LeadingPlusNumber,
                SwitchableRepair::HexNumber,
            ][..],
        ),
    ] {
        let parser = Parser {
            exact_numbers: true,
            diagnostics: DiagnosticsMode::On,
            ..Parser::default()
        };
        let input = format!("[ {raw} ]");
        let expected = parser.parse(json).expect("strict control").value;
        let parsed = parser.parse(raw).expect("numeric spelling");
        assert_eq!(parsed.value, expected);
        assert_eq!(
            parsed
                .diagnostics
                .expect("requested report")
                .repairs
                .iter()
                .map(|r| r.kind.as_str())
                .collect::<Vec<_>>(),
            kinds.iter().map(|k| k.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(
            parser
                .repair(input.as_str())
                .expect("repair")
                .value
                .as_str(),
            Some(format!("[ {json} ]").as_str())
        );
        for &kind in kinds {
            let refused = Parser {
                recover: parser.recover.without(kind),
                ..parser.clone()
            };
            match refused.parse(raw).expect_err("disabled kind").failure {
                ParseFailure::PolicyRefused {
                    recovered: Some(value),
                    issue,
                } => {
                    assert_eq!(value, expected);
                    assert_eq!(issue.refused, Some(kind));
                }
                other => panic!("wrong refusal: {other:?}"),
            }
        }
        for split in 0..=raw.len() {
            let mut stream = StreamParser::new(parser.clone());
            for chunk in [&raw[..split], &raw[split..]] {
                assert_eq!(stream.feed(chunk).count(), 0, "no delimiter yet");
            }
            let items: Vec<_> = stream.end().collect();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].as_ref().expect("complete root").value, expected);
        }
    }
}
