//! Keep scanner positions stable while the retained source slice moves forward.

use core::ops::Range;

use super::Units;

/// Only this boundary converts logical scanner offsets to retained-slice indexes.
#[derive(Clone, Copy)]
pub(crate) struct Window<'a> {
    units: Units<'a>,
    start: usize,
}

impl<'a> Window<'a> {
    pub(crate) fn new(units: Units<'a>, start: usize) -> Self {
        Self { units, start }
    }

    pub(crate) fn end(self) -> usize {
        self.start + self.units.len()
    }

    pub(crate) fn start(self) -> usize {
        self.start
    }

    pub(crate) fn get(self, at: usize) -> Option<u32> {
        self.units.get(at.checked_sub(self.start)?)
    }

    /// Ranges must still be retained; an old metadata offset is never readable source.
    pub(crate) fn slice(self, range: Range<usize>) -> Units<'a> {
        let range = range.start - self.start..range.end - self.start;
        self.units.slice(range)
    }

    pub(crate) fn whitespace(self, at: usize) -> usize {
        self.units.whitespace(at - self.start)
    }

    pub(crate) fn starts_with(self, at: usize, text: &[u8]) -> bool {
        at.checked_sub(self.start)
            .is_some_and(|at| self.units.starts_with(at, text))
    }

    pub(crate) fn next_opener(self, at: usize) -> Option<usize> {
        self.units
            .next_opener(at - self.start)
            .map(|at| self.start + at)
    }

    pub(crate) fn ready_end(self, end: usize) -> usize {
        self.start + self.units.prefix(end - self.start).ready_len()
    }
}

#[cfg(test)]
mod tests {
    use crate::options::Parser;
    use crate::scan::Scanner;

    /// Saved tokens resume even when their original source and decided prefixes are gone.
    #[test]
    fn tokens_resume_without_their_decided_prefixes() {
        let options = Parser::default();
        for (prefix, full) in [
            ("[\"abc", "[\"abcdef\"]"),
            ("{\"abc", "{\"abcdef\":1}"),
            ("['abc", "['abcdef']"),
            ("{'abc", "{'abcdef':1}"),
            ("{abc", "{abcdef:1}"),
            ("{a:abc ", "{a:abc def}"),
            ("{a:1_bad", "{a:1_badword}"),
            ("{a:1234", "{a:123456}"),
            ("{a: 1234", "{a: 1234word}"),
            ("{a:0xFF", "{a:0xFFaa}"),
            ("{a:foo\u{2000}", "{a:foo\u{2000}bar\u{3000}// note\n}"),
        ] {
            let mut scanner = Scanner::resume(prefix.as_bytes(), &options, Default::default());
            assert!(scanner.next_value().is_none());
            let mut state = scanner.suspend();
            let released = state.release_prefix().units;
            assert_eq!(released, prefix.len());
            let tail = &full.as_bytes()[released..];
            let mut resumed = Scanner::resume(tail, &options, state);
            let value = resumed.next_value().expect("root").expect("recovered");
            assert_eq!(value.value, options.parse(full).expect("whole input").value);
            assert_eq!((value.start, value.end), (0, full.len()));
        }
    }

    /// Open roots and completed candidates resume without rereading released source.
    #[test]
    fn scanner_resumes_after_a_released_container_prefix() {
        let options = Parser::default();
        for (prefix, full, minimum_release) in [
            (b"[1,".as_slice(), b"[1,2]".as_slice(), 2),
            (b"[1,2]/*".as_slice(), b"[1,2]/* note */".as_slice(), 5),
        ] {
            let mut scanner = Scanner::resume(prefix, &options, Default::default());
            assert!(scanner.next_value().is_none());
            let mut state = scanner.suspend();
            let released = state.release_prefix().units;
            assert!(released >= minimum_release);
            let tail = &full[released..];
            let mut resumed = Scanner::resume(tail, &options, state);
            let value = resumed.next_value().expect("root").expect("recovered");
            assert_eq!((value.start, value.end), (0, 5));
            assert_eq!(
                value.value,
                options.parse("[1,2]").expect("whole input").value
            );
            assert_eq!(resumed.input.get(0), None);
            assert_eq!(resumed.input.get(released), Some(u32::from(tail[0])));
        }
    }
}
