//! Preserve original offsets when a stream mixes bytes with native UTF-16 units.

use alloc::vec::Vec;

/// The byte tag distinguishes a damaged byte from the same numeric UTF-16 code unit.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EncodedUnit(u32);

impl EncodedUnit {
    pub(crate) fn byte(value: u8) -> Self {
        Self(0x10000 | u32::from(value))
    }

    pub(crate) fn utf16(value: u16) -> Self {
        Self(u32::from(value))
    }

    pub(crate) fn as_byte(self) -> Option<u8> {
        (self.0 & 0x10000 != 0).then_some(self.0 as u8)
    }
}

impl From<EncodedUnit> for u32 {
    fn from(value: EncodedUnit) -> Self {
        value.0 & 0xffff
    }
}

/// One decoded scalar or original surrogate, with its consumed source extent.
pub(crate) struct Decoded {
    pub(crate) value: u32,
    pub(crate) width: usize,
    pub(crate) invalid: bool,
}

impl Decoded {
    pub(crate) fn append_to(&self, output: &mut Vec<u16>) {
        if let Ok(unit) = u16::try_from(self.value) {
            output.push(unit);
        } else if let Some(character) = char::from_u32(self.value) {
            output.extend_from_slice(character.encode_utf16(&mut [0; 2]));
        }
    }
}

/// Decode at most one UTF-8 scalar; a native unit ends the byte sequence rather than completing it.
/// The standard library determines malformed-sequence width, including incomplete final tails.
pub(crate) fn decode(input: &[EncodedUnit]) -> Option<Decoded> {
    let first = *input.first()?;
    let Some(byte) = first.as_byte() else {
        return Some(Decoded {
            value: first.into(),
            width: 1,
            invalid: false,
        });
    };
    if byte.is_ascii() {
        return Some(Decoded {
            value: byte.into(),
            width: 1,
            invalid: false,
        });
    }
    let mut bytes = [0; 4];
    let mut count = 0;
    for unit in input.iter().take(bytes.len()) {
        let Some(byte) = unit.as_byte() else { break };
        bytes[count] = byte;
        count += 1;
    }
    let valid = match core::str::from_utf8(&bytes[..count]) {
        Ok(text) => text,
        Err(error) if error.valid_up_to() == 0 => {
            return Some(Decoded {
                value: 0xfffd,
                width: error.error_len().unwrap_or(count),
                invalid: true,
            });
        }
        Err(error) => core::str::from_utf8(&bytes[..error.valid_up_to()]).ok()?,
    };
    let character = valid.chars().next()?;
    Some(Decoded {
        value: character.into(),
        width: character.len_utf8(),
        invalid: false,
    })
}

/// Decode only the requested source slice, preserving native lone surrogates.
pub(crate) fn text(input: &[EncodedUnit]) -> Vec<u16> {
    let mut units = Vec::new();
    let mut at = 0;
    while let Some(decoded) = decode(&input[at..]) {
        decoded.append_to(&mut units);
        at += decoded.width;
    }
    units
}
