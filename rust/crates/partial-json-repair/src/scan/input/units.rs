//! Read one logical input from contiguous storage or retained carry plus an active chunk.

use crate::candidate::Candidate;
use crate::scan::mixed::{self, EncodedUnit};
use alloc::vec::Vec;

/// Borrow the original alphabet; indexes here are local to the retained slice.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Units<'a> {
    Bytes(&'a [u8]),
    Utf16(&'a [u16]),
    Mixed(&'a [EncodedUnit]),
    /// Retained carry followed by the active borrowed chunk; never nested.
    Joined(UnitSlice<'a>, UnitSlice<'a>),
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum UnitSlice<'a> {
    Bytes(&'a [u8]),
    Utf16(&'a [u16]),
    Mixed(&'a [EncodedUnit]),
}

impl UnitSlice<'_> {
    fn is_bytes(self) -> bool {
        matches!(self, Self::Bytes(_))
    }

    fn len(self) -> usize {
        match self {
            Self::Bytes(input) => input.len(),
            Self::Utf16(input) => input.len(),
            Self::Mixed(input) => input.len(),
        }
    }

    fn get(self, at: usize) -> Option<u32> {
        match self {
            Self::Bytes(input) => input.get(at).copied().map(u32::from),
            Self::Utf16(input) => input.get(at).copied().map(u32::from),
            Self::Mixed(input) => input.get(at).copied().map(u32::from),
        }
    }

    fn byte(self, at: usize) -> Option<u8> {
        match self {
            Self::Bytes(input) => input.get(at).copied(),
            Self::Utf16(_) => None,
            Self::Mixed(input) => input.get(at).and_then(|unit| unit.as_byte()),
        }
    }

    fn slice(self, range: core::ops::Range<usize>) -> Self {
        match self {
            Self::Bytes(input) => Self::Bytes(&input[range]),
            Self::Utf16(input) => Self::Utf16(&input[range]),
            Self::Mixed(input) => Self::Mixed(&input[range]),
        }
    }
}

impl<'a> From<UnitSlice<'a>> for Units<'a> {
    fn from(value: UnitSlice<'a>) -> Self {
        match value {
            UnitSlice::Bytes(input) => Self::Bytes(input),
            UnitSlice::Utf16(input) => Self::Utf16(input),
            UnitSlice::Mixed(input) => Self::Mixed(input),
        }
    }
}

impl<'a> Units<'a> {
    pub(crate) fn join(left: Units<'a>, right: Units<'a>) -> Units<'a> {
        if left.len() == 0 {
            return right;
        }
        if right.len() == 0 {
            return left;
        }
        Units::Joined(left.single(), right.single())
    }

    fn single(self) -> UnitSlice<'a> {
        match self {
            Self::Bytes(input) => UnitSlice::Bytes(input),
            Self::Utf16(input) => UnitSlice::Utf16(input),
            Self::Mixed(input) => UnitSlice::Mixed(input),
            Self::Joined(..) => unreachable!("only two source slices are joined"),
        }
    }

    /// Hold an incomplete UTF-8 sequence or native high surrogate until its continuation is known,
    /// so fragments never split a pair. Tail inspection is bounded independently of input length.
    pub(crate) fn ready_len(self) -> usize {
        let input = self;
        let length = input.len();
        if length == 0 {
            return length;
        }
        let Some(last) = input.byte(length - 1) else {
            return length
                - usize::from(
                    input
                        .get(length - 1)
                        .is_some_and(|unit| (0xd800..0xdc00).contains(&unit)),
                );
        };
        if last.is_ascii() {
            return length;
        }
        let mut tail = [0; 4];
        let mut count = 0;
        for at in (length.saturating_sub(tail.len())..length).rev() {
            let Some(byte) = input.byte(at) else { break };
            count += 1;
            tail[4 - count] = byte;
        }
        let bytes = &tail[4 - count..];
        let mut at = 0;
        while let Err(error) = core::str::from_utf8(&bytes[at..]) {
            at += error.valid_up_to();
            match error.error_len() {
                Some(width) => at += width,
                None => return length - count + at,
            }
        }
        length
    }

    pub(crate) fn prefix(self, end: usize) -> Self {
        self.slice(0..end)
    }

    pub(crate) fn slice(self, range: core::ops::Range<usize>) -> Self {
        match self {
            Self::Bytes(input) => Self::Bytes(&input[range]),
            Self::Utf16(input) => Self::Utf16(&input[range]),
            Self::Mixed(input) => Self::Mixed(&input[range]),
            Self::Joined(left, right) => {
                let split = left.len();
                if range.end <= split {
                    left.slice(range).into()
                } else if range.start >= split {
                    right.slice(range.start - split..range.end - split).into()
                } else {
                    Self::Joined(
                        left.slice(range.start..split),
                        right.slice(0..range.end - split),
                    )
                }
            }
        }
    }

    pub(crate) fn decode(self, at: usize) -> Option<mixed::Decoded> {
        let mut input = [EncodedUnit::utf16(0); 4];
        let mut count = 0;
        while count < input.len() {
            let Some(value) = self.get(at + count) else {
                break;
            };
            input[count] = self
                .byte(at + count)
                .map_or_else(|| EncodedUnit::utf16(value as u16), EncodedUnit::byte);
            count += 1;
            if input[0].as_byte().is_none() {
                break;
            }
        }
        mixed::decode(&input[..count])
    }

    pub(crate) fn encoded(self) -> Vec<EncodedUnit> {
        (0..self.len())
            .map(|at| {
                self.byte(at).map_or_else(
                    || {
                        EncodedUnit::utf16(
                            self.get(at).expect("index came from source length") as u16
                        )
                    },
                    EncodedUnit::byte,
                )
            })
            .collect()
    }

    pub(crate) fn text(self) -> Vec<u16> {
        let mut text = Vec::new();
        let mut at = 0;
        while let Some(decoded) = self.decode(at) {
            decoded.append_to(&mut text);
            at += decoded.width;
        }
        text
    }

    pub(crate) fn is_bytes(self) -> bool {
        match self {
            Self::Bytes(_) => true,
            Self::Joined(left, right) => left.is_bytes() && right.is_bytes(),
            Self::Utf16(_) | Self::Mixed(_) => false,
        }
    }

    pub(super) fn content_start(self) -> usize {
        (0..self.len())
            .find(|&at| self.get(at).is_some_and(|unit| !crate::chars::is_ws(unit)))
            .unwrap_or(self.len())
    }

    pub(crate) fn byte(self, at: usize) -> Option<u8> {
        match self {
            Self::Bytes(input) => input.get(at).copied(),
            Self::Utf16(_) => None,
            Self::Mixed(input) => input.get(at).and_then(|unit| unit.as_byte()),
            Self::Joined(left, right) => {
                let split = left.len();
                if at < split {
                    left.byte(at)
                } else {
                    right.byte(at - split)
                }
            }
        }
    }

    pub(crate) fn get(self, at: usize) -> Option<u32> {
        match self {
            Self::Bytes(input) => input.get(at).copied().map(u32::from),
            Self::Utf16(input) => input.get(at).copied().map(u32::from),
            Self::Mixed(input) => input.get(at).copied().map(u32::from),
            Self::Joined(left, right) => {
                let split = left.len();
                if at < split {
                    left.get(at)
                } else {
                    right.get(at - split)
                }
            }
        }
    }

    pub(crate) fn len(self) -> usize {
        match self {
            Self::Bytes(input) => input.len(),
            Self::Utf16(input) => input.len(),
            Self::Mixed(input) => input.len(),
            Self::Joined(left, right) => left.len() + right.len(),
        }
    }

    pub(crate) fn whitespace(self, at: usize) -> usize {
        match self {
            Self::Bytes(input) => crate::chars::extra_whitespace_len(&input[at..]),
            Self::Utf16(_) => {
                usize::from(self.get(at).is_some_and(crate::chars::is_extra_whitespace))
            }
            Self::Mixed(input) => mixed::decode(&input[at..]).map_or(0, |unit| {
                if crate::chars::is_extra_whitespace(unit.value) {
                    unit.width
                } else {
                    0
                }
            }),
            Self::Joined(..) => self.decode(at).map_or(0, |unit| {
                if crate::chars::is_extra_whitespace(unit.value) {
                    unit.width
                } else {
                    0
                }
            }),
        }
    }

    pub(crate) fn starts_with(self, at: usize, text: &[u8]) -> bool {
        match self {
            Self::Bytes(input) => input.get(at..).is_some_and(|tail| tail.starts_with(text)),
            Self::Utf16(input) => input
                .get(at..at.saturating_add(text.len()))
                .is_some_and(|tail| tail.iter().copied().eq(text.iter().copied().map(u16::from))),
            Self::Mixed(_) => text.iter().enumerate().all(|(offset, &byte)| {
                self.get(at.saturating_add(offset)) == Some(u32::from(byte))
            }),
            Self::Joined(..) => text.iter().enumerate().all(|(offset, &byte)| {
                self.get(at.saturating_add(offset)) == Some(u32::from(byte))
            }),
        }
    }

    pub(crate) fn next_opener(self, at: usize) -> Option<usize> {
        match self {
            Self::Bytes(input) => crate::candidate::next_opener(input, at),
            Self::Utf16(input) => crate::candidate::next_opener(input, at),
            Self::Mixed(input) => crate::candidate::next_opener(input, at),
            Self::Joined(..) => (at.min(self.len())..self.len())
                .find(|&at| matches!(self.get(at), Some(0x5b | 0x7b))),
        }
    }

    pub(super) fn candidate(self) -> Candidate {
        match self {
            Self::Bytes(input) => Candidate::new(input),
            Self::Utf16(input) => Candidate::new(input),
            Self::Mixed(input) => Candidate::new(input),
            Self::Joined(..) => Candidate::from_content_start(self.content_start()),
        }
    }
}
