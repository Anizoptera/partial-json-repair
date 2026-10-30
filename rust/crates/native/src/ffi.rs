//! Plain C facade over the same owned byte protocol used by N-API.

use core::ffi::c_void;
use core::panic::AssertUnwindSafe;
use core::ptr;
use std::panic::catch_unwind;
use std::sync::{Arc, Mutex};

use partial_json_repair_boundary::{ConfiguredParser, ConfiguredStream};

use crate::Cancellation;

struct Response {
    bytes: Box<[u8]>,
}

struct Parser {
    inner: Arc<ConfiguredParser>,
}

struct Stream {
    inner: Mutex<ConfiguredStream>,
}

struct CancellationHandle {
    inner: Cancellation,
}

fn response(run: impl FnOnce() -> Box<[u8]>) -> *mut c_void {
    catch_unwind(AssertUnwindSafe(run)).map_or(ptr::null_mut(), |bytes| {
        Box::into_raw(Box::new(Response { bytes })).cast()
    })
}

#[allow(unsafe_code)]
unsafe fn borrowed_bytes<'a>(bytes: *const u8, length: usize) -> Option<&'a [u8]> {
    if bytes.is_null() {
        return (length == 0).then_some(&[]);
    }
    // SAFETY: the caller keeps this readable buffer alive for the duration of the FFI call.
    Some(unsafe { core::slice::from_raw_parts(bytes, length) })
}

/// Executes one encoded request and returns an owned response handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_parse(request: *const u8, length: usize) -> *mut c_void {
    // SAFETY: the FFI contract keeps the request readable until this synchronous call returns.
    let Some(request) = (unsafe { borrowed_bytes(request, length) }) else {
        return ptr::null_mut();
    };
    response(|| partial_json_repair_boundary::parse(request).into_boxed_slice())
}

/// Creates one immutable configured parser, or null when configuration is invalid.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_parser_create(bytes: *const u8, length: usize) -> *mut c_void {
    // SAFETY: the FFI contract keeps the configuration readable until this call returns.
    let Some(bytes) = (unsafe { borrowed_bytes(bytes, length) }) else {
        return ptr::null_mut();
    };
    catch_unwind(AssertUnwindSafe(|| {
        partial_json_repair_boundary::configure(bytes)
    }))
    .ok()
    .and_then(Result::ok)
    .map_or(ptr::null_mut(), |inner| {
        Box::into_raw(Box::new(Parser {
            inner: Arc::new(inner),
        }))
        .cast()
    })
}

/// Executes one request through a configured parser.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_parser_execute(
    parser: *const c_void,
    bytes: *const u8,
    length: usize,
) -> *mut c_void {
    if parser.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: both handles remain caller-owned and readable for this synchronous call.
    let Some(bytes) = (unsafe { borrowed_bytes(bytes, length) }) else {
        return ptr::null_mut();
    };
    let parser = unsafe { &*parser.cast::<Parser>() };
    response(|| parser.inner.execute(bytes).into_boxed_slice())
}

/// Executes one request while polling the caller-owned cancellation state.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_parser_execute_controlled(
    parser: *const c_void,
    bytes: *const u8,
    length: usize,
    cancellation: *const c_void,
) -> *mut c_void {
    if parser.is_null() || cancellation.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: the caller keeps both handles and the request readable until this call returns.
    let Some(bytes) = (unsafe { borrowed_bytes(bytes, length) }) else {
        return ptr::null_mut();
    };
    let parser = unsafe { &*parser.cast::<Parser>() };
    let cancellation = unsafe { &*cancellation.cast::<CancellationHandle>() };
    response(|| {
        parser
            .inner
            .execute_controlled(bytes, || cancellation.inner.is_aborted())
            .into_boxed_slice()
    })
}

type Completion = unsafe extern "C" fn(*mut c_void);

/// Starts one controlled operation on an owned native thread and reports its response once.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_parser_execute_async(
    parser: *const c_void,
    bytes: *const u8,
    length: usize,
    cancellation: *const c_void,
    completion: Option<Completion>,
) -> u8 {
    if parser.is_null() || cancellation.is_null() {
        return 0;
    }
    let Some(completion) = completion else {
        return 0;
    };
    // SAFETY: the caller keeps the request readable until this function returns, so the thread owns
    // its copy and no longer depends on host memory.
    let Some(bytes) = (unsafe { borrowed_bytes(bytes, length) }).map(<[u8]>::to_vec) else {
        return 0;
    };
    // SAFETY: both validated handles remain caller-owned for this call; cloning their shared state
    // makes the spawned operation independent from subsequent handle release.
    let parser = Arc::clone(&unsafe { &*parser.cast::<Parser>() }.inner);
    let cancellation = unsafe { &*cancellation.cast::<CancellationHandle>() }
        .inner
        .clone();
    u8::from(
        std::thread::Builder::new()
            .name("partial-json-repair".into())
            .spawn(move || {
                let response = response(|| {
                    parser
                        .execute_controlled(&bytes, || cancellation.is_aborted())
                        .into_boxed_slice()
                });
                // SAFETY: the caller supplies a C callback that remains alive until this invocation.
                unsafe { completion(response) };
            })
            .is_ok(),
    )
}

/// Creates one independently observable cancellation state.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pjr_ffi_cancellation_create() -> *mut c_void {
    Box::into_raw(Box::new(CancellationHandle {
        inner: Cancellation::default(),
    }))
    .cast()
}

/// Makes cancellation observable to a controlled parser execution.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_cancellation_abort(cancellation: *const c_void) {
    if !cancellation.is_null() {
        // SAFETY: the caller keeps this handle alive until controlled execution returns.
        unsafe { &*cancellation.cast::<CancellationHandle>() }
            .inner
            .abort();
    }
}

/// Releases one cancellation state after controlled execution has returned.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_cancellation_release(cancellation: *mut c_void) {
    if !cancellation.is_null() {
        // SAFETY: ownership of this handle is returned exactly once after its execution settles.
        drop(unsafe { Box::from_raw(cancellation.cast::<CancellationHandle>()) });
    }
}

/// Releases one configured parser; a null handle is a no-op.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_parser_release(parser: *mut c_void) {
    if !parser.is_null() {
        // SAFETY: ownership of this handle is returned exactly once by the caller.
        drop(unsafe { Box::from_raw(parser.cast::<Parser>()) });
    }
}

/// Creates one mutable stream owned by the returned opaque handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_stream_create(parser: *const c_void, mode: u8) -> *mut c_void {
    if parser.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: the configured parser remains caller-owned and readable for this call.
    let parser = unsafe { &*parser.cast::<Parser>() };
    catch_unwind(AssertUnwindSafe(|| parser.inner.stream(mode)))
        .ok()
        .and_then(Result::ok)
        .map_or(ptr::null_mut(), |inner| {
            Box::into_raw(Box::new(Stream {
                inner: Mutex::new(inner),
            }))
            .cast()
        })
}

/// Feeds one chunk and returns only that chunk's completed result delta.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_stream_feed(
    stream: *const c_void,
    bytes: *const u8,
    length: usize,
) -> *mut c_void {
    if stream.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: both handles remain caller-owned and readable for this synchronous call.
    let Some(bytes) = (unsafe { borrowed_bytes(bytes, length) }) else {
        return ptr::null_mut();
    };
    // SAFETY: the validated stream handle follows this module's opaque-handle contract.
    unsafe { stream_response(stream, |inner| inner.feed(bytes)) }
}

#[allow(unsafe_code)]
unsafe fn stream_response(
    stream: *const c_void,
    run: impl FnOnce(&mut ConfiguredStream) -> Vec<u8>,
) -> *mut c_void {
    if stream.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: the stream handle remains caller-owned and readable for this synchronous call.
    let stream = unsafe { &*stream.cast::<Stream>() };
    response(|| {
        stream
            .inner
            .lock()
            .map_or_else(|_| Vec::new(), |mut inner| run(&mut inner))
            .into_boxed_slice()
    })
}

/// Finishes one stream and returns its terminal delta.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_stream_end(stream: *const c_void) -> *mut c_void {
    // SAFETY: the stream handle follows this module's opaque-handle contract.
    unsafe { stream_response(stream, ConfiguredStream::end) }
}

/// Returns the stream's current snapshot without consuming input.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_stream_snapshot(stream: *const c_void) -> *mut c_void {
    // SAFETY: the stream handle follows this module's opaque-handle contract.
    unsafe { stream_response(stream, ConfiguredStream::snapshot) }
}

/// Returns the stream's current source account without consuming input.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_stream_summary(stream: *const c_void) -> *mut c_void {
    // SAFETY: the stream handle follows this module's opaque-handle contract.
    unsafe { stream_response(stream, |inner| inner.summary()) }
}

/// Releases one stream; a null handle is a no-op.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_stream_release(stream: *mut c_void) {
    if !stream.is_null() {
        // SAFETY: ownership of this handle is returned exactly once by the caller.
        drop(unsafe { Box::from_raw(stream.cast::<Stream>()) });
    }
}

/// Returns response bytes borrowed until `pjr_ffi_response_release`.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_response_pointer(response: *const c_void) -> *const u8 {
    if response.is_null() {
        return ptr::null();
    }
    // SAFETY: a non-null response handle comes from `pjr_ffi_parse` and remains caller-owned.
    unsafe { (*response.cast::<Response>()).bytes.as_ptr() }
}

/// Returns the response byte length, or zero for an invalid null handle.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_response_length(response: *const c_void) -> usize {
    if response.is_null() {
        return 0;
    }
    // SAFETY: a non-null response handle comes from `pjr_ffi_parse` and remains caller-owned.
    let response = unsafe { &*response.cast::<Response>() };
    response.bytes.len()
}

/// Releases one response; a null handle is a no-op.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pjr_ffi_response_release(response: *mut c_void) {
    if !response.is_null() {
        // SAFETY: ownership of this handle is returned exactly once by the caller.
        drop(unsafe { Box::from_raw(response.cast::<Response>()) });
    }
}
