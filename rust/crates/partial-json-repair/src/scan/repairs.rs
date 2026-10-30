//! Keep streaming repair paths owned so each yield does not revisit every earlier report entry.

use super::{RawRepair, Scanner, path_of};
use crate::report::RepairKind;
use alloc::vec::Vec;

impl<'a> Scanner<'a> {
    /// Records a repair: always its kind, and the entry itself while the report budget allows.
    ///
    /// **The one place a repair enters either log**, so the count and the score cannot drift from
    /// what is stored. `max_diagnostics` bounds STORAGE only — see `kinds`.
    pub(super) fn record_repair(&mut self, kind: RepairKind, at: usize) {
        if !self.in_scope() {
            return;
        }
        self.kinds.push(kind);
        if self.claim_entry() {
            // Counts need no path; copy keys only when this entry can reach the caller.
            let path = path_of(&self.builder.stack);
            self.repairs.push(RawRepair { kind, at, path });
        }
    }
}

pub(super) enum Repairs<'a> {
    /// Whole-input scans can borrow unchanged keys for the lifetime of their source.
    Borrowed(Vec<RawRepair<'a>>),
    /// A resumed stream owns paths once, at insertion, and moves the log unchanged at suspension.
    Owned(Vec<RawRepair<'static>>),
}

impl<'a> Repairs<'a> {
    pub(super) fn as_slice(&self) -> &[RawRepair<'a>] {
        match self {
            Self::Borrowed(entries) => entries,
            Self::Owned(entries) => entries,
        }
    }

    pub(super) fn len(&self) -> usize {
        self.as_slice().len()
    }

    pub(super) fn push(&mut self, entry: RawRepair<'a>) {
        match self {
            Self::Borrowed(entries) => entries.push(entry),
            Self::Owned(entries) => entries.push(entry.into_owned()),
        }
    }

    pub(super) fn truncate(&mut self, len: usize) {
        match self {
            Self::Borrowed(entries) => entries.truncate(len),
            Self::Owned(entries) => entries.truncate(len),
        }
    }

    pub(super) fn into_owned(self) -> Vec<RawRepair<'static>> {
        match self {
            Self::Borrowed(entries) => entries.into_iter().map(RawRepair::into_owned).collect(),
            Self::Owned(entries) => entries,
        }
    }
}
