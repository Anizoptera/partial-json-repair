//! Deliver complete candidates only after distinguishing JSON from surrounding prose.

use super::continuation::CandidateValue;
use super::*;

impl<'a> Scanner<'a> {
    /// Reads one complete value, then refuses anything after it.
    ///
    /// # Errors
    /// Returns the first refusal, with its offset in the original input units.
    pub fn parse(&mut self) -> Result<Value<'a>, ScanError> {
        let Some(first) = self.next_value() else {
            return self.fail(ScanErrorKind::Empty);
        };
        let value = first?.value;
        self.skip_trivia()?;
        if self.peek().is_some() {
            return self.fail(ScanErrorKind::TrailingContent);
        }
        Ok(value)
    }

    /// The next value in the source with its extent, or `None` once only whitespace remains.
    ///
    /// The seam every one-shot verb is built on: `parse` adds a trailing-content refusal, a
    /// many-value read simply calls it again, a span read keeps the extent and drops the value, and
    /// a text repair slices the source by that extent. One scan answers all four, so asking for a
    /// span costs no second pass.
    ///
    /// # Errors
    /// Returns the first refusal, with its original-unit offset and path.
    pub fn next_value(&mut self) -> Option<Result<Spanned<'a>, ScanError>> {
        self.strip_bom();
        loop {
            let (start, mark, container, completed) = match self.resuming.take() {
                Some(Paused::Reading {
                    start,
                    mark,
                    container,
                    at,
                }) => {
                    // Handed back to the loop, which takes it at its door.
                    self.paused_at = at;
                    (start, mark, container, None)
                }
                Some(Paused::Judging {
                    start,
                    mark,
                    container,
                    value,
                    end,
                }) => (
                    start,
                    mark,
                    container,
                    Some((CandidateValue::Owned(value), end)),
                ),
                None => {
                    if let Err(error) = self.stop_if_spent() {
                        return Some(Err(error));
                    }
                    // Only trivia has arrived and it may still grow, so there is nothing to read a
                    // value out of yet. `skip_trivia` has rewound to where the run began.
                    let trivia = self.at;
                    if self.skip_trivia().is_err() {
                        return None;
                    }
                    if self.completed == 0 {
                        self.candidate.consumed_leading(trivia, self.at);
                    }
                    let mut start = self.at;
                    // A scalar carries no mark of data, so its only route to being a value is
                    // filling the document. Where it cannot, nothing but a container can begin a
                    // value here, and looking for one is a scan for two bytes rather than a parse
                    // of prose.
                    if !matches!(self.peek(), Some(unit::OPEN_BRACE | unit::OPEN_BRACKET))
                        && !self.candidate.may_stand_alone(start, self.completed)
                    {
                        let Some(next) = self.input.next_opener(start) else {
                            // This suffix cannot start another value; keeping it only grows carry.
                            self.at = self.input.end();
                            return None;
                        };
                        start = next;
                        self.at = start;
                    }
                    let container = matches!(self.peek()?, unit::OPEN_BRACE | unit::OPEN_BRACKET);
                    let mark = self.mark();
                    self.candidate.begin();
                    // A fresh value starts with no containers open. Done HERE rather than in
                    // `value`, because a RESUMED value's frames are the state it left behind and
                    // clearing them would throw away everything read before the chunk boundary.
                    self.builder.begin_root();
                    (start, mark, container, None)
                }
            };
            self.pause = None;
            let (read, value_end) = if let Some((value, end)) = completed {
                (Some(value), end)
            } else {
                let read = match self.value() {
                    Ok(value) => Some(CandidateValue::Fresh(value)),
                    // A pause waits for input or yields pending fragments. Keep the root's start so
                    // the next chunk or consumer pull resumes it instead of judging its tail anew.
                    Err(_) if self.pause.is_some() => {
                        self.resuming = Some(Paused::Reading {
                            start,
                            container,
                            mark,
                            at: self.paused_at,
                        });
                        return None;
                    }
                    // Detection has already decided this is no value, and the error it caused is a
                    // symptom of that rather than the answer. Falling through to the rejection below
                    // gives it the same treatment a well-formed shape gets when the marks of data never
                    // arrive, so `{{{` ends as `no-json-found` and not as a refusal carrying an empty
                    // object nobody wrote.
                    Err(_) if self.candidate.decided_against() => None,
                    // A unit that can begin nothing, met where a value would have to START, is prose —
                    // not damage. The reference skips it and reads on, and reports it only INSIDE a
                    // container, where the document is not prose around a value. Ending the scan on it
                    // instead throws away every chunk still to come: `, 3], "complete": true}` answered
                    // `no-json-found` on the feed rather than waiting for the rest of the stream.
                    Err(error)
                        if error.kind == ScanErrorKind::UnexpectedUnit
                            && self.builder.stack.is_empty() =>
                    {
                        None
                    }
                    Err(error) => return Some(Err(error)),
                };
                (read, self.at)
            };
            if let Some(value) = read {
                if self.decode_stopped {
                    self.resuming = Some(Paused::Judging {
                        start,
                        container,
                        mark,
                        end: value_end,
                        value: value.own(),
                    });
                    return Some(Err(ScanError {
                        kind: ScanErrorKind::DecodeBudget,
                        at: self.at,
                        path: path_of(&self.builder.stack),
                    }));
                }
                self.stands_at(self.at, Resume::AfterValue);
                if self.skip_trivia().is_err() && self.pause.is_some() {
                    self.resuming = Some(Paused::Judging {
                        start,
                        container,
                        mark,
                        end: value_end,
                        value: value.own(),
                    });
                    return None;
                }
                match self.candidate.judge(
                    start,
                    self.at == self.input.end(),
                    self.completed,
                    container,
                    self.at_end,
                ) {
                    Verdict::Accept => {
                        let _ = self
                            .builder
                            .place(value.get(), start, value_end, self.edits.len());
                        if let Err(error) = self.stop_if_spent()
                            && error.kind != ScanErrorKind::ErrorBudget
                        {
                            return Some(Err(error));
                        }
                        self.completed += 1;
                        self.delivered_mark = self.mark();
                        return Some(Ok(Spanned {
                            value: value.take(),
                            start,
                            end: value_end,
                        }));
                    }
                    // Keep the completed value until later input settles candidacy. Rejection
                    // still retracts its logs; waiting must not decode and build the value again.
                    Verdict::Hold => {
                        self.resuming = Some(Paused::Judging {
                            start,
                            container,
                            mark,
                            end: value_end,
                            value: value.own(),
                        });
                        return None;
                    }
                    Verdict::Reject => {}
                }
            }
            // Not JSON after all. Its repairs and edits go with it — they described something that
            // is not a value — and the scan resumes AFTER it, never inside it, so the object in
            // `{{name}}` is not found again from the second brace.
            self.retract(mark);
            self.at = self.at.max(start + 1);
        }
    }
}
