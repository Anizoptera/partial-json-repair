//! Decide declared byte encodings once, allowing a leading mark to span source chunks.

use crate::outcome::Encoding;
use crate::parse::Input;

#[derive(Default)]
pub(super) enum Declaration {
    #[default]
    Start,
    Prefix {
        bytes: [u8; 4],
        length: usize,
    },
    Finished(Option<Encoding>),
}

impl Declaration {
    pub(super) fn append(&mut self, input: Input<'_>) {
        if input.is_empty() {
            return;
        }
        if matches!(self, Self::Start) {
            *self = if matches!(input, Input::Bytes(_)) {
                Self::Prefix {
                    bytes: [0; 4],
                    length: 0,
                }
            } else {
                Self::Finished(None)
            };
        }
        if let Self::Prefix { bytes, length } = self {
            if let Input::Bytes(chunk) = input {
                let take = chunk.len().min(bytes.len() - *length);
                bytes[*length..*length + take].copy_from_slice(&chunk[..take]);
                *length += take;
                if Encoding::declaration_pending(&bytes[..*length]) {
                    return;
                }
            }
            *self = Self::Finished(Encoding::declared_by(&bytes[..*length]));
        }
    }

    /// `false` means the scanner must wait; exhaustion resolves a shorter complete mark.
    pub(super) fn ready(&self, ending: bool) -> Result<bool, Encoding> {
        match self {
            Self::Start | Self::Finished(None) => Ok(true),
            Self::Finished(Some(encoding)) => Err(*encoding),
            Self::Prefix { bytes, length } if ending => {
                Encoding::declared_by(&bytes[..*length]).map_or(Ok(true), Err)
            }
            Self::Prefix { .. } => Ok(false),
        }
    }
}
