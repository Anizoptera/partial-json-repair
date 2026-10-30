//! Drive fallible sources through the manual parser while preserving source failures and cleanup.

use super::values::{Capture, Cursor};
use super::{EndState, StreamItem, StreamParser};
use crate::options::{DEFAULTS, Parser};
use crate::outcome::{Failed, Outcome, ParseFailure};
use crate::parse::AsInput;
use crate::value::Value;
use alloc::boxed::Box;
use core::marker::PhantomData;

/// Why a driven stream produced no value, when the reason is not the JSON.
///
/// Two members, because two are reachable here. The JavaScript union carries seven more, and every
/// one of them is a shape Rust's types refuse before a call exists: a source or chunk of the wrong
/// kind, a second drain while one is open, or an invalid option. The first two are settled by
/// [`Iterator`] and the borrow checker — [`ParsedStream`] owns its parser and hands out no
/// overlapping drain — and the last by [`Parser`] being a struct rather than a parsed
/// literal. A member nothing can produce would teach a caller to handle a case they can never meet.
///
/// Cancellation is likewise absent: a consumer stops by dropping the iterator, and there is nobody
/// left to hand an item to.
#[derive(Clone, Debug, PartialEq)]
pub enum StreamFailure<'a, E> {
    /// The chunks arrived; recovering them failed. Exactly what a whole-input parse would answer.
    Parse(ParseFailure<'a>),
    /// The source stopped by failing.
    ///
    /// `recovered` is the root the input left open, closed under the recovery policy — `HLD.md`
    /// rules that a failed source exposes its recoverable prefix SEPARATELY rather than as a normal
    /// completion. Roots the source did finish were already delivered and are never repeated.
    SourceFailed {
        /// What the source failed with, kept at its own type rather than erased.
        cause: E,
        /// The unfinished root, if there was one.
        recovered: Option<Value<'a>>,
    },
}

/// One item of a driven stream, detached from the chunks that carried it.
///
/// [`StreamItem`] widened twice: it owns its content, and its failure arm can also say the SOURCE
/// stopped, which nothing feeding a [`StreamParser`] by hand can report. Named for the ownership
/// because that is the half a caller has to decide before choosing a door.
pub type OwnedStreamItem<E> = Outcome<'static, Value<'static>, StreamFailure<'static, E>>;

/// Values pulled out of a fallible chunk source, one at a time.
///
/// The counterpart of [`StreamParser`] for a caller who HAS a source rather than one who is handed
/// chunks by somebody else's callback. Both drive the same drain, so neither is a second parser.
///
/// **Items are owned.** A borrowed item would have to name the buffer the next `next()` extends,
/// which no [`Iterator`] can express, and paying for the detach is what buys an ordinary iterator
/// that a caller can collect, filter and hold. Manual drains likewise return owned results.
///
/// **Dropping this stops the work.** The parser and the source are owned here, so leaving the loop
/// releases both with no `close` to remember — which is why cancellation needs no item and no flag.
pub struct ParsedStream<S: Iterator, E> {
    pub(super) stream: StreamParser,
    /// The source until it is spent. `None` means no further chunk will ever be requested — after
    /// exhaustion, and after a failure, since a failed iterator owes nothing after its error.
    source: Option<S>,
    /// Retain progress, never a queue of results produced ahead of demand.
    cursor: Option<Cursor>,
    /// Keep the source's chunk alive while the scanner borrows it between consumer pulls.
    active: Option<S::Item>,
    error: PhantomData<fn() -> E>,
}

impl Parser {
    /// Values pulled out of a fallible chunk source under these options.
    ///
    /// The source's error type rides through as `E` rather than being erased, so a caller matches on
    /// their own transport failure with no downcast.
    pub fn parse_stream<S, C, E>(&self, source: S) -> ParsedStream<S, E>
    where
        S: Iterator<Item = Result<C, E>>,
        C: AsInput,
    {
        ParsedStream {
            stream: StreamParser::new(self.clone()),
            source: Some(source),
            cursor: None,
            active: None,
            error: PhantomData,
        }
    }
}

/// Values pulled out of a fallible chunk source, under the shipped defaults.
/// [`Parser::parse_stream`] is the configured door.
pub fn parse_stream<S, C, E>(source: S) -> ParsedStream<S, E>
where
    S: Iterator<Item = Result<C, E>>,
    C: AsInput,
{
    DEFAULTS.parse_stream(source)
}

impl<S, C, E> Iterator for ParsedStream<S, E>
where
    S: Iterator<Item = Result<C, E>>,
    C: AsInput,
{
    type Item = OwnedStreamItem<E>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(cursor) = &mut self.cursor {
                let input = self
                    .active
                    .as_ref()
                    .and_then(|item| item.as_ref().ok())
                    .map(AsInput::as_input);
                let item = cursor.advance(&mut self.stream, Capture::Value, input);
                if self.stream.is_closed() {
                    self.source = None;
                    self.active = None;
                }
                if let Some(item) = item {
                    return Some(own(item));
                }
                self.cursor = None;
                self.active = None;
            }
            let Self {
                stream,
                source,
                cursor,
                active,
                ..
            } = self;
            let chunk = source.as_mut()?.next();
            match chunk {
                Some(Ok(chunk)) => {
                    let next = Cursor::feed(stream, &chunk).0;
                    *active = next.borrows_chunk().then_some(Ok(chunk));
                    *cursor = Some(next);
                }
                Some(Err(cause)) => {
                    *source = None;
                    let recovered = unfinished(stream.end());
                    stream.end_state = EndState::Stopped;
                    return Some(Err(Box::new(Failed {
                        failure: StreamFailure::SourceFailed { cause, recovered },
                        diagnostics: None,
                    })));
                }
                None => {
                    *source = None;
                    *cursor = Some(Cursor::end());
                }
            }
        }
    }
}

/// Values polled out of a fallible asynchronous chunk source, one at a time.
///
/// The asynchronous twin of [`ParsedStream`], and deliberately not a second parser: both drive the
/// same [`StreamParser`], so a chunk read from a socket and the same chunk handed over by hand
/// produce the same answers. Only where the chunks come from differs.
///
/// **No executor is chosen.** `futures_core::Stream` is a trait, not a runtime, so this composes
/// with whatever the caller already runs. The scan itself never blocks or yields — it is ordinary
/// synchronous work between polls — which is why no executor is needed to run it.
///
/// **`S: Unpin`.** Polling an owned source requires either a pinning projection, which needs
/// `unsafe` that this workspace FORBIDS, or an outside crate for the same. A source that is not
/// `Unpin` — an `async_stream!` generator, say — becomes one with `Box::pin`, which is one line at
/// the call site and is already what `BoxStream` is.
///
/// **Dropping stops the work**, exactly as it does for the synchronous twin: parser and source are
/// owned here, so leaving the loop releases both. A source needing ASYNCHRONOUS cleanup cannot be
/// closed by `Drop` — no `Drop` can await — so [`Self::into_source`] hands it back to be awaited.
#[cfg(feature = "async")]
pub struct ParsedAsyncStream<S: futures_core::Stream, E> {
    pub(super) stream: StreamParser,
    /// Kept even once finished, unlike the synchronous twin which drops it. A source that ended
    /// normally may still owe an awaited close, and dropping it here would take that away.
    source: S,
    /// Whether the source has answered for the last time. Guards both re-polling a finished source,
    /// which its contract does not allow, and closing the tail twice.
    spent: bool,
    /// Retain progress across polls without producing unrequested results.
    cursor: Option<Cursor>,
    /// The chunk is owned here but never pinned or borrowed across a poll call.
    active: Option<S::Item>,
    error: PhantomData<fn() -> E>,
}

#[cfg(feature = "async")]
impl Parser {
    /// Values polled out of a fallible asynchronous chunk source under these options.
    ///
    /// The source's error type rides through as `E` rather than being erased, so a caller matches on
    /// their own transport failure with no downcast.
    pub fn parse_stream_async<S, C, E>(&self, source: S) -> ParsedAsyncStream<S, E>
    where
        S: futures_core::Stream<Item = Result<C, E>>,
        C: AsInput,
    {
        ParsedAsyncStream {
            stream: StreamParser::new(self.clone()),
            source,
            spent: false,
            cursor: None,
            active: None,
            error: PhantomData,
        }
    }
}

/// Values polled out of a fallible asynchronous chunk source, under the shipped defaults.
/// [`Parser::parse_stream_async`] is the configured door.
#[cfg(feature = "async")]
pub fn parse_stream_async<S, C, E>(source: S) -> ParsedAsyncStream<S, E>
where
    S: futures_core::Stream<Item = Result<C, E>>,
    C: AsInput,
{
    DEFAULTS.parse_stream_async(source)
}

#[cfg(feature = "async")]
impl<S: futures_core::Stream, E> ParsedAsyncStream<S, E> {
    /// The source, so a caller who must close it asynchronously can await their own shutdown.
    ///
    /// The counterpart of `close` on a JavaScript stream. It exists because `Drop` cannot await, so
    /// releasing the stream is enough for a source whose cleanup is synchronous and is not enough
    /// for one whose cleanup is not.
    pub fn into_source(self) -> S {
        self.source
    }
}

// Only the source is polled through Pin; no pinning promise is made for a retained chunk.
#[cfg(feature = "async")]
impl<S: futures_core::Stream + Unpin, E> Unpin for ParsedAsyncStream<S, E> {}

#[cfg(feature = "async")]
impl<S, C, E> futures_core::Stream for ParsedAsyncStream<S, E>
where
    S: futures_core::Stream<Item = Result<C, E>> + Unpin,
    C: AsInput,
{
    type Item = OwnedStreamItem<E>;

    fn poll_next(
        self: core::pin::Pin<&mut Self>,
        cx: &mut core::task::Context<'_>,
    ) -> core::task::Poll<Option<Self::Item>> {
        // Only the source has a pinning obligation; retained chunks are never structurally pinned.
        let this = self.get_mut();
        loop {
            if let Some(cursor) = &mut this.cursor {
                let input = this
                    .active
                    .as_ref()
                    .and_then(|item| item.as_ref().ok())
                    .map(AsInput::as_input);
                let item = cursor.advance(&mut this.stream, Capture::Value, input);
                this.spent |= this.stream.is_closed();
                if this.stream.is_closed() {
                    this.active = None;
                }
                if let Some(item) = item {
                    return core::task::Poll::Ready(Some(own(item)));
                }
                this.cursor = None;
                this.active = None;
            }
            if this.spent {
                return core::task::Poll::Ready(None);
            }
            let chunk = core::task::ready!(core::pin::Pin::new(&mut this.source).poll_next(cx));
            let Self {
                stream,
                spent,
                cursor,
                active,
                ..
            } = this;
            match chunk {
                Some(Ok(chunk)) => {
                    let next = Cursor::feed(stream, &chunk).0;
                    *active = next.borrows_chunk().then_some(Ok(chunk));
                    *cursor = Some(next);
                }
                Some(Err(cause)) => {
                    *spent = true;
                    let recovered = unfinished(stream.end());
                    stream.end_state = EndState::Stopped;
                    return core::task::Poll::Ready(Some(Err(Box::new(Failed {
                        failure: StreamFailure::SourceFailed { cause, recovered },
                        diagnostics: None,
                    }))));
                }
                None => {
                    *spent = true;
                    *cursor = Some(Cursor::end());
                }
            }
        }
    }
}

/// Widen an already owned result's failure without traversing its recovered tree again.
fn own<E>(item: StreamItem<'static>) -> OwnedStreamItem<E> {
    match item {
        Ok(success) => Ok(success),
        Err(failed) => Err(Box::new(Failed {
            failure: StreamFailure::Parse(failed.failure),
            diagnostics: failed.diagnostics,
        })),
    }
}

/// The root a tail drain closed, whichever arm carries it. At most one root can still be open.
fn unfinished(mut tail: impl Iterator<Item = StreamItem<'static>>) -> Option<Value<'static>> {
    match tail.next()? {
        Ok(success) => Some(success.value),
        Err(failed) => match failed.failure {
            ParseFailure::PolicyRefused { recovered, .. }
            | ParseFailure::LimitReached { recovered, .. } => recovered,
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::parse_stream;

    const CHUNK: &str = r#"{"a":1} {"b":2} {"c":3}"#;

    #[test]
    fn source_failure_remains_stopped_after_recovering_its_prefix() {
        let mut stream = parse_stream([Ok("{\"a\":1"), Err("disconnected")].into_iter());
        assert!(stream.next().expect("source failure").is_err());
        assert_eq!(stream.stream.end_state, super::EndState::Stopped);
        assert!(stream.next().is_none());
        assert_eq!(stream.stream.end_state, super::EndState::Stopped);
    }

    #[test]
    fn synchronous_pulls_do_not_parse_later_roots_in_the_same_chunk() {
        let mut stream = parse_stream(core::iter::once(Ok::<_, ()>(CHUNK)));
        for delivered in 1..=3 {
            assert!(stream.next().expect("root").is_ok());
            assert_eq!(stream.stream.delivered, delivered);
            assert_eq!(
                stream
                    .stream
                    .buffer
                    .source(false)
                    .expect("source")
                    .input
                    .len(),
                0
            );
        }
        assert!(stream.next().is_none());
        assert!(stream.next().is_none());
    }

    #[cfg(feature = "async")]
    #[test]
    fn asynchronous_pulls_do_not_parse_later_roots_in_the_same_chunk() {
        use core::pin::Pin;
        use core::task::{Context, Poll, Waker};
        use futures_core::Stream;

        struct Chunk(Option<&'static str>);
        impl Stream for Chunk {
            type Item = Result<&'static str, ()>;
            fn poll_next(
                mut self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Option<Self::Item>> {
                Poll::Ready(self.0.take().map(Ok))
            }
        }

        let mut stream = super::parse_stream_async(Chunk(Some(CHUNK)));
        let mut context = Context::from_waker(Waker::noop());
        for delivered in 1..=3 {
            assert!(matches!(
                Pin::new(&mut stream).poll_next(&mut context),
                Poll::Ready(Some(Ok(_)))
            ));
            assert_eq!(stream.stream.delivered, delivered);
            assert_eq!(
                stream
                    .stream
                    .buffer
                    .source(false)
                    .expect("source")
                    .input
                    .len(),
                0
            );
        }
        assert!(matches!(
            Pin::new(&mut stream).poll_next(&mut context),
            Poll::Ready(None)
        ));
        assert!(stream.into_source().0.is_none());
    }
}
