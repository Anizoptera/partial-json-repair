//! Keep input encoding and source-position conversion together.

use crate::options::Parser;
use crate::outcome::Encoding;
use crate::report::{CONTEXT_RADIUS, Position, Span, Unit};
use crate::scan::{Scanner, Units};
use crate::value::JsonString;
use alloc::borrow::Cow;
use alloc::string::String;
use alloc::vec::Vec;

/// Borrow original input: Rust text and UTF-8 use byte offsets; UTF-16 uses code-unit offsets.
#[derive(Clone, Copy, Debug)]
pub enum Input<'a> {
    /// Rust text. Positions come back in bytes.
    Text(&'a str),
    /// UTF-8 bytes. Positions come back in bytes.
    Bytes(&'a [u8]),
    /// Native UTF-16. Positions index the original code units, including lone surrogates.
    Utf16(&'a [u16]),
}

impl<'a> Input<'a> {
    pub(crate) fn units(self) -> Units<'a> {
        match self {
            Self::Text(text) => Units::Bytes(text.as_bytes()),
            Self::Bytes(bytes) => Units::Bytes(bytes),
            Self::Utf16(units) => Units::Utf16(units),
        }
    }

    pub(crate) fn len(self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Bytes(bytes) => bytes.len(),
            Self::Utf16(units) => units.len(),
        }
    }

    pub(crate) fn is_empty(self) -> bool {
        self.len() == 0
    }

    pub(crate) fn unit(self) -> Unit {
        match self {
            Self::Text(_) | Self::Bytes(_) => Unit::Byte,
            Self::Utf16(_) => Unit::Utf16,
        }
    }
}

/// The decoded location of a retained window's first unit, independent of discarded source.
#[derive(Clone, Copy)]
pub(crate) struct LineColumn {
    line: usize,
    column: usize,
}

impl Default for LineColumn {
    fn default() -> Self {
        Self { line: 1, column: 1 }
    }
}

impl LineColumn {
    /// Count a released prefix once through the same decoder used for report locations.
    pub(crate) fn advance(&mut self, input: Units<'_>, end: usize) {
        if end == 0 {
            return;
        }
        let (line, column) = Source::relative_line_column(input, end);
        self.column = column + if line == 1 { self.column - 1 } else { 0 };
        self.line += line - 1;
    }
}

impl<'a> From<&'a str> for Input<'a> {
    fn from(text: &'a str) -> Self {
        Self::Text(text)
    }
}

impl<'a> From<&'a [u8]> for Input<'a> {
    fn from(bytes: &'a [u8]) -> Self {
        Self::Bytes(bytes)
    }
}

impl<'a> From<&'a [u16]> for Input<'a> {
    fn from(units: &'a [u16]) -> Self {
        Self::Utf16(units)
    }
}

/// A retained source boundary, independent of how many empty chunks preceded it.
pub(crate) struct Chunk {
    pub(crate) start: usize,
    pub(crate) index: usize,
    pub(crate) unit: Unit,
}

pub(crate) struct StreamInput<'a> {
    pub(crate) input: Units<'a>,
    pub(crate) ready: usize,
    pub(crate) chunks: &'a [Chunk],
    pub(crate) start: usize,
    pub(crate) unit: Unit,
    pub(crate) origin: LineColumn,
}

impl StreamInput<'_> {
    pub(crate) fn span(&self, start: usize, end: usize) -> Span {
        let position = |at: usize| {
            let chunk = self
                .chunks
                .partition_point(|chunk| chunk.start <= at)
                .max(1)
                - 1;
            let chunk = &self.chunks[chunk];
            Position {
                offset: at - chunk.start,
                unit: chunk.unit,
                chunk: Some(chunk.index),
            }
        };
        Span {
            start: position(start),
            end: position(end),
        }
    }
}

/// The input as the scanner reads it, plus how to report an offset in the caller's own units.
pub(super) struct Source<'a> {
    pub(super) locations: super::locations::IssueLocations,
    pub(super) input: Units<'a>,
    pub(super) unit: Unit,
    /// Retained chunk boundaries. Empty for a one-shot parse, which has one source and no chunk
    /// to name; repeated empty chunks share their last boundary instead of accumulating entries.
    ///
    /// A stream reports every offset LOCAL to the chunk that carried the source unit, because a consumer
    /// holding chunk 7 cannot use an offset counted from a chunk 0 it has already forgotten.
    pub(super) chunks: &'a [Chunk],
    /// Logical offset of the retained input's first unit; chunk boundaries remain original.
    pub(super) start: usize,
    pub(super) origin: LineColumn,
}

/// UTF-16 code units in a byte prefix.
///
/// The ASCII test comes first and is the whole point: it is one vectorised pass with no decoding,
/// and it answers for ASCII JSON. Malformed sequences count as one replacement each, matching the
/// decoded text rather than the number of damaged bytes.
fn utf16_len(bytes: &[u8]) -> usize {
    if bytes.is_ascii() {
        return bytes.len();
    }
    match core::str::from_utf8(bytes) {
        Ok(text) => text.chars().map(char::len_utf16).sum(),
        Err(_) => bytes
            .utf8_chunks()
            .map(|chunk| {
                chunk.valid().encode_utf16().count() + usize::from(!chunk.invalid().is_empty())
            })
            .sum(),
    }
}

impl<'a> Source<'a> {
    /// The source, or the encoding it declares and this package refuses.
    pub(super) fn new(input: Input<'a>) -> Result<Self, Encoding> {
        let units = input.units();
        let unit = input.unit();
        // Only a byte view can declare an encoding. Text has already been decoded by whoever holds
        // it, so a mark there is content the caller kept, not a declaration to obey.
        if let Input::Bytes(bytes) = input
            && let Some(encoding) = Encoding::declared_by(bytes)
        {
            return Err(encoding);
        }
        Ok(Self {
            locations: super::locations::IssueLocations::default(),
            input: units,
            unit,
            chunks: &[],
            start: 0,
            origin: LineColumn::default(),
        })
    }

    #[cfg(test)]
    pub(super) fn scanner(&self, options: &'a Parser) -> Scanner<'a> {
        Scanner::from_units(self.input, options)
    }

    pub(super) fn scanner_prefix(&self, options: &'a Parser, end: usize) -> Scanner<'a> {
        Scanner::from_whole_prefix(self.input, end, options)
    }

    /// Splice only required edits, preserving untouched source units and borrowing unchanged text.
    pub(super) fn repaired(
        &self,
        edits: &[crate::scan::Edit<'_>],
        mut extent: (usize, usize),
    ) -> JsonString<'a> {
        match self.input {
            Units::Bytes(bytes) => JsonString::Text(if edits.is_empty() {
                String::from_utf8_lossy(&bytes[extent.0..extent.1])
            } else {
                let text = super::splice(bytes, edits, &mut extent, |text| {
                    Cow::Borrowed(text.as_bytes())
                });
                Cow::Owned(String::from_utf8_lossy(&text[extent.0..extent.1]).into_owned())
            }),
            Units::Utf16(units) => JsonString::Units(if edits.is_empty() {
                Cow::Borrowed(&units[extent.0..extent.1])
            } else {
                let mut text = super::splice(units, edits, &mut extent, |text| {
                    Cow::Owned(text.encode_utf16().collect())
                });
                text.truncate(extent.1);
                text.drain(..extent.0);
                Cow::Owned(text)
            }),
            Units::Mixed(units) => {
                let text = super::splice(units, edits, &mut extent, |text| {
                    Cow::Owned(
                        text.encode_utf16()
                            .map(crate::scan::mixed::EncodedUnit::utf16)
                            .collect(),
                    )
                });
                JsonString::Units(Cow::Owned(crate::scan::mixed::text(
                    &text[extent.0..extent.1],
                )))
            }
            Units::Joined(..) => {
                let units = self.input.encoded();
                let text = super::splice(&units, edits, &mut extent, |text| {
                    Cow::Owned(
                        text.encode_utf16()
                            .map(crate::scan::mixed::EncodedUnit::utf16)
                            .collect(),
                    )
                });
                self.joined_text(crate::scan::mixed::text(&text[extent.0..extent.1]))
            }
        }
    }

    /// Which chunk an offset belongs to, and where that chunk begins.
    ///
    /// The last chunk that had begun by `at`. An offset one past the whole buffer is a one-past-end
    /// position in the final chunk, which is what this already answers.
    fn chunk_at(&self, at: usize) -> (usize, Option<usize>, Unit) {
        match self.chunks.is_empty() {
            true => (0, None, self.unit),
            false => {
                let chunk = self
                    .chunks
                    .partition_point(|chunk| chunk.start <= at)
                    .max(1)
                    - 1;
                let chunk = &self.chunks[chunk];
                (chunk.start, Some(chunk.index), chunk.unit)
            }
        }
    }

    /// An original-unit offset in the chunk a stream consumer still holds.
    pub(super) fn position(&self, at: usize) -> Position {
        let (base, chunk, unit) = self.chunk_at(at);
        Position {
            offset: at - base,
            unit,
            chunk,
        }
    }

    pub(super) fn span(&self, start: usize, end: usize) -> Span {
        Span {
            start: self.position(start),
            end: self.position(end),
        }
    }

    /// Line and column for humans, both 1-based.
    ///
    /// The column counts UTF-16 units even when the offset is reported in bytes, because it is a
    /// position in the DECODED text — the same reading the TypeScript side takes, where the column
    /// is computed from absolute UTF-16 offsets whatever the input was made of.
    pub(super) fn line_column(&self, at: usize) -> (usize, usize) {
        if at < self.start
            && let Some(mark) = self.saved_mark(at)
        {
            return (mark.line, mark.column);
        }
        let mut position = self.origin;
        position.advance(self.input, at - self.start);
        (position.line, position.column)
    }

    fn relative_line_column(input: Units<'_>, at: usize) -> (usize, usize) {
        let bytes = match input {
            Units::Bytes(bytes) => bytes,
            Units::Mixed(units) => {
                let (mut line, mut column, mut offset) = (1, 1, 0);
                while let Some(decoded) = crate::scan::mixed::decode(&units[offset..at]) {
                    if decoded.value == 10 {
                        line += 1;
                        column = 1;
                    } else {
                        column += 1 + usize::from(decoded.value > 0xffff);
                    }
                    offset += decoded.width;
                }
                return (line, column);
            }
            Units::Joined(..) => {
                let (mut line, mut column, mut offset) = (1, 1, 0);
                while offset < at
                    && let Some(decoded) = input.decode(offset)
                {
                    if decoded.value == 10 {
                        line += 1;
                        column = 1;
                    } else {
                        column += 1 + usize::from(decoded.value > 0xffff);
                    }
                    offset += decoded.width;
                }
                return (line, column);
            }
            Units::Utf16(units) => {
                let before = &units[..at];
                let start = before
                    .iter()
                    .rposition(|&unit| unit == 10)
                    .map_or(0, |i| i + 1);
                return (
                    before.iter().filter(|&&unit| unit == 10).count() + 1,
                    at - start + 1,
                );
            }
        };
        let before = &bytes[..at];
        let line_start = before
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |n| n + 1);
        (
            before.iter().filter(|&&b| b == b'\n').count() + 1,
            utf16_len(&before[line_start..]) + 1,
        )
    }

    /// A bounded slice of source around an offset, [`CONTEXT_RADIUS`] units each side.
    ///
    /// Bounded deliberately: the error budget is in the thousands, and a thousand unbounded context
    /// strings is the memory hazard, not the error count. Match the reference's UTF-16 slice,
    /// including a lone surrogate when the boundary divides a pair.
    pub(super) fn context(&self, at: usize) -> JsonString<'a> {
        if at < self.start
            && let Some(mark) = self.saved_mark(at)
        {
            return mark.context.clone();
        }
        self.context_until(at - self.start, self.input.len())
    }

    /// Only the decoder piece containing the observation was visible when its location was saved.
    pub(super) fn observed_context(
        &self,
        at: usize,
        observed_at: usize,
        observed_end: usize,
    ) -> JsonString<'a> {
        if at < self.start {
            return self.context(at);
        }
        let at = at - self.start;
        let observed_at = observed_at.saturating_sub(self.start);
        let observed_end = observed_end - self.start;
        let bytes = match self.input {
            Units::Bytes(bytes) => bytes,
            Units::Utf16(_) => return self.context_until(at, observed_end),
            Units::Mixed(units) => {
                let right = (at + CONTEXT_RADIUS * 4).min(units.len()).min(observed_end);
                let mut end = observed_at.max(at).min(right);
                while let Some(decoded) = crate::scan::mixed::decode(&units[end..right]) {
                    end += decoded.width;
                    if decoded.invalid {
                        break;
                    }
                }
                return self.context_until(at, end);
            }
            Units::Joined(..) => {
                let right = (at + CONTEXT_RADIUS * 4)
                    .min(self.input.len())
                    .min(observed_end);
                let mut end = observed_at.max(at).min(right);
                while let Some(decoded) = self.input.prefix(right).decode(end) {
                    end += decoded.width;
                    if decoded.invalid {
                        break;
                    }
                }
                return self.context_until(at, end);
            }
        };
        let right = (at + CONTEXT_RADIUS * 4).min(bytes.len()).min(observed_end);
        let from = observed_at.max(at).min(right);
        let end = bytes[from..right]
            .utf8_chunks()
            .next()
            .map_or(right, |chunk| {
                from + chunk.valid().len() + chunk.invalid().len()
            });
        self.context_until(at, end)
    }

    fn context_until(&self, at: usize, end: usize) -> JsonString<'a> {
        let bytes = match self.input {
            Units::Bytes(bytes) => bytes,
            Units::Mixed(units) => {
                let mut before =
                    crate::scan::mixed::text(&units[at.saturating_sub(CONTEXT_RADIUS * 4)..at]);
                before.drain(..before.len().saturating_sub(CONTEXT_RADIUS));
                let after =
                    crate::scan::mixed::text(&units[at..(at + CONTEXT_RADIUS * 4).min(end)]);
                before.extend(after.into_iter().take(CONTEXT_RADIUS));
                return JsonString::Units(Cow::Owned(before));
            }
            Units::Joined(..) => {
                let units = self.input.slice(
                    at.saturating_sub(CONTEXT_RADIUS * 4)..(at + CONTEXT_RADIUS * 4).min(end),
                );
                let mut text = units.text();
                let center = self
                    .input
                    .slice(at.saturating_sub(CONTEXT_RADIUS * 4)..at)
                    .text()
                    .len();
                let start = center.saturating_sub(CONTEXT_RADIUS);
                text.drain(..start);
                text.truncate(CONTEXT_RADIUS * 2);
                return self.joined_text(text);
            }
            Units::Utf16(units) => {
                return JsonString::Units(Cow::Borrowed(
                    &units[at.saturating_sub(CONTEXT_RADIUS)..(at + CONTEXT_RADIUS).min(end)],
                ));
            }
        };
        let left = at.saturating_sub(CONTEXT_RADIUS * 4);
        let right = (at + CONTEXT_RADIUS * 4).min(end);
        let before = String::from_utf8_lossy(&bytes[left..at]);
        let after = String::from_utf8_lossy(&bytes[at..right]);
        let (before, first) = context_edge(&before, CONTEXT_RADIUS, true);
        let (after, last) = context_edge(&after, CONTEXT_RADIUS, false);
        context_text(before, after, first, last)
    }

    /// Decoder errors see only the prefix through their replacement, never future source text.
    pub(super) fn decoded_context(&self, at: usize, end: usize) -> JsonString<'a> {
        let at = at - self.start;
        let end = end - self.start;
        let bytes = match self.input {
            Units::Bytes(bytes) => bytes,
            Units::Mixed(units) => {
                let mut text =
                    crate::scan::mixed::text(&units[at.saturating_sub(CONTEXT_RADIUS * 4)..end]);
                text.drain(..text.len().saturating_sub(CONTEXT_RADIUS + 1));
                return JsonString::Units(Cow::Owned(text));
            }
            Units::Joined(..) => {
                let units = self.input.slice(at.saturating_sub(CONTEXT_RADIUS * 4)..end);
                let mut text = units.text();
                let keep = CONTEXT_RADIUS + 1;
                text.drain(..text.len().saturating_sub(keep));
                return self.joined_text(text);
            }
            Units::Utf16(units) => {
                return JsonString::Units(Cow::Borrowed(
                    &units[end.saturating_sub(CONTEXT_RADIUS + 1)..end],
                ));
            }
        };
        let start = at.saturating_sub(CONTEXT_RADIUS * 4);
        let text = String::from_utf8_lossy(&bytes[start..end]);
        let (text, first) = context_edge(&text, CONTEXT_RADIUS + 1, true);
        context_text(text, "", first, None)
    }

    fn joined_text(&self, text: Vec<u16>) -> JsonString<'a> {
        if self.input.is_bytes() {
            JsonString::Text(Cow::Owned(String::from_utf16_lossy(&text)))
        } else {
            JsonString::Units(Cow::Owned(text))
        }
    }
}

/// Retain a UTF-16 prefix or suffix, separating a boundary's unpaired unit from valid text.
fn context_edge(text: &str, mut units: usize, tail: bool) -> (&str, Option<u16>) {
    let mut chars = text.char_indices();
    while let Some((at, ch)) = if tail {
        chars.next_back()
    } else {
        chars.next()
    } {
        let width = ch.len_utf16();
        if units < width {
            let part = if tail {
                &text[at + ch.len_utf8()..]
            } else {
                &text[..at]
            };
            let split = (units == 1).then(|| {
                let mut pair = [0; 2];
                ch.encode_utf16(&mut pair);
                pair[usize::from(tail)]
            });
            return (part, split);
        }
        units -= width;
    }
    (text, None)
}

/// Allocate code units only when a context boundary cannot be represented as UTF-8.
fn context_text<'a>(
    before: &str,
    after: &str,
    first: Option<u16>,
    last: Option<u16>,
) -> JsonString<'a> {
    if first.is_some() || last.is_some() {
        return JsonString::Units(Cow::Owned(
            first
                .into_iter()
                .chain(before.encode_utf16())
                .chain(after.encode_utf16())
                .chain(last)
                .collect(),
        ));
    }
    let mut text = String::with_capacity(before.len() + after.len());
    text.push_str(before);
    text.push_str(after);
    JsonString::Text(Cow::Owned(text))
}
