//! Decode source units and apply one malformed-byte policy in their original coordinates.

use super::TextMode;
use crate::chars::{is_extra_whitespace, is_ws};
use crate::scan::mixed::{EncodedUnit, decode};
use crate::scan::{IssueKind, ScanError, ScanErrorKind, Scanner, Units};
use crate::value::JsonString;
use alloc::borrow::Cow;
use alloc::vec::Vec;

impl Scanner<'_> {
    /// Source offsets and decoded string offsets differ after UTF-8 decoding; convert only when
    /// an active fragment has already delivered part of this run.
    pub(super) fn fragment_text(&mut self, start: usize, end: usize, text: &JsonString<'_>) {
        let Some(emitted) = self.builder.fragment_source() else {
            return;
        };
        if end <= emitted {
            return;
        }
        let until = emitted.max(start);
        let from = match self.input.slice(start..until) {
            Units::Utf16(_) => until - start,
            Units::Bytes(_) if matches!(text, JsonString::Text(Cow::Borrowed(_))) => until - start,
            Units::Bytes(bytes) => bytes
                .utf8_chunks()
                .map(|chunk| chunk.valid().len() + 3 * usize::from(!chunk.invalid().is_empty()))
                .sum(),
            Units::Mixed(units) => {
                let (mut at, mut count) = (0, 0);
                while let Some(decoded) = decode(&units[at..]) {
                    count += 1 + usize::from(decoded.value > 0xffff);
                    at += decoded.width;
                }
                count
            }
            Units::Joined(..) => {
                let input = self.input.slice(start..until);
                let (mut at, mut count) = (0, 0);
                while let Some(decoded) = input.decode(at) {
                    count += 1 + usize::from(decoded.value > 0xffff);
                    at += decoded.width;
                }
                count
            }
        };
        self.builder.fragment_text(from, end, text);
    }

    /// Native surrogates are data; malformed byte runs spend the same decoder budget as byte input.
    pub(super) fn mixed_text(
        &mut self,
        input: &[EncodedUnit],
        start: usize,
        end: usize,
        mode: TextMode,
    ) -> Result<(JsonString<'static>, usize), ScanError> {
        let mut text = Vec::new();
        let (mut at, mut kept_end) = (start, start);
        while let Some(decoded) = decode(&input[at - start..end - start]) {
            let stopped = decoded.invalid && self.invalid_utf8(at, at + decoded.width, mode)?;
            if mode != TextMode::Discard {
                decoded.append_to(&mut text);
            }
            at += decoded.width;
            if !is_ws(decoded.value) && !is_extra_whitespace(decoded.value) {
                kept_end = at;
            }
            if stopped {
                self.decode_stopped = true;
                self.at = at;
                break;
            }
        }
        if mode != TextMode::Bare {
            kept_end = at;
        }
        Ok((JsonString::Units(Cow::Owned(text)), kept_end))
    }

    /// Bare tokens may finish one further decoder piece; strings and trivia stop at the budget.
    pub(super) fn invalid_utf8(
        &mut self,
        at: usize,
        end: usize,
        mode: TextMode,
    ) -> Result<bool, ScanError> {
        let stopped = self.budget_spent();
        self.record_issue(IssueKind::InvalidUtf8 { end }, at);
        if self.budget_spent() && mode != TextMode::Bare {
            return Err(ScanError {
                kind: ScanErrorKind::DecodeBudget,
                at,
                path: crate::builder::path_of(&self.builder.stack),
            });
        }
        Ok(stopped)
    }
}
