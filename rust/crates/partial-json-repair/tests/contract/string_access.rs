//! String access must preserve code units and never present lone surrogates as valid UTF-8.

use partial_json_repair::{JsonString, Object, Value, parse};

#[test]
fn keys_compare_by_content_across_encodings() {
    for (width, units_first) in [(0, false), (0, true), (32, false), (32, true)] {
        let mut object = Object::new(false);
        for n in 0..width {
            object.insert(JsonString::Text(format!("k{n}").into()), Value::Null);
        }
        for text in ["", "ascii", "é", "\u{d7ff}", "\u{e000}", "😀"] {
            let units: Vec<_> = text.encode_utf16().collect();
            let utf8 = JsonString::from(text);
            let utf16 = JsonString::from(units.as_slice());
            assert_eq!(utf8, utf16);
            assert_eq!(utf8.cmp(&utf16), core::cmp::Ordering::Equal);
            let utf16 = utf16.into_owned();
            let (first, last) = if units_first {
                (utf16, utf8)
            } else {
                (utf8, utf16)
            };
            object.insert(first, Value::Bool(false));
            object.insert(last, Value::Bool(true));
            assert_eq!(object.get(text), Some(&Value::Bool(true)));
            assert_eq!(object.get(units.as_slice()), Some(&Value::Bool(true)));
        }
        assert_eq!(object.entries().len(), width + 6);
        for units in [[0xd800], [0xdfff]] {
            object.insert(
                JsonString::from(units.as_slice()).into_owned(),
                Value::Bool(true),
            );
            assert_eq!(object.get(units.as_slice()), Some(&Value::Bool(true)));
        }
        assert_eq!(object.get("missing"), None);
        assert_eq!(object.get([0xfffd].as_slice()), None);
    }
}

#[test]
fn string_access_preserves_pairs_and_lone_surrogates() {
    for (source, text, units) in [
        ("\"A😀\"", Some("A😀"), [0x41, 0xd83d, 0xde00].as_slice()),
        (
            r#""\ud800😀\udfff""#,
            None,
            [0xd800, 0xd83d, 0xde00, 0xdfff].as_slice(),
        ),
        ("\"\"", Some(""), [].as_slice()),
    ] {
        let Value::String(value) = parse(source).expect("recover string").value else {
            panic!("expected a string");
        };
        assert_eq!(value.as_str(), text);
        assert_eq!(value.code_units().collect::<Vec<_>>(), units);
        if let Some(text) = value.as_str() {
            assert_eq!(text.as_ptr(), source.as_bytes()[1..].as_ptr());
        }
        assert_eq!(value.into_owned().code_units().collect::<Vec<_>>(), units);
    }
}

#[test]
fn utf16_borrows_until_owned_conversion() {
    let units = vec![0xd800, 0xd83d, 0xde00, 0xdfff];
    let value = JsonString::from(units.as_slice());
    let JsonString::Units(storage) = &value else {
        panic!("expected UTF-16 storage")
    };
    assert_eq!(storage.as_ptr(), units.as_ptr());
    let owned = value.into_owned();
    drop(units);
    assert_eq!(
        owned.code_units().collect::<Vec<_>>(),
        [0xd800, 0xd83d, 0xde00, 0xdfff]
    );
}
