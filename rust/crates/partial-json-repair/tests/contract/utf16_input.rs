//! Public calls preserve UTF-16 source and report positions in each input's original units.

use partial_json_repair::report::Unit;
use partial_json_repair::{
    JsonString, ParseFailure, Parser, PathSegment, SwitchableRepair, Value, find_json_span, parse,
    repair,
};

#[test]
fn unchanged_native_text_and_values_borrow_original_units() {
    let input = [0x22, 0xd800, 0x61, 0xdc00, 0x22];
    let result = parse(input.as_slice()).expect("lossless native input");
    let Value::String(JsonString::Units(text)) = result.value else {
        panic!("expected native string")
    };
    assert_eq!(text.as_ptr(), input[1..].as_ptr());
    assert_eq!(text.as_ref(), &input[1..4]);
    let JsonString::Units(text) = repair(input.as_slice()).expect("unchanged repair").value else {
        panic!("expected native text")
    };
    assert_eq!(text.as_ptr(), input.as_ptr());
    assert_eq!(text.as_ref(), input);
}

#[test]
fn native_repairs_and_refusals_preserve_lone_units() {
    let input = [0x5b, 0x20, 0xd800, 0x20, 0x5d];
    let repaired = repair(input.as_slice()).expect("quote bare unit");
    assert_eq!(
        repaired.value.code_units().collect::<Vec<_>>(),
        "[ \"\\ud800\" ]".encode_utf16().collect::<Vec<_>>()
    );
    let mut parser = Parser::default();
    parser.recover = parser.recover.without(SwitchableRepair::UnquotedString);
    let failed = parser.parse(input.as_slice()).expect_err("policy refusal");
    let ParseFailure::PolicyRefused { issue, .. } = failed.failure else {
        panic!("expected policy refusal")
    };
    assert_eq!(issue.at.offset, 2);
    assert_eq!(issue.context.code_units().collect::<Vec<_>>(), input);
}

#[test]
fn public_positions_follow_the_input_alphabet() {
    let text = "[\"😀\"]";
    let units: Vec<_> = text.encode_utf16().collect();
    for result in [find_json_span(text), find_json_span(text.as_bytes())] {
        let span = result.expect("UTF-8 source").value;
        assert_eq!(span.end.offset, text.len());
        assert_eq!(span.end.unit, Unit::Byte);
    }
    let span = find_json_span(units.as_slice())
        .expect("UTF-16 source")
        .value;
    assert_eq!(span.end.offset, units.len());
    assert_eq!(span.end.unit, Unit::Utf16);
}

#[test]
fn selected_native_repair_excludes_ancestor_edits() {
    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key("😀".into())]])
        .expect("selector");
    let input: Vec<_> = "{😀:[1,2".encode_utf16().collect();
    let result = parser.repair(input.as_slice()).expect("selected repair");
    assert_eq!(result.value.len(), 1);
    assert_eq!(
        result.value[0].value.code_units().collect::<Vec<_>>(),
        "[1,2]".encode_utf16().collect::<Vec<_>>()
    );
    assert_eq!(result.value[0].span.start.offset, 4);
}
