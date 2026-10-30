//! Retain stream input and map the compacted window back to original chunks.

use super::encoding::Declaration;
use super::storage::Storage;
use crate::outcome::Encoding;
use crate::parse::{Chunk, Input, LineColumn, PausedReader, StreamInput};
use crate::report::{Span, Unit};
use crate::scan::{Released, Units};
use alloc::vec::Vec;

/// All delivery modes share chunk boundaries and release accounting.
#[derive(Default)]
pub(super) struct Buffer {
    buffer: Storage,
    chunks: Vec<Chunk>,
    /// Sweep after enough new boundaries arrive to amortize walking the live report/selection set.
    prune_at: usize,
    next_chunk: usize,
    chunk_open: bool,
    start: usize,
    origin: LineColumn,
    declaration: Declaration,
}

impl Buffer {
    pub(super) fn span(&self, start: usize, end: usize) -> Option<Span> {
        self.source(false)
            .ok()
            .map(|source| source.span(start, end))
    }

    /// Keep the active chunk borrowed; only an unfinished tail enters retained storage.
    pub(super) fn begin(
        &mut self,
        chunk: Input<'_>,
        released: Released,
        final_slice: bool,
    ) -> (bool, bool) {
        let reports_reset = self.compact(released);
        self.record(chunk, final_slice);
        (reports_reset, !chunk.is_empty())
    }

    fn record(&mut self, chunk: Input<'_>, final_slice: bool) {
        self.declaration.append(chunk);
        if !self.chunk_open {
            let boundary = Chunk {
                start: self.start + self.buffer.units().len(),
                index: self.next_chunk,
                unit: chunk.unit(),
            };
            // Only the last chunk at an offset can own that position. Replacing its boundary keeps
            // empty chunks observable without letting them grow metadata outside the input limit.
            if let Some(last) = self.chunks.last_mut()
                && last.start == boundary.start
            {
                *last = boundary;
            } else {
                self.chunks.push(boundary);
            }
        }
        self.chunk_open = !final_slice;
        if final_slice {
            self.next_chunk += 1;
        }
    }

    /// Borrow the retained window and its matching source coordinates together.
    pub(super) fn source(&self, ending: bool) -> Result<StreamInput<'_>, Encoding> {
        self.source_units(self.buffer.units(), ending)
    }

    pub(super) fn borrowed_source<'a>(
        &'a self,
        input: Input<'a>,
        ending: bool,
    ) -> Result<StreamInput<'a>, Encoding> {
        self.source_units(Units::join(self.buffer.units(), input.units()), ending)
    }

    fn source_units<'a>(
        &'a self,
        input: Units<'a>,
        ending: bool,
    ) -> Result<StreamInput<'a>, Encoding> {
        let ready = self.declaration.ready(ending)?;
        Ok(StreamInput {
            input,
            ready: if !ready {
                0
            } else if ending {
                input.len()
            } else {
                input.ready_len()
            },
            chunks: &self.chunks,
            start: self.start,
            unit: Unit::Byte,
            origin: self.origin,
        })
    }

    /// Copy only source still needed after the active chunk's drain has settled.
    pub(super) fn retain(&mut self, input: Input<'_>, released: Released) -> bool {
        let carry = self.buffer.units().len();
        self.origin.advance(
            Units::join(self.buffer.units(), input.units()),
            released.units,
        );
        self.buffer.release(released.units.min(carry));
        let active = released.units.saturating_sub(carry);
        match input {
            Input::Text(text) => self.buffer.append(Input::Bytes(&text.as_bytes()[active..])),
            Input::Bytes(bytes) => self.buffer.append(Input::Bytes(&bytes[active..])),
            Input::Utf16(units) => self.buffer.append(Input::Utf16(&units[active..])),
        }
        self.release_coordinates(released)
    }

    pub(super) fn compact(&mut self, released: Released) -> bool {
        self.origin.advance(self.buffer.units(), released.units);
        self.buffer.release(released.units);
        self.release_coordinates(released)
    }

    /// Retain the input window and the chunk owning each still-observable logical position.
    /// A geometric interval pays for each sweep with new boundaries instead of walking reports
    /// on every feed. The small floor batches short streams without growing with their length.
    pub(super) fn prune_coordinates(&mut self, scan: &PausedReader) {
        if self.chunks.len() < self.prune_at.max(4) {
            return;
        }
        let tail = self
            .chunks
            .partition_point(|chunk| chunk.start <= self.start)
            .saturating_sub(1);
        let mut kept = alloc::vec![false; tail];
        let mut references = 0usize;
        for at in scan.source_positions() {
            references = references.saturating_add(1);
            if at >= self.start {
                continue;
            }
            let owner = self
                .chunks
                .partition_point(|chunk| chunk.start <= at)
                .saturating_sub(1);
            if let Some(keep) = kept.get_mut(owner) {
                *keep = true;
            }
        }
        let mut index = 0;
        self.chunks.retain(|_| {
            let keep = index >= tail || kept[index];
            index += 1;
            keep
        });
        self.release_excess_capacity();
        // Many report entries can share one chunk; their walk must also buy an interval.
        self.prune_at = self
            .chunks
            .len()
            .saturating_add(references.max(self.chunks.len()));
    }

    /// Live roots can still report an old chunk after its bytes leave the buffer.
    fn release_coordinates(&mut self, released: Released) -> bool {
        self.start += released.units;
        if !released.reports_reset {
            return false;
        }
        // A new root must not inherit the previous root's report-dependent sweep interval.
        self.prune_at = 0;
        if self.buffer.units().len() == 0 {
            if self.chunk_open {
                let keep = self.chunks.len().saturating_sub(1);
                self.chunks.drain(..keep);
            } else {
                self.chunks.clear();
            }
            self.release_excess_capacity();
            return true;
        }
        let chunk = self
            .chunks
            .partition_point(|chunk| chunk.start <= self.start)
            .saturating_sub(1);
        self.chunks.drain(..chunk);
        self.release_excess_capacity();
        true
    }

    /// Keep growth headroom without carrying a previous root's large allocation indefinitely.
    fn release_excess_capacity(&mut self) {
        let retained = self.chunks.len().max(4);
        if self.chunks.capacity() > retained.saturating_mul(4) {
            self.chunks.shrink_to(retained.saturating_mul(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Buffer;
    use crate::scan::Released;

    #[test]
    fn active_input_stays_borrowed_beside_retained_carry() {
        let mut buffer = Buffer::default();
        let (_, borrowed) = buffer.begin("[".into(), Default::default(), true);
        assert!(borrowed);
        buffer.retain("[".into(), Default::default());

        let active = "1,".repeat(512);
        let (_, borrowed) = buffer.begin(active.as_str().into(), Default::default(), true);
        assert!(borrowed);
        assert_eq!(buffer.buffer.units().len(), 1);
        buffer.retain(
            active.as_str().into(),
            Released {
                units: active.len() - 2,
                reports_reset: false,
            },
        );
        assert_eq!(buffer.buffer.units().len(), 3);
    }

    #[test]
    fn released_position_history_returns_excess_capacity() {
        let mut buffer = Buffer::default();
        for _ in 0..256 {
            buffer.begin("x".into(), Default::default(), true);
            buffer.retain(
                "x".into(),
                crate::scan::Released {
                    units: 1,
                    reports_reset: false,
                },
            );
        }
        let peak = buffer.chunks.capacity();
        buffer.compact(crate::scan::Released {
            units: 0,
            reports_reset: true,
        });
        assert!(
            buffer.chunks.capacity() < peak,
            "released history must release its allocation"
        );
    }

    #[test]
    fn one_open_string_does_not_retain_every_chunk_boundary() {
        use crate::{DiagnosticsMode, Input, Parser, StreamParser};
        for diagnostics in [DiagnosticsMode::Off, DiagnosticsMode::On] {
            let mut stream = StreamParser::new(Parser {
                diagnostics,
                locations: true,
                ..Parser::default()
            });
            for prefix in ["{", "\"a\"", ":\""] {
                assert_eq!(stream.feed(prefix).count(), 0);
            }
            let mut capacity = 0;
            for chunk in 1..=512 {
                let input = if chunk % 2 == 0 {
                    Input::Utf16(&[120])
                } else {
                    Input::Text("x")
                };
                assert_eq!(stream.feed(input).count(), 0);
                if chunk == 64 {
                    capacity = stream.buffer.chunks.capacity();
                }
            }
            assert_eq!(
                stream.buffer.chunks.capacity(),
                capacity,
                "stable live positions"
            );
            let item = stream.end().next().expect("root").expect("recovered");
            let span = item.span.expect("requested span");
            assert_eq!((span.start.chunk, span.start.offset), (Some(0), 0));
            assert_eq!((span.end.chunk, span.end.offset), (Some(514), 1));
            assert_eq!(span.start.unit, crate::report::Unit::Byte);
            assert_eq!(span.end.unit, crate::report::Unit::Utf16);
        }
    }

    /// Empty input must not buy unbounded retained metadata; inspect the owner rather than mock
    /// an allocator or infer retained memory from process-wide measurements.
    #[test]
    fn empty_chunks_keep_storage_bounded_and_original_chunk_numbers() {
        let mut buffer = Buffer::default();
        buffer.begin("[".into(), Default::default(), true);
        buffer.retain("[".into(), Default::default());
        buffer.begin("".into(), Default::default(), true);
        let capacity = buffer.chunks.capacity();
        for _ in 0..1024 {
            buffer.begin("".into(), Default::default(), true);
        }
        assert_eq!(buffer.chunks.capacity(), capacity);
        assert_eq!(
            buffer
                .source(false)
                .expect("text")
                .chunks
                .last()
                .expect("boundary")
                .index,
            1025
        );
        buffer.begin("]".into(), Default::default(), true);
        assert_eq!(
            buffer
                .source(false)
                .expect("text")
                .chunks
                .last()
                .expect("boundary")
                .index,
            1026
        );
    }
}
