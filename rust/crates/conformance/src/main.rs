//! Replays a recorded contract (`scripts/corpus/record.ts --out`) against this crate and reports every answer that differs.
//!
//! **This is a second PRODUCER for one comparison, never a second harness.** What a case observes is
//! defined once, in `scripts/corpus/observe.ts`; nothing here decides what to look at. The observed
//! SURFACES are read off each recorded row rather than listed here, so a surface added or dropped on
//! the TypeScript side arrives without an edit and cannot silently go unwatched from this side.
//!
//! Run `bun run rust:conform` after recovery changes. A difference names the recorded input,
//! options and surface to investigate; matching rows prove only those observations.
//!
//! **The corpus is read with this crate's OWN parser.** The rows are strict valid JSON, so a crate
//! that cannot read them is a crate that is not finished; the alternative is a second JSON reader
//! living in the harness, which is one more thing that can disagree about the same bytes.
//!
//! **Nothing is skipped on account of an option.** An earlier design guarded rows whose profile
//! named an option this crate does not hold, to stop a match being "accidental". That worry is
//! empty: the corpus compares canonical STRINGS, so a string that equals the recorded one IS the
//! contract met for that input under those options. A guard could only have shrunk what is measured
//! while looking rigorous. Missing or malformed observations fail the run.

#![forbid(unsafe_code)]

use core::fmt::Write as _;
use core::num::NonZeroUsize;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::ExitCode;

use partial_json_repair::options::{DangerousKeyPolicy, DiagnosticsMode, Parser};
use partial_json_repair::report::SwitchableRepair;
use partial_json_repair::selector::{PathSegment, SelectorPath};
use partial_json_repair::value::{JsonString, Number, Value};
use partial_json_repair::{
    AsInput, EncodingFailure, Fragment, FragmentStreamParser, Input, Outcome, ParseFailure,
    RepairFailure, Scanner, SelectedStreamParser, Snapshot, StreamEvent, StreamParser,
    StringifyOptions, Success, ViewFailure, canonical_of, stringify,
};

mod summary;

/// How many differences to print by default. One missing recovery moves hundreds of rows at once,
/// and a full dump buries the first one — which is the only one worth reading.
///
/// Raise it with `CONFORM_SAMPLE` (`0` for every difference) when the question is which recovery to
/// port NEXT: that is answered by tallying what the whole remainder has in common, and a sample
/// chosen to be readable cannot answer it. A tally over twelve rows looks like evidence and is not.
///
/// An environment variable rather than an argument, because the argument is the corpus path and a
/// second positional would make `rust:conform 0` silently mean a different corpus.
const SAMPLE: usize = 12;

/// The difference budget for this run.
fn sample_size() -> usize {
    match std::env::var("CONFORM_SAMPLE").as_deref().map(str::parse) {
        Ok(Ok(0)) => usize::MAX,
        Ok(Ok(n)) => n,
        _ => SAMPLE,
    }
}

/// A member of a parsed object, by name. Linear because a corpus row has a handful of fields and an
/// index would cost more to build than the walk it saves.
fn field<'v, 'a>(value: &'v Value<'a>, name: &str) -> Option<&'v Value<'a>> {
    let Value::Object(object) = value else {
        return None;
    };
    object.entries().iter().find_map(|(key, member)| {
        matches!(key, JsonString::Text(text) if text == name).then_some(member)
    })
}

fn text_of<'a>(value: &Value<'a>) -> Option<&'a str> {
    match value {
        // Borrowed only: a key that needed unescaping is owned by the value being dropped, and the
        // rows this reads spell their ids and inputs plainly.
        Value::String(JsonString::Text(std::borrow::Cow::Borrowed(text))) => Some(text),
        _ => None,
    }
}

fn owned_text(value: &Value<'_>) -> Option<String> {
    match value {
        Value::String(JsonString::Text(text)) => Some(text.to_string()),
        _ => None,
    }
}

fn owned_string(value: &Value<'_>) -> Option<JsonString<'static>> {
    match value {
        Value::String(text) => Some(text.clone().into_owned()),
        _ => None,
    }
}

fn number_of(value: &Value<'_>) -> Option<usize> {
    match value {
        Value::Number(Number::Double(n)) if *n >= 0.0 => Some(*n as usize),
        _ => None,
    }
}

fn flag_of(value: &Value<'_>) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

/// One selector path off the wire.
///
/// **The wildcard spelling is a shared table, not a local convention.** `ANY` and `ANY_DEPTH` are
/// symbols in the TypeScript API so no literal key can collide with them, and `JSON.stringify`
/// writes a symbol in an array as `null` — which is not a valid segment, so a profile recorded that
/// way replays as `invalid-options` on both sides and the row measures nothing. `corpus/AGENTS.md`
/// owns the table; `scripts/corpus/selectors.ts` is the other end of it.
///
/// `None` for anything this crate cannot express, which refuses the whole profile rather than
/// scoring a row under a selection nobody wrote.
fn path_from(value: &Value<'_>) -> Option<SelectorPath<'static>> {
    let Value::Array(segments) = value else {
        return None;
    };
    segments
        .iter()
        .map(|segment| match segment {
            Value::String(text) => Some(PathSegment::Key(text.clone().into_owned())),
            Value::Number(Number::Double(n)) if *n >= 0.0 && n.fract() == 0.0 => {
                Some(PathSegment::Index(*n as usize))
            }
            Value::Object(_) => match field(segment, "wildcard").and_then(text_of) {
                Some("any") => Some(PathSegment::Any),
                Some("any-depth") => Some(PathSegment::AnyDepth),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// The options a recorded profile names, as RESOLVED VALUES.
///
/// A row never names a preset: the presets are mostly empty objects, so porting them by name would
/// leave both sides falling through to their own defaults — agreeing on paper while differing in
/// fact. `None` when the profile names something this crate cannot express, so a row is reported as
/// unscorable rather than scored under options nobody asked for.
struct Profile {
    options: Parser,
    select: Option<Vec<SelectorPath<'static>>>,
    fragments: bool,
    summary: bool,
    view: bool,
    occurrences: bool,
}

fn options_from(profile: &Value<'_>) -> Option<Profile> {
    let mut options = Parser::default();
    if let Some(mode) = field(profile, "diagnostics") {
        options.diagnostics = match mode {
            Value::Bool(true) => DiagnosticsMode::On,
            Value::String(JsonString::Text(t)) if t == "all" => DiagnosticsMode::All,
            _ => DiagnosticsMode::Off,
        };
    }
    if let Some(locations) = field(profile, "locations").and_then(flag_of) {
        options.locations = locations;
    }
    if let Some(depth) = field(profile, "maxDepth")
        .and_then(number_of)
        .and_then(NonZeroUsize::new)
    {
        options.max_depth = depth;
    }
    if let Some(policy) = field(profile, "onDangerousKey").and_then(|v| text_of(v)) {
        options.on_dangerous_key = match policy {
            "drop" => DangerousKeyPolicy::Drop,
            "reject" => DangerousKeyPolicy::Reject,
            _ => DangerousKeyPolicy::Keep,
        };
    }
    if let Some(null_prototype) = field(profile, "nullPrototype").and_then(flag_of) {
        options.null_prototype = null_prototype;
    }
    if let Some(Value::Array(keys)) = field(profile, "customDangerousKeys") {
        options.custom_dangerous_keys = keys.iter().filter_map(owned_string).collect();
    }
    if let Some(exact) = field(profile, "exactNumbers").and_then(flag_of) {
        options.exact_numbers = exact;
    }
    if let Some(object_only) = field(profile, "objectOnly").and_then(flag_of) {
        options.object_only = object_only;
    }
    if let Some(Value::Array(keys)) = field(profile, "requiredKeys") {
        options.required_keys = keys.iter().map(owned_string).collect::<Option<Vec<_>>>()?;
    }
    if let Some(Value::Array(paths)) = field(profile, "skip") {
        options.skip = paths.iter().map(path_from).collect::<Option<Vec<_>>>()?;
    }
    let select = match field(profile, "select") {
        Some(Value::Array(paths)) => Some(paths.iter().map(path_from).collect::<Option<Vec<_>>>()?),
        Some(_) => return None,
        None => None,
    };
    if let Some(repair) = field(profile, "repairBroken").and_then(flag_of) {
        options.repair_broken = repair;
    }
    if let Some(entries) = field(profile, "maxDiagnostics").and_then(number_of) {
        options.max_diagnostics = entries;
    }
    if let Some(buffer) = field(profile, "maxBuffer")
        .and_then(number_of)
        .and_then(NonZeroUsize::new)
    {
        options.max_buffer = buffer;
    }
    if let Some(scalar) = field(profile, "maxScalar")
        .and_then(number_of)
        .and_then(NonZeroUsize::new)
    {
        options.max_scalar = scalar;
    }
    if let Some(retained) = field(profile, "maxRetained")
        .and_then(number_of)
        .and_then(NonZeroUsize::new)
    {
        options.max_retained = retained;
    }
    if let Some(errors) = field(profile, "maxErrors")
        .and_then(number_of)
        .and_then(NonZeroUsize::new)
    {
        options.max_errors = errors;
    }
    // An unknown kind means this crate's vocabulary is behind the corpus. Refusing the profile is
    // the only honest answer: defaulting the switch to ON would score every row under a leniency
    // the recording did not grant, and the score would move for a reason nobody could see.
    if let Some(Value::Object(recover)) = field(profile, "recover") {
        for (key, allowed) in recover.entries() {
            let JsonString::Text(name) = key else {
                return None;
            };
            let kind = SwitchableRepair::named(name.as_ref())?;
            options.recover = match allowed {
                Value::Bool(true) => options.recover.with(kind),
                Value::Bool(false) => options.recover.without(kind),
                _ => return None,
            };
        }
    }
    let fragments = field(profile, "fragments")
        .and_then(flag_of)
        .unwrap_or(false);
    let summary = field(profile, "summary").and_then(flag_of).unwrap_or(false);
    let view = field(profile, "view").and_then(text_of) == Some("owned");
    let occurrences = field(profile, "occurrences")
        .and_then(flag_of)
        .unwrap_or(false);
    Some(Profile {
        options,
        select,
        fragments,
        summary,
        view,
        occurrences,
    })
}

/// Hex as the recorder wrote it: two lowercase digits per byte, unambiguous and needing no library
/// on either side.
fn bytes_from_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            let digit = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                _ => None,
            };
            Some(digit(pair[0])? * 16 + digit(pair[1])?)
        })
        .collect()
}

/// What one whole-input row observes, keyed exactly as the recorder keyed it.
///
/// The four verbs are produced together because they share nothing but the input: `repair` is not
/// derivable from `parse` — it splices the source through an edit log kept in parallel with the
/// repairs, never regenerated from them — so a port can get one right and the other wrong.
fn observe(
    input: partial_json_repair::Input<'_>,
    options: &Parser,
    select: Option<Vec<SelectorPath<'static>>>,
    stringify_bounds: bool,
) -> BTreeMap<&'static str, String> {
    let mut out = BTreeMap::new();
    if let Some(paths) = select {
        let selected = options
            .clone()
            .select(paths)
            .expect("profile was validated");
        out.insert("parse", canonical_of(&selected.parse(input)));
        out.insert("repair", canonical_of(&selected.repair(input)));
        out.insert("span", canonical_of(&selected.find_json_span(input)));
        out.insert(
            "many",
            canonical_of(&selected.parse_many(input).collect::<Vec<_>>()),
        );
    } else {
        let parsed = options.parse(input);
        if let Ok(success) = &parsed {
            out.insert("stringify", stringify_outcome(&success.value));
            if stringify_bounds {
                let size = stringify(&success.value)
                    .expect("a parsed value has a JSON spelling")
                    .encode_utf16()
                    .count();
                out.insert(
                    "stringifyBelow",
                    bounded_stringify(&success.value, size - 1),
                );
                out.insert("stringifyAt", bounded_stringify(&success.value, size));
                out.insert(
                    "stringifyAbove",
                    bounded_stringify(&success.value, size + 1),
                );
            }
        }
        out.insert("parse", canonical_of(&parsed));
        out.insert("repair", canonical_of(&options.repair(input)));
        out.insert("span", canonical_of(&options.find_json_span(input)));
        out.insert(
            "many",
            canonical_of(&options.parse_many(input).collect::<Vec<_>>()),
        );
    }
    out
}

fn bounded_stringify(value: &Value<'_>, limit: usize) -> String {
    let options = StringifyOptions {
        max_output: NonZeroUsize::new(limit).expect("the fixture output is longer than one unit"),
    };
    stringify_result(options.stringify(value))
}

fn stringify_outcome(value: &Value<'_>) -> String {
    stringify_result(stringify(value))
}

fn stringify_result(result: Result<String, EncodingFailure<'_>>) -> String {
    match result {
        Ok(text) => format!("{{\"ok\":true,\"value\":{}}}", canonical_of(&text.as_str())),
        Err(EncodingFailure::NonJsonValue { value_kind, path }) => {
            let failure = RepairFailure::NonJsonValue { value_kind, path };
            format!("{{\"ok\":false,\"failure\":{}}}", canonical_of(&failure))
        }
        Err(EncodingFailure::LimitReached { limit }) => format!(
            "{{\"ok\":false,\"failure\":{{\"kind\":\"limit-reached\",\"resource\":\"output\",\"limit\":{limit}}}}}"
        ),
    }
}

/// What a stream produced, driven by feeding the row's chunks in order and then ending it.
///
/// `fed` is per-chunk deltas — what THAT chunk completed, never a running total — so it is built
/// one chunk at a time rather than collected: each chunk's items borrow the parser's buffer and
/// must be read before the next `feed` extends it, which is the borrow rule the API relies on to
/// stay allocation-free in the ordinary case.
fn observe_stream(
    chunks: &[Chunk],
    options: &Parser,
    select: Option<Vec<SelectorPath<'static>>>,
    fragments: bool,
    summary: bool,
    view: bool,
    occurrences: bool,
) -> BTreeMap<&'static str, String> {
    if let Some(select) = select {
        let selected = options
            .clone()
            .select(select)
            .unwrap_or_else(|_| unreachable!("the corpus profile already decoded its selectors"));
        if fragments {
            if summary {
                let mut stream = FragmentStreamParser::new(
                    selected.fragments().expect("fragment mode is compatible"),
                )
                .with_summary();
                let mut fed = Vec::new();
                let mut boundaries = Vec::new();
                for chunk in chunks {
                    let items = stream.feed(chunk).collect::<Vec<_>>();
                    boundaries.push(summary::events(
                        items
                            .iter()
                            .filter(|event| {
                                !matches!(
                                    event,
                                    StreamEvent::Item(Ok(Success {
                                        value: Fragment::Data { .. },
                                        ..
                                    }))
                                )
                            })
                            .cloned(),
                    ));
                    fed.extend(items);
                }
                return BTreeMap::from([
                    ("fed", summary::fragment_events(fed.into_iter())),
                    ("ended", summary::fragment_events(stream.end())),
                    ("boundaries", format!("[{}]", boundaries.join(","))),
                ]);
            }
            let mut stream = FragmentStreamParser::new(
                selected.fragments().expect("fragment mode is compatible"),
            );
            let mut fed = Vec::new();
            let mut boundaries = Vec::new();
            for chunk in chunks {
                let items = stream.feed(chunk).collect::<Vec<_>>();
                boundaries.push(format!(
                    "[{}]",
                    items
                        .iter()
                        .filter(|item| !matches!(
                            item,
                            Ok(Success {
                                value: Fragment::Data { .. },
                                ..
                            })
                        ))
                        .map(canonical_of)
                        .collect::<Vec<_>>()
                        .join(",")
                ));
                fed.extend(items);
            }
            let fed = canonical_of(&normalize_fragments(fed));
            let ended = canonical_of(&normalize_fragments(stream.end().collect()));
            let boundaries = format!("[{}]", boundaries.join(","));
            return BTreeMap::from([("fed", fed), ("ended", ended), ("boundaries", boundaries)]);
        }
        if summary {
            let mut stream = SelectedStreamParser::new(selected).with_summary();
            let mut fed = String::from("[");
            for (at, chunk) in chunks.iter().enumerate() {
                if at > 0 {
                    fed.push(',');
                }
                fed.push_str(&summary::events(stream.feed(chunk)));
            }
            fed.push(']');
            return BTreeMap::from([("fed", fed), ("ended", summary::events(stream.end()))]);
        }
        if view {
            let mut stream = SelectedStreamParser::new(selected).viewed();
            let mut fed = Vec::new();
            let mut views = Vec::new();
            for chunk in chunks {
                fed.push(stream.feed(chunk).collect::<Vec<_>>());
                views.push(selected_view(&mut stream));
            }
            let ended = stream.end().collect::<Vec<_>>();
            views.push(selected_view(&mut stream));
            return BTreeMap::from([
                ("fed", canonical_of(&fed)),
                ("ended", canonical_of(&ended)),
                ("views", format!("[{}]", views.join(","))),
            ]);
        }
        let mut stream = SelectedStreamParser::new(selected);
        if occurrences {
            stream = stream.occurrences();
        }
        let mut fed = String::from("[");
        for (at, chunk) in chunks.iter().enumerate() {
            if at > 0 {
                fed.push(',');
            }
            fed.push_str(&canonical_of(&stream.feed(chunk).collect::<Vec<_>>()));
        }
        fed.push(']');
        let ended = canonical_of(&stream.end().collect::<Vec<_>>());
        return BTreeMap::from([("fed", fed), ("ended", ended)]);
    }
    if summary {
        return summary::observe(chunks, options);
    }
    if view {
        let mut stream = StreamParser::new(options.clone()).viewed();
        let mut fed = Vec::new();
        let mut views = Vec::new();
        for chunk in chunks {
            fed.push(stream.feed(chunk).collect::<Vec<_>>());
            views.push(value_view(&mut stream));
        }
        let ended = stream.end().collect::<Vec<_>>();
        views.push(value_view(&mut stream));
        return BTreeMap::from([
            ("fed", canonical_of(&fed)),
            ("ended", canonical_of(&ended)),
            ("views", format!("[{}]", views.join(","))),
        ]);
    }
    let mut stream = StreamParser::new(options.clone());
    let mut fed = String::from("[");
    for (at, chunk) in chunks.iter().enumerate() {
        if at > 0 {
            fed.push(',');
        }
        fed.push_str(&canonical_of(&stream.feed(chunk).collect::<Vec<_>>()));
    }
    fed.push(']');
    let ended = canonical_of(&stream.end().collect::<Vec<_>>());
    BTreeMap::from([("fed", fed), ("ended", ended)])
}

fn snapshot<T: partial_json_repair::Canonical>(snapshot: Option<&Snapshot<T>>) -> String {
    let Some(snapshot) = snapshot else {
        return String::from("{\"ok\":true,\"value\":#undef}");
    };
    let mut out = format!(
        "{{\"ok\":true,\"value\":{{\"value\":{},\"valueIndex\":{},\"complete\":{}",
        canonical_of(&snapshot.value),
        snapshot.value_index,
        snapshot.complete
    );
    if let Some(path) = &snapshot.partial_path {
        let _ = write!(out, ",\"partialPath\":{}", canonical_of(path));
    }
    out.push_str("}}");
    out
}

fn failed_view<T: partial_json_repair::Canonical>(failure: ViewFailure<'_, T>) -> String {
    format!(
        "{{\"ok\":false,\"failure\":{}}}",
        canonical_of(failure.failure)
    )
}

fn value_view(stream: &mut partial_json_repair::ViewedStreamParser) -> String {
    match stream.view() {
        Ok(value) => snapshot(value),
        Err(failure) => failed_view(failure),
    }
}

fn selected_view(stream: &mut partial_json_repair::ViewedSelectedStreamParser) -> String {
    match stream.view() {
        Ok(value) => snapshot(value),
        Err(failure) => failed_view(failure),
    }
}

pub(crate) fn normalize_fragments(
    items: Vec<Outcome<'static, Fragment, ParseFailure<'static>>>,
) -> Vec<Outcome<'static, Fragment, ParseFailure<'static>>> {
    let mut out = Vec::new();
    for item in items {
        if let Ok(Success {
            value: Fragment::Data { id, text },
            span,
            diagnostics,
        }) = item
        {
            if let Some(Ok(Success {
                value:
                    Fragment::Data {
                        id: previous_id,
                        text: previous,
                    },
                span: previous_span,
                diagnostics: previous_report,
            })) = out.last_mut()
                && *previous_id == id
                && *previous_span == span
                && *previous_report == diagnostics
            {
                append_json_string(previous, text);
                continue;
            }
            out.push(Ok(Success {
                value: Fragment::Data { id, text },
                span,
                diagnostics,
            }));
        } else {
            out.push(item);
        }
    }
    out
}

fn append_json_string(left: &mut JsonString<'static>, right: JsonString<'static>) {
    match (left, right) {
        (JsonString::Text(left), JsonString::Text(right)) => left.to_mut().push_str(&right),
        (JsonString::Units(left), JsonString::Units(right)) => {
            left.to_mut().extend_from_slice(&right)
        }
        (JsonString::Units(left), JsonString::Text(right)) => {
            left.to_mut().extend(right.encode_utf16())
        }
        (left @ JsonString::Text(_), JsonString::Units(right)) => {
            let JsonString::Text(text) =
                core::mem::replace(left, JsonString::Units(Cow::Borrowed(&[])))
            else {
                unreachable!()
            };
            let mut units: Vec<u16> = text.encode_utf16().collect();
            units.extend_from_slice(&right);
            *left = JsonString::Units(Cow::Owned(units));
        }
    }
}

/// Keep each chunk's representation: text uses UTF-16 positions, while bytes retain decoder state.
enum Chunk {
    Text(Vec<u16>),
    Bytes(Vec<u8>),
}

impl AsInput for Chunk {
    fn as_input(&self) -> Input<'_> {
        match self {
            Self::Text(units) => Input::Utf16(units),
            Self::Bytes(bytes) => Input::Bytes(bytes),
        }
    }
}

fn chunk_units(chunks: &Value<'_>) -> Option<Vec<Chunk>> {
    match chunks {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => Some(Chunk::Text(text.code_units().collect())),
                Value::Object(object) if object.entries().len() == 1 => field(item, "bytes")
                    .and_then(text_of)
                    .and_then(bytes_from_hex)
                    .map(Chunk::Bytes),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// Scores one row's observation against ours, driven by the RECORDED keys.
///
/// Recorded-driven so a surface this crate does not produce shows up as a difference against an
/// empty answer rather than quietly going unwatched. Shared by whole-input and chunked rows: a
/// second copy of this is how two producers come to disagree about what counts as a match.
///
/// Returns false when the row is malformed, which is a corpus defect rather than a low score.
fn compare(
    id: &str,
    observed: &Value<'_>,
    ours: &BTreeMap<&'static str, String>,
    sample: usize,
    surfaces: &mut BTreeMap<String, Tally>,
    differences: &mut Vec<String>,
) -> bool {
    let Value::Object(recorded) = observed else {
        eprintln!("conformance: row {id} records an observation that is not an object");
        return false;
    };
    if recorded.entries().is_empty() {
        eprintln!("conformance: row {id} records no observations");
        return false;
    }
    for (key, expected) in recorded.entries() {
        let JsonString::Text(key) = key else {
            eprintln!("conformance: row {id} has a non-text observation key");
            return false;
        };
        let expected = match expected {
            Value::String(JsonString::Text(text)) => text.as_ref(),
            _ => {
                eprintln!("conformance: row {id}, surface {key}: expected a canonical string");
                return false;
            }
        };
        let tally = surfaces.entry(key.to_string()).or_default();
        tally.attempted += 1;
        let actual = ours.get(key.as_ref()).map_or("", String::as_str);
        if actual == expected {
            tally.matched += 1;
        } else if differences.len() < sample {
            let mut note = String::new();
            let _ = write!(
                note,
                "{id} {key}\n  recorded: {expected}\n  actual:   {actual}"
            );
            differences.push(note);
        }
    }
    true
}

fn credit_witnesses(
    id: &str,
    observed: &Value<'_>,
    ours: &BTreeMap<&'static str, String>,
    witnesses_by_id: &BTreeMap<String, Vec<(String, String)>>,
    witnessed: &mut BTreeSet<String>,
) {
    let Some(entries) = witnesses_by_id.get(id) else {
        return;
    };
    for (requirement, surface) in entries {
        let Some(Value::String(JsonString::Text(expected))) = field(observed, surface) else {
            continue;
        };
        if ours
            .get(surface.as_str())
            .is_some_and(|actual| actual == expected)
        {
            witnessed.insert(requirement.clone());
        }
    }
}

/// What the run learned, as counts a reader can only interpret together.
///
/// Absolute numbers, never a rate: a rate rises when coverage falls, so a run that stopped
/// attempting a surface would report progress. `attempted` is the denominator that makes the two
/// movements distinguishable.
#[derive(Default)]
struct Tally {
    attempted: usize,
    matched: usize,
}

fn main() -> ExitCode {
    // Git keeps no full contract: `bun run rust:conform` passes the pinned one, and
    // `bun scripts/corpus/record.ts --out <file>` writes the live one for a catch-up.
    let Some(path) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("conformance: pass a contract file (see scripts/rust/conform.ts)");
        return ExitCode::FAILURE;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("conformance: cannot read {}", path.display());
        return ExitCode::FAILURE;
    };
    let mut lines = text.lines().filter(|line| !line.is_empty());
    let options = Parser::default();

    let Some(header) = lines.next() else {
        eprintln!(
            "conformance: {} is empty; run corpus:record",
            path.display()
        );
        return ExitCode::FAILURE;
    };
    let header = match Scanner::new(header.as_bytes(), &options).parse() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("conformance: the profile header is not JSON this crate reads: {error:?}");
            return ExitCode::FAILURE;
        }
    };
    let Some(Value::Array(profiles)) = field(&header, "profiles") else {
        eprintln!("conformance: the profile header carries no `profiles` list");
        return ExitCode::FAILURE;
    };
    let Some(Value::Array(required)) =
        field(&header, "coverage").and_then(|v| field(v, "required"))
    else {
        eprintln!("conformance: the header carries no coverage requirements");
        return ExitCode::FAILURE;
    };
    let Some(required): Option<BTreeSet<String>> =
        required.iter().map(owned_text).collect::<Option<_>>()
    else {
        eprintln!("conformance: every coverage requirement must be text");
        return ExitCode::FAILURE;
    };
    let Some(Value::Object(witnesses)) =
        field(&header, "coverage").and_then(|v| field(v, "witnesses"))
    else {
        eprintln!("conformance: the header carries no coverage witnesses");
        return ExitCode::FAILURE;
    };
    let mut witnesses_by_id: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut witness_names = BTreeSet::new();
    for (requirement, witness) in witnesses.entries() {
        let (JsonString::Text(requirement), Some(id), Some(surface)) = (
            requirement,
            field(witness, "id").and_then(owned_text),
            field(witness, "surface").and_then(owned_text),
        ) else {
            eprintln!("conformance: every coverage witness must name a text id and surface");
            return ExitCode::FAILURE;
        };
        witness_names.insert(requirement.to_string());
        witnesses_by_id
            .entry(id)
            .or_default()
            .push((requirement.to_string(), surface));
    }
    if witness_names != required {
        eprintln!("conformance: coverage witnesses do not match the required inventory");
        return ExitCode::FAILURE;
    }

    // A panic in the crate under test is a finding, and the default hook names a line in `src/`
    // while the row that reached it — the only reproducer — is the one thing the reader needs. It
    // ends the run either way; this is what makes it actionable rather than a bare backtrace.
    let reading = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    {
        let reading = std::sync::Arc::clone(&reading);
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let row = reading
                .lock()
                .map_or_else(|e| e.into_inner().clone(), |r| r.clone());
            eprintln!("conformance: panicked while reading row {row}");
            default(info);
        }));
    }

    let mut surfaces: BTreeMap<String, Tally> = BTreeMap::new();
    let mut rows = 0usize;
    let mut differences = Vec::new();
    let mut witnessed = BTreeSet::new();
    let sample = sample_size();

    for line in lines {
        rows += 1;
        let row = match Scanner::new(line.as_bytes(), &options).parse() {
            Ok(row) => row,
            Err(error) => {
                eprintln!("conformance: row {rows} is not JSON this crate reads: {error:?}");
                return ExitCode::FAILURE;
            }
        };
        let id = field(&row, "id").and_then(text_of).unwrap_or("?");
        if let Ok(mut held) = reading.lock() {
            held.clear();
            held.push_str(id);
        }
        let Some(observed) = field(&row, "observed") else {
            eprintln!("conformance: row {id} records no observation");
            return ExitCode::FAILURE;
        };
        let Some(profile) = field(&row, "p")
            .and_then(number_of)
            .and_then(|at| profiles.get(at))
        else {
            eprintln!("conformance: row {id} names a profile the header does not hold");
            return ExitCode::FAILURE;
        };
        let Some(profile) = options_from(profile) else {
            eprintln!("conformance: row {id} names options this crate cannot express");
            return ExitCode::FAILURE;
        };

        if ["text", "bytes", "chunks"]
            .iter()
            .filter(|name| field(&row, name).is_some())
            .count()
            != 1
        {
            eprintln!("conformance: row {id} must supply exactly one of text, bytes or chunks");
            return ExitCode::FAILURE;
        }
        // A chunked row observes the stream and nothing else, so it is the row — not a surface —
        // that is driven differently, by feeding rather than by handing over the whole input.
        if let Some(chunks) = field(&row, "chunks") {
            let Some(chunks) = chunk_units(chunks) else {
                eprintln!(
                    "conformance: row {id} chunks must contain text or lowercase hexadecimal bytes"
                );
                return ExitCode::FAILURE;
            };
            let ours = observe_stream(
                &chunks,
                &profile.options,
                profile.select,
                profile.fragments,
                profile.summary,
                profile.view,
                profile.occurrences,
            );
            if !compare(id, observed, &ours, sample, &mut surfaces, &mut differences) {
                return ExitCode::FAILURE;
            }
            credit_witnesses(id, observed, &ours, &witnesses_by_id, &mut witnessed);
            continue;
        }
        let bytes = match field(&row, "bytes") {
            Some(value) => match text_of(value).and_then(bytes_from_hex) {
                Some(bytes) => Some(bytes),
                None => {
                    eprintln!(
                        "conformance: row {id} bytes must be a string of lowercase hex pairs"
                    );
                    return ExitCode::FAILURE;
                }
            },
            None => None,
        };
        let ours = match (&bytes, field(&row, "text")) {
            (Some(bytes), _) => observe(
                bytes.as_slice().into(),
                &profile.options,
                profile.select.clone(),
                field(&row, "stringifyBounds").and_then(flag_of) == Some(true),
            ),
            (None, Some(Value::String(text))) => {
                // JavaScript text is UTF-16. Feed those units directly, including lone surrogates;
                // Rust's &str contract uses byte positions and is a different input alphabet.
                let units: Vec<_> = text.code_units().collect();
                observe(
                    units.as_slice().into(),
                    &profile.options,
                    profile.select.clone(),
                    field(&row, "stringifyBounds").and_then(flag_of) == Some(true),
                )
            }
            (None, Some(_)) => {
                eprintln!("conformance: row {id} has a non-string text source");
                return ExitCode::FAILURE;
            }
            (None, None) => {
                eprintln!("conformance: row {id} has no whole-input source");
                return ExitCode::FAILURE;
            }
        };

        if !compare(id, observed, &ours, sample, &mut surfaces, &mut differences) {
            return ExitCode::FAILURE;
        }
        credit_witnesses(id, observed, &ours, &witnesses_by_id, &mut witnessed);
    }

    let missing: Vec<_> = required.difference(&witnessed).collect();
    if !missing.is_empty() {
        for requirement in missing {
            eprintln!("conformance: no matched row witnesses {requirement}");
        }
        return ExitCode::FAILURE;
    }

    let mut report = format!("conformance: {rows} rows\n");
    for (surface, tally) in &surfaces {
        let _ = writeln!(
            report,
            "  {surface:<8} {} of {} match",
            tally.matched, tally.attempted
        );
    }
    for note in &differences {
        let _ = writeln!(report, "{note}");
    }
    let total: usize = surfaces.values().map(|t| t.attempted - t.matched).sum();
    if total > differences.len() {
        let _ = writeln!(
            report,
            "  ({} of {total} differences shown)",
            differences.len()
        );
    }
    print!("{report}");
    // A diagnostic sample bounds printing, never acceptance. Missing observations also prevent
    // parity, even when every attempted call matches.
    if total == 0 && !surfaces.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
