//! Character classification for the scanner: code-unit names, lookup tables and the state tags.
//!
//! Pure data with no scan state, kept apart from the scanner because it is a different job —
//! deciding what class a unit belongs to, rather than what to do about it.
//!
//! Every shape here is measured rather than chosen (`bench/primitives.bench.ts`, table in
//! `bench/AGENTS.md`): a byte-table lookup beats a regex test per character by 10.3x and a `match` by
//! 1.5x, and the tables are 128 entries because nothing above 0x7f is JSON whitespace or an escape,
//! so the bounds test doubles as the non-ASCII fast path.

/// Code units the grammar branches on. Named because a bare `0x7b` in a condition is unreadable.
pub mod unit {
    /// Horizontal tab.
    pub const TAB: u32 = 0x09;
    /// Line feed.
    pub const LF: u32 = 0x0a;
    /// Carriage return.
    pub const CR: u32 = 0x0d;
    /// Space.
    pub const SPACE: u32 = 0x20;
    /// `"`.
    pub const QUOTE: u32 = 0x22;
    /// `'`.
    pub const APOSTROPHE: u32 = 0x27;
    /// `*`.
    pub const STAR: u32 = 0x2a;
    /// `+`.
    pub const PLUS: u32 = 0x2b;
    /// `,`.
    pub const COMMA: u32 = 0x2c;
    /// `-`.
    pub const MINUS: u32 = 0x2d;
    /// `.`.
    pub const DOT: u32 = 0x2e;
    /// `/`.
    pub const SLASH: u32 = 0x2f;
    /// `0`.
    pub const ZERO: u32 = 0x30;
    /// `9`.
    pub const NINE: u32 = 0x39;
    /// `:`.
    pub const COLON: u32 = 0x3a;
    /// `A`.
    pub const UPPER_A: u32 = 0x41;
    /// `E`.
    pub const UPPER_E: u32 = 0x45;
    /// `F`.
    pub const UPPER_F: u32 = 0x46;
    /// `Z`.
    pub const UPPER_Z: u32 = 0x5a;
    /// `[`.
    pub const OPEN_BRACKET: u32 = 0x5b;
    /// `\`.
    pub const BACKSLASH: u32 = 0x5c;
    /// `]`.
    pub const CLOSE_BRACKET: u32 = 0x5d;
    /// `_`.
    pub const UNDERSCORE: u32 = 0x5f;
    /// `` ` ``.
    pub const BACKTICK: u32 = 0x60;
    /// `a`.
    pub const LOWER_A: u32 = 0x61;
    /// `b`.
    pub const LOWER_B: u32 = 0x62;
    /// `e`.
    pub const LOWER_E: u32 = 0x65;
    /// `f`.
    pub const LOWER_F: u32 = 0x66;
    /// `n`.
    pub const LOWER_N: u32 = 0x6e;
    /// `r`.
    pub const LOWER_R: u32 = 0x72;
    /// `t`.
    pub const LOWER_T: u32 = 0x74;
    /// `u`.
    pub const LOWER_U: u32 = 0x75;
    /// `x`.
    pub const LOWER_X: u32 = 0x78;
    /// `z`.
    pub const LOWER_Z: u32 = 0x7a;
    /// `{`.
    pub const OPEN_BRACE: u32 = 0x7b;
    /// `}`.
    pub const CLOSE_BRACE: u32 = 0x7d;
}

use unit::{
    CLOSE_BRACE, CLOSE_BRACKET, COLON, COMMA, CR, LF, LOWER_A, LOWER_F, LOWER_Z, MINUS, NINE,
    OPEN_BRACE, OPEN_BRACKET, PLUS, QUOTE, SLASH, SPACE, TAB, UNDERSCORE, UPPER_A, UPPER_F,
    UPPER_Z, ZERO,
};

/// Builds a 128-entry class table at compile time. `const` rather than a lazily built array so the
/// tables cost no initialisation and live in the binary's read-only data.
const fn table(members: &[u32]) -> [bool; 128] {
    let mut t = [false; 128];
    let mut i = 0;
    while i < members.len() {
        t[members[i] as usize] = true;
        i += 1;
    }
    t
}

/// JSON's whitespace is exactly these four; anything above 0x7f is not whitespace to this grammar.
const WS: [bool; 128] = table(&[SPACE, TAB, LF, CR]);

/// Characters that end a bare word wherever one is read: the structural delimiters, plus a line
/// break, which ends one even inside a value where an ordinary space does not.
///
/// A double quote ends one because `{a: b"c"}` is two tokens the source spelled separately. An
/// apostrophe does NOT: `don't` is one word, and splitting it would lose the rest of the value.
const WORD_END: [bool; 128] = table(&[
    LF,
    CR,
    COMMA,
    QUOTE,
    OPEN_BRACE,
    CLOSE_BRACE,
    OPEN_BRACKET,
    CLOSE_BRACKET,
]);

/// Characters that may legally FOLLOW a completed scalar token.
///
/// Anything else means the token was never a scalar of that kind: `1_000` is not the number 1 with
/// junk after it, it is one damaged token, and reading it as `1` hands back a number the source
/// never wrote while `_000` goes on to become an invented key that swallows the member after it.
/// A slash counts, so a comment straight after a number still ends it.
const SCALAR_END: [bool; 128] = {
    let mut t = [false; 128];
    let mut i = 0;
    while i < 128 {
        t[i] = WORD_END[i] || WS[i];
        i += 1;
    }
    t[COLON as usize] = true;
    t[SLASH as usize] = true;
    t
};

/// Whether this unit is JSON whitespace.
#[must_use]
pub fn is_ws(c: u32) -> bool {
    (c as usize) < 128 && WS[c as usize]
}

/// ECMAScript spacing outside JSON's four whitespace characters, matching the TypeScript reader.
#[must_use]
pub fn is_extra_whitespace(c: u32) -> bool {
    matches!(
        c,
        0x0b | 0x0c | 0xa0 | 0x1680 | 0x2000
            ..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// Width of a non-JSON whitespace character at the byte boundary; no whole-input decoding.
#[must_use]
pub fn extra_whitespace_len(input: &[u8]) -> usize {
    let width = match input.first() {
        Some(0x0b | 0x0c) => return 1,
        Some(0xc2) => 2,
        Some(0xe1..=0xe3 | 0xef) => 3,
        _ => return 0,
    };
    input
        .get(..width)
        .and_then(|bytes| core::str::from_utf8(bytes).ok())
        .and_then(|text| text.chars().next())
        .filter(|&c| is_extra_whitespace(u32::from(c)))
        .map_or(0, |_| width)
}

/// Whether this unit ends a bare word.
#[must_use]
pub fn ends_word(c: u32) -> bool {
    (c as usize) < 128 && WORD_END[c as usize]
}

/// Whether this unit may follow a completed scalar. `None` — past the end of input — counts:
/// nothing following a token cannot contradict it.
#[must_use]
pub fn ends_scalar(c: Option<u32>) -> bool {
    match c {
        None => true,
        Some(c) => (c as usize) >= 128 || SCALAR_END[c as usize] || is_extra_whitespace(c),
    }
}

/// Whether this unit ends a member. Used only by the quote-mismatch lookahead, where it is what
/// separates a real quote-style switch from an apostrophe inside ordinary prose.
#[must_use]
pub fn is_separator(c: u32) -> bool {
    matches!(c, COMMA | COLON | CLOSE_BRACE | CLOSE_BRACKET)
}

/// Structural punctuation can follow a stray escape between tokens.
#[must_use]
pub fn is_delimiter(c: u32) -> bool {
    is_separator(c) || matches!(c, unit::OPEN_BRACE | unit::OPEN_BRACKET)
}

/// The character a single-character escape stands for, or `None` when the escape is not one.
#[must_use]
pub fn escape(c: u32) -> Option<u32> {
    match c {
        QUOTE => Some(QUOTE),
        unit::BACKSLASH => Some(unit::BACKSLASH),
        SLASH => Some(SLASH),
        unit::LOWER_B => Some(0x08),
        unit::LOWER_F => Some(0x0c),
        unit::LOWER_N => Some(LF),
        unit::LOWER_R => Some(CR),
        unit::LOWER_T => Some(TAB),
        _ => None,
    }
}

/// Value of a hex digit, or `None`. Range comparisons rather than a table: three branches, no
/// memory touched.
#[must_use]
pub fn hex_value(c: u32) -> Option<u32> {
    match c {
        ZERO..=NINE => Some(c - ZERO),
        LOWER_A..=LOWER_F => Some(c - LOWER_A + 10),
        UPPER_A..=UPPER_F => Some(c - UPPER_A + 10),
        _ => None,
    }
}

/// Value of a digit in any base up to 16, or 99 — which is below no radix, so it always stops a run.
#[must_use]
pub fn digit_value(c: u32) -> u32 {
    hex_value(c).unwrap_or(99)
}

/// Whether this unit belongs to a fenced block's info string (the ` ```json ` after the ticks).
///
/// The info string runs to end of line in Markdown, but a model writes ` ```js{"a":1} ` often
/// enough that consuming the rest of the line would swallow the value it was announcing. A language
/// name is a bare word, so the word is what gets consumed and the content starts where it stops.
#[must_use]
pub fn is_info_char(c: u32) -> bool {
    matches!(c, LOWER_A..=LOWER_Z | UPPER_A..=UPPER_Z | ZERO..=NINE)
        || matches!(c, MINUS | PLUS | UNDERSCORE)
}

/// What the scanner is waiting for. The grammar is small enough that these four cover it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Expect {
    /// A value, at the root or after a comma or colon.
    Value,
    /// An object key, or the closer of an empty object.
    Key,
    /// The colon between a key and its value.
    Colon,
    /// A comma or a closer, after a completed member.
    After,
}

/// The other quote character: JSON's own for an apostrophe, and the apostrophe for JSON's.
///
/// Only quote-mismatch asks, and it asks about the character a string did NOT open with — the one
/// whose appearance where a closer belongs makes two readings of the same bytes possible.
#[must_use]
pub const fn flip(quote: u32) -> u32 {
    match quote {
        unit::QUOTE => unit::APOSTROPHE,
        _ => unit::QUOTE,
    }
}
