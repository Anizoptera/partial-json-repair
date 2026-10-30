//! Native UTF-16 scanning preserves source units while sharing byte-input recovery decisions.

use partial_json_repair::{
    DangerousKeyPolicy, JsonString, Parser, PathSegment, Scanner, Value, canonical_of,
};

#[test]
fn native_units_match_byte_scanning_without_byte_aliases() {
    let parser = Parser::default();
    for text in [
        "[true,FALSE,None,undefined,NaN,-Infinity,1e999,+.5,0x2a]",
        "{a:John Doe , b:'x\\ny', c:\"\\ud800\\t😀\"}",
        "\u{feff}{\"a\": [1,2",
        "[İ,ś,Ġ]",
        "[\u{2000}42\u{3000}]",
        "[abc\u{2000}]",
        "/* text */{\"😀\":1,\"😀\":2}",
    ] {
        let units: Vec<_> = text.encode_utf16().collect();
        let bytes = Scanner::new(text.as_bytes(), &parser).parse().expect(text);
        let native = Scanner::from_utf16(&units, &parser).parse().expect(text);
        assert_eq!(canonical_of(&native), canonical_of(&bytes), "{text}");
    }
}

#[test]
fn lone_units_are_borrowed_and_never_replaced() {
    let parser = Parser::default();
    let source = [0x22, 0xd800, 0x61, 0xdc00, 0x22];
    let Value::String(JsonString::Units(value)) = Scanner::from_utf16(&source, &parser)
        .parse()
        .expect("raw units")
    else {
        panic!("expected lossless string");
    };
    assert_eq!(value.as_ptr(), source[1..].as_ptr());
    assert_eq!(value.as_ref(), &source[1..4]);
    let source = [0x5b, 0xd800, 0x5d];
    assert_eq!(
        canonical_of(
            &Scanner::from_utf16(&source, &parser)
                .parse()
                .expect("bare lone unit")
        ),
        "[\"\\ud800\"]"
    );
}

#[test]
fn key_policies_and_selection_use_text_not_storage_encoding() {
    let parser = Parser {
        on_dangerous_key: DangerousKeyPolicy::Drop,
        custom_dangerous_keys: vec!["😀".into()],
        skip: vec![
            vec![PathSegment::Key("skip".into())],
            vec![PathSegment::Key("𐐀".into())],
        ],
        ..Parser::default()
    };
    let input: Vec<_> = "{__proto__:1,😀:2,skip:3,𐐀:5,keep:4}"
        .encode_utf16()
        .collect();
    let mut scan = Scanner::from_utf16(&input, &parser)
        .with_selection(parser.selection().expect("valid selector"));
    assert_eq!(
        canonical_of(&scan.parse().expect("filtered object")),
        "{\"keep\":4}"
    );
}

#[test]
fn configured_keys_preserve_lone_utf16_units() {
    let key = JsonString::from(vec![0xd800]);
    let input = r#"{"\ud800":1,"keep":2}"#;

    let parser = Parser::default()
        .select(vec![vec![PathSegment::Key(key.clone())]])
        .expect("lossless selector");
    let selected = parser.parse(input).expect("selected value");
    assert_eq!(selected.value.len(), 1);
    assert_eq!(canonical_of(&selected.value[0].path), r#"["\ud800"]"#);
    assert_eq!(canonical_of(&selected.value[0].value), "1");

    let required = Parser {
        required_keys: vec![key.clone()],
        ..Parser::default()
    };
    assert!(required.parse(input).is_ok(), "lossless root filter");

    let dangerous = Parser {
        on_dangerous_key: DangerousKeyPolicy::Drop,
        custom_dangerous_keys: vec![key],
        ..Parser::default()
    };
    assert_eq!(
        canonical_of(&dangerous.parse(input).expect("lossless key policy").value),
        r#"{"keep":2}"#
    );
}
