//! Driving the parser from an asynchronous source, with no executor anywhere.
//!
//! The stream is polled by hand against `Waker::noop`. That is not a shortcut around a runtime — it
//! is the only way to pin what happens on a `Pending`, which is the whole difference between this
//! door and the synchronous one. An executor would hide exactly the behaviour under test by
//! retrying until something was ready.

#![cfg(feature = "async")]

use core::pin::Pin;
use core::task::{Context, Poll, Waker};
use std::collections::VecDeque;

use futures_core::Stream;
use partial_json_repair::{OwnedStreamItem, StreamFailure, canonical_of, parse_stream_async};

/// A source that hands back one scripted answer per poll, `Pending` included, and reports its end
/// once the script runs out. A real `Stream` implementation, not a stand-in: the trait IS the seam
/// this door is defined against, so implementing it is what the test is supposed to exercise.
struct Scripted<C = &'static str>(VecDeque<Poll<Option<Result<C, &'static str>>>>);

/// Pending preserves the source; failure emits its result before the single incomplete summary.
#[test]
fn summary_waits_for_a_terminal_poll_and_preserves_cleanup_access() {
    use partial_json_repair::StreamEvent;
    let source = Scripted::new([
        Poll::Ready(Some(Ok("{\"a\":1"))),
        Poll::Pending,
        Poll::Ready(Some(Err("offline"))),
        Poll::Ready(Some(Ok("unread"))),
    ]);
    let mut stream = parse_stream_async(source).with_summary();
    let mut cx = Context::from_waker(Waker::noop());
    assert!(Pin::new(&mut stream).poll_next(&mut cx).is_pending());
    assert!(matches!(
        Pin::new(&mut stream).poll_next(&mut cx),
        Poll::Ready(Some(StreamEvent::Item(Err(_))))
    ));
    assert!(matches!(Pin::new(&mut stream).poll_next(&mut cx),
        Poll::Ready(Some(StreamEvent::Summary(summary))) if !summary.complete && summary.roots == 1));
    assert!(matches!(
        Pin::new(&mut stream).poll_next(&mut cx),
        Poll::Ready(None)
    ));
    let mut source = stream.into_source();
    assert_eq!(
        Pin::new(&mut source).poll_next(&mut cx),
        Poll::Ready(Some(Ok("unread")))
    );
}

impl<C> Scripted<C> {
    fn new<const N: usize>(script: [Poll<Option<Result<C, &'static str>>>; N]) -> Self {
        Self(script.into_iter().collect())
    }
}

impl<C: Unpin> Stream for Scripted<C> {
    type Item = Result<C, &'static str>;

    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.pop_front().unwrap_or(Poll::Ready(None))
    }
}

/// One poll of a stream, so a test reads as the sequence of answers it expects.
fn poll(
    stream: &mut Pin<&mut impl Stream<Item = OwnedStreamItem<&'static str>>>,
) -> Poll<Option<OwnedStreamItem<&'static str>>> {
    stream
        .as_mut()
        .poll_next(&mut Context::from_waker(Waker::noop()))
}

/// The canonical form of a delivered value, so a case names the answer rather than its shape.
fn delivered(polled: Poll<Option<OwnedStreamItem<&'static str>>>) -> String {
    let Poll::Ready(Some(item)) = polled else {
        panic!("expected a value to have been delivered");
    };
    canonical_of(&item.expect("a value, not a refusal").value)
}

/// A chunk that has not arrived yet is not the end of the stream, and it costs no value.
///
/// The defect this exists to catch: reading `Pending` as exhaustion, which closes the tail early and
/// answers a repaired value nobody asked for. Nothing about the types prevents it.
#[test]
fn a_pending_source_is_not_an_ended_one() {
    let source = Scripted::new([
        Poll::Pending,
        Poll::Ready(Some(Ok("{\"a\":1} [2"))),
        Poll::Pending,
        Poll::Ready(Some(Ok(",3]"))),
        Poll::Ready(None),
    ]);
    let mut stream = core::pin::pin!(parse_stream_async(source));

    assert!(poll(&mut stream).is_pending(), "no chunk had arrived yet");
    // The first chunk completes one root and leaves a second open; only the finished one is handed
    // over, because a value that could still grow is not judged early.
    assert_eq!(delivered(poll(&mut stream)), "{\"a\":1}");
    assert!(poll(&mut stream).is_pending(), "the rest had not arrived");
    assert_eq!(delivered(poll(&mut stream)), "[2,3]");
    assert!(
        matches!(poll(&mut stream), Poll::Ready(None)),
        "the source is spent"
    );
}

/// A source that stops by failing still gives up whatever its chunks had already built.
///
/// `HLD.md` rules the recoverable prefix exposed SEPARATELY rather than as a normal completion, so
/// the failure arm carries it and the caller cannot mistake it for a document that ended.
#[test]
fn a_failed_source_exposes_its_prefix() {
    let source = Scripted::new([
        Poll::Ready(Some(Ok("{\"a\":1,\"b\":"))),
        Poll::Ready(Some(Err("socket closed"))),
    ]);
    let mut stream = core::pin::pin!(parse_stream_async(source));

    let Poll::Ready(Some(Err(failed))) = poll(&mut stream) else {
        panic!("the source failed, so the stream must say so");
    };
    let StreamFailure::SourceFailed { cause, recovered } = failed.failure else {
        panic!("the JSON was fine; the transport was not");
    };
    assert_eq!(cause, "socket closed");
    assert_eq!(
        canonical_of(&recovered.expect("the prefix built a root")),
        "{\"a\":1}"
    );
    assert!(
        matches!(poll(&mut stream), Poll::Ready(None)),
        "a failed source owes nothing further and must not be polled again"
    );
}

#[test]
fn parser_refusal_preserves_the_unpolled_source_for_cleanup() {
    let source = Scripted::new([
        Poll::Ready(Some(Ok(vec![0xfeu8, 0xff]))),
        Poll::Ready(Some(Ok(vec![b'0']))),
    ]);
    let mut stream = parse_stream_async(source);
    assert!(matches!(
        poll(&mut Pin::new(&mut stream)),
        Poll::Ready(Some(Err(_)))
    ));
    assert!(matches!(
        poll(&mut Pin::new(&mut stream)),
        Poll::Ready(None)
    ));
    assert!(matches!(
        poll(&mut Pin::new(&mut stream)),
        Poll::Ready(None)
    ));
    assert_eq!(
        stream.into_source().0.len(),
        1,
        "unread chunk remains available for cleanup"
    );
}

#[test]
fn owned_native_chunks_preserve_lone_units() {
    let source = Scripted::new([
        Poll::Ready(Some(Ok(vec![0x22u16, 0xd800]))),
        Poll::Pending,
        Poll::Ready(Some(Ok(vec![0xdc00, 0xd800, 0x22]))),
        Poll::Ready(None),
    ]);
    let mut stream = core::pin::pin!(parse_stream_async(source));
    assert!(poll(&mut stream).is_pending());
    let Poll::Ready(Some(Ok(item))) = poll(&mut stream) else {
        panic!("native value")
    };
    let partial_json_repair::Value::String(text) = item.value else {
        panic!("string")
    };
    assert_eq!(
        text.code_units().collect::<Vec<_>>(),
        [0xd800, 0xdc00, 0xd800]
    );
    assert!(matches!(poll(&mut stream), Poll::Ready(None)));
}
