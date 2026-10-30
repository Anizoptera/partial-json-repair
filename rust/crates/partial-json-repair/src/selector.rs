//! Decides, for every node the scanner reaches, whether a `select` path names it, whether a `skip`
//! path removes it, and whether any selector could still match beneath it — so the builder can
//! decline to allocate a subtree BEFORE its first member arrives.
//!
//! Paths are lists of segments rather than a string grammar: a key is a string, an index a number,
//! and the two wildcards are their own variants, so a document whose key is literally `*` or
//! `items.name` needs no escaping. Segment matching is exact and typed — the string `"0"` is a key,
//! never index `0`.
//!
//! The matcher is the textbook automaton for glob paths, kept one level per depth: a level holds the
//! (path, segment) pairs still alive at that depth, a descent derives the next level from the
//! current one, and an ascent discards it. Work per node is bounded by the number of selector
//! segments, never by the document. `AnyDepth` is the one segment that stays alive across levels,
//! and a stamp dedupes the states it produces: without one, `[AnyDepth, "a", AnyDepth]` gained a
//! duplicate state on every level below the first `a`.

use alloc::vec::Vec;

use crate::value::JsonString;

/// One segment of a selector path.
///
/// The JavaScript API spells the two wildcards as unique symbols so no literal key can collide with
/// them. Rust needs no such trick: a distinct variant IS the guarantee, which is why this is an enum
/// rather than a string grammar with an escape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathSegment<'a> {
    /// An object member, matched exactly. Never an array index, whatever its digits spell.
    Key(JsonString<'a>),
    /// An array element by position.
    Index(usize),
    /// Exactly one key or index.
    Any,
    /// Zero or more keys or indexes.
    AnyDepth,
}

/// One `select` or `skip` entry: the segments from the root down, `[]` being the root itself.
pub type SelectorPath<'a> = Vec<PathSegment<'a>>;

/// Which option was unusable, and why. Mirrors the JavaScript `invalid-options` failure so a caller
/// reading either implementation is told the same thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectorFailure {
    /// Which of the two options held the unusable path.
    pub field: SelectorField,
    /// What was wrong with it.
    pub reason: SelectorReason,
}

/// The option a failure came from. Named rather than a boolean so a message can quote it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectorField {
    /// `select` — what to keep.
    Select,
    /// `skip` — what to remove.
    Skip,
    /// `fragments` — eager scalar delivery.
    Fragments,
}

impl SelectorField {
    /// The name a report spells, matching the reference's `field` exactly — the corpus compares
    /// these as strings, so a different spelling IS a different answer.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Select => "select",
            Self::Skip => "skip",
            Self::Fragments => "fragments",
        }
    }
}

/// Why a path was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectorReason {
    /// A path or a segment was not one of the four segment kinds.
    Selector,
    /// A `skip` path did not end in a key.
    SkipTail,
    /// Root acceptance cannot be known before fragment delivery begins.
    RootFilter,
}

impl SelectorReason {
    /// The name a report spells. See [`SelectorField::as_str`].
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Selector => "selector",
            Self::SkipTail => "skip-tail",
            Self::RootFilter => "root-filter",
        }
    }
}

/// Paths with consecutive `AnyDepth` collapsed, and the stride that packs (path, position) into one
/// integer.
#[derive(Clone, Debug)]
pub struct Compiled<'a> {
    paths: Vec<SelectorPath<'a>>,
    stride: usize,
}

impl<'a> Compiled<'a> {
    /// Validates and normalises one path list.
    ///
    /// A `skip` path must end in a key: a wildcard or index tail could name an array element, and
    /// removing one would shift every later index, which the contract refuses to do silently. `[]`
    /// cannot be skipped for the same reason it cannot be a member — it is the root.
    pub fn compile(
        field: SelectorField,
        paths: impl IntoIterator<Item = SelectorPath<'a>>,
    ) -> Result<Self, SelectorFailure> {
        let mut out: Vec<SelectorPath<'a>> = Vec::new();
        let mut longest = 0;
        for path in paths {
            let mut segments: SelectorPath<'a> = Vec::with_capacity(path.len());
            for segment in path {
                // A run of `AnyDepth` matches exactly what one does, and each extra copy is a state
                // per level for the rest of the scan.
                if segment == PathSegment::AnyDepth
                    && segments.last() == Some(&PathSegment::AnyDepth)
                {
                    continue;
                }
                segments.push(segment);
            }
            if field == SelectorField::Skip && !matches!(segments.last(), Some(PathSegment::Key(_)))
            {
                return Err(SelectorFailure {
                    field,
                    reason: SelectorReason::SkipTail,
                });
            }
            longest = longest.max(segments.len());
            out.push(segments);
        }
        Ok(Self {
            paths: out,
            // Positions run 0..=length, and a state may sit one past a trailing wildcard.
            stride: longest + 2,
        })
    }

    /// How many paths were compiled — the denominator of the unmatched-selector tally.
    #[must_use]
    pub fn len(&self) -> usize {
        self.paths.len()
    }

    /// Whether the list was empty. An empty `select` selects nothing, which is not the same as no
    /// `select` at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
}

/// What a node is called by its parent: an object key or an array index.
#[derive(Clone, Copy, Debug)]
pub enum Label<'key, 'source> {
    /// An object member's lossless key.
    Key(&'key JsonString<'source>),
    /// An array element's position.
    Index(usize),
}

impl PathSegment<'_> {
    /// Whether this segment names `label`. Typed, so the key `"0"` never matches index `0`.
    fn matches(&self, label: Label<'_, '_>) -> bool {
        match (self, label) {
            (Self::Any, _) => true,
            (Self::Key(key), Label::Key(name)) => key == name,
            (Self::Index(i), Label::Index(at)) => *i == at,
            _ => false,
        }
    }
}

/// One automaton over one path list, its levels reused across the whole scan.
#[derive(Clone, Debug)]
struct Matcher<'a> {
    compiled: Compiled<'a>,
    /// Live states per depth. Kept and truncated rather than reallocated, so a deep document pays
    /// for its depth once.
    levels: Vec<Vec<usize>>,
    /// Last stamp that reached each state, so a level dedupes in O(1) per push.
    ///
    /// `u64` and not the reference's `Uint32Array`: JavaScript's number wraps at 2^53, and a `u32`
    /// stamp would alias after four billion descents — a document long enough to reach that would
    /// silently start dropping states. The array is `paths × stride` entries, so the extra four
    /// bytes each are nothing.
    stamps: Vec<u64>,
    stamp: u64,
}

impl<'a> Matcher<'a> {
    fn new(compiled: Compiled<'a>) -> Self {
        let states = compiled.paths.len() * compiled.stride;
        let root = (0..compiled.paths.len())
            .map(|s| s * compiled.stride)
            .collect();
        Self {
            compiled,
            levels: alloc::vec![root],
            stamps: alloc::vec![0; states],
            stamp: 0,
        }
    }

    /// Derives the level at `depth + 1` from the one at `depth`, for the child named `label`.
    fn descend(&mut self, depth: usize, label: Label<'_, '_>) {
        let stride = self.compiled.stride;
        self.stamp += 1;
        let stamp = self.stamp;
        if self.levels.len() <= depth + 1 {
            self.levels.resize(depth + 2, Vec::new());
        }
        // Split the borrow: the source level is read while the target is written, and both live in
        // one `Vec`. `split_at_mut` is the safe way to hold two disjoint slices of it.
        let (before, after) = self.levels.split_at_mut(depth + 1);
        let from = &before[depth];
        let to = &mut after[0];
        to.clear();
        for &state in from {
            let s = state / stride;
            let i = state - s * stride;
            let path = &self.compiled.paths[s];
            let Some(segment) = path.get(i) else { continue };
            if *segment == PathSegment::AnyDepth {
                // The wildcard keeps consuming...
                push(to, &mut self.stamps, stamp, state);
                // ...or consumes nothing, and the segment after it must name this node.
                if let Some(next) = path.get(i + 1)
                    && next.matches(label)
                {
                    push(to, &mut self.stamps, stamp, state + 2);
                }
            } else if segment.matches(label) {
                push(to, &mut self.stamps, stamp, state + 1);
            }
        }
    }

    /// Path indexes whose state names the node at `depth`, ascending. Empty when none does.
    fn hits(&self, depth: usize) -> Vec<usize> {
        let stride = self.compiled.stride;
        let mut out: Vec<usize> = Vec::new();
        for &state in &self.levels[depth] {
            let s = state / stride;
            let path = &self.compiled.paths[s];
            let i = state - s * stride;
            // Terminal: every segment consumed, or only a trailing `AnyDepth` left.
            if i >= path.len() || (i + 1 == path.len() && path[i] == PathSegment::AnyDepth) {
                out.push(s);
            }
        }
        out.sort_unstable();
        out
    }

    /// Whether any state at `depth` can still consume a further segment.
    fn reachable(&self, depth: usize) -> bool {
        let stride = self.compiled.stride;
        self.levels[depth].iter().any(|&state| {
            let s = state / stride;
            state - s * stride < self.compiled.paths[s].len()
        })
    }
}

fn push(to: &mut Vec<usize>, stamps: &mut [u64], stamp: u64, state: usize) {
    if stamps[state] == stamp {
        return;
    }
    stamps[state] = stamp;
    to.push(state);
}

/// What the selection says about the node the builder is about to place.
#[derive(Clone, Debug, Default)]
pub struct Placement {
    /// Selector indexes naming this node; empty when none does.
    pub hits: Vec<usize>,
    /// A `skip` path names it: not built, nothing beneath it matters.
    pub skipped: bool,
    /// No selector can match this node or anything beneath it.
    pub dead: bool,
}

/// The `select` and `skip` automata walked together, one level per depth.
///
/// `select` absent means everything is wanted except what `skip` removes; `select` present means
/// nothing is wanted except what it names, `skip` still winning where the two overlap.
/// **Depth is a PARAMETER, not state.** The reference keeps its own counter and pairs a `descend`
/// with an `ascend`; the scanner already knows the depth as `stack.len()`, so taking it as an
/// argument removes a second copy that can fall out of step — and with it every way to leave the
/// matcher standing at the wrong level. Nothing needs undoing on the way back up: a level is
/// overwritten by the next descent that reaches it, and levels above the current depth are never
/// read.
#[derive(Clone, Debug)]
pub struct Selection<'a> {
    select: Option<Matcher<'a>>,
    skip: Option<Matcher<'a>>,
    /// How many `select` paths there are, for the tally of the ones that never matched.
    pub selectors: usize,
}

impl<'a> Selection<'a> {
    /// Walks the two automata together. Absent `select` means everything is wanted; absent `skip`
    /// means nothing is removed.
    #[must_use]
    pub fn new(select: Option<Compiled<'a>>, skip: Option<Compiled<'a>>) -> Self {
        Self {
            selectors: select.as_ref().map_or(0, Compiled::len),
            select: select.map(Matcher::new),
            skip: skip.map(Matcher::new),
        }
    }

    /// Whether `select` was given at all — the switch between whole values and matches.
    pub const fn selecting(&self) -> bool {
        self.select.is_some()
    }

    /// Classifies one node: the ROOT when `from` is `None`, otherwise the child reached from the
    /// container at depth `parent` by `label`.
    ///
    /// Stepping down and reading the answer are ONE call because they are one question, and split
    /// apart they are two that can be asked at different depths. The parent and the label travel as
    /// one argument for the same reason: the root has neither, and a label with no parent names
    /// nothing.
    pub fn placement(&mut self, from: Option<(usize, Label<'_, '_>)>) -> Placement {
        let depth = match from {
            None => 0,
            Some((parent, label)) => {
                if let Some(select) = self.select.as_mut() {
                    select.descend(parent, label);
                }
                if let Some(skip) = self.skip.as_mut() {
                    skip.descend(parent, label);
                }
                parent + 1
            }
        };
        // A skip wins wherever the two overlap, so nothing beneath it matters and the `select`
        // answer is not worth computing.
        if self
            .skip
            .as_ref()
            .is_some_and(|m| !m.hits(depth).is_empty())
        {
            return Placement {
                hits: Vec::new(),
                skipped: true,
                dead: true,
            };
        }
        let Some(select) = self.select.as_ref() else {
            return Placement::default();
        };
        let hits = select.hits(depth);
        let dead = hits.is_empty() && !select.reachable(depth);
        Placement {
            hits,
            skipped: false,
            dead,
        }
    }
}
