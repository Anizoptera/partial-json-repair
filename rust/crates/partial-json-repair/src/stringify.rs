//! Encodes a recovered value back to JSON text, or says exactly which value has no spelling.
//!
//! `serde_json` cannot do this job for these values, and neither can [`crate::canonical`]. An exact
//! number must emit the digits the source wrote, unquoted and unrounded; a [`JsonString`] holding an
//! unpaired surrogate has no `&str` to hand a serialiser. The canonical writer knows both, but it
//! writes the CONFORMANCE spelling — `#undef`, `#exact:`, `#np{` — which is a comparison alphabet
//! rather than JSON, and a caller who shipped it would be shipping text nothing can parse.
//!
//! So this is the third writer over the same value, and it shares the only parts that must not
//! drift: string escaping and the double's spelling both come from [`crate::canonical`]. What
//! differs is the whole point of it — a value JSON cannot spell is REFUSED here, where the canonical
//! form marks it and the parser keeps it.

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::{self, Write};
use core::num::NonZeroUsize;

use crate::canonical::{write_f64_to, write_str_to, write_units_to};
use crate::options::DEFAULTS;
use crate::outcome::NonJsonKind;
use crate::report::{PathStep, SourcePath};
use crate::value::{JsonString, Number, Value};

/// Why no complete JSON text was produced.
///
/// Cycles, accessors and proxy traps are not reachable from a [`Value`]: the
/// tree is an owned enum with no getters, no user code runs during the walk, and a tree built out of
/// owned nodes cannot contain itself.
///
/// Separate from [`crate::RepairFailure`]: encoding can exhaust output, but cannot fail a scan.
#[derive(Clone, Debug, PartialEq)]
pub enum EncodingFailure<'a> {
    /// A value JSON cannot represent.
    NonJsonValue {
        /// Which unspellable value.
        value_kind: NonJsonKind,
        /// Where it sits in the value; empty for the root.
        path: SourcePath<'a>,
    },
    /// Writing stopped before exceeding the output bound. Partial text is not valid output.
    LimitReached {
        /// The maximum number of UTF-16 code units in the encoded JSON text.
        limit: usize,
    },
}

/// Output limits for JSON encoding, independent of parser configuration.
#[derive(Clone, Copy, Debug)]
pub struct StringifyOptions {
    /// Maximum encoded UTF-16 code units, including quotes, escapes and punctuation.
    pub max_output: NonZeroUsize,
}

impl Default for StringifyOptions {
    fn default() -> Self {
        Self {
            max_output: DEFAULTS.max_buffer,
        }
    }
}

impl StringifyOptions {
    /// Encodes with this output bound; no oversized intermediate JSON string is built.
    ///
    /// # Errors
    /// Returns [`EncodingFailure`] for a non-JSON value or an exhausted output bound.
    pub fn stringify<'a>(&self, value: &Value<'a>) -> Result<String, EncodingFailure<'a>> {
        let mut out = Output {
            text: String::new(),
            remaining: self.max_output.get(),
            limit: self.max_output.get(),
        };
        write_value(value, &mut out, &mut Vec::new())?;
        Ok(out.text)
    }
}

/// Every append checks the remaining units before allocation, including escaped string pieces.
struct Output {
    text: String,
    remaining: usize,
    limit: usize,
}

impl Write for Output {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let mut remaining = self.remaining;
        for c in text.chars() {
            remaining = remaining.checked_sub(c.len_utf16()).ok_or(fmt::Error)?;
        }
        self.text.push_str(text);
        self.remaining = remaining;
        Ok(())
    }
}

impl Output {
    fn failure(&self) -> EncodingFailure<'static> {
        EncodingFailure::LimitReached { limit: self.limit }
    }

    fn append(&mut self, text: &str) -> Result<(), EncodingFailure<'static>> {
        self.write_str(text).map_err(|_| self.failure())
    }

    fn character(&mut self, c: char) -> Result<(), EncodingFailure<'static>> {
        self.write_char(c).map_err(|_| self.failure())
    }

    fn string(&mut self, text: &JsonString<'_>) -> Result<(), EncodingFailure<'static>> {
        match text {
            JsonString::Text(t) => write_str_to(t, self),
            JsonString::Units(u) => write_units_to(u, self),
        }
        .map_err(|_| self.failure())
    }
}

/// Encodes a recovered value as JSON text.
///
/// Recursive, like every other walk of a [`Value`] — see the depth bound stated on that type. An
/// iterative encoder was measured and removed: it survives a value deeper than the stack, which
/// nothing else about `Value` does, so the caller reaches the same abort one line later and pays
/// for a second traversal style meanwhile.
///
/// # Errors
///
/// [`EncodingFailure`] when the value, or a member of it, is one JSON cannot spell — `undefined`,
/// `NaN` or an infinity — or when the default output bound is exhausted.
/// Use [`StringifyOptions::stringify`] to set a different bound.
pub fn stringify<'a>(value: &Value<'a>) -> Result<String, EncodingFailure<'a>> {
    StringifyOptions::default().stringify(value)
}

/// Appends one value, carrying the path so a refusal can say where it sits.
fn write_value<'a>(
    value: &Value<'a>,
    out: &mut Output,
    path: &mut SourcePath<'a>,
) -> Result<(), EncodingFailure<'a>> {
    let refuse = |value_kind| {
        Err(EncodingFailure::NonJsonValue {
            value_kind,
            // Cloned at the point of refusal: the walk unwinds without popping, so this is the only
            // moment the path names the offending value.
            path: path.clone(),
        })
    };
    match value {
        Value::Null => out.append("null")?,
        Value::Bool(b) => out.append(if *b { "true" } else { "false" })?,
        Value::Undefined => return refuse(NonJsonKind::Undefined),
        Value::Number(Number::Exact(text)) => out.append(text)?,
        Value::Number(Number::Double(n)) if n.is_nan() => return refuse(NonJsonKind::Nan),
        Value::Number(Number::Double(n)) if n.is_infinite() => {
            return refuse(NonJsonKind::Infinity);
        }
        // `-0` has no JSON spelling that survives a round trip, and every conformant encoder writes
        // `0`. Not refused: the sign is a distinction JSON never carried, so nothing the format
        // could hold is lost.
        Value::Number(Number::Double(n)) => {
            write_f64_to(*n, out).map_err(|_| out.failure())?;
        }
        Value::String(s) => out.string(s)?,
        Value::Array(items) => {
            out.character('[')?;
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.character(',')?;
                }
                path.push(PathStep::Index(at));
                write_value(item, out, path)?;
                path.pop();
            }
            out.character(']')?;
        }
        Value::Object(object) => {
            out.character('{')?;
            for (at, (key, item)) in object.entries().iter().enumerate() {
                if at > 0 {
                    out.character(',')?;
                }
                out.string(key)?;
                out.character(':')?;
                path.push(PathStep::Key(key.clone()));
                write_value(item, out, path)?;
                path.pop();
            }
            out.character('}')?;
        }
    }
    Ok(())
}
