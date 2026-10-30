//! Decodes one validated host configuration into the parser state that owns it.

use alloc::string::String;
use alloc::vec::Vec;
use core::num::NonZeroUsize;

use partial_json_repair::{
    DangerousKeyPolicy, DiagnosticsMode, JsonString, Parser, PathSegment, Recovery, SelectorPath,
    SwitchableRepair,
};

pub(crate) struct Configuration {
    pub(crate) parser: Parser,
    pub(crate) select: Option<Vec<SelectorPath<'static>>>,
    pub(crate) occurrences: bool,
}

pub(crate) fn decode(input: &[u8]) -> Result<Configuration, u8> {
    let mut reader = Reader { input, at: 0 };
    if reader.byte()? != 1 {
        return Err(1);
    }
    let diagnostics = match reader.byte()? {
        0 => DiagnosticsMode::Off,
        1 => DiagnosticsMode::On,
        2 => DiagnosticsMode::All,
        _ => return Err(7),
    };
    let flags = reader.byte()?;
    if flags & !0x3f != 0 {
        return Err(7);
    }
    let on_dangerous_key = match reader.byte()? {
        0 => DangerousKeyPolicy::Keep,
        1 => DangerousKeyPolicy::Drop,
        2 => DangerousKeyPolicy::Reject,
        _ => return Err(7),
    };
    let max_depth = reader.nonzero()?;
    let max_errors = reader.nonzero()?;
    let max_diagnostics = reader.usize()?;
    let max_buffer = reader.nonzero()?;
    let max_scalar = reader.nonzero()?;
    let max_retained = reader.nonzero()?;
    let mut recover = Recovery::ALL;
    for name in reader.strings()? {
        let Some(kind) = name.as_str().and_then(SwitchableRepair::named) else {
            return Err(7);
        };
        recover = recover.without(kind);
    }
    let custom_dangerous_keys = reader.strings()?;
    let required_keys = reader.strings()?;
    let skip = reader.paths()?;
    let select = match reader.byte()? {
        0 => None,
        1 => Some(reader.paths()?),
        _ => return Err(7),
    };
    if reader.at != input.len() {
        return Err(7);
    }
    Ok(Configuration {
        parser: Parser {
            diagnostics,
            locations: flags & 1 != 0,
            max_depth,
            on_dangerous_key,
            null_prototype: flags & 2 != 0,
            custom_dangerous_keys,
            recover,
            max_errors,
            max_diagnostics,
            max_buffer,
            max_scalar,
            max_retained,
            exact_numbers: flags & 4 != 0,
            object_only: flags & 8 != 0,
            required_keys,
            skip,
            repair_broken: flags & 16 != 0,
        },
        select,
        occurrences: flags & 32 != 0,
    })
}

struct Reader<'a> {
    input: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Result<u8, u8> {
        let value = *self.input.get(self.at).ok_or(7)?;
        self.at += 1;
        Ok(value)
    }

    fn usize(&mut self) -> Result<usize, u8> {
        let bytes: [u8; 8] = self.take(8)?.try_into().map_err(|_| 7)?;
        usize::try_from(u64::from_le_bytes(bytes)).map_err(|_| 7)
    }

    fn nonzero(&mut self) -> Result<NonZeroUsize, u8> {
        NonZeroUsize::new(self.usize()?).ok_or(7)
    }

    fn take(&mut self, length: usize) -> Result<&[u8], u8> {
        let end = self.at.checked_add(length).ok_or(7)?;
        let value = self.input.get(self.at..end).ok_or(7)?;
        self.at = end;
        Ok(value)
    }

    fn string(&mut self) -> Result<JsonString<'static>, u8> {
        match self.byte()? {
            6 => {
                let length = self.usize()?;
                core::str::from_utf8(self.take(length)?)
                    .map(|value| String::from(value).into())
                    .map_err(|_| 7)
            }
            7 => {
                let length = self.usize()?;
                let bytes = self.take(length.checked_mul(2).ok_or(7)?)?;
                Ok(bytes
                    .chunks_exact(2)
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect::<Vec<_>>()
                    .into())
            }
            _ => Err(7),
        }
    }

    fn strings(&mut self) -> Result<Vec<JsonString<'static>>, u8> {
        let count = self.usize()?;
        (0..count).map(|_| self.string()).collect()
    }

    fn paths(&mut self) -> Result<Vec<SelectorPath<'static>>, u8> {
        let count = self.usize()?;
        (0..count)
            .map(|_| {
                let segments = self.usize()?;
                (0..segments)
                    .map(|_| match self.byte()? {
                        0 => Ok(PathSegment::Key(self.string()?)),
                        1 => Ok(PathSegment::Index(self.usize()?)),
                        2 => Ok(PathSegment::Any),
                        3 => Ok(PathSegment::AnyDepth),
                        _ => Err(7),
                    })
                    .collect()
            })
            .collect()
    }
}
