//! Report construction and source-preserving repair projections.

use alloc::borrow::Cow;
use alloc::boxed::Box;
use alloc::vec::Vec;

use super::{Marks, Source};
use crate::options::{DiagnosticsMode, Parser};
use crate::outcome::{Failed, ParseFailure, Resource};
use crate::report::{Counts, Diagnostics, ErrorKind, ParseError, Repair, Scope, confidence_of};
use crate::scan::{IssueKind, RawIssue, Refused, ScanError, ScanErrorKind, Scanner};
use crate::value::Value;

pub(super) fn report<'a>(
    scanner: &Scanner<'a>,
    source: &Source<'a>,
    from: Marks,
    index: usize,
) -> Diagnostics<'a> {
    report_from(scanner, source, from, from, index)
}

pub(super) fn stopped_report<'a>(
    scanner: &Scanner<'a>,
    source: &Source<'a>,
    from: Marks,
    index: usize,
) -> Diagnostics<'a> {
    let mut diagnostics = report(scanner, source, from, index);
    diagnostics.scan_complete = false;
    diagnostics
}

pub(super) fn report_from<'a>(
    scanner: &Scanner<'a>,
    source: &Source<'a>,
    entries_from: Marks,
    counts_from: Marks,
    index: usize,
) -> Diagnostics<'a> {
    let repairs: Vec<Repair<'a>> = scanner.repairs()[entries_from.repairs..]
        .iter()
        .map(|raw| Repair {
            kind: raw.kind,
            at: source.position(raw.at),
            path: raw.path.clone(),
            value_index: index,
        })
        .collect();
    let refused: Vec<&RawIssue> = scanner.issues()[entries_from.errors..]
        .iter()
        .filter(|raw| raw.scoped)
        .collect();
    let refused_count = scanner.issues()[counts_from.errors..]
        .iter()
        .filter(|raw| raw.scoped)
        .count();
    // Every error is kept so the outcome cannot depend on a report budget; only the ones the
    // budget had room for are LISTED.
    let errors: Vec<ParseError<'a>> = refused
        .iter()
        .filter(|raw| raw.retained)
        .map(|raw| refused_error(raw, source, index))
        .collect();
    let kinds = &scanner.repair_kinds()[counts_from.kinds..];
    Diagnostics {
        counts: Counts {
            repairs: kinds.len(),
            errors: refused_count,
        },
        // Refusals cost nothing: a declined leniency says the caller would not accept the spelling,
        // not that the value read is less certain. Only repairs move the score.
        confidence: confidence_of(kinds.iter().copied()),
        entries_complete: repairs.len() == kinds.len() && errors.len() == refused_count,
        // A spent budget stopped the scan even where the stop had nowhere left to be RAISED: the
        // unwind that closes what the input left open runs past the last member boundary, so
        // `[{"name": "John"` under `max_errors: 1` reaches the end of the walk with the budget
        // already gone. What the caller is owed is the same either way — this value was not read to
        // its end. Asked of the scanner at the moment the value is produced, so a value completed
        // BEFORE the budget latched still reports the truth about itself.
        scan_complete: !scanner.budget_spent(),
        scope: if scanner.selecting() && !scanner.options.diagnostics.audits() {
            Scope::Selected
        } else {
            Scope::All
        },
        repairs,
        errors,
    }
}

/// A decoder error or policy refusal, as the report entry a caller sees.
///
/// `unparsable-span` for both spelling cases: the span WAS read — that is what makes the recovered
/// value real. Only a switch refusal can name one, so a caller who sees `refused` knows exactly which
/// leniency to turn on rather than loosening everything, and one who does not is being told there is
/// no switch for this. The depth budget is not an unparsable span at all: nothing about the input was
/// unreadable, a bound the caller set stopped it, and saying otherwise blames the document.
pub(super) fn refused_error<'a>(
    raw: &RawIssue,
    source: &Source<'a>,
    index: usize,
) -> ParseError<'a> {
    let location = source.issue_location(raw);
    let (kind, refused) = match raw.kind {
        IssueKind::Refused(Refused::Switch(kind)) => (ErrorKind::UnparsableSpan, Some(kind)),
        IssueKind::Refused(Refused::Unspellable) => (ErrorKind::UnparsableSpan, None),
        IssueKind::Refused(Refused::DangerousKey) => (ErrorKind::DangerousKey, None),
        IssueKind::Refused(Refused::Depth) => (ErrorKind::DepthBudget, None),
        IssueKind::InvalidUtf8 { .. } => (ErrorKind::InvalidUtf8, None),
    };
    ParseError {
        kind,
        at: location.at,
        line: location.line,
        column: location.column,
        context: location.context,
        refused,
        path: raw.path.clone(),
        value_index: index,
    }
}

/// The failure a scan that STOPPED becomes, with whatever it had built attached.
///
/// Distinct from [`super::Reader::declined`], which handles a scan that finished and is refused only for
/// its spelling. Here the scan did not finish, so `scan_complete` is false and the value is a
/// prefix — real data, never padded out to look whole.
///
/// **The strict scanner still refuses where the TypeScript reader RECOVERS** for every kind the
/// port has not yet transliterated; those arrive as `unparsable-span` with no `refused` name,
/// because naming the declined kind means knowing which recovery would have applied.
///
/// `scan_complete` says whether a LIMIT stopped the scan, NOT whether the scan finished — the caller
/// supplies it, because only the scanner knows. A policy the input met — a rejected dangerous key, a
/// refused leniency — ends the read without being a limit, and the failure itself is what tells the
/// caller about it. Reporting those as an incomplete scan claims the reader gave up on input it
/// could still have read, which is what a spent budget means and the one thing a consumer would act
/// on differently.
pub(super) struct RefusalContext<'s, 'a, 'o> {
    pub(super) source: &'s Source<'a>,
    pub(super) options: &'o Parser,
    pub(super) index: usize,
    pub(super) scan_complete: bool,
    pub(super) selected: bool,
}

pub(super) fn refusal<'a>(
    error: &ScanError,
    recovered: Option<Value<'a>>,
    issues: &[RawIssue],
    context: RefusalContext<'_, 'a, '_>,
) -> Box<Failed<'a, ParseFailure<'a>>> {
    let RefusalContext {
        source,
        options,
        index,
        scan_complete,
        selected,
    } = context;
    // A stop that salvaged NOTHING is not a damaged document — the input simply held no JSON, and
    // that is the answer whatever the scan collected on the way. `no-json-found` carries a clean
    // report by construction, so the refusals go with it: they describe constructs inside a value
    // that turned out not to exist, and a reader sent to a member of nothing is worse off than one
    // told plainly there was nothing. Only a stop CAN reach this: a refusal never ends a scan, and
    // the budget is checked before a new token, so a value in hand always finishes and comes back.
    // Measured: `Some text [1, 2, 3] more text {"name": "John"} end` under `maxErrors: 1` stops on
    // the prose word, and the reference answers `no-json-found` with an empty report.
    if recovered.is_none() {
        return bare(ParseFailure::NoJsonFound, options.diagnostics);
    }
    let stopped = || {
        let (line, column) = source.line_column(error.at);
        ParseError {
            kind: match error.kind {
                ScanErrorKind::BadUtf8 => ErrorKind::InvalidUtf8,
                _ => ErrorKind::UnparsableSpan,
            },
            at: source.position(error.at),
            line,
            column,
            context: source.context(error.at),
            refused: None,
            path: error.path.clone(),
            value_index: index,
        }
    };
    // A budget stop is not itself a defect in the input — the refusals it counted are, and each was
    // already recorded with the kind it declined. Reporting the stop as another error would invent
    // an entry naming nothing, so the budget case contributes no entry of its own and the refusals
    // it counted ARE the report.
    let budget = matches!(
        error.kind,
        ScanErrorKind::ErrorBudget | ScanErrorKind::DecodeBudget
    );
    // A depth refusal outranks the stop that followed it, the same precedence `declined` applies to a
    // value that finished: the caller's own bound is what shortened this one, and under `max_errors:
    // 1` the depth refusal IS the error that spent the budget, so reporting the stop instead would
    // hand back a policy refusal naming no policy.
    // Classify from scanner facts, so optional report construction cannot select the failure.
    let depth = issues
        .iter()
        .find(|raw| raw.scoped && raw.refused() == Some(Refused::Depth))
        .map(|raw| source.issue_position(raw));
    let failure = match error.kind {
        ScanErrorKind::Empty => ParseFailure::NoJsonFound,
        _ if depth.is_some() => ParseFailure::LimitReached {
            resource: Resource::Depth,
            limit: options.max_depth.get(),
            at: depth,
            recovered,
        },
        _ => ParseFailure::PolicyRefused {
            issue: if budget {
                issues
                    .iter()
                    .find(|raw| raw.refused().is_some())
                    .map_or_else(stopped, |raw| refused_error(raw, source, index))
            } else {
                stopped()
            },
            recovered,
        },
    };
    Box::new(Failed {
        failure,
        diagnostics: options.diagnostics.reporting().then(|| {
            let mut errors: Vec<_> = issues
                .iter()
                .filter(|raw| raw.scoped)
                .map(|raw| refused_error(raw, source, index))
                .collect();
            if !budget {
                errors.push(stopped());
            }
            Box::new(Diagnostics {
                counts: Counts {
                    repairs: 0,
                    errors: errors.len(),
                },
                errors,
                entries_complete: true,
                scan_complete,
                scope: if selected && !options.diagnostics.audits() {
                    Scope::Selected
                } else {
                    Scope::All
                },
                repairs: Vec::new(),
                confidence: 1.0,
            })
        }),
    })
}

/// Applies the edit log to the source, carrying the value's extent through the splices so the
/// result can be cut down to it.
///
/// Right to left, because each splice shifts every offset after it. Sorted rather than assumed
/// sorted: an edit for an unclosed container is recorded at the END of the input while the repairs
/// inside it were recorded earlier, so the log is not in source order. Ties matter, and are not
/// cosmetic. Every closer for an unclosed document is an insert at the SAME offset — the end of the
/// input — so `{"a":[1,{"b":2` needs `}`, `]`, `}` in that order. Splicing right to left puts the
/// LATER splice's text first in the output, so at equal offsets the later-recorded edit is applied
/// first, which reproduces the recording order: innermost out. Reversing BEFORE a STABLE sort is
/// what carries that tie-break, with no index to thread through.
///
/// No prefilter removes overlapping edits, and none is needed: a construct dropped from the tree has
/// its edits retracted with it, so an edit inside a deleted span cannot reach here. A filter would
/// also be wrong where retraction is right — an inserted comma has zero width and sits at the
/// deleted key's start, so containment cannot distinguish it from an adjacent one.
///
/// Each selected match supplies its log at closure, so ancestor edits at the same offset cannot
/// leak into the selected text. Replacement text is encoded in the original source's units.
pub(super) fn splice<T: Copy>(
    text: &[T],
    log: &[crate::scan::Edit<'_>],
    span: &mut (usize, usize),
    encode: for<'a> fn(&'a str) -> Cow<'a, [T]>,
) -> Vec<T> {
    let mut edits: Vec<&crate::scan::Edit<'_>> = log.iter().rev().collect();
    edits.sort_by_key(|e| core::cmp::Reverse(e.start));
    let mut previous = text.len();
    let mut parts: Vec<Cow<'_, [T]>> = Vec::with_capacity(edits.len() * 2 + 1);
    for e in &edits {
        let replacement = encode(&e.text);
        let delta = replacement.len() as isize - (e.end - e.start) as isize;
        parts.push(Cow::Borrowed(&text[e.end..previous]));
        parts.push(replacement);
        previous = e.start;
        // A zero-width insert AT the extent's end — every closer for an unclosed container is one —
        // satisfies `e.end <= end` and so extends it, which is what keeps `[1,{"b":2` whole.
        //
        // An edit entirely BEFORE the extent slides the WHOLE of it: moving the start alone
        // stretches it by `delta`, so the result carries text the value does not. A byte-order mark
        // is the only edit that precedes a value, and it made `repair` hand back the value plus one
        // character of the prose after it — measured on the reference, which had the same defect.
        if e.end <= span.0 {
            span.0 = span.0.wrapping_add_signed(delta);
            span.1 = span.1.wrapping_add_signed(delta);
        } else if e.end <= span.1 {
            span.1 = span.1.wrapping_add_signed(delta);
        }
    }
    parts.push(Cow::Borrowed(&text[..previous]));
    parts.reverse();
    parts.concat()
}

/// A failure that never reached the scanner. Its report is empty rather than absent, so a caller who
/// asked for one finds it on every branch.
pub(crate) fn bare<'a, F>(failure: F, mode: DiagnosticsMode) -> Box<Failed<'a, F>> {
    Box::new(Failed {
        failure,
        diagnostics: mode
            .reporting()
            .then(|| Box::new(crate::report::clean_diagnostics::<'a>())),
    })
}
