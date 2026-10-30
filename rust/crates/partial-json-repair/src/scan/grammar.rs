//! Token walking for one candidate value.

use super::*;

impl<'a> Scanner<'a> {
    /// The single loop, over an explicit frame stack.
    ///
    /// The stack lives here rather than inside the loop so that a refusal can be given the path it
    /// happened at: nothing unwinds on error, so the frames still describe where the scan was. That
    /// puts the path derivation at ONE site instead of at every `?`.
    pub(super) fn value(&mut self) -> Result<Value<'a>, ScanError> {
        let result = self.walk();
        result.map_err(|mut error| {
            if error.path.is_empty() {
                error.path = path_of(&self.builder.stack);
            }
            error
        })
    }

    /// Containers push a frame and continue rather than recursing; a completed value either closes
    /// the scan or is placed into the frame below it.
    fn walk(&mut self) -> Result<Value<'a>, ScanError> {
        // Taken once, at the door: a resumed scan re-enters the loop at the position it stopped at,
        // and after that first turn it is in ordinary flow. A resume point that outlived the turn
        // would re-enter on every iteration.
        let mut resume = core::mem::take(&mut self.paused_at);
        // Each turn either opens a container — continuing with the new frame — or completes a
        // scalar, which then unwinds as far as the closers allow.
        'outer: loop {
            // Leading trivia belongs to the root token. Finish that token before honoring its
            // refusal; otherwise whitespace alone can erase the value it precedes.
            // Decoder errors can arrive inside a continued scalar. Finish that token before the
            // member-boundary stop so its available content remains in the recovered prefix.
            if !self.builder.stack.is_empty() && self.word.is_none() && self.number_extent.is_none()
            {
                self.stop_if_spent()?;
            }
            // Where a pause rewinds to. Trivia may be a comment the next chunk continues, so a
            // stream re-reads it rather than assuming it ended where the buffer did.
            self.stands_at(self.at, Resume::Value);
            // `None` only on the first turn of a scan resumed after a value: the value is already
            // in its container, and what follows it is what has not arrived.
            let mut done: Option<Value<'a>> = match core::mem::take(&mut resume) {
                Resume::AfterValue => None,
                Resume::Colon => {
                    if self.key_colon()? {
                        continue 'outer;
                    }
                    None
                }
                Resume::Key => {
                    if self.key_then_colon()? {
                        continue 'outer;
                    }
                    None
                }
                Resume::Value
                    if self.quoted.is_some()
                        || self.word.is_some()
                        || self.number_extent.is_some() =>
                {
                    // The saved token owns its prefix; its old opener is no longer input.
                    self.placing_start = self.at;
                    Some(self.scalar()?)
                }
                Resume::Value => {
                    self.skip_trivia()?;
                    self.placing_start = self.at;
                    let next = self.peek();
                    if self.builder.stack.is_empty() {
                        self.root_object = next == Some(unit::OPEN_BRACE);
                        self.root_required.fill(false);
                    }
                    // Something follows the separator, so the container does not end on one.
                    self.after_comma = self.after_comma && next.is_none();
                    // `Option`, because a turn can end with NO value: a key position holding a
                    // separator, a closer or a template's opener starts no member, and the unwind
                    // below is exactly the "after a member" handling those need.
                    match next {
                        // Nothing open means nothing was read: an empty input is no value, not a truncated
                        // one, and finalising here would hand back a value the source never began.
                        None if self.builder.stack.is_empty() => {
                            return self.fail(ScanErrorKind::UnexpectedEnd);
                        }
                        None => return self.ran_out(),
                        // **The budget is a resource bound, not a crash boundary.** The container is
                        // placed EMPTY and its contents skipped: dropping it outright would leave the
                        // parent's pending key waiting and shift every later member, and building it
                        // would defeat the bound. Structure kept, contents dropped, caller told.
                        //
                        // Ahead of the two opener arms so `self.at` still stands ON the opener, which
                        // is where the reference reports it and where the skip has to begin.
                        Some(c @ (unit::OPEN_BRACE | unit::OPEN_BRACKET))
                            if self.builder.stack.len() >= self.options.max_depth.get() =>
                        {
                            let at = self.at;
                            // Skipped BEFORE the refusal is recorded, the reverse of the reference's
                            // order, because a pause here rewinds to the opener and re-reads the
                            // subtree — and `retract` deliberately keeps refusals, so one recorded
                            // first would be recorded again on every chunk that does not finish it.
                            if !self.skip_container() {
                                return Err(self.pause());
                            }
                            self.refuse(Refused::Depth, at);
                            Some(if c == unit::OPEN_BRACE {
                                self.empty_object()
                            } else {
                                Value::Array(Vec::new())
                            })
                        }
                        Some(unit::OPEN_BRACE) => {
                            self.at += 1;
                            self.builder.stage_view_container(true);
                            let member_mark = self.mark();
                            self.skip_trivia()?;
                            self.need_byte()?;
                            self.builder.clear_view_container();
                            if self.peek() == Some(unit::CLOSE_BRACE) {
                                self.at += 1;
                                Some(self.empty_object())
                            } else {
                                self.open(Frame::Object(self.new_object(), None, false));
                                // Trivia belongs to the first member, but the open frame and its
                                // selected occurrence survive a member being dropped.
                                self.member_mark = Logged {
                                    occurrences: self.member_mark.occurrences,
                                    content: self.member_mark.content,
                                    ..member_mark
                                };
                                self.stop_if_spent()?;
                                if self.key_then_colon()? {
                                    continue 'outer;
                                }
                                None
                            }
                        }
                        Some(unit::OPEN_BRACKET) => {
                            self.at += 1;
                            self.builder.stage_view_container(false);
                            self.skip_trivia()?;
                            self.need_byte()?;
                            self.builder.clear_view_container();
                            if self.peek() == Some(unit::CLOSE_BRACKET) {
                                self.at += 1;
                                Some(Value::Array(Vec::new()))
                            } else {
                                self.open(Frame::Array(Vec::new()));
                                continue 'outer;
                            }
                        }
                        // `{"a":}` — the key was announced and the value never arrived. Closing the
                        // object here, rather than letting the closer reach the scalar reader as a
                        // character that begins nothing, is what keeps every later container at the
                        // right depth. Any closer shape does it; `close_shape` rewrites the wrong one.
                        Some(c @ (unit::CLOSE_BRACE | unit::CLOSE_BRACKET))
                            if self.builder.stack.last().is_some_and(Frame::is_object) =>
                        {
                            self.drop_pending_member(c);
                            self.at += 1;
                            Some(self.builder.close(None, self.at, self.edits.len()))
                        }
                        Some(_) => Some(self.scalar()?),
                    }
                }
            };

            // Unwind: place the finished value, then close every container whose closer follows.
            loop {
                if self.builder.stack.is_empty() {
                    return Ok(done.unwrap_or_else(|| {
                        unreachable!("a separator resumes inside the container it separates")
                    }));
                }
                let dropped = self.govern_pending()?;
                let Some(frame) = self.builder.stack.last_mut() else {
                    unreachable!("emptiness was tested above")
                };
                match frame {
                    // A value with no key waiting is not a member of anything — the source wrote a
                    // value where a key belonged, and inventing a name for it would be a member the
                    // input never had.
                    // Guarded on there BEING a value: a scan resumed after one has already placed
                    // it and cleared the slot, which is the same shape and none of the same defect.
                    frame if frame.is_object() && frame.pending().is_none() && done.is_some() => {
                        return self.fail(ScanErrorKind::UnexpectedUnit);
                    }
                    // A dropped key still clears its slot, so the value goes nowhere and the object
                    // keeps its siblings.
                    frame if frame.is_object() && dropped => {
                        frame.pending_mut().and_then(Option::take);
                        // And the value is let go with it. Left in hand it is a value with no key
                        // waiting, which the arm above answers by failing the scan the moment this
                        // loop turns again: `{"a": 1,,}` with `a` governed refused at the second
                        // comma, where the same input with `a` ordinary parses.
                        done = None;
                    }
                    _ => {
                        // Asked before the frame is borrowed to receive the value, because the
                        // label it would be placed under lives on that same frame.
                        let skipped = done.as_ref().is_some_and(|value| {
                            self.builder
                                .place(value, self.placing_start, self.at, self.edits.len())
                        });
                        let Some(frame) = self.builder.stack.last_mut() else {
                            unreachable!("emptiness was tested above")
                        };
                        if let Some(value) = done.take() {
                            // A skipped member still CONSUMES its key: the member was read, and
                            // leaving the key waiting would hand it to whatever came next.
                            if skipped {
                                frame.pending_mut().and_then(Option::take);
                                // **Its repairs STAY.** They describe the source, which still holds
                                // the member — measured on the reference: `{'a': 'b', 'c': 'd'}`
                                // under `skip: [["a"]]` keeps `single-quote` at the skipped key's
                                // own offset, and the confidence falls for it. Retracting them here
                                // was tried and cost 27 rows.
                                //
                                // What the reference does lose is the `unclosed-*` repair of a
                                // truncated container INSIDE the skip — because that repair is
                                // written when a BUILT frame closes, and the subtree was never
                                // built. That is the one thing this placement-time answer cannot
                                // reproduce: the decision is made when the member is complete, and
                                // by then its frames have been built and closed. It needs a build
                                // MODE on the frame, which `select` needs anyway for `dead`.
                            } else {
                                frame.place(value);
                            }
                            self.candidate.saw_placed();
                        }
                    }
                }
                // The member just placed is kept; the budget decides only whether to read the NEXT
                // one — and the separator below is a token like any other.
                self.stop_if_spent()?;
                // Where a pause rewinds to, as at the top of the loop: nothing between here and the
                // `None` arm below is consumed, so re-reading from here repeats no decision.
                self.stands_at(self.at, Resume::AfterValue);
                // The NEXT member begins here — see `member_mark`. Before the trivia, so a comment
                // removed between two members belongs to the second one and goes if it does.
                self.member_mark = self.mark();
                if self.builder.has_fragments() && self.candidate.established() {
                    return Err(self.yield_output());
                }
                self.skip_trivia()?;
                // Only once the deciding token is in hand. Where it has not arrived the scan pauses
                // below and rewinds past this line, so asking now would splice on a guess and then
                // have the pause retract it — the member's fate simply waits for the next chunk.
                if (self.peek().is_some() || self.at_end) && self.splice_dropped() {
                    self.comma_at = None;
                    // The separator was deleted with the member, so the scan steps over it and the
                    // handler below never sees it. Neither `after_comma` nor `comma_at` is set:
                    // a comma that is no longer in the repaired text separates nothing and cannot
                    // be the trailing one a closer would report.
                    self.at += 1;
                    // What follows may be another separator, and this route is the second way to
                    // reach a member position holding one: `{"a":1,,"b":2}` with `a` governed had its
                    // own comma deleted with it, so the extra one became the separator here and went
                    // unreported.
                    self.extra_commas()?;
                    if !self.builder.stack.last().is_some_and(Frame::is_object)
                        || self.peek().is_none()
                        || self.key_then_colon()?
                    {
                        continue 'outer;
                    }
                    // The key position started no member. Back to the top of THIS loop, which is
                    // where a separator, a closer and the end of input are each handled once.
                    continue;
                }
                // A separator continues the container unless a closer follows it, in which case it
                // separated nothing. That is decided HERE rather than in a branch of its own so the
                // closer keeps ONE handler: a second copy is how a trailing comma before `}` and one
                // before `]` come to be read differently.
                if self.peek() == Some(unit::COMMA) {
                    let comma = self.at;
                    self.at += 1;
                    self.skip_trivia()?;
                    self.extra_commas()?;
                    if matches!(self.peek(), Some(unit::CLOSE_BRACE | unit::CLOSE_BRACKET)) {
                        self.lenient(SwitchableRepair::TrailingComma, comma);
                        self.edit(comma, comma + 1, Cow::Borrowed(""));
                    } else {
                        self.after_comma = true;
                        self.comma_at = Some(comma);
                        // Nothing follows the separator yet, so what it separates is still unknown:
                        // a key, or the closer that would make it trailing. Rewinding to the comma
                        // ITSELF rather than past it puts that undecided question back where the
                        // one handler above answers it. Resuming after the comma instead was
                        // measured wrong — it jumps over the closer test, so `{"a":1,` + `}` read
                        // the closer as a key and refused a document the whole-input path parses.
                        if self.peek().is_none() && !self.at_end {
                            return Err(self.pause());
                        }
                        // A key is read only if there is input for one. Where there is not, the top
                        // of the loop meets the end and finalises, with the comma still described.
                        if !self.builder.stack.last().is_some_and(Frame::is_object)
                            || self.peek().is_none()
                            || self.key_then_colon()?
                        {
                            continue 'outer;
                        }
                        // The key position started no member — see the same test above the splice.
                        continue;
                    }
                }
                self.stop_if_spent()?;
                match self.peek() {
                    Some(c @ (unit::CLOSE_BRACE | unit::CLOSE_BRACKET)) => {
                        self.close_shape(c);
                        self.at += 1;
                        done = Some(self.builder.close(None, self.at, self.edits.len()));
                        if self.builder.stack.is_empty() {
                            return Ok(done.unwrap_or_else(|| unreachable!("just closed")));
                        }
                    }
                    // Input ended with this container still open. Finalising is not a failure: a
                    // truncated document is the commonest damaged one there is — unless a stream
                    // is still receiving it, which is what `ran_out` decides.
                    None => return self.ran_out(),
                    // Anything else where a separator belongs is a member the input forgot to
                    // punctuate. Free, like every repair that guessed nothing: the members are
                    // exactly the ones the source wrote, and only the punctuation between them was
                    // supplied.
                    Some(_) => {
                        self.lenient(SwitchableRepair::MissingComma, self.at);
                        self.comma_at = None;
                        self.edit(self.at, self.at, Cow::Borrowed(","));
                        // A key position that starts no member falls to the next turn of THIS loop,
                        // where the separator or closer it holds is handled once.
                        if !self.builder.stack.last().is_some_and(Frame::is_object)
                            || self.key_then_colon()?
                        {
                            continue 'outer;
                        }
                    }
                }
            }
        }
    }
}
