//! The whole-input verbs, and the one scan all four are projections of.
//!
//! `parse` takes the first value, `parse_many` keeps taking, `find_json_span` keeps the extent and
//! drops the value, and `repair` slices the source by that extent. Sharing one scan is not a tidying
//! — it is what makes asking for a span cost nothing, and it is why the four cannot disagree about
//! what counts as a value.
//!
//! **`repair` splices the source; it never re-serialises the tree.** Re-serialising would normalise
//! key order, turn `1.50` into `1.5` and drop everything outside the value, so a document needing no
//! repair would come back changed. Splicing means an untouched document is returned byte-identical
//! because nothing was spliced, not because a serialiser happened to agree.
//!
//! The scanner has ONE coordinate — an original-unit offset — and every reported source position
//! asks the source adapter that fed it. A second coordinate system inside the scan loop is a
//! second mechanism reading the same bytes, which is the defect this package exists without.

use alloc::boxed::Box;
use alloc::vec::Vec;

use crate::builder::RawFragment;
use crate::options::{DEFAULTS, Parser};
use crate::outcome::{
    Failed, Fragment, Match, Outcome, ParseFailure, RepairFailure, Resource, Success,
};
use crate::report::Span;
use crate::scan::{Refused, ScanErrorKind, Scanner, Spanned};
use crate::selector::Selection;
use crate::value::{JsonString, Value};

#[cfg(feature = "boundary")]
mod boundary;
mod continuation;
#[cfg(feature = "boundary")]
#[doc(hidden)]
pub use boundary::{BoundaryKind, BoundaryOperation, BoundaryOutcome, BoundaryStep, Stopped};
mod diagnostics;
mod input;
mod locations;
mod projection;
mod selected;
mod source;

pub(crate) use continuation::PausedReader;
pub use input::{AsInput, InputSlice};

pub use source::Input;
use source::Source;
pub(crate) use source::{Chunk, LineColumn, StreamInput};

pub(crate) use diagnostics::bare;
use diagnostics::{
    RefusalContext, refusal, refused_error, report, report_from, splice, stopped_report,
};
pub use selected::SelectedIter;

/// Where one value's entries begin in the scanner's logs.
///
/// The scanner logs across every value it reads, so a report for value N must start where value N
/// began. Separate marks rather than one because the logs advance independently — a value may add to
/// any of them, or to none.
#[derive(Clone, Copy, Default)]
pub(crate) struct Marks {
    pub(crate) repairs: usize,
    pub(crate) errors: usize,
    /// Into the scanner's uncapped record of repair KINDS, which is what the count and the score are
    /// read from: `max_diagnostics` caps `repairs`, and a report must state what happened rather
    /// than what it had room to keep.
    pub(crate) kinds: usize,
}

/// One value's report, sliced from the scanner's log.
///
/// `confidence` is computed from EVERY repair, retained or not, because a cap on what is stored
/// must never raise the score.
/// Reads values out of one source, sharing a single scan between the verbs.
///
/// Public because `parse_many` is an iterator over it: a caller who stops reading stops the scan,
/// which is the whole reason the many-value verb is lazy rather than an eager list.
pub struct Reader<'a> {
    scanner: Scanner<'a>,
    source: Source<'a>,
    /// Full whole-input source and the prefix currently visible to the scanner. Streams own their
    /// input window externally and leave this empty.
    whole_input: Option<(crate::scan::Units<'a>, usize)>,
    options: &'a Parser,
    index: usize,
    /// Where this value's entries begin in the scanner's logs, so each value reports its own.
    logged: Marks,
    /// The original-unit extent of the value last read, for verbs returning source rather than the
    /// value. Kept here so one scan answers every verb: asking for a span costs no second pass.
    extent: (usize, usize),
    /// Set once a refusal has been delivered: a scan that refused cannot be resumed, and yielding
    /// past it would report the same failure for ever.
    done: bool,
    /// First object rejected only for missing required keys, retained for a useful no-match failure.
    compatible: Option<Value<'a>>,
}

pub(crate) enum ReaderStep<'a> {
    Checkpoint,
    Item(Outcome<'a, Value<'a>, ParseFailure<'a>>),
    Complete,
}

impl<'a> Reader<'a> {
    const WHOLE_INPUT_SLICE: usize = 4096;

    /// One reader over one source. Every whole-input verb is built on this, so all of them share a
    /// single scan and a single idea of what a value is.
    /// `edits` asks the scan to record the source rewrites `repair` splices. Only `repair` wants
    /// them, and `src/AGENTS.md` rules that a call pays only for what it asked for.
    fn new(
        input: Input<'a>,
        options: &'a Parser,
        edits: bool,
    ) -> Result<Self, Box<Failed<'a, ParseFailure<'a>>>> {
        // Before the source is even decoded: options that cannot be compiled describe a parser that
        // cannot exist, and every verb built on this reader owes the same refusal.
        let selection = match options.selection() {
            Ok(selection) => selection,
            Err(failure) => {
                return Err(bare(
                    ParseFailure::InvalidOptions {
                        field: failure.field,
                        reason: failure.reason,
                    },
                    options.diagnostics,
                ));
            }
        };
        Self::with_selection(input, options, edits, selection)
    }

    fn with_selection(
        input: Input<'a>,
        options: &'a Parser,
        edits: bool,
        selection: Option<Selection<'static>>,
    ) -> Result<Self, Box<Failed<'a, ParseFailure<'a>>>> {
        match Source::new(input) {
            Ok(source) => {
                let supplied = source.input.len().min(Self::WHOLE_INPUT_SLICE);
                Ok(Self {
                    scanner: match edits {
                        true => source.scanner_prefix(options, supplied).with_edits(),
                        false => source.scanner_prefix(options, supplied),
                    }
                    .with_selection(selection),
                    whole_input: Some((source.input, supplied)),
                    source,
                    options,
                    index: 0,
                    logged: Marks {
                        repairs: 0,
                        errors: 0,
                        kinds: 0,
                    },
                    extent: (0, 0),
                    done: false,
                    compatible: None,
                })
            }
            Err(encoding) => Err(bare(
                ParseFailure::UnsupportedEncoding { encoding },
                options.diagnostics,
            )),
        }
    }

    /// A reader over a stream's buffer as it now stands, continuing the scan `state` paused.
    ///
    /// The SAME reader every whole-input verb uses, which is the point: a stream shapes values,
    /// spans and reports through one mechanism rather than a parallel one that would drift. Its
    /// iterator stops at a pause exactly as it stops at the end of input, so the values it yields
    /// are already the delta this chunk completed.
    ///
    /// `delivered` continues the stream's value index. Reuse candidate bounds between pulls;
    /// only a new chunk changes the input extent.
    pub(crate) fn resume_chunk(
        input: StreamInput<'a>,
        options: &'a Parser,
        state: PausedReader,
        delivered: usize,
        changed: bool,
    ) -> Self {
        let StreamInput {
            input,
            ready,
            chunks,
            start,
            unit,
            origin,
        } = input;
        Self {
            scanner: Scanner::resume_chunk(input.prefix(ready), options, state.scan, changed),
            whole_input: None,
            source: Source {
                input,
                unit,
                chunks,
                start,
                origin,
                locations: state.locations,
            },
            options,
            index: delivered,
            logged: Marks {
                repairs: 0,
                errors: 0,
                kinds: 0,
            },
            extent: (0, 0),
            done: false,
            compatible: state.compatible,
        }
    }

    /// Gives up the buffer, keeping the scan so the next chunk can continue it.
    pub(crate) fn suspend(mut self, releasing_input: bool) -> (PausedReader, usize) {
        if releasing_input {
            self.source.capture_issue_locations(
                self.scanner.issues(),
                self.logged.errors,
                self.options.diagnostics.reporting(),
            );
            if self.options.diagnostics.reporting()
                || self.options.recover != crate::options::Recovery::ALL
                || !self.options.repair_broken
                || self.options.on_dangerous_key == crate::options::DangerousKeyPolicy::Reject
            {
                self.source.capture_marks(&self.scanner);
            }
        }
        (
            PausedReader {
                scan: self.scanner.suspend(),
                locations: self.source.locations,
                compatible: self.compatible.map(Value::into_owned),
            },
            self.index,
        )
    }

    /// A stopped reader must not restart merely because its consumer asks for another result.
    pub(crate) const fn is_done(&self) -> bool {
        self.done
    }

    pub(crate) fn is_yielding(&self) -> bool {
        self.scanner.is_yielding()
    }

    pub(crate) fn no_match(&mut self) -> Box<Failed<'a, ParseFailure<'a>>> {
        bare(
            ParseFailure::NoMatch {
                required_keys: self.options.required_keys.clone(),
                recovered: self.compatible.take(),
            },
            self.options.diagnostics,
        )
    }

    fn exhausted(&mut self) -> Box<Failed<'a, ParseFailure<'a>>> {
        if self.options.filters_roots() && self.index > 0 {
            self.no_match()
        } else {
            bare(ParseFailure::NoJsonFound, self.options.diagnostics)
        }
    }

    /// A spent policy budget stops inspection even when a recovered root was returned.
    pub(crate) fn budget_spent(&self) -> bool {
        // A bare token may finish the next decoder piece before the error stop is reported.
        // Closing while it waits would discard both its partial value and the terminal outcome.
        self.scanner.budget_spent()
            && self.scanner.word.is_none()
            && self.scanner.number_extent.is_none()
    }

    /// Declares the stream over, so what is still open is damage to repair rather than delay.
    pub(crate) fn no_more_input(&mut self) {
        self.scanner.no_more_input();
    }

    fn shape<T>(&self, value: T, at: Option<(usize, usize)>) -> Success<'a, T> {
        Success {
            value,
            span: at.and_then(|(start, end)| {
                self.options.locations.then(|| self.source.span(start, end))
            }),
            diagnostics: self
                .options
                .diagnostics
                .reporting()
                .then(|| Box::new(report(&self.scanner, &self.source, self.logged, self.index))),
        }
    }

    /// Project retained matches directly into the caller's destination without an intermediate log.
    pub(crate) fn take_matches(&mut self) -> impl Iterator<Item = Match<Value<'a>>> + '_ {
        let index = self.index.saturating_sub(1);
        self.scanner
            .take_occurrences()
            .into_iter()
            .filter_map(move |occurrence| {
                occurrence.value.map(|value| Match {
                    value,
                    path: occurrence.path,
                    value_index: index,
                    span: self.source.span(occurrence.start, occurrence.end),
                    selectors: occurrence.selectors,
                })
            })
    }

    pub(crate) fn matches_after(&self, sequence: usize) -> (usize, Vec<Match<Value<'static>>>) {
        let index = self.index.saturating_sub(1);
        let occurrences = self.scanner.occurrences_after(sequence);
        let next = occurrences
            .last()
            .map_or(sequence, |occurrence| occurrence.sequence + 1);
        let matches = occurrences
            .into_iter()
            .filter_map(|occurrence| {
                occurrence.value.map(|value| Match {
                    value,
                    path: occurrence.path,
                    value_index: index,
                    span: self.source.span(occurrence.start, occurrence.end),
                    selectors: occurrence.selectors,
                })
            })
            .collect();
        (next, matches)
    }

    pub(crate) fn take_fragments<'r>(
        &'r mut self,
        value_index: usize,
        reported: &'r mut Marks,
        stopped: bool,
    ) -> impl Iterator<Item = Outcome<'static, Fragment, ParseFailure<'static>>> + 'r {
        let fragments = self.scanner.take_fragments(stopped);
        fragments.into_iter().map(move |fragment| {
            let diagnostics = self.options.diagnostics.reporting().then(|| {
                Box::new(
                    report_from(
                        &self.scanner,
                        &self.source,
                        *reported,
                        self.logged,
                        value_index,
                    )
                    .into_owned(),
                )
            });
            *reported = self.current_marks();
            match fragment {
                RawFragment::Start {
                    id,
                    path,
                    selectors,
                    scalar,
                } => Ok(Success {
                    value: Fragment::Start {
                        id,
                        value_index,
                        path,
                        selectors,
                        scalar,
                    },
                    span: None,
                    diagnostics,
                }),
                RawFragment::Data { id, text } => Ok(Success {
                    value: Fragment::Data { id, text },
                    span: None,
                    diagnostics,
                }),
                RawFragment::End { id, start, end } => Ok(Success {
                    value: Fragment::End {
                        id,
                        span: self.source.span(start, end),
                    },
                    span: None,
                    diagnostics,
                }),
                RawFragment::NonScalar { path } => Err(Box::new(Failed {
                    failure: ParseFailure::NonScalarSelection { path },
                    diagnostics,
                })),
            }
        })
    }

    fn current_marks(&self) -> Marks {
        Marks {
            repairs: self.scanner.repairs().len(),
            errors: self.scanner.issues().len(),
            kinds: self.scanner.repair_kinds().len(),
        }
    }

    pub(crate) const fn value_index(&self) -> usize {
        self.index
    }

    pub(crate) fn retained_source(&self) -> usize {
        self.source
            .input
            .len()
            .saturating_sub(self.scanner.releasable_prefix())
    }

    pub(crate) fn resource_limit(
        &mut self,
        resource: Resource,
        limit: usize,
    ) -> Box<Failed<'a, ParseFailure<'a>>> {
        // Report the undecided syntax, not the storage prefix retained for an open root.
        let at = self.scanner.at;
        let recovered = self.scanner.salvage();
        Box::new(Failed {
            failure: ParseFailure::LimitReached {
                resource,
                limit,
                at: Some(self.source.position(at)),
                recovered,
            },
            diagnostics: self.options.diagnostics.reporting().then(|| {
                Box::new(stopped_report(
                    &self.scanner,
                    &self.source,
                    self.logged,
                    self.index,
                ))
            }),
        })
    }

    /// A complete value the options refuse to call a success, because a leniency it needed was off.
    ///
    /// The FIRST refusal is the issue: it is the one a caller acts on, and the rest are in the
    /// report when one was asked for.
    ///
    /// **A depth refusal outranks every spelling one, wherever it sits in the log.** The caller's own
    /// bound is what shortened the value, so naming a declined leniency instead would send them to
    /// loosen a switch that changes nothing — and `limit-reached` is the outcome the same input
    /// carries when the bound stops the scan outright.
    fn declined(&self, value: Value<'a>) -> Box<Failed<'a, ParseFailure<'a>>> {
        let issues = &self.scanner.issues()[self.logged.errors..];
        let failure = match issues
            .iter()
            .find(|raw| raw.refused() == Some(Refused::Depth))
        {
            Some(depth) => ParseFailure::LimitReached {
                resource: Resource::Depth,
                limit: self.options.max_depth.get(),
                at: Some(self.source.issue_position(depth)),
                recovered: Some(value),
            },
            None => ParseFailure::PolicyRefused {
                issue: refused_error(
                    issues
                        .iter()
                        .find(|raw| raw.refused().is_some())
                        .expect("caller found a refusal"),
                    &self.source,
                    self.index,
                ),
                recovered: Some(value),
            },
        };
        Box::new(Failed {
            failure,
            diagnostics: self
                .options
                .diagnostics
                .reporting()
                .then(|| Box::new(report(&self.scanner, &self.source, self.logged, self.index))),
        })
    }
}

impl<'a> Reader<'a> {
    fn next_visible(&mut self) -> Option<Outcome<'a, Value<'a>, ParseFailure<'a>>> {
        loop {
            if self.done {
                return None;
            }
            // Asked of the SCANNER rather than read off the log lengths, because a value resumed across
            // a chunk boundary began before this reader did and its report must reach back that far.
            let (repairs, errors, kinds) = self.scanner.value_mark();
            self.logged = Marks {
                repairs,
                errors,
                kinds,
            };
            let read = match self.scanner.next_value() {
                Some(read) => read,
                None => {
                    let whole_can_advance = self
                        .whole_input
                        .is_some_and(|(input, supplied)| supplied < input.len());
                    self.done = !whole_can_advance && !self.scanner.is_yielding();
                    return None;
                }
            };
            let outcome = match read {
                Ok(Spanned { value, start, end }) => {
                    self.extent = (start, end);
                    let stopped = self.scanner.budget_spent();
                    let refused = self.scanner.issues()[self.logged.errors..]
                        .iter()
                        .any(|raw| raw.refused().is_some());
                    let accepted = self.scanner.accepts_root();
                    if !refused && !accepted {
                        let _ = self.scanner.take_occurrences();
                        if self.compatible.is_none()
                            && !self.options.required_keys.is_empty()
                            && self.scanner.root_is_object()
                        {
                            self.compatible = Some(value);
                        }
                        self.index += 1;
                        self.done = stopped;
                        continue;
                    }
                    let read = match refused {
                        // The scan finished and the value is complete; what the caller declined is the
                        // SPELLING, so the data is handed back through `recovered` rather than thrown
                        // away. `HLD.md`: a policy refusal is never an ordinary success, and never a
                        // reason to discard what was read.
                        true => Err(self.declined(value)),
                        false => Ok(self.shape(value, Some((start, end)))),
                    };
                    // Counted AFTER the report is built: `value_index` names the value the entry belongs
                    // to, and the value being read is the one `self.index` already names.
                    self.index += 1;
                    self.done = stopped;
                    read
                }
                Err(error) => {
                    self.done = true;
                    let error_budget = matches!(
                        error.kind,
                        ScanErrorKind::ErrorBudget | ScanErrorKind::DecodeBudget
                    );
                    if matches!(
                        error.kind,
                        ScanErrorKind::ScalarBudget | ScanErrorKind::RetainedBudget
                    ) || (error_budget
                        && self
                            .scanner
                            .issues()
                            .last()
                            .is_some_and(|raw| raw.refused().is_none()))
                    {
                        let recovered = if error_budget {
                            self.scanner
                                .finish_decode_stop(error.kind == ScanErrorKind::DecodeBudget)
                        } else {
                            self.scanner.salvage()
                        };
                        if error_budget && recovered.is_none() {
                            return Some(Err(bare(
                                ParseFailure::NoJsonFound,
                                self.options.diagnostics,
                            )));
                        }
                        let (resource, limit) = match error.kind {
                            ScanErrorKind::ScalarBudget => {
                                (Resource::Scalar, self.options.max_scalar.get())
                            }
                            ScanErrorKind::RetainedBudget => {
                                (Resource::Retained, self.options.max_retained.get())
                            }
                            ScanErrorKind::ErrorBudget | ScanErrorKind::DecodeBudget => {
                                (Resource::Errors, self.options.max_errors.get())
                            }
                            _ => unreachable!("guarded above"),
                        };
                        return Some(Err(Box::new(Failed {
                            failure: ParseFailure::LimitReached {
                                resource,
                                limit,
                                at: Some(if error_budget {
                                    self.scanner.issues().last().map_or_else(
                                        || self.source.position(error.at),
                                        |issue| self.source.issue_position(issue),
                                    )
                                } else {
                                    self.source.position(error.at)
                                }),
                                recovered,
                            },
                            diagnostics: self.options.diagnostics.reporting().then(|| {
                                Box::new(stopped_report(
                                    &self.scanner,
                                    &self.source,
                                    self.logged,
                                    self.index,
                                ))
                            }),
                        })));
                    }
                    let selected = self.scanner.selecting();
                    let recovered = self.scanner.salvage();
                    Err(refusal(
                        &error,
                        recovered,
                        &self.scanner.issues()[self.logged.errors..],
                        RefusalContext {
                            source: &self.source,
                            options: self.options,
                            index: self.index,
                            scan_complete: !self.scanner.budget_spent(),
                            selected,
                        },
                    ))
                }
            };
            return Some(outcome);
        }
    }

    pub(crate) fn advance(&mut self) -> ReaderStep<'a> {
        let item = self.next_visible();
        if let Some(item) = item {
            return ReaderStep::Item(item);
        }
        if self.is_yielding() || self.done {
            return ReaderStep::Complete;
        }
        let Some((input, supplied)) = &mut self.whole_input else {
            return ReaderStep::Complete;
        };
        if *supplied == input.len() {
            return ReaderStep::Complete;
        }
        *supplied = supplied
            .saturating_add(Self::WHOLE_INPUT_SLICE)
            .min(input.len());
        self.scanner
            .extend_whole_input(input.prefix(*supplied), *supplied == input.len());
        ReaderStep::Checkpoint
    }
}

impl<'a> Iterator for Reader<'a> {
    type Item = Outcome<'a, Value<'a>, ParseFailure<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self.advance() {
                ReaderStep::Checkpoint => {}
                ReaderStep::Item(item) => return Some(item),
                ReaderStep::Complete => return None,
            }
        }
    }
}

impl Parser {
    /// Every value in the input, lazily, each with its own outcome and report.
    ///
    /// Lazy rather than a list because the iterator stops scanning when its consumer stops: a caller who
    /// wants the first two values of a megabyte of records must not pay for the rest. A refusal is the
    /// last item — this scanner cannot resume past one.
    ///
    /// # Errors
    /// Yields the input's declared encoding as a single failed item when it is one this package refuses.
    pub fn parse_many<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
    ) -> impl Iterator<Item = Outcome<'a, Value<'a>, ParseFailure<'a>>> {
        // Both arms are iterators of the same item, so the encoding refusal is delivered THROUGH the
        // iteration rather than beside it: a caller draining the verb meets every failure the same way.
        match Reader::new(input.into(), self, false) {
            Ok(reader) => Iter::Reading {
                reader: Box::new(reader),
                silent: true,
            },
            Err(failure) => Iter::Refused(Some(Err(failure))),
        }
    }

    /// The FIRST value in the input. The rest is not read.
    ///
    /// A caller who wants every value asks [`parse_many`], and one who wants the first should not pay
    /// for the others. Input holding no value at all is `no-json-found`, which is NOT the same as
    /// parsing the literal `null`: absence and a null value stay distinguishable without inspecting the
    /// value.
    ///
    /// # Errors
    /// Returns the first refusal, with whatever had been built attached to it.
    pub fn parse<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
    ) -> Outcome<'a, Value<'a>, ParseFailure<'a>> {
        self.parse_many(input)
            .next()
            .unwrap_or_else(|| Err(bare(ParseFailure::NoJsonFound, self.diagnostics)))
    }

    /// The extent of the first value in the source, or why there is none.
    ///
    /// The same scan as [`parse`], so the two cannot disagree about what counts as a value. The span is
    /// present here whatever `locations` says: it is the answer, not an annotation on one.
    ///
    /// # Errors
    /// Returns the same refusal [`parse`] would.
    pub fn find_json_span<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
    ) -> Outcome<'a, Span, ParseFailure<'a>> {
        let mut reader = Reader::new(input.into(), self, false)?;
        let outcome = reader.first();
        reader.span(outcome)
    }

    /// The source with its repairs applied, as TEXT.
    ///
    /// What a caller needs when the JSON must be handed to something else — a log, another service, a
    /// schema validator. The result is the VALUE's extent, not the whole document, so the fenced block a
    /// model wrapped it in does not come back with it.
    ///
    /// Borrowed while nothing has been spliced, which is the honest reading of "an untouched document is
    /// returned unchanged": the bytes handed back ARE the caller's bytes.
    ///
    /// # Errors
    /// Returns the same refusal [`parse`] would; text holding no value is `no-json-found`.
    pub fn repair<'a>(
        &'a self,
        input: impl Into<Input<'a>>,
    ) -> Outcome<'a, JsonString<'a>, RepairFailure<'a>> {
        let mut reader = Reader::new(input.into(), self, true).map_err(|e| {
            Box::new(Failed {
                failure: RepairFailure::Parse(e.failure),
                diagnostics: e.diagnostics,
            })
        })?;
        let outcome = reader.first();
        reader.repair(outcome)
    }
}

/// The two shapes `parse_many` can be in, as one iterator type.
enum Iter<'a> {
    /// Boxed because a reader carries the whole scanner, which is hundreds of bytes, and this enum
    /// is returned BY VALUE from a public verb — every caller's frame would carry it, and every
    /// `next()` moves it. One allocation per `parse_many` call, against a scan that allocates per
    /// value, is not a cost the caller can measure.
    Reading {
        reader: Box<Reader<'a>>,
        /// Whether the iteration has said nothing at all yet. An input holding no candidate must
        /// answer `no-json-found` rather than run dry in silence: a caller draining the verb cannot
        /// otherwise tell "there was no JSON here" from "there is none LEFT", and the single-value
        /// verbs on the same scan do say it. Cleared by the first item of either kind — a refusal is
        /// an answer too, so a stopped scan is not also called empty.
        silent: bool,
    },
    Refused(Option<Outcome<'a, Value<'a>, ParseFailure<'a>>>),
}

impl<'a> Iterator for Iter<'a> {
    type Item = Outcome<'a, Value<'a>, ParseFailure<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Reading { reader, silent } => match reader.next() {
                Some(item) => {
                    *silent = false;
                    Some(item)
                }
                None if *silent => {
                    *silent = false;
                    Some(Err(reader.exhausted()))
                }
                None => None,
            },
            Self::Refused(item) => item.take(),
        }
    }
}

/// Every value in the input, under the shipped defaults. [`Parser::parse_many`] configured.
pub fn parse_many<'a>(
    input: impl Into<Input<'a>>,
) -> impl Iterator<Item = Outcome<'a, Value<'a>, ParseFailure<'a>>> {
    DEFAULTS.parse_many(input)
}

/// The first value in the input, under the shipped defaults. [`Parser::parse`] configured.
///
/// # Errors
/// Returns the first refusal, with whatever had been built attached to it.
pub fn parse<'a>(input: impl Into<Input<'a>>) -> Outcome<'a, Value<'a>, ParseFailure<'a>> {
    DEFAULTS.parse(input)
}

/// The extent of the first value, under the shipped defaults. [`Parser::find_json_span`] configured.
///
/// # Errors
/// Returns the same refusal [`parse`] would.
pub fn find_json_span<'a>(input: impl Into<Input<'a>>) -> Outcome<'a, Span, ParseFailure<'a>> {
    DEFAULTS.find_json_span(input)
}

/// The source with its repairs applied, under the shipped defaults. [`Parser::repair`] configured.
///
/// # Errors
/// Returns the same refusal [`parse`] would; text holding no value is `no-json-found`.
pub fn repair<'a>(input: impl Into<Input<'a>>) -> Outcome<'a, JsonString<'a>, RepairFailure<'a>> {
    DEFAULTS.repair(input)
}

#[cfg(test)]
mod tests {
    use super::{Input, Reader, ReaderStep};
    use crate::Parser;
    use alloc::format;

    #[test]
    fn whole_reader_exposes_bounded_progress() {
        let input = format!("{{\"data\":\"{}\"}}", "x".repeat(10_000));
        let parser = Parser::default();
        let mut reader = Reader::new(Input::Text(&input), &parser, false).expect("valid reader");

        assert!(matches!(reader.advance(), ReaderStep::Checkpoint));
        assert!(matches!(reader.advance(), ReaderStep::Checkpoint));
        assert!(matches!(reader.advance(), ReaderStep::Item(Ok(_))));
        assert!(matches!(reader.advance(), ReaderStep::Complete));
    }
}
