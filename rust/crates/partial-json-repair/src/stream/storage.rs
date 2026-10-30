//! Keep homogeneous input in native storage and preserve source indices when alphabets mix.

use crate::parse::Input;
use crate::scan::Units;
use crate::scan::mixed::EncodedUnit;
use alloc::vec::Vec;

pub(super) enum Storage {
    Bytes(Vec<u8>),
    Utf16(Vec<u16>),
    Mixed(Vec<EncodedUnit>),
}

impl Default for Storage {
    fn default() -> Self {
        Self::Bytes(Vec::new())
    }
}

impl Storage {
    pub(super) fn units(&self) -> Units<'_> {
        match self {
            Self::Bytes(input) => Units::Bytes(input),
            Self::Utf16(input) => Units::Utf16(input),
            Self::Mixed(input) => Units::Mixed(input),
        }
    }

    pub(super) fn append(&mut self, input: Input<'_>) {
        if input.is_empty() {
            return;
        }
        match (&mut *self, input) {
            (Self::Bytes(buffer), Input::Text(text)) => buffer.extend_from_slice(text.as_bytes()),
            (Self::Bytes(buffer), Input::Bytes(bytes)) => buffer.extend_from_slice(bytes),
            (Self::Utf16(buffer), Input::Utf16(units)) => buffer.extend_from_slice(units),
            (storage, input) if storage.units().len() == 0 => {
                *storage = match input {
                    Input::Text(text) => Self::Bytes(text.as_bytes().to_vec()),
                    Input::Bytes(bytes) => Self::Bytes(bytes.to_vec()),
                    Input::Utf16(units) => Self::Utf16(units.to_vec()),
                };
            }
            (Self::Mixed(buffer), input) => append_mixed(buffer, input),
            (_, input) => {
                let mut buffer = Vec::with_capacity(self.units().len() + input.len());
                match core::mem::take(self) {
                    Self::Bytes(bytes) => buffer.extend(bytes.into_iter().map(EncodedUnit::byte)),
                    Self::Utf16(units) => buffer.extend(units.into_iter().map(EncodedUnit::utf16)),
                    Self::Mixed(units) => buffer.extend(units),
                }
                append_mixed(&mut buffer, input);
                *self = Self::Mixed(buffer);
            }
        }
    }

    pub(super) fn release(&mut self, count: usize) {
        match self {
            Self::Bytes(input) => {
                input.drain(..count);
            }
            Self::Utf16(input) => {
                input.drain(..count);
            }
            Self::Mixed(input) => {
                input.drain(..count);
            }
        }
    }
}

fn append_mixed(buffer: &mut Vec<EncodedUnit>, input: Input<'_>) {
    match input {
        Input::Text(text) => buffer.extend(text.bytes().map(EncodedUnit::byte)),
        Input::Bytes(bytes) => buffer.extend(bytes.iter().copied().map(EncodedUnit::byte)),
        Input::Utf16(units) => buffer.extend(units.iter().copied().map(EncodedUnit::utf16)),
    }
}
