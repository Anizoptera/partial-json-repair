//! Finalization of damaged and incomplete container shapes.

use super::*;

impl<'a> Scanner<'a> {
    /// Close the consumed prefix, discarding a token only when decoding interrupted it.
    pub(crate) fn finish_decode_stop(&mut self, unfinished: bool) -> Option<Value<'a>> {
        if matches!(self.resuming, Some(Paused::Judging { .. })) {
            return self.salvage();
        }
        if unfinished {
            self.at = self.placing_start;
            self.after_comma = self.comma_at.is_some();
        }
        if self.builder.stack.is_empty() {
            return None;
        }
        if unfinished && matches!(self.rewind.resume, Resume::Key) {
            self.lenient(SwitchableRepair::DroppedMember, self.at);
            self.after_comma = false;
        }
        match self.finalize(None) {
            Ok(value) => Some(value),
            Err(_) => self.salvage(),
        }
    }

    /// Input ended with containers still open. Closes them, and reports every one.
    ///
    /// Closing them is this package's promise that a partial result beats dropped content; the
    /// repairs are what keep it from being a silent invention. **Nothing is appended to the VALUE to
    /// mark incompleteness** — the closers exist in the repaired TEXT, where a `}` is what another
    /// parser needs, and nowhere in the tree.
    ///
    /// The order is load-bearing. A key whose value never arrived is dropped FIRST, because the
    /// repaired text must lose it too — otherwise `{"a":1,"b":` closes to `{"a":1,"b":}`. Then a
    /// comma the input wrote and never followed, or `[1,2,3,` closes to `[1,2,3,]`. Only then do the
    /// closers go on. The first two are mutually exclusive: reading a key ends `after_comma`.
    ///
    /// Returns the value built so far — a real prefix of what the source held, never padded out.
    pub(super) fn finalize(&mut self, done: Option<Value<'a>>) -> Result<Value<'a>, ScanError> {
        let final_at = self.at;
        // Read by reference and LEFT on the frame, because a path is derived from the frames and
        // BOTH the dropped member and the container that could not be closed are reported at the
        // member the input was in the middle of writing: `{"a":1,"b":` is damage to `b`, and a
        // report that named neither would tell a reader which object broke but not where.
        //
        // A pending key is an orphan only when no value arrived — a key whose value HAS just been
        // completed is the ordinary case, and `done` is what distinguishes them. Stating that here
        // is also what makes leaving the key on the frame safe: the loop below places nothing into
        // a frame whose value is `None`, so the key cannot pick up a member it never had.
        let orphan = done.is_none().then(|| {
            self.builder
                .stack
                .last()
                .and_then(Frame::pending)
                .map(|pending| (pending.at, pending.comma, pending.mark))
        });
        let orphan = orphan.flatten();
        if let Some((key_at, comma, mark)) = orphan {
            let from = self.drop_start(mark, comma.unwrap_or(key_at));
            self.retract(mark);
            // Reported AFTER the retraction, or the retraction takes the report too. A caller told
            // nothing at all cannot tell a dropped member from one the input never had.
            self.lenient(SwitchableRepair::DroppedMember, key_at);
            self.edit(from, final_at, Cow::Borrowed(""));
        } else if let (true, Some(comma)) = (self.after_comma, self.comma_at)
            && !self.builder.stack.is_empty()
        {
            self.lenient(SwitchableRepair::TrailingComma, comma);
            self.edit(comma, comma + 1, Cow::Borrowed(""));
        }
        let mut value = done;
        while !self.builder.stack.is_empty() {
            // Placed BEFORE this container reports itself, because the report carries the path and
            // the path counts what the container holds: `[{"name":"John"` names the unclosed array
            // at index 1, the slot after the object that was just closed into it.
            // The member's key is on the frame below and its value is in hand, which is the moment
            // the policy governs — the container simply reached its end instead of its closer.
            let mut inner = value.take();
            if inner.is_some() && self.govern_pending()? {
                inner = None;
                self.builder
                    .stack
                    .last_mut()
                    .and_then(Frame::pending_mut)
                    .and_then(Option::take);
                // Spliced HERE rather than left for the next token, because there is none: the
                // deletion runs to `final_at`, where this loop inserts the closer. Leaving it
                // unspliced puts the member back into the repaired text while the tree drops it —
                // `{"__proto__": {"x":1` would repair to `{"__proto__": {"x":1}`, which re-parses
                // WITH the prototype key. `SECURITY.md` rules a repair that parses to a different
                // value than the recovery a defect.
                self.splice_dropped();
            }
            let dead = inner.as_ref().is_some_and(|value| {
                self.builder
                    .place(value, self.placing_start, final_at, self.edits.len())
            });
            match (inner, dead, self.builder.stack.last_mut()) {
                // A skipped member still CONSUMES its key, the same rule the placement site in the
                // unwind states. Here it also decides the PATH: the closer this loop is about to
                // report is described by the frames, so a key left waiting names the repair after
                // the very member the caller skipped — `["a"]` where the reference says `[]`.
                (Some(_), true, Some(frame)) if frame.is_object() => {
                    frame.pending_mut().and_then(Option::take);
                }
                (Some(inner), false, Some(frame)) => frame.place(inner),
                _ => {}
            }
            let object = self.builder.stack.last().is_some_and(Frame::is_object);
            self.lenient(
                match object {
                    true => SwitchableRepair::UnclosedObject,
                    false => SwitchableRepair::UnclosedArray,
                },
                final_at,
            );
            self.edit(
                final_at,
                final_at,
                Cow::Borrowed(match object {
                    true => "}",
                    false => "]",
                }),
            );
            value = Some(self.builder.close(None, final_at, self.edits.len()));
        }
        Ok(value.unwrap_or(Value::Null))
    }

    /// Closes an object whose closer arrived where the pending key's VALUE belonged.
    ///
    /// The closer punctuates the member that never came, so it is reported as a missing separator —
    /// and then retracted with everything else the member logged, because the member is not in the
    /// tree. What survives is the LOSS: retracting alone leaves a consumer unable to tell a dropped
    /// member from one the input never had. The repaired TEXT loses it too, or `{"a":1,"b":}` keeps a
    /// key with no value; the deletion reaches back over the separator before the key, or the same
    /// input repairs to a trailing comma.
    ///
    /// `close_shape` runs LAST because it edits, and an edit recorded before the retraction goes with
    /// it: measured in the reference, `{"a" ]` repaired to `{]`.
    pub(super) fn drop_pending_member(&mut self, closer: u32) {
        let closer_at = self.at;
        self.lenient(SwitchableRepair::MissingComma, closer_at);
        self.drop_pending_member_at(closer_at);
        self.close_shape(closer);
    }

    /// Takes the innermost object's pending key back out, reporting the loss, and deletes the bytes
    /// it occupied up to `end`. See [`Self::drop_pending_member`] for why the order is what it is.
    fn drop_pending_member_at(&mut self, end: usize) {
        let Some(p) = self.builder.stack.last().and_then(Frame::pending) else {
            return;
        };
        let (key_at, from, mark) = (p.at, p.comma.unwrap_or(p.at), p.mark);
        let from = self.drop_start(mark, from);
        self.retract(mark);
        self.lenient(SwitchableRepair::DroppedMember, key_at);
        self.edit(from, end, Cow::Borrowed(""));
        self.builder
            .stack
            .last_mut()
            .and_then(Frame::pending_mut)
            .and_then(Option::take);
    }

    /// A closer of the wrong shape still closes the container it lands in.
    ///
    /// `[{"b":2]` is an array holding an object, not an array holding a brace, and every lenient
    /// parser reads it that way. Reported, because the scanner read a character as something other
    /// than what it is and a consumer must be able to tell that from a document written correctly;
    /// and EDITED, because otherwise the repaired text keeps the wrong bracket and gains the
    /// inferred one — `[{"b":2]]`.
    ///
    /// One predicate across every state, deliberately. Testing for one shape per state and letting
    /// the other fall through to ordinary handling is what grew a member under an empty key for
    /// `{"a":2,]` and repaired `{]` to `{"":}`.
    pub(super) fn close_shape(&mut self, closer: u32) {
        let object = self.builder.stack.last().is_some_and(Frame::is_object);
        if object == (closer == unit::CLOSE_BRACE) {
            return;
        }
        self.lenient(SwitchableRepair::BracketMismatch, self.at);
        self.edit(
            self.at,
            self.at + 1,
            Cow::Borrowed(match object {
                true => "}",
                false => "]",
            }),
        );
    }

    /// An object with the prototype disposition the options asked for. Carried into the value
    /// because the canonical form the conformance corpus compares spells a null-prototype object
    /// differently; it means nothing to a Rust consumer.
    pub(super) fn new_object(&self) -> Object<'a> {
        Object::new(self.options.null_prototype)
    }

    pub(super) fn empty_object(&self) -> Value<'a> {
        Value::Object(self.new_object())
    }

    /// Consumes a run of separators standing where a member belongs.
    ///
    /// `{"a":1,,"b":2}` otherwise reads the empty span between them as a key and lands
    /// `{"a":1,"":2}` — a member the input never wrote, under a name it never gave. The same leniency
    /// as a trailing comma: an extra comma is an extra comma wherever it sits, and RFC 8259 forbids
    /// both spellings, so a flag governing one of them would be arbitrary.
    ///
    /// One method rather than a branch at each site, because a member position is reachable two ways
    /// — after the separator that ended the last member, and after a dropped member whose separator
    /// was deleted along with it — and only one of them used to know this rule.
    pub(super) fn extra_commas(&mut self) -> Result<(), ScanError> {
        while self.peek() == Some(unit::COMMA) {
            self.lenient(SwitchableRepair::TrailingComma, self.at);
            self.edit(self.at, self.at + 1, Cow::Borrowed(""));
            self.at += 1;
            self.skip_trivia()?;
        }
        Ok(())
    }

    /// Opens a container.
    ///
    /// It cannot be one past `max_depth`: the walk answers that opener with an empty placeholder
    /// before reaching here, so this holds no second reading of the bound. A guard here as well
    /// would be the two-readers defect the core rule names — and the one that used to sit here
    /// FAILED the scan, which is the reading the reference does not take.
    pub(super) fn open(&mut self, frame: Frame<'a>) {
        self.builder.open(frame, self.placing_start);
        self.comma_at = None;
        // A container's FIRST member has no separator before it, so nothing else sets this for it —
        // and leaving the enclosing container's mark would un-log the PARENT's entries when the
        // first member turns out to be droppable.
        self.member_mark = self.mark();
    }

    /// Reads a key and its colon into the open object frame.
    pub(super) fn key_then_colon(&mut self) -> Result<bool, ScanError> {
        // Where a pause rewinds to, taken before the trivia so a comment split across a chunk is
        // re-read rather than assumed to have ended with the buffer.
        self.stands_at(self.at, Resume::Key);
        // A suspended key resumes its token reader, not trivia at its released start.
        let next = if let Some(state) = &self.quoted {
            Some(state.quote)
        } else if let Some(state) = &self.word {
            Some(state.first)
        } else {
            self.skip_trivia()?;
            self.peek()
        };
        // A key that has not arrived is not a member with no key. This runs BEFORE `after_comma` is
        // cleared below, so a stream that pauses here still knows it came from a comma and can
        // report the trailing one if the input turns out to end there.
        if next.is_none() {
            if !self.at_end {
                return Err(self.pause());
            }
            // `{` and `{"a":1,` end here with no key at all. That is a container the input never
            // closed — the commonest damage there is — so the scan returns to the loop, which meets
            // the end and finalises it. Failing instead turned a recoverable `{}` into a refusal.
            // Returning BEFORE `after_comma` is cleared below is what still lets `{"a":1,` report
            // the separator nothing followed.
            return Ok(false);
        }
        // A separator or a closer where a key belongs is not a key, and reading one as a word would
        // invent a member under an empty name: `{"a":1,,"b":2}` landed `{"a":1,"":2}`. Left
        // UNCONSUMED on purpose — the caller's loop is the one place that decides what a separator
        // or a closer means, and a second copy of that decision is how a trailing comma before `}`
        // and one before `]` come to be read differently.
        if matches!(
            next,
            Some(unit::COMMA | unit::CLOSE_BRACE | unit::CLOSE_BRACKET)
        ) {
            return Ok(false);
        }
        let at = self.at;
        // What a member with no value un-logs back to, and it is NOT taken here: the member began at
        // the separator, and the entries between there and the key describe it too. See `member_mark`.
        //
        // Reading a key ends `after_comma`: the comma was followed, and what may still be missing is
        // the VALUE, which is a dropped member rather than a trailing separator.
        let mark = self.member_mark;
        self.placing_start = at;
        let key_issues = self.quoted.as_ref().map_or_else(
            || {
                self.word
                    .as_ref()
                    .map_or(self.issues.len(), |word| word.issues_start)
            },
            |state| state.issues_start,
        );
        self.after_comma = false;
        let key = match next {
            Some(unit::QUOTE | unit::APOSTROPHE) => self.string(false)?,
            // An opener where a key belongs is NOT a key. No leniency reads `{` as one, and
            // swallowing it would invent a key the source never wrote. At the ROOT object's first
            // key it also settles CANDIDACY — `{{name}}` is a template, not a damaged object — which
            // is why the note is taken here, the one place that knows both facts.
            Some(unit::OPEN_BRACE | unit::OPEN_BRACKET) | None => {
                if self.builder.stack.len() == 1 {
                    self.candidate.note_brace_key();
                }
                return self.fail(ScanErrorKind::UnexpectedUnit);
            }
            // Key position is structural, so a space or a colon ends the word.
            Some(_) => {
                let (word, end) = self.word(true)?;
                // A colon can delimit an empty bare key; its missing value is handled as a
                // dropped member by the grammar, just like an explicitly quoted empty key.
                // Recorded BEFORE the key is placed, so the repair's path does not name the very
                // key it is reporting.
                self.lenient_at(SwitchableRepair::UnquotedKey, at, at);
                self.edit_string(at, end, &word);
                word
            }
        };
        if self.builder.stack.len() == 1 {
            for (required, matched) in self
                .options
                .required_keys
                .iter()
                .zip(&mut self.root_required)
            {
                *matched |= key == *required;
            }
        }
        // Placed BEFORE the colon is judged, so a repair about the punctuation between a key and
        // its value carries the key in its path: a reader shown "a colon was missing" wants to know
        // WHICH member, and the frames are where a path is derived from. The unquoted-key repair
        // above is recorded before this for the opposite reason — it reports the key itself, and a
        // path naming the very key it is about says nothing.
        self.builder.key(PendingKey {
            key,
            at,
            comma: self.comma_at,
            mark,
        });
        // Decoder errors inside a key can name that key only after it is complete.
        if self.options.diagnostics.reporting() && self.issues.len() > key_issues {
            let path = path_of(&self.builder.stack);
            for issue in &mut self.issues[key_issues..] {
                if matches!(issue.kind, IssueKind::InvalidUtf8 { .. }) {
                    issue.path = path.clone();
                }
            }
        }
        self.stop_if_retained()?;
        if self.budget_spent()
            && self
                .issues
                .last()
                .is_some_and(|issue| issue.refused().is_none())
        {
            self.stop_if_spent()?;
        }
        self.key_colon()
    }

    /// A completed key stays in its frame while punctuation arrives, so decoding and diagnostics
    /// happen once even when the stream pauses immediately before the colon.
    pub(super) fn key_colon(&mut self) -> Result<bool, ScanError> {
        self.stands_at(self.at, Resume::Colon);
        self.skip_trivia()?;
        match self.peek() {
            Some(unit::COLON) => {
                self.at += 1;
                // Only a colon the source WROTE is a mark of data. An inferred one below is this
                // reader's own guess, and counting it would let a candidate be evidence of itself.
                self.candidate.saw_colon();
            }
            // More input may supply the colon; keep the key and wait at its following trivia.
            None if !self.at_end => {
                return Err(self.pause());
            }
            // The input ended after the key: a member with no value, which finalisation drops and
            // reports. No colon is inferred — there is nothing for it to stand between — and the key
            // stays on the frame so the drop can name it: `{invalid` recovers `{}` and says the
            // member `invalid` was lost, where failing here said only that the document was bad.
            None => {}
            // A key with no value is not a member. `{a: 12 34, b: 2}` otherwise made a key of `34`,
            // and the inferred colon let `b: 2` become its value — destroying the member outright.
            // The separator is the proof: whatever the source wrote, it wrote nothing between this
            // token and the next member, so there is no value here to keep. NOT "the comma before it
            // was inferred too" — measured against the corpus, that drops `"age" 30` on the line
            // after a member that forgot its comma, and every byte of that member is real.
            Some(unit::COMMA) => {
                self.drop_pending_member_at(self.at);
                return Ok(false);
            }
            // A key announced with no colon after it. Key and value are both real and only the mark
            // between them is missing, so nothing is guessed and the repair is free.
            Some(_) => {
                self.lenient(SwitchableRepair::MissingColon, self.at);
                self.edit(self.at, self.at, Cow::Borrowed(":"));
            }
        }
        Ok(true)
    }
}
