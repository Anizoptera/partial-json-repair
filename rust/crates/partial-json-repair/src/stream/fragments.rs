//! Deliver one root's scalar events before requesting work on the next root.

use super::values::{Capture, Drain};
use super::{FragmentStreamItem, FragmentStreamParser};
use crate::parse::{AsInput, Marks};
use alloc::vec::Vec;

/// Keep undelivered events with the drain so abandoning it releases both events and source.
pub(super) struct FragmentDrain<'a, C: AsInput> {
    roots: Drain<'a, C>,
    pending: alloc::vec::IntoIter<FragmentStreamItem<'static>>,
    reported: &'a mut Marks,
    finished: bool,
}

impl<'a, C: AsInput> FragmentDrain<'a, C> {
    pub(super) fn new(roots: Drain<'a, C>, reported: &'a mut Marks) -> Self {
        Self {
            roots,
            pending: Vec::new().into_iter(),
            reported,
            finished: false,
        }
    }

    pub(super) fn stream(&self) -> &super::StreamParser {
        self.roots.stream
    }
}

impl<C: AsInput> Iterator for FragmentDrain<'_, C> {
    type Item = FragmentStreamItem<'static>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            if let Some(item) = self.pending.next() {
                return Some(item);
            }
            let mut items = Vec::new();
            let root = self.roots.advance(Capture::Fragments {
                items: &mut items,
                reported: self.reported,
            });
            let finished = root.is_none();
            if let Some(Err(failed)) = root {
                items.push(Err(failed));
            }
            self.pending = items.into_iter();
            if finished && self.pending.len() == 0 {
                self.finished = true;
                return None;
            }
        }
    }
}

impl<C: AsInput> Drop for FragmentDrain<'_, C> {
    fn drop(&mut self) {
        // Scanner exhaustion does not settle an output iterator the caller has not finished.
        if !self.finished {
            self.roots.abandon();
        }
    }
}

impl FragmentStreamParser {
    /// Yield owned scalar events without scanning a later root ahead of demand.
    /// Abandoning the drain closes the parser and releases its source and undelivered events.
    pub fn feed<'a, C: AsInput + 'a>(
        &'a mut self,
        chunk: C,
    ) -> impl Iterator<Item = FragmentStreamItem<'static>> + 'a {
        let (roots, reports_reset) = Drain::feed(&mut self.stream, chunk);
        if reports_reset {
            self.reported = Marks::default();
        }
        FragmentDrain::new(roots, &mut self.reported)
    }

    /// Recover the unfinished tail once; finishing or abandoning its drain closes the parser.
    pub fn end(&mut self) -> impl Iterator<Item = FragmentStreamItem<'static>> + '_ {
        FragmentDrain::new(Drain::end(&mut self.stream), &mut self.reported)
    }
}

#[cfg(test)]
mod tests {
    use crate::{Fragment, ParseFailure, Parser, PathSegment};
    use alloc::vec;

    #[test]
    fn pulls_yield_string_prefixes_before_root_completion() {
        let parser = Parser::default()
            .select(vec![vec![PathSegment::Key("msg".into())]])
            .expect("selector")
            .fragments()
            .expect("fragment mode is compatible");
        let text = "a😀".repeat(8192);
        let input = alloc::format!("{{\"msg\":\"{text}\"}}");
        for pulls in [1, 2] {
            let mut stream = parser.stream_parser();
            let mut drain = stream.feed(&input);
            let held: alloc::vec::Vec<_> = drain.by_ref().take(pulls).collect();
            drop(drain);
            assert_eq!(stream.stream.delivered, 0, "unrequested root completion");
            assert!(matches!(
                &held[0].as_ref().expect("start").value,
                Fragment::Start { .. }
            ));
            if pulls == 2 {
                let Fragment::Data { text: piece, .. } = &held[1].as_ref().expect("data").value
                else {
                    panic!("expected bounded content");
                };
                let piece = piece.as_str().expect("valid UTF-8");
                assert!(!piece.is_empty() && piece.len() < text.len());
                assert!(text.starts_with(piece));
            }
        }
    }

    #[test]
    fn raw_and_escaped_surrogates_share_a_fragment_when_they_form_a_pair() {
        let parser = Parser::default()
            .select(vec![vec![PathSegment::Key("msg".into())]])
            .expect("selector")
            .fragments()
            .expect("fragment mode is compatible");
        for content in [
            vec![0xd83d, 0x5c, 0x75, 0x64, 0x65, 0x30, 0x30],
            vec![0x5c, 0x75, 0x64, 0x38, 0x33, 0x64, 0xde00],
        ] {
            let mut input: alloc::vec::Vec<_> = "{\"msg\":\"".encode_utf16().collect();
            input.extend(content);
            input.extend("\"}".encode_utf16());
            let mut stream = parser.stream_parser();
            let mut data = alloc::vec::Vec::new();
            for item in stream.feed(input.as_slice()) {
                if let Fragment::Data { text, .. } = item.expect("fragment").value {
                    let piece: alloc::vec::Vec<_> = text.code_units().collect();
                    assert!(
                        !(data
                            .last()
                            .is_some_and(|unit| (0xd800..0xdc00).contains(unit))
                            && piece
                                .first()
                                .is_some_and(|unit| (0xdc00..0xe000).contains(unit))),
                        "split surrogate pair"
                    );
                    data.extend(piece);
                }
            }
            assert_eq!(data, [0xd83d, 0xde00]);
        }
    }

    #[test]
    fn abandonment_releases_pending_events_without_scanning_later_roots() {
        let parser = Parser::default()
            .select(vec![vec![PathSegment::Key("msg".into())]])
            .expect("selector")
            .fragments()
            .expect("fragment mode is compatible");
        for input in [r#"{"msg":"kept"} {"msg":"unrequested"}"#, r#"{"msg":"kept"#] {
            for pulls in [0, 1, 2] {
                let mut stream = parser.stream_parser();
                let mut drain = stream.feed(input);
                let held: alloc::vec::Vec<_> = drain.by_ref().take(pulls).collect();
                drop(drain);
                assert!(stream.stream.delivered <= 1, "later root was scanned");
                assert_eq!(
                    stream
                        .stream
                        .buffer
                        .source(false)
                        .expect("released")
                        .input
                        .len(),
                    0
                );
                assert!(
                    matches!(stream.end().next(), Some(Err(failed)) if failed.failure == ParseFailure::StreamClosed)
                );
                if pulls == 2 {
                    let fragment = &held[1].as_ref().expect("data").value;
                    assert!(
                        matches!(fragment, Fragment::Data { text, .. } if text.as_str() == Some("kept"))
                    );
                }
            }
        }
    }
}
