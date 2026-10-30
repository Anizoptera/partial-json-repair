//! Repair edits must preserve source offsets and the retained candidate's member boundaries.

use partial_json_repair::{DangerousKeyPolicy, Parser, PathSegment};

#[test]
fn discarded_invalid_bytes_do_not_erase_repair_source() {
    let parser = Parser::default();
    for (input, expected) in [
        (b"/*\x81*/42".as_slice(), "42"),
        (b"/*\x81*/[42".as_slice(), "[42]"),
    ] {
        assert_eq!(
            parser
                .repair(input)
                .expect("recover candidate")
                .value
                .as_str(),
            Some(expected)
        );
    }
    let selected = parser
        .select(vec![vec![PathSegment::Key("a".into())]])
        .expect("valid selector");
    let result = selected
        .repair(b"/*\x81*/{\"a\":[42".as_slice())
        .expect("recover selected candidate");
    assert_eq!(result.value.len(), 1);
    assert_eq!(result.value[0].value.as_str(), Some("[42]"));
}

#[test]
fn nested_drops_keep_valid_member_boundaries() {
    let parser = Parser {
        on_dangerous_key: DangerousKeyPolicy::Drop,
        custom_dangerous_keys: vec!["drop".into()],
        ..Parser::default()
    };
    for (input, expected) in [
        (r#"{"keep":1,"drop":[1,2]}"#, r#"{"keep":1}"#),
        (r#"{"drop":[1,2],"keep":1}"#, r#"{"keep":1}"#),
        (r#"{"a":1,"drop":{"x":1,"y":2},"b":2}"#, r#"{"a":1,"b":2}"#),
        (
            r#"{"keep":1,"nested":{"drop":2}}"#,
            r#"{"keep":1,"nested":{}}"#,
        ),
        (r#"{"drop":[1,2],"drop":[3,4],"keep":1}"#, r#"{"keep":1}"#),
        (r#"{"keep":1,"drop":[1,2"#, r#"{"keep":1}"#),
    ] {
        assert_eq!(
            parser.repair(input).expect(input).value.as_str(),
            Some(expected),
            "{input}"
        );
    }
}
