//! Keep original chunk coordinates only while a pending output or recovery can still name them.

use super::{Builder, RawFragment};

impl Builder<'_> {
    pub(crate) fn source_positions(&self) -> impl Iterator<Item = usize> + '_ {
        self.stack
            .iter()
            .filter_map(|frame| frame.pending())
            .flat_map(|key| core::iter::once(key.at).chain(key.comma))
            .chain(
                self.occurrences
                    .iter()
                    .flat_map(|node| [node.start, node.end]),
            )
            .chain(
                self.fragments
                    .iter()
                    .filter_map(|fragment| match fragment {
                        RawFragment::End { start, end, .. } => Some([*start, *end]),
                        _ => None,
                    })
                    .flatten(),
            )
            .chain(self.active_fragment.map(|active| active.start))
            .chain(self.retained_failure)
    }
}
