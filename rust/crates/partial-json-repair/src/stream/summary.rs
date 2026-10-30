//! Append stream completion facts without changing ordinary result iteration or reading ahead.

use super::values::Drain;
use super::views::{ViewedDrain, ViewedSelectedDrain};
use super::{
    EndState, FragmentStreamItem, FragmentStreamParser, OwnedStreamItem, ParsedStream,
    SelectedStreamItem, SelectedStreamParser, StreamItem, StreamParser, ViewedSelectedStreamParser,
    ViewedStreamParser,
};
use super::{fragments::FragmentDrain, selected::SelectedDrain};
use crate::outcome::Fragment;
use crate::parse::{AsInput, Input};
use crate::value::Value;
use alloc::vec::Vec;

/// One ordinary result or the final account of the source examined.
#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent<T> {
    /// The original result, including its reports and failure data.
    Item(T),
    /// Emitted once after exhaustion or a delivered terminal failure, never by dropping a stream.
    Summary(StreamSummary),
}

/// Counts describe observed input and delivery, not absence in unread or refused input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamSummary {
    /// Whether the whole source was examined.
    pub complete: bool,
    /// Recognized roots, including refused roots and a root salvaged at a limit.
    pub roots: usize,
    /// Successfully delivered matches, or started scalar occurrences; zero without selection.
    pub matches: usize,
    /// Selector indexes with no such delivery.
    pub unmatched: Vec<usize>,
}

/// An opt-in final summary over the same source driver, with no separate parser or result queue.
pub struct Summarized<S> {
    inner: S,
    state: SummaryState,
}

impl<S> Summarized<S> {
    fn new(inner: S, selectors: usize) -> Self {
        Self {
            inner,
            state: SummaryState {
                emitted: false,
                matches: 0,
                hits: alloc::vec![false; selectors],
            },
        }
    }
}

struct SummaryState {
    emitted: bool,
    matches: usize,
    hits: Vec<bool>,
}

fn current_summary(stream: &StreamParser, state: &SummaryState) -> StreamSummary {
    StreamSummary {
        complete: stream.end_state == EndState::Complete,
        roots: stream.delivered,
        matches: state.matches,
        unmatched: state
            .hits
            .iter()
            .enumerate()
            .filter_map(|(index, hit)| (!hit).then_some(index))
            .collect(),
    }
}

fn whole_summary(stream: &StreamParser, state: &mut SummaryState) -> Option<StreamSummary> {
    if state.emitted || !matches!(stream.end_state, EndState::Complete | EndState::Stopped) {
        return None;
    }
    state.emitted = true;
    Some(current_summary(stream, state))
}

trait SummaryDelivery {
    fn selectors(&self) -> Option<&[usize]>;
}

impl SummaryDelivery for StreamItem<'static> {
    fn selectors(&self) -> Option<&[usize]> {
        None
    }
}

impl SummaryDelivery for SelectedStreamItem<'static> {
    fn selectors(&self) -> Option<&[usize]> {
        self.as_ref()
            .ok()
            .map(|item| item.value.selectors.as_slice())
    }
}

impl SummaryDelivery for FragmentStreamItem<'static> {
    fn selectors(&self) -> Option<&[usize]> {
        match self.as_ref().ok().map(|item| &item.value) {
            Some(Fragment::Start { selectors, .. }) => Some(selectors),
            _ => None,
        }
    }
}

impl<S: Iterator, E> ParsedStream<S, E> {
    /// Append one summary through iteration. Dropping this wrapper stops work without emitting it.
    #[must_use]
    pub fn with_summary(self) -> Summarized<Self> {
        Summarized::new(self, 0)
    }
}

impl StreamParser {
    /// Append a summary to the drain that ends or stops this stream.
    #[must_use]
    pub fn with_summary(self) -> Summarized<Self> {
        Summarized::new(self, 0)
    }
}

impl SelectedStreamParser {
    /// Append one summary after selected-match delivery finishes or stops.
    #[must_use]
    pub fn with_summary(self) -> Summarized<Self> {
        let selectors = self.selectors;
        Summarized::new(self, selectors)
    }
}

impl FragmentStreamParser {
    /// Append one summary after selected scalar delivery finishes or stops.
    #[must_use]
    pub fn with_summary(self) -> Summarized<Self> {
        let selectors = self.selectors;
        Summarized::new(self, selectors)
    }
}

impl ViewedStreamParser {
    /// Appends a terminal summary while retaining pull-based whole-value views.
    #[must_use]
    pub fn with_summary(self) -> Summarized<Self> {
        Summarized::new(self, 0)
    }
}

impl ViewedSelectedStreamParser {
    /// Appends a terminal summary while retaining pull-based selected views.
    #[must_use]
    pub fn with_summary(self) -> Summarized<Self> {
        let selectors = self.selectors();
        Summarized::new(self, selectors)
    }
}

impl Summarized<SelectedStreamParser> {
    /// Returns the current source account without ending or advancing the stream.
    #[must_use]
    pub fn summary(&self) -> StreamSummary {
        current_summary(&self.inner.stream, &self.state)
    }

    /// Stops the stream without emitting a summary and releases retained input.
    pub fn close(&mut self) {
        self.state.emitted = true;
        self.inner.close();
    }

    /// Yield selected matches from this chunk, followed by a terminal summary when applicable.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = StreamEvent<SelectedStreamItem<'static>>> + 'a {
        let (roots, _) = Drain::feed(&mut self.inner.stream, chunk);
        DeliverySummaryDrain {
            inner: SelectedDrain::new(roots, self.inner.occurrences),
            state: &mut self.state,
            finished: false,
        }
    }

    /// Recover the selected tail, then emit the terminal summary once.
    pub fn end(&mut self) -> impl Iterator<Item = StreamEvent<SelectedStreamItem<'static>>> + '_ {
        DeliverySummaryDrain {
            inner: SelectedDrain::new(Drain::end(&mut self.inner.stream), self.inner.occurrences),
            state: &mut self.state,
            finished: false,
        }
    }
}

impl Summarized<FragmentStreamParser> {
    /// Returns the current source account without ending or advancing the stream.
    #[must_use]
    pub fn summary(&self) -> StreamSummary {
        current_summary(&self.inner.stream, &self.state)
    }

    /// Stops the stream without emitting a summary and releases retained input.
    pub fn close(&mut self) {
        self.state.emitted = true;
        self.inner.close();
    }

    /// Yield scalar events from this chunk, followed by a terminal summary when applicable.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = StreamEvent<FragmentStreamItem<'static>>> + 'a {
        let (roots, reports_reset) = Drain::feed(&mut self.inner.stream, chunk);
        if reports_reset {
            self.inner.reported = crate::parse::Marks::default();
        }
        DeliverySummaryDrain {
            inner: FragmentDrain::new(roots, &mut self.inner.reported),
            state: &mut self.state,
            finished: false,
        }
    }

    /// Recover the scalar tail, then emit the terminal summary once.
    pub fn end(&mut self) -> impl Iterator<Item = StreamEvent<FragmentStreamItem<'static>>> + '_ {
        DeliverySummaryDrain {
            inner: FragmentDrain::new(Drain::end(&mut self.inner.stream), &mut self.inner.reported),
            state: &mut self.state,
            finished: false,
        }
    }
}

impl Summarized<ViewedStreamParser> {
    /// Returns the current source account without ending or advancing the stream.
    #[must_use]
    pub fn summary(&self) -> StreamSummary {
        current_summary(self.inner.stream(), &self.state)
    }

    /// Stops the stream without emitting a summary and releases its retained view.
    pub fn close(&mut self) {
        self.state.emitted = true;
        self.inner.close();
    }

    /// Yields whole-value deltas while keeping the current view available between drains.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = StreamEvent<StreamItem<'static>>> + 'a {
        DeliverySummaryDrain {
            inner: self.inner.feed_drain(chunk),
            state: &mut self.state,
            finished: false,
        }
    }

    /// Finishes the source and appends its single terminal summary.
    pub fn end(&mut self) -> impl Iterator<Item = StreamEvent<StreamItem<'static>>> + '_ {
        DeliverySummaryDrain {
            inner: self.inner.end_drain(),
            state: &mut self.state,
            finished: false,
        }
    }

    /// Borrows the current whole-value view without advancing the stream.
    pub fn view(
        &mut self,
    ) -> Result<
        Option<&super::views::Snapshot<Value<'static>>>,
        super::views::ViewFailure<'_, Value<'static>>,
    > {
        self.inner.view()
    }
}

impl Summarized<ViewedSelectedStreamParser> {
    /// Returns the current source account without ending or advancing the stream.
    #[must_use]
    pub fn summary(&self) -> StreamSummary {
        current_summary(self.inner.stream(), &self.state)
    }

    /// Stops the stream without emitting a summary and releases its retained view.
    pub fn close(&mut self) {
        self.state.emitted = true;
        self.inner.close();
    }

    /// Yields selected deltas while keeping the current view available between drains.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = StreamEvent<SelectedStreamItem<'static>>> + 'a {
        DeliverySummaryDrain {
            inner: self.inner.feed_drain(chunk),
            state: &mut self.state,
            finished: false,
        }
    }

    /// Finishes the source and appends its single terminal summary.
    pub fn end(&mut self) -> impl Iterator<Item = StreamEvent<SelectedStreamItem<'static>>> + '_ {
        DeliverySummaryDrain {
            inner: self.inner.end_drain(),
            state: &mut self.state,
            finished: false,
        }
    }

    /// Borrows the current selected view without advancing the stream.
    pub fn view(&mut self) -> super::views::SelectedViewResult<'_> {
        self.inner.view()
    }
}

impl Summarized<StreamParser> {
    /// Returns the current source account without ending or advancing the stream.
    #[must_use]
    pub fn summary(&self) -> StreamSummary {
        current_summary(&self.inner, &self.state)
    }

    /// Stops the stream without emitting a summary and releases retained input.
    pub fn close(&mut self) {
        self.state.emitted = true;
        self.inner.close();
    }

    /// Yield this chunk's results; a terminal failure is followed by the single summary.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = StreamEvent<StreamItem<'static>>> + 'a {
        SummaryDrain {
            inner: Drain::feed(&mut self.inner, chunk).0,
            state: &mut self.state,
            finished: false,
        }
    }

    /// Recover the tail, then emit the summary; abandoning this drain suppresses later summaries.
    pub fn end(&mut self) -> impl Iterator<Item = StreamEvent<StreamItem<'static>>> + '_ {
        SummaryDrain::<Input<'static>> {
            inner: Drain::end(&mut self.inner),
            state: &mut self.state,
            finished: false,
        }
    }
}

/// Draining a chunk is not source exhaustion; abandoning any drain suppresses terminal delivery.
struct SummaryDrain<'a, C: AsInput> {
    inner: Drain<'a, C>,
    state: &'a mut SummaryState,
    finished: bool,
}

impl<C: AsInput> Iterator for SummaryDrain<'_, C> {
    type Item = StreamEvent<StreamItem<'static>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        if let Some(item) = self.inner.next() {
            return Some(StreamEvent::Item(item));
        }
        self.finished = true;
        whole_summary(self.inner.stream, self.state).map(StreamEvent::Summary)
    }
}

impl<C: AsInput> Drop for SummaryDrain<'_, C> {
    fn drop(&mut self) {
        if !self.finished {
            // Even a terminal failure may already have closed the scanner. Its undelivered
            // summary belongs to this abandoned drain and must not escape through a later call.
            self.state.emitted = true;
        }
    }
}

trait StreamBacked: Iterator {
    fn stream(&self) -> &StreamParser;
}

impl<C: AsInput> StreamBacked for SelectedDrain<'_, C> {
    fn stream(&self) -> &StreamParser {
        self.stream()
    }
}

impl<C: AsInput> StreamBacked for FragmentDrain<'_, C> {
    fn stream(&self) -> &StreamParser {
        self.stream()
    }
}

impl<C: AsInput> StreamBacked for ViewedDrain<'_, C> {
    fn stream(&self) -> &StreamParser {
        self.stream()
    }
}

impl<C: AsInput> StreamBacked for ViewedSelectedDrain<'_, C> {
    fn stream(&self) -> &StreamParser {
        self.stream()
    }
}

struct DeliverySummaryDrain<'a, I> {
    inner: I,
    state: &'a mut SummaryState,
    finished: bool,
}

impl<I> Iterator for DeliverySummaryDrain<'_, I>
where
    I: StreamBacked,
    I::Item: SummaryDelivery,
{
    type Item = StreamEvent<I::Item>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        if let Some(item) = self.inner.next() {
            if let Some(selectors) = item.selectors() {
                self.state.matches += 1;
                for &selector in selectors {
                    self.state.hits[selector] = true;
                }
            }
            return Some(StreamEvent::Item(item));
        }
        self.finished = true;
        whole_summary(self.inner.stream(), self.state).map(StreamEvent::Summary)
    }
}

impl<I> Drop for DeliverySummaryDrain<'_, I> {
    fn drop(&mut self) {
        if !self.finished {
            self.state.emitted = true;
        }
    }
}

impl<S, C, E> Iterator for Summarized<ParsedStream<S, E>>
where
    S: Iterator<Item = Result<C, E>>,
    C: AsInput,
{
    type Item = StreamEvent<OwnedStreamItem<E>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.state.emitted {
            return None;
        }
        if let Some(item) = self.inner.next() {
            return Some(StreamEvent::Item(item));
        }
        whole_summary(&self.inner.stream, &mut self.state).map(StreamEvent::Summary)
    }
}

#[cfg(feature = "async")]
impl<S: futures_core::Stream, E> super::ParsedAsyncStream<S, E> {
    /// Append one summary after asynchronous exhaustion or failure, preserving pending polls.
    #[must_use]
    pub fn with_summary(self) -> Summarized<Self> {
        Summarized::new(self, 0)
    }
}

#[cfg(feature = "async")]
impl<S: futures_core::Stream, E> Summarized<super::ParsedAsyncStream<S, E>> {
    /// Stop delivery and return the producer for caller-owned asynchronous cleanup.
    pub fn into_source(self) -> S {
        self.inner.into_source()
    }
}

#[cfg(feature = "async")]
impl<S, C, E> futures_core::Stream for Summarized<super::ParsedAsyncStream<S, E>>
where
    S: futures_core::Stream<Item = Result<C, E>> + Unpin,
    C: AsInput,
{
    type Item = StreamEvent<OwnedStreamItem<E>>;

    fn poll_next(
        self: core::pin::Pin<&mut Self>,
        cx: &mut core::task::Context<'_>,
    ) -> core::task::Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.state.emitted {
            return core::task::Poll::Ready(None);
        }
        let item = core::task::ready!(core::pin::Pin::new(&mut this.inner).poll_next(cx));
        core::task::Poll::Ready(match item {
            Some(item) => Some(StreamEvent::Item(item)),
            None => whole_summary(&this.inner.stream, &mut this.state).map(StreamEvent::Summary),
        })
    }
}
