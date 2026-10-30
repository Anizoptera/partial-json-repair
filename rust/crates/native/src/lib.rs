//! N-API transport for the shared byte boundary.
//!
//! JavaScript owns the request buffer and receives a new response buffer; parsing and every
//! product decision stay in the host-independent boundary and recovery crates.

use core::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use napi::Task;
use napi::bindgen_prelude::{AsyncTask, Buffer, ClassInstance, Error, Result, Status};
use napi_derive::napi;
use partial_json_repair_boundary::{ConfiguredParser, ConfiguredStream};

mod ffi;

#[derive(Clone, Default)]
struct Cancellation {
    stopped: Arc<AtomicBool>,
}

impl Cancellation {
    fn abort(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    fn is_aborted(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
}

/// Executes one encoded request without retaining host memory.
#[napi]
#[must_use]
pub fn parse(request: Buffer) -> Buffer {
    partial_json_repair_boundary::parse(request.as_ref()).into()
}

/// Owns one validated parser configuration for repeated calls.
#[napi]
pub struct NativeParser {
    inner: Arc<ConfiguredParser>,
}

/// Owns the stop state shared by one JavaScript call and its background task.
#[napi]
#[derive(Default)]
pub struct NativeCancellation {
    inner: Cancellation,
}

#[napi]
impl NativeCancellation {
    /// Creates an independently owned cancellation state.
    #[napi(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Makes cancellation observable to the background task.
    #[napi]
    pub fn abort(&self) {
        self.inner.abort();
    }
}

#[doc(hidden)]
pub struct ExecuteTask {
    parser: Arc<ConfiguredParser>,
    request: Vec<u8>,
    cancellation: Cancellation,
}

impl Task for ExecuteTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self
            .parser
            .execute_controlled(&self.request, || self.cancellation.is_aborted()))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi]
impl NativeParser {
    /// Validates and compiles configuration before a source can be supplied.
    #[napi(constructor)]
    pub fn new(configuration: Buffer) -> Result<Self> {
        partial_json_repair_boundary::configure(configuration.as_ref())
            .map(|inner| Self {
                inner: Arc::new(inner),
            })
            .map_err(|_| Error::new(Status::InvalidArg, "invalid parser configuration"))
    }

    /// Executes one operation through this parser's fixed configuration.
    #[napi]
    #[must_use]
    pub fn execute(&self, request: Buffer) -> Buffer {
        self.inner.execute(request.as_ref()).into()
    }

    /// Executes one operation on a host thread while cancellation remains independently observable.
    #[napi]
    pub fn execute_async(
        &self,
        request: Buffer,
        cancellation: Option<ClassInstance<'_, NativeCancellation>>,
    ) -> AsyncTask<ExecuteTask> {
        let cancellation = cancellation
            .as_ref()
            .map_or_else(Cancellation::default, |state| state.inner.clone());
        AsyncTask::new(ExecuteTask {
            parser: Arc::clone(&self.inner),
            request: request.to_vec(),
            cancellation,
        })
    }

    /// Creates an independent stream under this parser's compiled configuration.
    #[napi]
    pub fn create_stream(&self, mode: u8) -> Result<NativeStream> {
        self.inner
            .stream(mode)
            .map(|inner| NativeStream { inner })
            .map_err(|_| Error::new(Status::InvalidArg, "invalid stream configuration"))
    }
}

/// Owns one incremental parser for exactly one JavaScript stream.
#[napi]
#[derive(Default)]
pub struct NativeStream {
    inner: ConfiguredStream,
}

#[napi]
impl NativeStream {
    /// Creates an empty stream parser.
    #[napi(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one encoded source chunk and returns that chunk's completed values.
    #[napi]
    #[must_use]
    pub fn feed(&mut self, request: Buffer) -> Buffer {
        self.inner.feed(request.as_ref()).into()
    }

    /// Finishes the stream and returns its remaining tail once.
    #[napi]
    #[must_use]
    pub fn end(&mut self) -> Buffer {
        self.inner.end().into()
    }

    /// Returns the configured view without consuming input.
    #[napi]
    #[must_use]
    pub fn snapshot(&mut self) -> Buffer {
        self.inner.snapshot().into()
    }

    /// Returns the current source account without ending or advancing the stream.
    #[napi]
    #[must_use]
    pub fn summary(&self) -> Buffer {
        self.inner.summary().into()
    }

    /// Abandons unfinished input and releases retained parser storage.
    #[napi]
    pub fn close(&mut self) {
        self.inner.close();
    }
}
