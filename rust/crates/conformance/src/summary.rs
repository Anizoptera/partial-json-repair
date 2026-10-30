//! Observe summaries through public drains, preserving their position among ordinary results.

use partial_json_repair::{
    Canonical, FragmentStreamItem, Parser, StreamEvent, StreamParser, canonical_of,
};
use std::collections::BTreeMap;

pub(super) fn events<T: Canonical>(items: impl Iterator<Item = StreamEvent<T>>) -> String {
    let mut out = String::from("[");
    for (index, item) in items.enumerate() {
        if index != 0 {
            out.push(',');
        }
        match item {
            StreamEvent::Item(item) => out.push_str(&canonical_of(&item)),
            StreamEvent::Summary(summary) => out.push_str(&summary_text(&summary)),
        }
    }
    out.push(']');
    out
}

fn summary_text(summary: &partial_json_repair::StreamSummary) -> String {
    format!(
        "{{\"kind\":\"summary\",\"complete\":{},\"roots\":{},\"matches\":{},\"unmatched\":[{}]}}",
        summary.complete,
        summary.roots,
        summary.matches,
        summary
            .unmatched
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(","),
    )
}

pub(super) fn fragment_events(
    items: impl Iterator<Item = StreamEvent<FragmentStreamItem<'static>>>,
) -> String {
    let mut values = Vec::new();
    let mut final_summary = None;
    for event in items {
        match event {
            StreamEvent::Item(item) => values.push(item),
            StreamEvent::Summary(summary) => final_summary = Some(summary),
        }
    }
    let mut out = canonical_of(&super::normalize_fragments(values));
    if let Some(summary) = final_summary {
        out.pop();
        if out.len() > 1 {
            out.push(',');
        }
        out.push_str(&summary_text(&summary));
        out.push(']');
    }
    out
}

pub(super) fn observe(chunks: &[super::Chunk], options: &Parser) -> BTreeMap<&'static str, String> {
    let mut stream = StreamParser::new(options.clone()).with_summary();
    let mut fed = String::from("[");
    for (index, chunk) in chunks.iter().enumerate() {
        if index != 0 {
            fed.push(',');
        }
        fed.push_str(&events(stream.feed(chunk)));
    }
    fed.push(']');
    BTreeMap::from([("fed", fed), ("ended", events(stream.end()))])
}
