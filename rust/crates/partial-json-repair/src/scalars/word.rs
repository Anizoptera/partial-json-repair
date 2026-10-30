//! Read unquoted tokens with grammar-dependent delimiters and lossless text decoding.

use super::TextMode;
use crate::chars::{ends_word, is_delimiter, is_extra_whitespace, is_ws, unit};
use crate::report::SwitchableRepair;
use crate::scan::{ScanError, Scanner, Units};
use crate::value::JsonString;
use alloc::borrow::Cow;
use alloc::vec::Vec;

/// Decoded prefixes survive source release; trailing whitespace remains undecided until a delimiter.
pub(crate) struct WordState<'a> {
    pub(crate) start: usize,
    pub(crate) next: usize,
    pub(crate) first: u32,
    pub(crate) issues_start: usize,
    pub(crate) space_at: Option<usize>,
    out: Option<JsonString<'a>>,
    end: usize,
    after_space: bool,
    /// Only repair-text calls need each original whitespace span; ordinary streams retain none.
    spaces: Vec<(usize, usize)>,
}

impl WordState<'_> {
    fn into_owned(self) -> WordState<'static> {
        WordState {
            start: self.start,
            next: self.next,
            first: self.first,
            issues_start: self.issues_start,
            space_at: self.space_at,
            out: self.out.map(JsonString::into_owned),
            end: self.end,
            after_space: self.after_space,
            spaces: self.spaces,
        }
    }
}

impl<'a> Scanner<'a> {
    /// Transfer released numeric spelling into the word reader without decoding or copying it.
    pub(super) fn continue_number_as_word(
        &mut self,
        start: usize,
        next: usize,
        raw: alloc::string::String,
    ) {
        self.word = Some(WordState {
            start,
            next,
            first: raw.as_bytes().first().map_or(0, |unit| u32::from(*unit)),
            issues_start: self.issues().len(),
            space_at: None,
            out: Some(JsonString::Text(Cow::Owned(raw))),
            end: next,
            after_space: false,
            spaces: Vec::new(),
        });
    }

    /// Only these rejected numeric prefixes can become numeric after more input arrives.
    pub(super) fn numeric_may_continue(&self, start: usize) -> bool {
        let length = self.input.end() - start;
        let infinity = length <= super::NEGATIVE_INFINITY.len()
            && super::NEGATIVE_INFINITY
                .iter()
                .take(length)
                .enumerate()
                .all(|(offset, byte)| self.input.get(start + offset) == Some(u32::from(*byte)));
        let digits = start
            + usize::from(matches!(
                self.input.get(start),
                Some(unit::PLUS | unit::MINUS)
            ));
        let radix = self.input.end() == digits + 2
            && self.input.get(digits) == Some(unit::ZERO)
            && matches!(
                self.input.get(digits + 1).map(|unit| unit | 0x20),
                Some(unit::LOWER_X | unit::LOWER_B)
            );
        let escape =
            self.input.get(self.at) == Some(unit::BACKSLASH) && self.at + 1 == self.input.end();
        infinity || radix || escape
    }

    /// A bare word — text the source did not quote.
    ///
    /// `structural` says the word sits where the grammar is still being DECIDED: at the root, or in
    /// key position. There a space or a colon ends it. Inside an established container's VALUE
    /// position both are ordinary content — `{a: John Doe, b: 1}` is one member, and ending at the
    /// space instead invents the key `Doe`, whose value then swallows `b:` and destroys the member
    /// after it. Conservative where candidacy is in question, forgiving once it is settled. A line
    /// break ends a word either way, so a missing comma between members cannot run one value into
    /// the next.
    ///
    /// The position is left at the break; only the VALUE is trimmed, because trailing space is
    /// layout rather than content — `{a: John Doe , b: 1}` holds the same value as without it.
    pub(crate) fn word(&mut self, structural: bool) -> Result<(JsonString<'a>, usize), ScanError> {
        let mut state = self.word.take().unwrap_or(WordState {
            start: self.at,
            next: self.at,
            first: self.peek().unwrap_or(0),
            issues_start: self.issues().len(),
            space_at: None,
            out: None,
            end: self.at,
            after_space: false,
            spaces: Vec::new(),
        });
        self.at = state.next;
        let part_start = self.at;
        let mut waiting = false;
        while let Some(c) = self.peek() {
            let extra = self.input.whitespace(self.at);
            if ends_word(c) || (structural && (is_ws(c) || extra != 0 || c == unit::COLON)) {
                break;
            }
            if c == unit::BACKSLASH {
                match self.input.get(self.at + 1) {
                    None if !self.input_ended() => {
                        waiting = true;
                        break;
                    }
                    Some(next) if is_delimiter(next) && (structural || next != unit::COLON) => {
                        break;
                    }
                    _ => {}
                }
            }
            // A comment is a delimiter, so `{a: undefined // note}` holds `undefined`, not the note.
            // Only after whitespace: a `//` with no space before it is inside the value the source
            // wrote, which is what keeps `{url: http://example.test}` whole.
            if c == unit::SLASH && state.after_space {
                match self.input.get(self.at + 1) {
                    Some(unit::SLASH | unit::STAR) => break,
                    None if !self.input_ended() => {
                        waiting = true;
                        break;
                    }
                    _ => {}
                }
            }
            state.after_space = is_ws(c) || extra != 0;
            self.at += extra.max(1);
        }
        // Nothing delimited this word: it ran into the end of the input. A stream must wait, since
        // `tru` becomes `true` and `nul` becomes `null` with one more byte — judging the prefix
        // would answer about a word the source has not finished writing.
        waiting |= self.peek().is_none() && !self.input_ended();
        let root = self.builder.stack.is_empty();
        // Root candidacy still needs source. Keep only its cursor while waiting, then decode once;
        // banking decoded chunks as well would retain the same undecided root twice.
        if root && waiting {
            state.next = self.at;
        } else {
            let from = if root { state.start } else { part_start };
            self.bank_word(&mut state, from)?;
        }
        if waiting {
            let start = state.start;
            self.word = Some(state.into_owned());
            return Err(self.pause_scalar(start));
        }
        Ok(self.finish_word(state))
    }

    /// Decode each decided run once; keep source positions only for its still-trailing whitespace.
    fn bank_word(&mut self, state: &mut WordState<'a>, from: usize) -> Result<(), ScanError> {
        if from == self.at {
            return Ok(());
        }
        let (piece, end) = self.word_piece(from)?;
        if end > from {
            state.end = end;
            state.space_at = None;
            state.spaces.clear();
        }
        let mut at = end;
        while at < self.at {
            let width = self.input.whitespace(at);
            if width != 0 {
                state.space_at.get_or_insert(at);
                if self.records_edits() {
                    state.spaces.push((at, at + width));
                }
            }
            at += width.max(1);
        }
        state.after_space = end < self.at;
        state.next = self.at;
        super::quoted::append(&mut state.out, piece);
        Ok(())
    }

    /// A delimiter settles whitespace once, after all chunks have contributed their content.
    fn finish_word(&mut self, state: WordState<'a>) -> (JsonString<'a>, usize) {
        if let Some(at) = state.space_at {
            self.lenient(SwitchableRepair::NonJsonWhitespace, at);
            for (at, end) in state.spaces {
                self.edit(at, end, Cow::Borrowed(" "));
            }
        }
        let out = state.out.unwrap_or(JsonString::Text(Cow::Borrowed("")));
        let out = match out {
            JsonString::Text(text) => {
                let end = text
                    .trim_end_matches(|c: char| {
                        is_ws(u32::from(c)) || is_extra_whitespace(u32::from(c))
                    })
                    .len();
                JsonString::Text(match text {
                    Cow::Borrowed(text) => Cow::Borrowed(&text[..end]),
                    Cow::Owned(mut text) => {
                        text.truncate(end);
                        Cow::Owned(text)
                    }
                })
            }
            JsonString::Units(units) => {
                let end = units
                    .iter()
                    .rposition(|&c| !is_ws(u32::from(c)) && !is_extra_whitespace(u32::from(c)))
                    .map_or(0, |last| last + 1);
                JsonString::Units(match units {
                    Cow::Borrowed(units) => Cow::Borrowed(&units[..end]),
                    Cow::Owned(mut units) => {
                        units.truncate(end);
                        Cow::Owned(units)
                    }
                })
            }
        };
        (out, state.end)
    }

    /// Return raw decoded content and the original-unit end of its non-whitespace prefix.
    fn word_piece(&mut self, start: usize) -> Result<(JsonString<'a>, usize), ScanError> {
        if let Units::Utf16(input) = self.input.slice(start..self.at) {
            let mut end = input.len();
            while end > 0
                && (is_ws(u32::from(input[end - 1]))
                    || is_extra_whitespace(u32::from(input[end - 1])))
            {
                end -= 1;
            }
            return Ok((JsonString::Units(Cow::Borrowed(input)), start + end));
        }
        if let Units::Mixed(input) = self.input.slice(start..self.at) {
            return self.mixed_text(input, start, self.at, TextMode::Bare);
        }
        if let Units::Joined(..) = self.input.slice(start..self.at) {
            let source = self.input.slice(start..self.at);
            let input = source.encoded();
            let (text, end) = self.mixed_text(&input, start, self.at, TextMode::Bare)?;
            return Ok((super::joined_text(source, text), end));
        }
        let raw = self.decode_text(start, self.at, TextMode::Bare)?;
        let word = raw
            .trim_end_matches(|c: char| is_ws(u32::from(c)) || is_extra_whitespace(u32::from(c)));
        let length = word.len();
        // Replacement bytes change decoded length; only the unchanged whitespace tail maps back
        // directly to source bytes. Repair edits must end at the original token boundary.
        let end = self.at - (raw.len() - length);
        Ok((JsonString::Text(raw), end))
    }
}
