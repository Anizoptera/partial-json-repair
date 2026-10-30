//! Pull-based snapshots whose borrow prevents the stream from changing underneath them.

use super::selected::SelectedDrain;
use super::values::Drain;
use super::{SelectedStreamItem, SelectedStreamParser, StreamItem, StreamParser};
use crate::outcome::{Match, ParseFailure};
use crate::parse::{AsInput, Input};
use crate::report::SourcePath;
use crate::value::Value;

/// One root as it stood when [`ViewedStreamParser::view`] was called.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot<T> {
    /// Recovered content available at the time of the call.
    pub value: T,
    /// Zero-based recognized-root index.
    pub value_index: usize,
    /// Whether this root has finished.
    pub complete: bool,
    /// Where the unfinished token or innermost open container sits.
    pub partial_path: Option<SourcePath<'static>>,
}

/// Snapshot shape for a stream configured with selectors.
pub type SelectedSnapshot = Snapshot<alloc::vec::Vec<Match<Value<'static>>>>;

/// Borrowed selected view or its stopped/refused outcome.
pub type SelectedViewResult<'a> =
    Result<Option<&'a SelectedSnapshot>, ViewFailure<'a, alloc::vec::Vec<Match<Value<'static>>>>>;

/// A stopped or refused root remains a failure while exposing any available view.
#[derive(Clone, Copy, Debug)]
pub struct ViewFailure<'a, T> {
    /// The reason processing stopped.
    pub failure: &'a ParseFailure<'static>,
    /// Data recovered before the failure.
    pub recovered: Option<&'a Snapshot<T>>,
}

enum ViewState<T> {
    Success(Snapshot<T>),
    Failed {
        failure: ParseFailure<'static>,
        recovered: Option<Snapshot<T>>,
    },
}

/// A manual stream that retains only the current root for explicit views.
pub struct ViewedStreamParser {
    stream: StreamParser,
    state: Option<ViewState<Value<'static>>>,
    next_index: usize,
}

/// A selected stream retaining only the matches belonging to its current root.
pub struct ViewedSelectedStreamParser {
    stream: SelectedStreamParser,
    state: Option<ViewState<alloc::vec::Vec<Match<Value<'static>>>>>,
    matches: alloc::vec::Vec<Match<Value<'static>>>,
    value_index: usize,
}

impl ViewedStreamParser {
    pub(super) fn new(mut stream: StreamParser) -> Self {
        stream.scan = stream.scan.with_view();
        Self {
            stream,
            state: None,
            next_index: 0,
        }
    }

    pub(super) fn stream(&self) -> &StreamParser {
        &self.stream
    }

    /// Advances the stream lazily and remembers only roots actually delivered by this drain.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = StreamItem<'static>> + 'a {
        self.feed_drain(chunk)
    }

    /// Finishes the source and remembers the final delivered or recovered root.
    pub fn end(&mut self) -> impl Iterator<Item = StreamItem<'static>> + '_ {
        self.end_drain()
    }

    /// Returns the open root, otherwise the last root delivered, without retaining history.
    pub fn view(
        &mut self,
    ) -> Result<Option<&Snapshot<Value<'static>>>, ViewFailure<'_, Value<'static>>> {
        if matches!(self.state, Some(ViewState::Failed { .. })) {
            return failed(&self.state);
        }
        if let Some((value, partial_path)) = self.stream.scan.snapshot() {
            self.state = Some(ViewState::Success(Snapshot {
                value,
                value_index: self.next_index,
                complete: false,
                partial_path: Some(partial_path),
            }));
        } else if matches!(
            self.state,
            Some(ViewState::Success(Snapshot {
                complete: false,
                ..
            }))
        ) {
            self.state = None;
        }
        match self.state.as_ref() {
            None => Ok(None),
            Some(ViewState::Success(snapshot)) => Ok(Some(snapshot)),
            Some(ViewState::Failed { failure, recovered }) => Err(ViewFailure {
                failure,
                recovered: recovered.as_ref(),
            }),
        }
    }

    /// Stops parsing and releases retained source and snapshot state.
    pub fn close(&mut self) {
        self.stream.close();
        self.state = None;
    }

    pub(super) fn feed_drain<C: AsInput>(&mut self, chunk: C) -> ViewedDrain<'_, C> {
        ViewedDrain {
            inner: Drain::feed(&mut self.stream, chunk).0,
            state: &mut self.state,
            next_index: &mut self.next_index,
        }
    }

    pub(super) fn end_drain(&mut self) -> ViewedDrain<'_, Input<'static>> {
        ViewedDrain {
            inner: Drain::end(&mut self.stream),
            state: &mut self.state,
            next_index: &mut self.next_index,
        }
    }
}

pub(super) struct ViewedDrain<'a, C: AsInput> {
    inner: Drain<'a, C>,
    state: &'a mut Option<ViewState<Value<'static>>>,
    next_index: &'a mut usize,
}

impl<C: AsInput> Iterator for ViewedDrain<'_, C> {
    type Item = StreamItem<'static>;

    fn next(&mut self) -> Option<Self::Item> {
        let item = self.inner.next()?;
        remember(&item, self.state, self.next_index);
        Some(item)
    }
}

impl<C: AsInput> ViewedDrain<'_, C> {
    pub(super) fn stream(&self) -> &StreamParser {
        self.inner.stream
    }
}

impl ViewedSelectedStreamParser {
    pub(super) fn new(mut stream: SelectedStreamParser) -> Self {
        stream.stream.scan = stream.stream.scan.with_view();
        Self {
            stream,
            state: None,
            matches: alloc::vec::Vec::new(),
            value_index: 0,
        }
    }

    /// Advances selected delivery and marks the snapshot complete only when the drain exhausts.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = SelectedStreamItem<'static>> + 'a {
        self.feed_drain(chunk)
    }

    /// Finishes selected delivery and retains the final root's matches as one complete view.
    pub fn end(&mut self) -> impl Iterator<Item = SelectedStreamItem<'static>> + '_ {
        self.end_drain()
    }

    /// Returns held matches plus the single selected container still being assembled.
    pub fn view(&mut self) -> SelectedViewResult<'_> {
        if matches!(self.state, Some(ViewState::Failed { .. })) {
            return failed(&self.state);
        }
        if let Some((occurrences, partial_path)) = self.stream.stream.scan.selected_snapshot() {
            let values = occurrences
                .into_iter()
                .filter_map(|occurrence| {
                    Some(Match {
                        value: occurrence.value?,
                        path: occurrence.path,
                        value_index: self.value_index,
                        span: self
                            .stream
                            .stream
                            .buffer
                            .span(occurrence.start, occurrence.end)?,
                        selectors: occurrence.selectors,
                    })
                })
                .collect();
            self.state = Some(ViewState::Success(Snapshot {
                value: values,
                value_index: self.value_index,
                complete: false,
                partial_path: Some(partial_path),
            }));
        } else if matches!(
            self.state,
            Some(ViewState::Success(Snapshot {
                complete: false,
                ..
            }))
        ) {
            self.state = None;
        }
        match self.state.as_ref() {
            None => Ok(None),
            Some(ViewState::Success(snapshot)) => Ok(Some(snapshot)),
            Some(ViewState::Failed { failure, recovered }) => Err(ViewFailure {
                failure,
                recovered: recovered.as_ref(),
            }),
        }
    }

    /// Stops parsing and releases retained input, matches, and snapshot state.
    pub fn close(&mut self) {
        self.stream.stream.close();
        self.state = None;
        self.matches.clear();
    }

    pub(super) fn selectors(&self) -> usize {
        self.stream.selectors
    }

    pub(super) fn stream(&self) -> &StreamParser {
        &self.stream.stream
    }

    pub(super) fn feed_drain<C: AsInput>(&mut self, chunk: C) -> ViewedSelectedDrain<'_, C> {
        ViewedSelectedDrain::new(
            self.stream.feed_drain(chunk),
            &mut self.matches,
            &mut self.state,
            &mut self.value_index,
        )
    }

    pub(super) fn end_drain(&mut self) -> ViewedSelectedDrain<'_, Input<'static>> {
        ViewedSelectedDrain::new(
            self.stream.end_drain(),
            &mut self.matches,
            &mut self.state,
            &mut self.value_index,
        )
    }
}

pub(super) struct ViewedSelectedDrain<'a, C: AsInput> {
    inner: SelectedDrain<'a, C>,
    matches: &'a mut alloc::vec::Vec<Match<Value<'static>>>,
    state: &'a mut Option<ViewState<alloc::vec::Vec<Match<Value<'static>>>>>,
    value_index: &'a mut usize,
}

impl<'a, C: AsInput> ViewedSelectedDrain<'a, C> {
    fn new(
        inner: SelectedDrain<'a, C>,
        matches: &'a mut alloc::vec::Vec<Match<Value<'static>>>,
        state: &'a mut Option<ViewState<alloc::vec::Vec<Match<Value<'static>>>>>,
        value_index: &'a mut usize,
    ) -> Self {
        Self {
            inner,
            matches,
            state,
            value_index,
        }
    }

    pub(super) fn stream(&self) -> &StreamParser {
        self.inner.stream()
    }
}

impl<C: AsInput> Iterator for ViewedSelectedDrain<'_, C> {
    type Item = SelectedStreamItem<'static>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(item) = self.inner.next() {
            let recovered = item.is_err().then(|| self.inner.take_recovered());
            remember_match(&item, recovered, self.matches, self.state, self.value_index);
            return Some(item);
        }
        let delivered = self.inner.stream().delivered;
        if delivered > *self.value_index && !matches!(self.state, Some(ViewState::Failed { .. })) {
            let completed = delivered - 1;
            if *self.value_index != completed {
                self.matches.clear();
            }
            *self.state = Some(ViewState::Success(Snapshot {
                value: self.matches.clone(),
                value_index: completed,
                complete: true,
                partial_path: None,
            }));
            self.matches.clear();
            *self.value_index = delivered;
        }
        None
    }
}

fn failed<T>(state: &Option<ViewState<T>>) -> Result<Option<&Snapshot<T>>, ViewFailure<'_, T>> {
    match state {
        Some(ViewState::Failed { failure, recovered }) => Err(ViewFailure {
            failure,
            recovered: recovered.as_ref(),
        }),
        _ => unreachable!("called only for a failed view"),
    }
}

fn remember_match(
    item: &SelectedStreamItem<'static>,
    recovered: Option<alloc::vec::Vec<Match<Value<'static>>>>,
    matches: &mut alloc::vec::Vec<Match<Value<'static>>>,
    state: &mut Option<ViewState<alloc::vec::Vec<Match<Value<'static>>>>>,
    value_index: &mut usize,
) {
    match item {
        Ok(success) => {
            if success.value.value_index != *value_index {
                matches.clear();
                *value_index = success.value.value_index;
            }
            matches.push(success.value.clone());
        }
        Err(failed) => {
            if matches!(
                failed.failure,
                ParseFailure::PolicyRefused { .. } | ParseFailure::LimitReached { .. }
            ) {
                *state = Some(ViewState::Failed {
                    failure: failed.failure.clone(),
                    recovered: Some(Snapshot {
                        value: recovered.unwrap_or_else(|| matches.clone()),
                        value_index: *value_index,
                        complete: false,
                        partial_path: None,
                    }),
                });
            }
        }
    }
}

fn remember(
    item: &StreamItem<'static>,
    state: &mut Option<ViewState<Value<'static>>>,
    next_index: &mut usize,
) {
    match item {
        Ok(success) => {
            *state = Some(ViewState::Success(Snapshot {
                value: success.value.clone(),
                value_index: *next_index,
                complete: true,
                partial_path: None,
            }));
            *next_index += 1;
        }
        Err(failed) => {
            if let failure @ (ParseFailure::PolicyRefused { recovered, .. }
            | ParseFailure::LimitReached { recovered, .. }) = &failed.failure
            {
                *state = Some(ViewState::Failed {
                    failure: failure.clone(),
                    recovered: recovered.clone().map(|value| Snapshot {
                        value,
                        value_index: *next_index,
                        complete: false,
                        partial_path: None,
                    }),
                });
            }
        }
    }
}
