//! Read numeric spellings and apply their recovery policy before building a value.

use crate::number;
use crate::scan::{ScanError, Scanner};
use crate::value::{JsonString, Number, Value};
use alloc::borrow::Cow;
use alloc::string::String;

/// Saved spelling owns released numeric units; an empty spelling leaves source with candidacy.
pub(crate) struct NumberState {
    pub(crate) start: usize,
    pub(crate) next: usize,
    pub(crate) raw: String,
}

impl<'a> Scanner<'a> {
    /// A number, as the source spelled it and as JSON would have.
    ///
    /// The extent and the meaning come from `crate::number`, which needs no scan state; what stays
    /// here is the DISPOSITION — whether the spelling in question is a repair or a refusal — and the
    /// edit that makes the repaired text spell what the tree holds.
    pub(super) fn number(&mut self) -> Result<Value<'a>, ScanError> {
        let start = self.at;
        let mut state = self.number_extent.take().unwrap_or(NumberState {
            start,
            next: start,
            raw: String::new(),
        });
        self.at = number::token_end_with(self.input.end(), start, state.next, |at| {
            if at < self.input.start() {
                state
                    .raw
                    .as_bytes()
                    .get(at - start)
                    .map_or(0, |unit| u32::from(*unit))
            } else {
                self.input.get(at).unwrap_or(0)
            }
        });
        // The token ran into the end of the input, so nothing delimited it. `12` becomes `123` and
        // `1e` becomes `1e5` with one more byte, and both are DIFFERENT numbers — a stream that
        // answered from the prefix would report a value the source never wrote.
        let pending_escape =
            self.peek() == Some(crate::chars::unit::BACKSLASH) && self.at + 1 == self.input.end();
        if (self.at == self.input.end() || pending_escape) && !self.input_ended() {
            // Keep the short opening probe until radix and negative-infinity ambiguity is gone.
            if !self.builder.stack.is_empty() && self.at - start >= 4 {
                let from = if state.raw.is_empty() {
                    start
                } else {
                    state.next
                };
                state.raw.push_str(&self.number_text(from, self.at)?);
            }
            state.next = self.at;
            self.number_extent = Some(state);
            return Err(self.pause_scalar(start));
        }
        let raw = if state.raw.is_empty() {
            self.number_text(start, self.at)?
        } else {
            state.raw.push_str(&self.number_text(state.next, self.at)?);
            Cow::Owned(state.raw)
        };
        let escaped = self.peek() == Some(crate::chars::unit::BACKSLASH)
            && self
                .input
                .get(self.at + 1)
                .is_some_and(crate::chars::is_delimiter);
        if start < self.input.start() && !crate::chars::ends_scalar(self.peek()) && !escaped {
            self.continue_number_as_word(start, self.at, raw.into_owned());
            let (word, end) = self.word(false)?;
            return Ok(self.decode_word(word, start, end));
        }
        let (value, kinds, edit) = match &raw {
            Cow::Borrowed(text) => {
                let read = number::read(text, self.options.exact_numbers);
                let edit = (read.text != *text).then_some(read.text);
                (read.value, read.kinds, edit)
            }
            Cow::Owned(text) => {
                let read = number::read(text, self.options.exact_numbers);
                let edit = (read.text != *text).then(|| Cow::Owned(read.text.into_owned()));
                (read.value.map(Number::into_owned), read.kinds, edit)
            }
        };
        for kind in kinds.into_iter().flatten() {
            self.lenient(kind, start);
        }
        let spelling = JsonString::Text(Cow::Owned(raw.clone().into_owned()));
        let value = match value {
            // Not a number: the token is the string the source wrote, quoted so the repaired text
            // says the same thing. Reading a prefix of it as a number would invent a value.
            None => {
                self.edit_quoted(start, self.at, &raw);
                Value::String(JsonString::Text(raw))
            }
            Some(value) => {
                if let Some(text) = edit {
                    self.edit(start, self.at, text);
                }
                Value::Number(value)
            }
        };
        self.fragment_bare(start, self.at, &value, spelling);
        Ok(value)
    }
}
