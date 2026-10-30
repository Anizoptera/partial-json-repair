//! Typed response serialization for every native and WebAssembly boundary.

use alloc::vec::Vec;
use partial_json_repair::parse::Stopped;
use partial_json_repair::report::Scope;
use partial_json_repair::{
    Diagnostics, Failed, Fragment, JsonString, Match, NonJsonKind, Number, Outcome, ParseError,
    ParseFailure, PathStep, Position, Repair, RepairFailure, Resource, ScalarKind,
    SelectedSnapshot, Snapshot, Span, StreamEvent, StreamSummary, Success, Unit, Value,
    ViewFailure,
};

use super::{
    ABORTED, FRAGMENT_DATA, FRAGMENT_END, FRAGMENT_START, INVALID_BOUNDARY, INVALID_OPTIONS,
    LIMIT_REACHED, MANY, NO_JSON, NO_MATCH, NON_JSON_VALUE, NON_SCALAR_SELECTION, POLICY_REFUSED,
    SNAPSHOT, SNAPSHOT_NONE, SPAN, STREAM_CLOSED, SUCCESS, SUMMARY, UNSUPPORTED_ENCODING, VERSION,
};

pub(crate) fn aborted(input: &Stopped<'_>, out: &mut Vec<u8>) {
    out.push(ABORTED);
    optional_value(input.recovered.as_ref(), out);
    report(input.diagnostics.as_deref(), out);
}

pub(crate) struct Collection {
    out: Vec<u8>,
    count: u64,
}

impl Collection {
    pub(crate) fn new() -> Self {
        let mut out = alloc::vec![VERSION, MANY];
        usize_field(0, &mut out);
        Self { out, count: 0 }
    }

    pub(crate) fn push<T>(&mut self, item: &T, encode: impl FnOnce(&T, &mut Vec<u8>)) {
        encode(item, &mut self.out);
        self.count = self.count.saturating_add(1);
    }

    pub(crate) fn stop(&mut self, stopped: &Stopped<'_>) {
        aborted(stopped, &mut self.out);
        self.count = self.count.saturating_add(1);
    }

    pub(crate) fn finish(mut self) -> Vec<u8> {
        self.out[2..10].copy_from_slice(&self.count.to_le_bytes());
        self.out
    }
}

pub(crate) fn many<'a>(
    items: impl Iterator<Item = Outcome<'a, Value<'a>, ParseFailure<'a>>>,
) -> Vec<u8> {
    collection(items, outcome, None)
}

pub(crate) fn selected_many<'a>(
    items: impl Iterator<Item = Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>>,
) -> Vec<u8> {
    collection(items, selected_item, None)
}

fn collection<T>(
    items: impl Iterator<Item = T>,
    encode: impl Fn(&T, &mut Vec<u8>),
    stopped: Option<&Stopped<'_>>,
) -> Vec<u8> {
    let mut out = Collection::new();
    for item in items {
        out.push(&item, &encode);
    }
    if let Some(stopped) = stopped {
        out.stop(stopped);
    }
    out.finish()
}

pub(crate) fn many_events<'a>(
    items: impl Iterator<Item = StreamEvent<Outcome<'a, Value<'a>, ParseFailure<'a>>>>,
) -> Vec<u8> {
    collection(
        items,
        |item, out| match item {
            StreamEvent::Item(item) => outcome(item, out),
            StreamEvent::Summary(summary) => stream_summary(summary, out),
        },
        None,
    )
}

pub(crate) fn selected_events<'a>(
    items: impl Iterator<Item = StreamEvent<Outcome<'a, Match<Value<'a>>, ParseFailure<'a>>>>,
) -> Vec<u8> {
    collection(
        items,
        |item, out| match item {
            StreamEvent::Item(item) => selected_item(item, out),
            StreamEvent::Summary(summary) => stream_summary(summary, out),
        },
        None,
    )
}

pub(crate) fn fragment_many<'a>(
    items: impl Iterator<Item = Outcome<'a, Fragment, ParseFailure<'a>>>,
) -> Vec<u8> {
    collection(items, fragment_item, None)
}

pub(crate) fn fragment_events<'a>(
    items: impl Iterator<Item = StreamEvent<Outcome<'a, Fragment, ParseFailure<'a>>>>,
) -> Vec<u8> {
    collection(
        items,
        |item, out| match item {
            StreamEvent::Item(item) => fragment_item(item, out),
            StreamEvent::Summary(summary) => stream_summary(summary, out),
        },
        None,
    )
}

fn stream_summary(input: &StreamSummary, out: &mut Vec<u8>) {
    out.extend([SUMMARY, u8::from(input.complete)]);
    usize_field(input.roots, out);
    usize_field(input.matches, out);
    usize_field(input.unmatched.len(), out);
    for selector in &input.unmatched {
        usize_field(*selector, out);
    }
}

pub(crate) fn summary(input: &StreamSummary) -> Vec<u8> {
    let mut out = alloc::vec![VERSION, MANY];
    usize_field(1, &mut out);
    stream_summary(input, &mut out);
    out
}

pub(crate) fn snapshot(
    input: Result<Option<&Snapshot<Value<'static>>>, ViewFailure<'_, Value<'static>>>,
) -> Vec<u8> {
    view_response(input, value)
}

pub(crate) fn selected_snapshot(
    input: Result<Option<&SelectedSnapshot>, ViewFailure<'_, Vec<Match<Value<'static>>>>>,
) -> Vec<u8> {
    view_response(input, |items, out| matched_values(items, out))
}

fn view_response<T>(
    input: Result<Option<&Snapshot<T>>, ViewFailure<'_, T>>,
    encode: impl Fn(&T, &mut Vec<u8>),
) -> Vec<u8> {
    let mut out = alloc::vec![VERSION];
    match input {
        Ok(None) => out.push(SNAPSHOT_NONE),
        Ok(Some(input)) => {
            out.push(SNAPSHOT);
            snapshot_value(input, &mut out, &encode);
        }
        Err(input) => {
            view_failure(input, &mut out, &encode);
            out.push(0);
        }
    }
    out
}

fn snapshot_value<T>(input: &Snapshot<T>, out: &mut Vec<u8>, encode: &impl Fn(&T, &mut Vec<u8>)) {
    encode(&input.value, out);
    usize_field(input.value_index, out);
    out.push(u8::from(input.complete));
    out.push(u8::from(input.partial_path.is_some()));
    if let Some(path) = &input.partial_path {
        source_path(path, out);
    }
}

fn view_failure<T>(
    input: ViewFailure<'_, T>,
    out: &mut Vec<u8>,
    encode: &impl Fn(&T, &mut Vec<u8>),
) {
    match input.failure {
        ParseFailure::LimitReached {
            resource,
            limit,
            at,
            ..
        } => {
            out.extend([LIMIT_REACHED, resource_tag(*resource)]);
            usize_field(*limit, out);
            out.push(u8::from(at.is_some()));
            if let Some(at) = at {
                position(at, out);
            }
        }
        ParseFailure::PolicyRefused { issue, .. } => {
            out.push(POLICY_REFUSED);
            parse_error(issue, out);
        }
        _ => unreachable!("views retain only stopped or refused failures"),
    }
    out.push(u8::from(input.recovered.is_some()));
    if let Some(recovered) = input.recovered {
        encode(&recovered.value, out);
    }
}

fn fragment_item(input: &Outcome<'_, Fragment, ParseFailure<'_>>, out: &mut Vec<u8>) {
    match input {
        Ok(success) => {
            fragment(&success.value, out);
            success_report(success, out);
        }
        Err(failed) => encode_failed(failed, out, failure),
    }
}

fn fragment(input: &Fragment, out: &mut Vec<u8>) {
    match input {
        Fragment::Start {
            id,
            value_index,
            path,
            selectors,
            scalar,
        } => {
            out.push(FRAGMENT_START);
            usize_field(*id, out);
            usize_field(*value_index, out);
            source_path(path, out);
            usize_field(selectors.len(), out);
            for selector in selectors {
                usize_field(*selector, out);
            }
            out.push(match scalar {
                ScalarKind::String => 0,
                ScalarKind::Number => 1,
                ScalarKind::Literal => 2,
            });
        }
        Fragment::Data { id, text: data } => {
            out.push(FRAGMENT_DATA);
            usize_field(*id, out);
            string(data, out);
        }
        Fragment::End { id, span } => {
            out.push(FRAGMENT_END);
            usize_field(*id, out);
            position(&span.start, out);
            position(&span.end, out);
        }
    }
}

pub(crate) fn outcome(input: &Outcome<'_, Value<'_>, ParseFailure<'_>>, out: &mut Vec<u8>) {
    match input {
        Ok(success) => {
            out.push(SUCCESS);
            value(&success.value, out);
            success_report(success, out);
        }
        Err(failed) => encode_failed(failed, out, failure),
    }
}

pub(crate) fn repair_outcome(
    input: &Outcome<'_, JsonString<'_>, RepairFailure<'_>>,
    out: &mut Vec<u8>,
) {
    match input {
        Ok(success) => {
            out.push(SUCCESS);
            string(&success.value, out);
            success_report(success, out);
        }
        Err(failed) => encode_failed(failed, out, repair_failure),
    }
}

pub(crate) fn selected_outcome(
    input: &Outcome<'_, Vec<Match<Value<'_>>>, ParseFailure<'_>>,
    out: &mut Vec<u8>,
) {
    match input {
        Ok(success) => encode_success(success, out, |items, out| matches(items, out, value)),
        Err(failed) => encode_failed(failed, out, failure),
    }
}

pub(crate) fn selected_repair_outcome(
    input: &Outcome<'_, Vec<Match<JsonString<'_>>>, RepairFailure<'_>>,
    out: &mut Vec<u8>,
) {
    match input {
        Ok(success) => encode_success(success, out, |items, out| matches(items, out, string)),
        Err(failed) => encode_failed(failed, out, repair_failure),
    }
}

pub(crate) fn selected_span_outcome(
    input: &Outcome<'_, Vec<Match<Span>>, ParseFailure<'_>>,
    out: &mut Vec<u8>,
) {
    match input {
        Ok(success) => encode_success(success, out, |items, out| matches(items, out, span_value)),
        Err(failed) => encode_failed(failed, out, failure),
    }
}

pub(crate) fn selected_item(
    input: &Outcome<'_, Match<Value<'_>>, ParseFailure<'_>>,
    out: &mut Vec<u8>,
) {
    match input {
        Ok(success) => {
            out.push(SUCCESS);
            matched(&success.value, out, value);
            success_report(success, out);
        }
        Err(failed) => encode_failed(failed, out, failure),
    }
}

fn matches<T>(items: &[Match<T>], out: &mut Vec<u8>, encode: fn(&T, &mut Vec<u8>)) {
    out.push(SUCCESS);
    matched_values_with(items, out, encode);
}

fn matched_values(items: &[Match<Value<'_>>], out: &mut Vec<u8>) {
    matched_values_with(items, out, value);
}

fn matched_values_with<T>(items: &[Match<T>], out: &mut Vec<u8>, encode: fn(&T, &mut Vec<u8>)) {
    out.push(8);
    usize_field(items.len(), out);
    for item in items {
        matched(item, out, encode);
    }
}

fn encode_success<T>(
    input: &Success<'_, T>,
    out: &mut Vec<u8>,
    encode: impl FnOnce(&T, &mut Vec<u8>),
) {
    encode(&input.value, out);
    success_report(input, out);
}

fn success_report<T>(input: &Success<'_, T>, out: &mut Vec<u8>) {
    out.push(u8::from(input.span.is_some()));
    if let Some(span) = &input.span {
        position(&span.start, out);
        position(&span.end, out);
    }
    report(input.diagnostics.as_deref(), out);
}

fn encode_failed<F>(input: &Failed<'_, F>, out: &mut Vec<u8>, encode: fn(&F, &mut Vec<u8>)) {
    encode(&input.failure, out);
    report(input.diagnostics.as_deref(), out);
}

fn report(input: Option<&Diagnostics<'_>>, out: &mut Vec<u8>) {
    out.push(u8::from(input.is_some()));
    let Some(input) = input else { return };
    usize_field(input.repairs.len(), out);
    for repair in &input.repairs {
        repair_entry(repair, out);
    }
    usize_field(input.errors.len(), out);
    for error in &input.errors {
        parse_error(error, out);
    }
    usize_field(input.counts.repairs, out);
    usize_field(input.counts.errors, out);
    out.extend([
        u8::from(input.entries_complete),
        u8::from(input.scan_complete),
    ]);
    out.push(match input.scope {
        Scope::All => 0,
        Scope::Selected => 1,
    });
    out.extend(input.confidence.to_le_bytes());
}

fn repair_entry(input: &Repair<'_>, out: &mut Vec<u8>) {
    text(input.kind.as_str(), out);
    position(&input.at, out);
    source_path(&input.path, out);
    usize_field(input.value_index, out);
}

fn matched<T>(input: &Match<T>, out: &mut Vec<u8>, encode: fn(&T, &mut Vec<u8>)) {
    out.push(10);
    encode(&input.value, out);
    source_path(&input.path, out);
    usize_field(input.value_index, out);
    position(&input.span.start, out);
    position(&input.span.end, out);
    usize_field(input.selectors.len(), out);
    for selector in &input.selectors {
        usize_field(*selector, out);
    }
}

fn span_value(input: &Span, out: &mut Vec<u8>) {
    out.push(11);
    position(&input.start, out);
    position(&input.end, out);
}

pub(crate) fn span_outcome(input: &Outcome<'_, Span, ParseFailure<'_>>, out: &mut Vec<u8>) {
    match input {
        Ok(success) => {
            out.push(SPAN);
            position(&success.value.start, out);
            position(&success.value.end, out);
            success_report(success, out);
        }
        Err(failed) => encode_failed(failed, out, failure),
    }
}

pub(crate) fn invalid(reason: u8) -> Vec<u8> {
    alloc::vec![VERSION, INVALID_BOUNDARY, reason]
}

fn failure(failure: &ParseFailure<'_>, out: &mut Vec<u8>) {
    match failure {
        ParseFailure::NoJsonFound => out.push(NO_JSON),
        ParseFailure::UnsupportedEncoding { encoding } => {
            out.extend([
                UNSUPPORTED_ENCODING,
                match encoding.as_str() {
                    "utf-16be" => 0,
                    "utf-16le" => 1,
                    "utf-32be" => 2,
                    _ => 3,
                },
            ]);
        }
        ParseFailure::LimitReached {
            resource,
            limit,
            at,
            recovered,
        } => {
            out.extend([LIMIT_REACHED, resource_tag(*resource)]);
            usize_field(*limit, out);
            out.push(u8::from(at.is_some()));
            if let Some(at) = at {
                position(at, out);
            }
            out.push(u8::from(recovered.is_some()));
            if let Some(recovered) = recovered {
                value(recovered, out);
            }
        }
        ParseFailure::NoMatch {
            required_keys,
            recovered,
        } => {
            out.push(NO_MATCH);
            usize_field(required_keys.len(), out);
            for key in required_keys {
                string(key, out);
            }
            optional_value(recovered.as_ref(), out);
        }
        ParseFailure::StreamClosed => out.push(STREAM_CLOSED),
        ParseFailure::InvalidOptions { field, reason } => {
            out.push(INVALID_OPTIONS);
            text(field.as_str(), out);
            text(reason.as_str(), out);
        }
        ParseFailure::NonScalarSelection { path } => {
            out.push(NON_SCALAR_SELECTION);
            source_path(path, out);
        }
        ParseFailure::PolicyRefused { issue, recovered } => {
            out.push(POLICY_REFUSED);
            parse_error(issue, out);
            optional_value(recovered.as_ref(), out);
        }
    }
}

fn optional_value(input: Option<&Value<'_>>, out: &mut Vec<u8>) {
    out.push(u8::from(input.is_some()));
    if let Some(value) = input {
        self::value(value, out);
    }
}

fn parse_error(input: &ParseError<'_>, out: &mut Vec<u8>) {
    text(input.kind.as_str(), out);
    usize_field(input.value_index, out);
    source_path(&input.path, out);
    position(&input.at, out);
    usize_field(input.line, out);
    usize_field(input.column, out);
    string(&input.context, out);
    out.push(u8::from(input.refused.is_some()));
    if let Some(refused) = input.refused {
        text(refused.as_str(), out);
    }
}

fn repair_failure(repair: &RepairFailure<'_>, out: &mut Vec<u8>) {
    match repair {
        RepairFailure::Parse(parse) => failure(parse, out),
        RepairFailure::NonJsonValue { value_kind, path } => {
            out.extend([
                NON_JSON_VALUE,
                match value_kind {
                    NonJsonKind::Undefined => 0,
                    NonJsonKind::Nan => 1,
                    NonJsonKind::Infinity => 2,
                },
            ]);
            source_path(path, out);
        }
    }
}

fn source_path(path: &[PathStep<'_>], out: &mut Vec<u8>) {
    usize_field(path.len(), out);
    for segment in path {
        match segment {
            PathStep::Key(key) => {
                out.push(0);
                string(key, out);
            }
            PathStep::Index(index) => {
                out.push(1);
                usize_field(*index, out);
            }
        }
    }
}

fn resource_tag(resource: Resource) -> u8 {
    match resource {
        Resource::Errors => 0,
        Resource::Buffer => 1,
        Resource::Depth => 2,
        Resource::Scalar => 3,
        Resource::Retained => 4,
    }
}

fn position(input: &Position, out: &mut Vec<u8>) {
    usize_field(input.offset, out);
    out.push(match input.unit {
        Unit::Utf16 => 0,
        Unit::Byte => 1,
    });
    out.push(u8::from(input.chunk.is_some()));
    if let Some(chunk) = input.chunk {
        usize_field(chunk, out);
    }
}

fn value(input: &Value<'_>, out: &mut Vec<u8>) {
    match input {
        Value::Null => out.push(0),
        Value::Bool(false) => out.push(1),
        Value::Bool(true) => out.push(2),
        Value::Undefined => out.push(3),
        Value::Number(Number::Double(number)) => {
            out.push(4);
            out.extend(number.to_le_bytes());
        }
        Value::Number(Number::Exact(text)) => {
            out.push(5);
            bytes(text.as_bytes(), out);
        }
        Value::String(text) => string(text, out),
        Value::Array(items) => {
            out.push(8);
            usize_field(items.len(), out);
            for item in items {
                value(item, out);
            }
        }
        Value::Object(object) => {
            out.push(9);
            usize_field(object.entries().len(), out);
            for (key, item) in object.entries() {
                string(key, out);
                value(item, out);
            }
        }
    }
}

fn string(input: &JsonString<'_>, out: &mut Vec<u8>) {
    match input {
        JsonString::Text(text) => {
            out.push(6);
            bytes(text.as_bytes(), out);
        }
        JsonString::Units(units) => {
            out.push(7);
            usize_field(units.len(), out);
            for unit in units.iter() {
                out.extend(unit.to_le_bytes());
            }
        }
    }
}

fn text(input: &str, out: &mut Vec<u8>) {
    out.push(6);
    bytes(input.as_bytes(), out);
}

fn bytes(input: &[u8], out: &mut Vec<u8>) {
    usize_field(input.len(), out);
    out.extend(input);
}
fn usize_field(input: usize, out: &mut Vec<u8>) {
    out.extend(u64::try_from(input).unwrap_or(u64::MAX).to_le_bytes());
}
