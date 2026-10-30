//! Safe ownership and lifetime rules for the portable WebAssembly byte boundary.
//!
//! Hosts receive opaque handles and may write only into a request vector they allocated. Parsing
//! replaces that vector with an owned response, so callers must reacquire its pointer and length;
//! release removes the handle, making every later use fail instead of reaching recycled memory.

#![cfg_attr(target_arch = "wasm32", no_std)]
#![deny(unsafe_code)]

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use partial_json_repair_boundary::{ConfiguredParser, ConfiguredStream};

use spin::Mutex;

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

static BUFFERS: Mutex<Handles<Vec<u8>>> = Mutex::new(Handles::new());
static STREAMS: Mutex<Handles<ConfiguredStream>> = Mutex::new(Handles::new());
static PARSERS: Mutex<Handles<ConfiguredParser>> = Mutex::new(Handles::new());

struct Handles<T> {
    next: u32,
    values: BTreeMap<u32, T>,
}

impl<T> Handles<T> {
    const fn new() -> Self {
        Self {
            next: 1,
            values: BTreeMap::new(),
        }
    }

    fn unused_handle(&mut self) -> Option<u32> {
        let start = self.next;
        loop {
            let handle = self.next;
            self.next = self.next.wrapping_add(1).max(1);
            if !self.values.contains_key(&handle) {
                return Some(handle);
            }
            if self.next == start {
                return None;
            }
        }
    }

    fn insert(&mut self, value: T) -> Option<u32> {
        let handle = self.unused_handle()?;
        self.values.insert(handle, value);
        Some(handle)
    }
}

/// Allocates an owned request buffer and returns its opaque handle, or zero when allocation fails.
#[must_use]
pub fn allocate(length: usize) -> u32 {
    let mut value = Vec::new();
    if value.try_reserve_exact(length).is_err() {
        return 0;
    }
    value.resize(length, 0);

    let mut buffers = BUFFERS.lock();
    buffers.insert(value).unwrap_or(0)
}

/// Returns the current buffer pointer, or zero for a stale or unknown handle.
#[must_use]
pub fn pointer(handle: u32) -> usize {
    BUFFERS
        .lock()
        .values
        .get(&handle)
        .map_or(0, |value| value.as_ptr() as usize)
}

/// Returns the current buffer length, or zero for a stale or unknown handle.
#[must_use]
pub fn length(handle: u32) -> usize {
    BUFFERS.lock().values.get(&handle).map_or(0, Vec::len)
}

/// Copies bytes into an allocated request without exposing memory to native tests and tools.
#[must_use]
pub fn write(handle: u32, offset: usize, source: &[u8]) -> bool {
    let mut buffers = BUFFERS.lock();
    let Some(target) = buffers.values.get_mut(&handle) else {
        return false;
    };
    let Some(end) = offset.checked_add(source.len()) else {
        return false;
    };
    let Some(destination) = target.get_mut(offset..end) else {
        return false;
    };
    destination.copy_from_slice(source);
    true
}

/// Replaces a request with its parsed response; returns false for a stale or unknown handle.
#[must_use]
pub fn parse(handle: u32) -> bool {
    let mut buffers = BUFFERS.lock();
    let Some(value) = buffers.values.get_mut(&handle) else {
        return false;
    };
    *value = partial_json_repair_boundary::parse(value);
    true
}

/// Releases a buffer; returns false when the handle was already released or never existed.
#[must_use]
pub fn release(handle: u32) -> bool {
    BUFFERS.lock().values.remove(&handle).is_some()
}

/// Validates one configuration buffer and returns an opaque parser handle.
#[must_use]
pub fn parser_create(buffer: u32) -> u32 {
    let parser = {
        let buffers = BUFFERS.lock();
        let Some(configuration) = buffers.values.get(&buffer) else {
            return 0;
        };
        let Ok(parser) = partial_json_repair_boundary::configure(configuration) else {
            return 0;
        };
        parser
    };
    PARSERS.lock().insert(parser).unwrap_or(0)
}

/// Replaces a source request buffer with this configured parser's response.
#[must_use]
pub fn parser_execute(parser: u32, buffer: u32) -> bool {
    let parsers = PARSERS.lock();
    let Some(parser) = parsers.values.get(&parser) else {
        return false;
    };
    let mut buffers = BUFFERS.lock();
    let Some(request) = buffers.values.get_mut(&buffer) else {
        return false;
    };
    *request = parser.execute(request);
    true
}

/// Creates an independent stream under an existing configured parser.
#[must_use]
pub fn parser_stream_create(parser: u32, mode: u8) -> u32 {
    let stream = {
        let parsers = PARSERS.lock();
        let Some(parser) = parsers.values.get(&parser) else {
            return 0;
        };
        let Ok(stream) = parser.stream(mode) else {
            return 0;
        };
        stream
    };
    STREAMS.lock().insert(stream).unwrap_or(0)
}

/// Releases a configured parser; repeated release is a no-op failure.
#[must_use]
pub fn parser_release(handle: u32) -> bool {
    PARSERS.lock().values.remove(&handle).is_some()
}

/// Allocates one incremental parser and returns its opaque handle.
#[must_use]
pub fn stream_create() -> u32 {
    STREAMS
        .lock()
        .insert(ConfiguredStream::default())
        .unwrap_or(0)
}

/// Feeds a request buffer into a stream and replaces it with that chunk's result delta.
#[must_use]
pub fn stream_feed(stream: u32, buffer: u32) -> bool {
    let mut streams = STREAMS.lock();
    let Some(stream) = streams.values.get_mut(&stream) else {
        return false;
    };
    let mut buffers = BUFFERS.lock();
    let Some(value) = buffers.values.get_mut(&buffer) else {
        return false;
    };
    *value = stream.feed(value);
    true
}

/// Finishes a stream and writes its tail into an existing buffer.
#[must_use]
pub fn stream_end(stream: u32, buffer: u32) -> bool {
    let mut streams = STREAMS.lock();
    let Some(stream) = streams.values.get_mut(&stream) else {
        return false;
    };
    let mut buffers = BUFFERS.lock();
    let Some(value) = buffers.values.get_mut(&buffer) else {
        return false;
    };
    *value = stream.end();
    true
}

/// Writes a stream's current snapshot into an existing buffer.
#[must_use]
pub fn stream_snapshot(stream: u32, buffer: u32) -> bool {
    let mut streams = STREAMS.lock();
    let Some(stream) = streams.values.get_mut(&stream) else {
        return false;
    };
    let mut buffers = BUFFERS.lock();
    let Some(value) = buffers.values.get_mut(&buffer) else {
        return false;
    };
    *value = stream.snapshot();
    true
}

/// Writes a stream's current source account into an existing buffer.
#[must_use]
pub fn stream_summary(stream: u32, buffer: u32) -> bool {
    let streams = STREAMS.lock();
    let Some(stream) = streams.values.get(&stream) else {
        return false;
    };
    let mut buffers = BUFFERS.lock();
    let Some(value) = buffers.values.get_mut(&buffer) else {
        return false;
    };
    *value = stream.summary();
    true
}

/// Releases a stream and its retained input; repeated release is a no-op failure.
#[must_use]
pub fn stream_release(handle: u32) -> bool {
    STREAMS.lock().values.remove(&handle).is_some()
}

#[cfg(target_arch = "wasm32")]
include!(concat!(env!("OUT_DIR"), "/exports.rs"));

#[cfg(test)]
mod tests {
    use super::{BUFFERS, allocate, length, parse, pointer, release, write};

    #[test]
    fn stale_handles_never_reach_recycled_memory() {
        let handle = allocate(4);
        assert_ne!(handle, 0);
        assert_ne!(pointer(handle), 0);
        assert_eq!(length(handle), 4);
        assert!(release(handle));
        assert_eq!(pointer(handle), 0);
        assert_eq!(length(handle), 0);
        assert!(!parse(handle));
        assert!(!release(handle));

        let replacement = allocate(4);
        assert_ne!(replacement, handle);
        assert!(release(replacement));
    }

    #[test]
    fn parse_replaces_the_request_and_checks_write_ranges() {
        let request = [1, 0, 0, b'n', b'u', b'l', b'l'];
        let handle = allocate(request.len());
        assert!(write(handle, 0, &request));
        assert!(!write(handle, request.len(), &[0]));
        assert!(!write(handle, usize::MAX, &[0]));
        assert!(parse(handle));
        assert_eq!(
            BUFFERS
                .lock()
                .values
                .get(&handle)
                .map(|value| value.as_slice()),
            Some([1, 0, 0, 0, 0].as_slice())
        );
        assert!(release(handle));
    }
}
