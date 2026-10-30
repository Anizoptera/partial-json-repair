//! Generates the symbol attributes required by Rust 2024 without putting unsafe code in the
//! authored transport implementation.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR")).join("exports.rs");
    fs::write(
        output,
        r#"
/// Allocates a request buffer and returns its handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_allocate(length: u32) -> u32 { crate::allocate(length as usize) }

/// Returns the current linear-memory address for a handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_pointer(handle: u32) -> u32 { crate::pointer(handle) as u32 }

/// Returns the current byte length for a handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_length(handle: u32) -> u32 { crate::length(handle) as u32 }

/// Replaces a request buffer with its parsed response.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_parse(handle: u32) -> u32 { u32::from(crate::parse(handle)) }

/// Validates a configuration buffer and returns a parser handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_parser_create(buffer: u32) -> u32 { crate::parser_create(buffer) }

/// Replaces a source request buffer with a configured parser response.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_parser_execute(parser: u32, buffer: u32) -> u32 {
    u32::from(crate::parser_execute(parser, buffer))
}

/// Creates a stream from a configured parser.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_parser_stream_create(parser: u32, mode: u32) -> u32 {
    let Ok(mode) = u8::try_from(mode) else { return 0 };
    crate::parser_stream_create(parser, mode)
}

/// Releases a configured parser.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_parser_release(handle: u32) -> u32 {
    u32::from(crate::parser_release(handle))
}

/// Allocates an incremental parser and returns its handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_stream_create() -> u32 { crate::stream_create() }

/// Replaces a request buffer with one stream feed delta.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_stream_feed(stream: u32, buffer: u32) -> u32 {
    u32::from(crate::stream_feed(stream, buffer))
}

/// Replaces a buffer with the stream tail.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_stream_end(stream: u32, buffer: u32) -> u32 {
    u32::from(crate::stream_end(stream, buffer))
}

/// Replaces a buffer with the stream's current snapshot.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_stream_snapshot(stream: u32, buffer: u32) -> u32 {
    u32::from(crate::stream_snapshot(stream, buffer))
}

/// Replaces a buffer with the stream's current source account.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_stream_summary(stream: u32, buffer: u32) -> u32 {
    u32::from(crate::stream_summary(stream, buffer))
}

/// Releases a stream handle and its retained input.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_stream_release(handle: u32) -> u32 {
    u32::from(crate::stream_release(handle))
}

/// Releases a handle and its buffer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_release(handle: u32) -> u32 { u32::from(crate::release(handle)) }
"#,
    )
    .expect("write generated WebAssembly exports");
}
