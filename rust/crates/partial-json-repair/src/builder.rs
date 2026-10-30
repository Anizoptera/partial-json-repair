//! Owns the value frames and rewind marks that turn scanned tokens into one recovered tree.

use alloc::borrow::Cow;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

pub(crate) const FRAGMENT_UNITS: usize = 4096;

use crate::canonical::write_f64;
use crate::outcome::ScalarKind;
use crate::report::{PathStep, SourcePath};
use crate::selector::{Label, Placement, Selection};
use crate::value::{JsonString, Number, Object, Value};

mod positions;

/// All state whose depth must stay aligned with value construction.
///
/// Keeping the container stack, selector levels, and skip boundary behind one owner makes a stream
/// suspend and resume them as one unit. Selection build modes belong here too: adding them to the
/// scanner would create a second stack whose correctness depended on matching every unwind path.
#[derive(Default)]
pub(crate) struct Builder<'a> {
    pub(crate) stack: Vec<Frame<'a>>,
    labels: Option<Vec<Option<PathStep<'static>>>>,
    pending_view: Option<PendingContainer>,
    pub(crate) selection: Option<Selection<'static>>,
    modes: Vec<BuildMode>,
    frames: Vec<BuildFrame>,
    occurrences: Vec<Occurrence<'a>>,
    next_occurrence: usize,
    matched_from: Option<usize>,
    finished_frame_skipped: Option<bool>,
    fragmenting: bool,
    fragments: Vec<RawFragment>,
    active_fragment: Option<ActiveFragment>,
    next_fragment: usize,
    retained: usize,
    retained_limit: Option<usize>,
    retained_failure: Option<usize>,
}

impl Builder<'_> {
    /// Detaches unfinished containers from the source while preserving selector progress.
    pub(crate) fn into_owned(self) -> Builder<'static> {
        Builder {
            stack: self.stack.into_iter().map(Frame::into_owned).collect(),
            labels: self.labels,
            pending_view: self.pending_view,
            selection: self.selection,
            modes: self.modes,
            frames: self.frames,
            occurrences: self
                .occurrences
                .into_iter()
                .map(Occurrence::into_owned)
                .collect(),
            next_occurrence: self.next_occurrence,
            matched_from: self.matched_from,
            finished_frame_skipped: self.finished_frame_skipped,
            fragmenting: self.fragmenting,
            fragments: self.fragments,
            active_fragment: self.active_fragment,
            next_fragment: self.next_fragment,
            retained: self.retained,
            retained_limit: self.retained_limit,
            retained_failure: self.retained_failure,
        }
    }
}

/// A fragment before source offsets are converted to caller positions.
pub(crate) enum RawFragment {
    Start {
        id: usize,
        path: SourcePath<'static>,
        selectors: Vec<usize>,
        scalar: ScalarKind,
    },
    Data {
        id: usize,
        text: JsonString<'static>,
    },
    End {
        id: usize,
        start: usize,
        end: usize,
    },
    NonScalar {
        path: SourcePath<'static>,
    },
}

#[derive(Clone, Copy)]
struct ActiveFragment {
    id: usize,
    start: usize,
    decoded_source: usize,
    /// A high surrogate cannot leave before the next decoded unit decides whether it is paired.
    tail: Option<u16>,
}

/// Whether a frame retains values, only carries selector traversal, or cannot contain a match.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BuildMode {
    Built,
    Transit,
    Dead,
}

#[derive(Clone, Copy)]
enum PendingContainer {
    Object,
    Array,
}

/// Selection facts fixed when a container opens and completed when it closes.
struct BuildFrame {
    occurrence: Option<usize>,
    matched_keys: Vec<JsonString<'static>>,
}

/// One selected source node, held until its root is accepted.
#[derive(Clone)]
pub(crate) struct Occurrence<'a> {
    pub(crate) sequence: usize,
    pub(crate) value: Option<Value<'a>>,
    pub(crate) path: SourcePath<'static>,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) selectors: Vec<usize>,
    pub(crate) close_edit: usize,
}

impl Occurrence<'_> {
    fn into_owned(self) -> Occurrence<'static> {
        Occurrence {
            sequence: self.sequence,
            value: self.value.map(Value::into_owned),
            path: self.path,
            start: self.start,
            end: self.end,
            selectors: self.selectors,
            close_edit: self.close_edit,
        }
    }
}

impl<'a> Builder<'a> {
    /// Replaces the compiled selector state before any input is read.
    pub(crate) fn select(&mut self, selection: Option<Selection<'static>>) {
        self.selection = selection;
    }

    /// Enables the stream-only bound on recovered content still owned by the parser.
    pub(crate) fn limit_retained(&mut self, limit: usize) {
        self.retained_limit = Some(limit);
    }

    /// Retains path labels only for an explicitly requested snapshot stream.
    pub(crate) fn view(&mut self) {
        self.labels = Some(Vec::new());
    }

    pub(crate) fn stage_view_container(&mut self, object: bool) {
        if self.labels.is_some() {
            self.pending_view = Some(if object {
                PendingContainer::Object
            } else {
                PendingContainer::Array
            });
        }
    }

    pub(crate) fn clear_view_container(&mut self) {
        self.pending_view = None;
    }

    pub(crate) fn view_container(&self) -> Option<Value<'static>> {
        match self.pending_view {
            Some(PendingContainer::Object) => Some(Value::Object(Default::default())),
            Some(PendingContainer::Array) => Some(Value::Array(Vec::new())),
            None => None,
        }
    }

    pub(crate) fn retained_mark(&self) -> usize {
        self.retained
    }

    pub(crate) fn retract_retained(&mut self, mark: usize) {
        self.retained = mark;
        self.retained_failure = None;
    }

    pub(crate) fn retained_failure(&self) -> Option<usize> {
        self.retained_failure
    }

    pub(crate) fn would_exceed_retained(&self, units: usize) -> bool {
        self.retained_limit
            .is_some_and(|limit| self.retained.saturating_add(units) > limit)
    }

    fn charge(&mut self, units: usize, at: usize) {
        if self.retained_limit.is_none() {
            return;
        }
        self.retained = self.retained.saturating_add(units);
        if self.retained > self.retained_limit.unwrap_or(usize::MAX) {
            self.retained_failure.get_or_insert(at);
        }
    }

    /// Switches selected scalar delivery from final matches to source fragments.
    pub(crate) fn fragment(&mut self, selection: Selection<'static>) {
        self.selection = Some(selection);
        self.fragmenting = true;
    }

    /// Starts a fresh recognized root after the previous root's deliveries were taken.
    pub(crate) fn begin_root(&mut self) {
        self.stack.clear();
        self.pending_view = None;
        if let Some(labels) = &mut self.labels {
            labels.clear();
        }
        self.modes.clear();
        self.frames.clear();
        self.occurrences.clear();
        self.matched_from = None;
        self.finished_frame_skipped = None;
        self.active_fragment = None;
        self.retained = 0;
        self.retained_failure = None;
    }

    /// Removes and returns selected nodes completed by the accepted root.
    pub(crate) fn take_occurrences(&mut self) -> Vec<Occurrence<'a>> {
        core::mem::take(&mut self.occurrences)
    }

    pub(crate) fn occurrences_after(&self, sequence: usize) -> Vec<Occurrence<'static>> {
        let first = self
            .occurrences
            .partition_point(|occurrence| occurrence.sequence < sequence);
        self.occurrences[first..]
            .iter()
            .filter(|occurrence| occurrence.value.is_some())
            .cloned()
            .map(Occurrence::into_owned)
            .collect()
    }

    /// Removes fragment events completed since the previous drain.
    pub(crate) fn take_fragments(&mut self) -> Vec<RawFragment> {
        core::mem::take(&mut self.fragments)
    }

    /// Pending events are a reason to yield before reading another scalar.
    pub(crate) fn has_fragments(&self) -> bool {
        !self.fragments.is_empty()
    }

    /// Closes a stopped root without turning unbuilt frames into placeholder values.
    pub(crate) fn salvage(&mut self, end: usize, close_edit: usize) -> Option<Value<'a>> {
        let mut done = None;
        while let Some(frame) = self.stack.pop() {
            if let Some(labels) = &mut self.labels {
                labels.pop();
            }
            let mode = self
                .modes
                .pop()
                .unwrap_or_else(|| unreachable!("every open frame has one build mode"));
            let build = self
                .frames
                .pop()
                .unwrap_or_else(|| unreachable!("every open frame has build metadata"));
            if mode == BuildMode::Built {
                let value = close(frame, done.take());
                if let Some(at) = build.occurrence {
                    let occurrence = &mut self.occurrences[at];
                    occurrence.value = Some(value.clone());
                    occurrence.end = end;
                    occurrence.close_edit = close_edit;
                }
                done = Some(value);
            } else {
                done = None;
            }
        }
        done
    }

    /// Number of occurrences held by the current reversible scan branch.
    pub(crate) fn occurrence_mark(&self) -> usize {
        self.occurrences.len()
    }

    /// Removes occurrences created by a candidate or member the scanner retracted.
    pub(crate) fn retract_occurrences(&mut self, mark: usize) {
        self.occurrences.truncate(mark);
    }

    /// Whether diagnostics at the innermost open frame belong to the requested result.
    pub(crate) fn in_scope(&self) -> bool {
        !matches!(self.modes.last(), Some(BuildMode::Dead))
    }

    /// Stores the innermost object's pending key and charges it only when that object is retained.
    pub(crate) fn key(&mut self, pending: PendingKey<'a>) {
        if matches!(self.modes.last(), Some(BuildMode::Built)) {
            self.charge(string_units(&pending.key), pending.at);
        }
        *self
            .stack
            .last_mut()
            .and_then(Frame::pending_mut)
            .unwrap_or_else(|| unreachable!("called only with an open object frame")) =
            Some(pending);
    }

    /// Whether a `select` list changes this builder's result shape and report scope.
    pub(crate) fn selecting(&self) -> bool {
        self.selection.as_ref().is_some_and(Selection::selecting)
    }

    /// Copies the open root without consuming the scanner state that will finish it.
    pub(crate) fn snapshot(&self, pending: Option<Value<'static>>) -> Option<Value<'static>> {
        self.snapshot_from(0, pending)
    }

    fn snapshot_from(
        &self,
        start: usize,
        pending: Option<Value<'static>>,
    ) -> Option<Value<'static>> {
        let mut inner = pending;
        for (frame, mode) in self.stack.iter().zip(&self.modes).skip(start).rev() {
            inner = if *mode == BuildMode::Built {
                Some(close(frame.clone().into_owned(), inner))
            } else {
                None
            };
        }
        inner
    }

    pub(crate) fn snapshot_occurrences(
        &self,
        pending: Option<Value<'static>>,
    ) -> Vec<Occurrence<'static>> {
        self.occurrences
            .iter()
            .enumerate()
            .filter_map(|(at, occurrence)| {
                let mut occurrence = occurrence.clone().into_owned();
                if occurrence.value.is_none() {
                    let frame = self
                        .frames
                        .iter()
                        .position(|frame| frame.occurrence == Some(at))?;
                    occurrence.value = self.snapshot_from(frame, pending.clone());
                }
                occurrence.value.as_ref()?;
                Some(occurrence)
            })
            .collect()
    }

    /// Path of the open container, extended to the unfinished string slot when one exists.
    pub(crate) fn snapshot_path(
        &self,
        pending: bool,
        pending_container: bool,
    ) -> SourcePath<'static> {
        let selecting = self.selecting();
        let open_match = self.frames.iter().position(|frame| {
            frame
                .occurrence
                .is_some_and(|at| self.occurrences[at].value.is_none())
        });
        let mut path: SourcePath<'static> = self
            .labels
            .iter()
            .flatten()
            .zip(&self.modes)
            .enumerate()
            .skip(1)
            .filter_map(|(depth, (label, mode))| {
                (open_match.is_some_and(|start| depth >= start)
                    || self.occurrences.is_empty()
                    || *mode != BuildMode::Dead)
                    .then_some(label.as_ref())
                    .flatten()
            })
            .cloned()
            .collect();
        if pending && (!selecting || pending_container || open_match.is_some()) {
            path.extend(path_of(&self.stack).into_iter().next_back());
        }
        path
    }

    /// Starts a selected scalar occurrence once the enclosing root is known to be JSON.
    pub(crate) fn begin_fragmented_scalar(
        &mut self,
        start: usize,
        established: bool,
        scalar: ScalarKind,
    ) -> bool {
        if !self.fragmenting || !established {
            return false;
        }
        if self
            .active_fragment
            .is_some_and(|active| active.start == start)
        {
            return true;
        }
        let (placement, path) = self.classify_next();
        if placement.skipped || placement.hits.is_empty() {
            return false;
        }
        let id = self.next_fragment;
        self.next_fragment += 1;
        self.fragments.push(RawFragment::Start {
            id,
            path,
            selectors: placement.hits,
            scalar,
        });
        self.active_fragment = Some(ActiveFragment {
            id,
            start,
            decoded_source: start + usize::from(scalar == ScalarKind::String),
            tail: None,
        });
        true
    }

    /// The source position already decoded, including a high surrogate waiting for its partner.
    pub(crate) fn fragment_source(&self) -> Option<usize> {
        self.active_fragment.map(|active| active.decoded_source)
    }

    /// Slice at a decoded offset while retaining the original source end for replay suppression.
    pub(crate) fn fragment_text(&mut self, from: usize, end: usize, text: &JsonString<'_>) {
        let Some(active) = self.active_fragment.as_mut() else {
            return;
        };
        if end <= active.decoded_source {
            return;
        }
        let piece = match text {
            JsonString::Text(text) => {
                let Some(piece) = text.get(from..) else {
                    return;
                };
                JsonString::Text(Cow::Owned(piece.to_string()))
            }
            JsonString::Units(units) => {
                let Some(piece) = units.get(from..) else {
                    return;
                };
                JsonString::Units(Cow::Owned(piece.to_vec()))
            }
        };
        active.decoded_source = end;
        self.fragment_piece(piece);
    }

    /// Emits one decoded escape after every source unit producing it has arrived.
    pub(crate) fn fragment_decoded(&mut self, end: usize, text: JsonString<'static>) {
        let Some(active) = self.active_fragment.as_mut() else {
            return;
        };
        if end <= active.decoded_source {
            return;
        }
        active.decoded_source = end;
        self.fragment_piece(text);
    }

    /// Bound caller-visible pieces without splitting a Unicode scalar or surrogate pair.
    fn fragment_piece(&mut self, text: JsonString<'static>) {
        if text.code_units().count() <= FRAGMENT_UNITS {
            self.push_fragment_piece(text);
            return;
        }
        match text {
            JsonString::Text(text) => {
                let mut start = 0;
                while start < text.len() {
                    let mut end = start;
                    let mut units = 0;
                    for (offset, character) in text[start..].char_indices() {
                        let width = character.len_utf16();
                        if units + width > FRAGMENT_UNITS {
                            break;
                        }
                        units += width;
                        end = start + offset + character.len_utf8();
                    }
                    self.push_fragment_piece(JsonString::Text(Cow::Owned(
                        text[start..end].to_string(),
                    )));
                    start = end;
                }
            }
            JsonString::Units(units) => {
                let mut start = 0;
                while start < units.len() {
                    let mut end = (start + FRAGMENT_UNITS).min(units.len());
                    if end < units.len()
                        && (0xd800..0xdc00).contains(&units[end - 1])
                        && (0xdc00..0xe000).contains(&units[end])
                    {
                        end -= 1;
                    }
                    self.push_fragment_piece(JsonString::Units(Cow::Owned(
                        units[start..end].to_vec(),
                    )));
                    start = end;
                }
            }
        }
    }

    /// Join only a pending surrogate; ordinary decoded pieces move directly into delivery.
    fn push_fragment_piece(&mut self, mut text: JsonString<'static>) {
        if text.code_units().next().is_none() {
            return;
        }
        let Some(active) = self.active_fragment.as_mut() else {
            return;
        };
        if let Some(high) = active.tail.take() {
            if let JsonString::Units(units) = &mut text
                && units
                    .first()
                    .is_some_and(|unit| (0xdc00..0xe000).contains(unit))
            {
                units.to_mut().insert(0, high);
            } else {
                self.fragments.push(RawFragment::Data {
                    id: active.id,
                    text: JsonString::Units(Cow::Owned(alloc::vec![high])),
                });
            }
        }
        if let JsonString::Units(units) = &mut text
            && units
                .last()
                .is_some_and(|unit| (0xd800..0xdc00).contains(unit))
        {
            active.tail = units.to_mut().pop();
        }
        if text.code_units().next().is_some() {
            self.fragments.push(RawFragment::Data {
                id: active.id,
                text,
            });
        }
    }

    /// End of a scalar or terminal failure makes a pending high surrogate an unpaired unit.
    pub(crate) fn flush_fragment_tail(&mut self) {
        if let Some(active) = self.active_fragment.as_mut()
            && let Some(high) = active.tail.take()
        {
            self.fragments.push(RawFragment::Data {
                id: active.id,
                text: JsonString::Units(Cow::Owned(alloc::vec![high])),
            });
        }
    }

    /// Opens a container after classifying its relationship to selection.
    pub(crate) fn open(&mut self, frame: Frame<'a>, start: usize) {
        let (placement, path) = self.classify_next();
        let label = path.last().cloned();
        let mut mode = self.mode_for(&placement);
        if self.fragmenting && !placement.hits.is_empty() {
            self.fragments
                .push(RawFragment::NonScalar { path: path.clone() });
            mode = BuildMode::Dead;
        }
        let occurrence = (!self.fragmenting && !placement.hits.is_empty()).then(|| {
            let at = self.occurrences.len();
            self.occurrences.push(Occurrence {
                sequence: self.next_occurrence,
                value: None,
                path,
                start,
                end: start,
                selectors: placement.hits,
                close_edit: 0,
            });
            self.next_occurrence += 1;
            at
        });
        let depth = self.stack.len();
        if mode == BuildMode::Built {
            self.charge(1, start);
        }
        if occurrence.is_some() && self.matched_from.is_none() {
            self.matched_from = Some(depth);
        }
        let frame = if mode == BuildMode::Built {
            frame
        } else {
            match frame {
                Frame::Array(_) => Frame::UnbuiltArray(0),
                Frame::Object(_, pending, _) => Frame::UnbuiltObject(pending),
                Frame::UnbuiltArray(_) | Frame::UnbuiltObject(_) => frame,
            }
        };
        self.stack.push(frame);
        if let Some(labels) = &mut self.labels {
            labels.push(label);
        }
        self.modes.push(mode);
        self.frames.push(BuildFrame {
            occurrence,
            matched_keys: Vec::new(),
        });
        if let Some(at) = occurrence {
            self.hold(at);
        }
    }

    /// Closes the innermost frame and completes any match recorded at its opener.
    pub(crate) fn close(
        &mut self,
        inner: Option<Value<'a>>,
        end: usize,
        close_edit: usize,
    ) -> Value<'a> {
        let frame = self
            .stack
            .pop()
            .unwrap_or_else(|| unreachable!("a frame is open before it closes"));
        if let Some(labels) = &mut self.labels {
            labels.pop();
        }
        let mode = self
            .modes
            .pop()
            .unwrap_or_else(|| unreachable!("every open frame has one build mode"));
        let built = close(frame, inner);
        let depth = self.stack.len();
        let build = self
            .frames
            .pop()
            .unwrap_or_else(|| unreachable!("every open frame has build metadata"));
        if let Some(at) = build.occurrence {
            let occurrence = &mut self.occurrences[at];
            occurrence.value = Some(built.clone());
            occurrence.end = end;
            occurrence.close_edit = close_edit;
        }
        if self.matched_from == Some(depth) {
            self.matched_from = None;
        }
        self.finished_frame_skipped = Some(mode != BuildMode::Built);
        built
    }

    /// Classifies and records a completed node immediately before its parent receives it.
    pub(crate) fn place(
        &mut self,
        value: &Value<'a>,
        start: usize,
        end: usize,
        close_edit: usize,
    ) -> bool {
        if let Some(skipped) = self.finished_frame_skipped.take() {
            if skipped
                && let Some(frame @ (Frame::UnbuiltArray(_) | Frame::UnbuiltObject(_))) =
                    self.stack.last_mut()
            {
                frame.place(Value::Null);
            }
            return skipped;
        }
        let (placement, path) = self.classify_next();
        let matched = !placement.hits.is_empty();
        if self.fragmenting && !placement.hits.is_empty() {
            self.emit_scalar(value, path, placement.hits, start, end);
        } else if !placement.hits.is_empty() {
            let at = self.occurrences.len();
            self.occurrences.push(Occurrence {
                sequence: self.next_occurrence,
                value: Some(value.clone()),
                path,
                start,
                end,
                selectors: placement.hits,
                close_edit,
            });
            self.next_occurrence += 1;
            self.hold(at);
        }
        let retained = !placement.skipped
            && !self.fragmenting
            && (matches!(self.modes.last(), Some(BuildMode::Built))
                || matched
                || self.stack.is_empty());
        if retained {
            self.charge(value_size(value), start);
        }
        let skipped = placement.skipped || (self.fragmenting && self.active_fragment.is_none());
        // Discarded content still occupies its source array index. Unbuilt frames keep only that
        // position, so advancing them cannot retain a value the caller did not select.
        if skipped && let Some(frame @ Frame::UnbuiltArray(_)) = self.stack.last_mut() {
            frame.place(Value::Null);
        }
        skipped
    }

    fn mode_for(&self, placement: &Placement) -> BuildMode {
        if matches!(self.modes.last(), Some(BuildMode::Dead)) || placement.skipped {
            BuildMode::Dead
        } else if !placement.hits.is_empty() || self.matched_from.is_some() {
            BuildMode::Built
        } else if self.selection.as_ref().is_some_and(Selection::selecting) {
            if placement.dead {
                BuildMode::Dead
            } else {
                BuildMode::Transit
            }
        } else {
            BuildMode::Built
        }
    }

    fn emit_scalar(
        &mut self,
        value: &Value<'_>,
        path: SourcePath<'static>,
        selectors: Vec<usize>,
        start: usize,
        end: usize,
    ) {
        self.flush_fragment_tail();
        if let Some(active) = self.active_fragment.take() {
            self.fragments.push(RawFragment::End {
                id: active.id,
                start,
                end,
            });
            return;
        }
        let id = self.next_fragment;
        self.next_fragment += 1;
        let (scalar, text) = fragment_value(value);
        self.fragments.push(RawFragment::Start {
            id,
            path,
            selectors,
            scalar,
        });
        self.fragments.push(RawFragment::Data { id, text });
        self.fragments.push(RawFragment::End { id, start, end });
    }

    /// Remembers which object members currently own retained final matches.
    fn hold(&mut self, occurrence: usize) {
        let path = &self.occurrences[occurrence].path;
        for (at, step) in path.iter().take(self.frames.len()).enumerate() {
            let PathStep::Key(key) = step else {
                continue;
            };
            if !self.stack[at].is_object() {
                continue;
            }
            let keys = &mut self.frames[at].matched_keys;
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }

    /// Removes final matches beneath an object member that a later member replaces.
    fn supersede(&mut self, frame: usize, path: &SourcePath<'static>) {
        let Some(PathStep::Key(key)) = path.last() else {
            return;
        };
        if !self.frames[frame].matched_keys.contains(key) {
            return;
        }
        for build in &mut self.frames {
            let Some(at) = build.occurrence else {
                continue;
            };
            if self.occurrences[at].path.starts_with(path) {
                build.occurrence = None;
            } else {
                let removed = self.occurrences[..at]
                    .iter()
                    .filter(|occurrence| occurrence.path.starts_with(path))
                    .count();
                build.occurrence = Some(at - removed);
            }
        }
        self.occurrences
            .retain(|occurrence| !occurrence.path.starts_with(path));
    }

    fn classify_next(&mut self) -> (Placement, SourcePath<'static>) {
        if self.selection.is_none() && self.labels.is_none() {
            return (Placement::default(), Vec::new());
        }
        let path = path_of(&self.stack);
        if self.selection.is_none() {
            return (Placement::default(), path);
        }
        let depth = self.stack.len();
        if depth > 0 {
            self.supersede(depth - 1, &path);
        }
        let selection = self.selection.as_mut().expect("selection checked above");
        let Some(parent) = self.stack.last() else {
            return (selection.placement(None), path);
        };
        if matches!(self.modes.last(), Some(BuildMode::Dead)) {
            return (
                Placement {
                    dead: true,
                    ..Placement::default()
                },
                path,
            );
        }
        let label = match parent {
            Frame::Array(items) => Label::Index(items.len()),
            Frame::UnbuiltArray(count) => Label::Index(*count),
            Frame::Object(_, Some(pending), _) | Frame::UnbuiltObject(Some(pending)) => {
                Label::Key(&pending.key)
            }
            Frame::Object(_, None, _) | Frame::UnbuiltObject(None) => {
                return (Placement::default(), path);
            }
        };
        (selection.placement(Some((depth - 1, label))), path)
    }
}

fn fragment_value(value: &Value<'_>) -> (ScalarKind, JsonString<'static>) {
    match value {
        Value::String(text) => (ScalarKind::String, text.clone().into_owned()),
        Value::Number(Number::Exact(text)) => (
            ScalarKind::Number,
            JsonString::Text(Cow::Owned(text.to_string())),
        ),
        Value::Number(Number::Double(number)) => {
            let mut text = String::new();
            if number.is_nan() {
                text.push_str("NaN");
            } else if number.is_infinite() {
                text.push_str(if number.is_sign_positive() {
                    "Infinity"
                } else {
                    "-Infinity"
                });
            } else {
                write_f64(*number, &mut text);
            }
            (ScalarKind::Number, JsonString::Text(Cow::Owned(text)))
        }
        Value::Bool(value) => (
            ScalarKind::Literal,
            JsonString::Text(Cow::Borrowed(if *value { "true" } else { "false" })),
        ),
        Value::Null => (ScalarKind::Literal, JsonString::Text(Cow::Borrowed("null"))),
        Value::Undefined => (
            ScalarKind::Literal,
            JsonString::Text(Cow::Borrowed("undefined")),
        ),
        Value::Array(_) | Value::Object(_) => {
            unreachable!("fragment mode rejects selected containers before scalar delivery")
        }
    }
}

fn string_units(value: &JsonString<'_>) -> usize {
    match value {
        JsonString::Text(text) => text.encode_utf16().count(),
        JsonString::Units(units) => units.len(),
    }
}

fn value_size(value: &Value<'_>) -> usize {
    match value {
        Value::String(text) => 1 + string_units(text),
        Value::Number(Number::Exact(text)) => 1 + text.len(),
        Value::Null
        | Value::Bool(_)
        | Value::Number(Number::Double(_))
        | Value::Undefined
        | Value::Array(_)
        | Value::Object(_) => 1,
    }
}

/// How far each scanner log had been written when a reversible build decision began.
///
/// The positions travel as one value because a dropped member or rejected candidate must restore
/// every log to the same boundary; separate counters can silently retain an edit after removing the
/// repair that explained it.
#[derive(Clone, Copy, Default)]
pub(crate) struct Logged {
    /// Retained repair entries.
    pub(crate) repairs: usize,
    /// Refusal entries that decide the outcome.
    pub(crate) issues: usize,
    /// Source rewrites retained for `repair`.
    pub(crate) edits: usize,
    /// Every repair kind, including entries omitted by the diagnostics storage budget.
    pub(crate) kinds: usize,
    /// Selected occurrences held by the reversible scan branch.
    pub(crate) occurrences: usize,
    /// Parser-owned recovered content charged by the stream-only retained bound.
    pub(crate) content: usize,
}

/// A key that has been read and is waiting for its value.
///
/// Its source position anchors member-level diagnostics. The log mark removes every trace of a
/// member whose value never arrives, because that member never enters the recovered tree.
#[derive(Clone)]
pub(crate) struct PendingKey<'a> {
    pub(crate) key: JsonString<'a>,
    pub(crate) at: usize,
    /// The member's own separator; nested values overwrite the scanner's latest comma.
    pub(crate) comma: Option<usize>,
    pub(crate) mark: Logged,
}

impl PendingKey<'_> {
    fn into_owned(self) -> PendingKey<'static> {
        PendingKey {
            key: self.key.into_owned(),
            at: self.at,
            comma: self.comma,
            mark: self.mark,
        }
    }
}

/// An open container, holding what has been built so far.
///
/// An explicit stack rather than recursion makes depth an ordinary bounded number. An object keeps
/// its pending key separate because a member exists only once its value arrives; a refused object
/// remains refused for the rest of its lifetime so later members cannot silently repopulate it.
#[derive(Clone)]
pub(crate) enum Frame<'a> {
    Array(Vec<Value<'a>>),
    Object(Object<'a>, Option<PendingKey<'a>>, bool),
    UnbuiltArray(usize),
    UnbuiltObject(Option<PendingKey<'a>>),
}

impl Frame<'_> {
    /// Detaches the unfinished frame from the source before a stream buffer can move.
    pub(crate) fn into_owned(self) -> Frame<'static> {
        match self {
            Self::Array(items) => Frame::Array(items.into_iter().map(Value::into_owned).collect()),
            Self::Object(object, pending, refused) => Frame::Object(
                object.into_owned(),
                pending.map(PendingKey::into_owned),
                refused,
            ),
            Self::UnbuiltArray(count) => Frame::UnbuiltArray(count),
            Self::UnbuiltObject(pending) => {
                Frame::UnbuiltObject(pending.map(PendingKey::into_owned))
            }
        }
    }
}

impl<'a> Frame<'a> {
    /// Puts a completed value into this container when a lawful destination exists.
    pub(crate) fn place(&mut self, value: Value<'a>) {
        match self {
            Self::Array(items) => items.push(value),
            Self::Object(object, pending, refused) => {
                if let Some(pending) = pending.take()
                    && !*refused
                {
                    object.insert(pending.key, value);
                }
            }
            Self::UnbuiltArray(count) => *count += 1,
            Self::UnbuiltObject(pending) => {
                pending.take();
            }
        }
    }

    pub(crate) fn is_object(&self) -> bool {
        matches!(self, Self::Object(..) | Self::UnbuiltObject(_))
    }

    pub(crate) fn pending(&self) -> Option<&PendingKey<'a>> {
        match self {
            Self::Object(_, pending, _) | Self::UnbuiltObject(pending) => pending.as_ref(),
            Self::Array(_) | Self::UnbuiltArray(_) => None,
        }
    }

    pub(crate) fn pending_mut(&mut self) -> Option<&mut Option<PendingKey<'a>>> {
        match self {
            Self::Object(_, pending, _) | Self::UnbuiltObject(pending) => Some(pending),
            Self::Array(_) | Self::UnbuiltArray(_) => None,
        }
    }
}

/// Derives the current source path from the only stack that owns container progress.
///
/// Paths are needed only for diagnostics, so deriving them on that cold path avoids maintaining a
/// second label stack on every container operation. Keys are detached because scan errors outlive
/// the source borrow.
pub(crate) fn path_of(stack: &[Frame<'_>]) -> SourcePath<'static> {
    stack
        .iter()
        .filter_map(|frame| match frame {
            Frame::Array(items) => Some(PathStep::Index(items.len())),
            Frame::Object(_, pending, _) => pending
                .as_ref()
                .map(|pending| PathStep::Key(pending.key.clone().into_owned())),
            Frame::UnbuiltArray(count) => Some(PathStep::Index(*count)),
            Frame::UnbuiltObject(pending) => pending
                .as_ref()
                .map(|pending| PathStep::Key(pending.key.clone().into_owned())),
        })
        .collect()
}

/// Closes one frame around an unfinished inner value without manufacturing a missing member.
pub(crate) fn close<'a>(mut frame: Frame<'a>, inner: Option<Value<'a>>) -> Value<'a> {
    if let Some(value) = inner {
        frame.place(value);
    }
    match frame {
        Frame::Array(items) => Value::Array(items),
        Frame::Object(object, _, _) => Value::Object(object),
        Frame::UnbuiltArray(_) | Frame::UnbuiltObject(_) => Value::Null,
    }
}
