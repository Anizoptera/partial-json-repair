//! Resume the scanner and its source locations together across stream chunks.

use super::locations::IssueLocations;
use crate::scan::{Released, Suspended};
use crate::selector::Selection;

/// Scanner state stays public and source-independent; stream report storage belongs to the reader.
#[derive(Default)]
pub(crate) struct PausedReader {
    pub(super) scan: Suspended,
    pub(super) locations: IssueLocations,
    pub(super) compatible: Option<crate::Value<'static>>,
}

impl PausedReader {
    pub(crate) fn with_view(mut self) -> Self {
        self.scan = self.scan.with_view();
        self
    }

    pub(crate) fn snapshot(&self) -> Option<(crate::Value<'static>, crate::SourcePath<'static>)> {
        self.scan.snapshot()
    }

    pub(crate) fn selected_snapshot(
        &self,
    ) -> Option<(
        alloc::vec::Vec<crate::builder::Occurrence<'static>>,
        crate::SourcePath<'static>,
    )> {
        self.scan.selected_snapshot()
    }

    pub(crate) fn source_positions(&self) -> impl Iterator<Item = usize> + '_ {
        self.scan.source_positions()
    }

    pub(crate) fn with_selection(mut self, selection: Selection<'static>) -> Self {
        self.scan = self.scan.with_selection(selection);
        self
    }

    pub(crate) fn with_fragments(mut self, selection: Selection<'static>) -> Self {
        self.scan = self.scan.with_fragments(selection);
        self
    }

    /// Error locations survive input release until the corresponding reports are discarded.
    pub(crate) fn release_prefix(&mut self) -> Released {
        let released = self.scan.release_prefix();
        if released.reports_reset {
            self.locations = IssueLocations::default();
        }
        released
    }
}
