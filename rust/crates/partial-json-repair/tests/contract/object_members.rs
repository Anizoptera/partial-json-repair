//! Duplicate handling must not change when an object crosses the size at which the builder swaps a
//! linear scan for an index.
//!
//! The threshold is an internal acceleration, so it is exactly the kind of boundary a corpus of
//! small documents cannot see: the recorded inputs have a median of 25 bytes, so every one of them
//! takes the linear path and the indexed path would ship untested. These cases sit on both sides of
//! it deliberately.

use partial_json_repair::{Parser, Scanner, canonical_of};

fn parse(src: &str) -> String {
    let options = Parser::default();
    canonical_of(
        &Scanner::new(src.as_bytes(), &options)
            .parse()
            .expect("input is well-formed JSON"),
    )
}

/// `HLD.md`: the LAST value of a duplicate key wins, and it wins at the FIRST position — which is
/// what `obj[k] = v` does in JavaScript, and the half that is easy to lose by pushing instead.
#[test]
fn last_duplicate_wins_at_first_position_on_both_paths() {
    // Below the threshold: the linear scan decides.
    assert_eq!(parse(r#"{"a":1,"b":2,"a":3}"#), r#"{"a":3,"b":2}"#);

    // Across the threshold: the duplicate arrives after the index has been built, and the key it
    // replaces was placed before it existed. Getting the handover wrong moves the member.
    let mut wide = String::from("{");
    for k in 0..40 {
        wide.push_str(&format!("\"k{k}\":{k},"));
    }
    wide.push_str("\"k0\":999}");
    let parsed = parse(&wide);
    assert!(
        parsed.starts_with(r#"{"k0":999,"k1":1,"#),
        "duplicate must overwrite in place, got {parsed}"
    );
    assert_eq!(
        parsed.matches("\"k0\"").count(),
        1,
        "the key must appear once, got {parsed}"
    );
}

/// A duplicate of a key that was itself inserted AFTER the index existed.
///
/// The case the two above cannot see: they duplicate early keys, which the index's initial build
/// captured, so an index that stopped recording later insertions still answers them correctly. A
/// mutation that did exactly that left both of them green, which is how this case came to exist.
#[test]
fn a_key_added_after_the_index_is_still_deduplicated() {
    let mut src = String::from("{");
    for k in 0..40 {
        src.push_str(&format!("\"k{k}\":{k},"));
    }
    // `k30` was placed long after the index was built from the first members.
    src.push_str("\"k30\":555}");
    let parsed = parse(&src);
    assert_eq!(
        parsed.matches("\"k30\"").count(),
        1,
        "a late key was duplicated rather than overwritten: {parsed}"
    );
    assert!(
        parsed.contains(r#""k30":555"#),
        "a late duplicate kept the wrong value: {parsed}"
    );
}

/// A duplicate landing exactly at the handover, where one insertion scans linearly and the next
/// consults an index built from the entries that scan produced.
#[test]
fn the_threshold_itself_is_not_a_seam() {
    for width in 14..20 {
        let mut src = String::from("{");
        for k in 0..width {
            src.push_str(&format!("\"k{k}\":{k},"));
        }
        src.push_str("\"k3\":777}");
        let parsed = parse(&src);
        assert_eq!(
            parsed.matches("\"k3\"").count(),
            1,
            "width {width} duplicated a key: {parsed}"
        );
        assert!(
            parsed.contains(r#""k3":777"#),
            "width {width} kept the wrong value: {parsed}"
        );
    }
}
