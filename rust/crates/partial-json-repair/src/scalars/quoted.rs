//! Read quoted content with one escape, control-character and quote-ambiguity state.

use alloc::borrow::Cow;
use alloc::string::ToString;

use crate::builder::FRAGMENT_UNITS;
use crate::chars::{flip, is_separator, unit};
use crate::report::SwitchableRepair;
use crate::scan::{ScanError, Scanner};
use crate::value::JsonString;

/// A possible wrong closer keeps the value and policy state from before its suffix was read.
/// The suffix may belong to subsequent members, so it cannot be delivered as scalar content yet.
struct Suspect<'a> {
    at: usize,
    prefix: JsonString<'a>,
    dirty: bool,
    bad_escape: bool,
}

/// A decided prefix moves across chunks; only the next undecided source unit is read again.
pub(crate) struct QuotedState<'a> {
    pub(crate) open: usize,
    /// Keep the delimiter after its source byte is consumed.
    pub(crate) quote: u32,
    pub(crate) issues_start: usize,
    next: usize,
    out: Option<JsonString<'a>>,
    /// UTF-8 bytes and UTF-16 units already counted; recounting the prefix at each pause is quadratic.
    counted: (usize, usize),
    suspect: Option<Suspect<'a>>,
    dirty: bool,
    bad_escape: bool,
    escaped: bool,
}

impl QuotedState<'_> {
    /// A possible wrong closer can replay its suffix; decided decoded content needs no source.
    pub(crate) fn retained_from(&self) -> usize {
        self.suspect
            .as_ref()
            .map_or(self.next, |suspect| suspect.at)
    }

    /// Decoded content whose source interpretation is already settled.
    pub(crate) fn snapshot_text(&self) -> JsonString<'static> {
        self.out
            .clone()
            .map(JsonString::into_owned)
            .unwrap_or(JsonString::Text(Cow::Borrowed("")))
    }

    fn into_owned(self) -> QuotedState<'static> {
        let counted = match &self.out {
            Some(JsonString::Text(text)) => (
                text.len(),
                self.counted.1 + text[self.counted.0..].encode_utf16().count(),
            ),
            _ => (0, 0),
        };
        QuotedState {
            open: self.open,
            quote: self.quote,
            issues_start: self.issues_start,
            next: self.next,
            out: self.out.map(JsonString::into_owned),
            counted,
            suspect: self.suspect.map(|suspect| Suspect {
                at: suspect.at,
                prefix: suspect.prefix.into_owned(),
                dirty: suspect.dirty,
                bad_escape: suspect.bad_escape,
            }),
            dirty: self.dirty,
            bad_escape: self.bad_escape,
            escaped: self.escaped,
        }
    }
}

/// Keep unchanged runs borrowed; only an escape or a second run requires concatenation.
pub(super) fn append<'a>(out: &mut Option<JsonString<'a>>, piece: JsonString<'a>) {
    let Some(current) = out.as_mut() else {
        *out = Some(piece);
        return;
    };
    match (current, piece) {
        (JsonString::Text(text), JsonString::Text(piece)) => text.to_mut().push_str(&piece),
        (JsonString::Units(units), piece) => units.to_mut().extend(piece.code_units()),
        (current @ JsonString::Text(_), JsonString::Units(piece)) => {
            let mut units: alloc::vec::Vec<_> = current.code_units().collect();
            units.extend_from_slice(&piece);
            *current = JsonString::Units(Cow::Owned(units));
        }
    }
}

fn value(out: Option<JsonString<'_>>) -> JsonString<'_> {
    out.unwrap_or(JsonString::Text(Cow::Borrowed("")))
}

impl<'a> Scanner<'a> {
    /// Read the same token before and after escapes: neither a control character nor an apparent
    /// wrong closer ceases to matter when a later backslash changes how content is stored.
    pub(super) fn quoted(
        &mut self,
        quote: u32,
        retain_partial: bool,
    ) -> Result<JsonString<'a>, ScanError> {
        let open = self.at;
        let QuotedState {
            next,
            issues_start,
            mut out,
            mut counted,
            mut suspect,
            mut dirty,
            mut bad_escape,
            mut escaped,
            ..
        } = self.quoted.take().unwrap_or(QuotedState {
            open,
            quote,
            issues_start: self.issues().len(),
            next: open + 1,
            out: None,
            counted: (0, 0),
            suspect: None,
            dirty: false,
            bad_escape: false,
            escaped: false,
        });
        self.at = next;
        let start = open + 1;
        let mut run = next;
        // Candidacy can activate fragment delivery only after an earlier chunk banked a prefix.
        // Deliver that decided prefix once; an ambiguous suffix still belongs to neither reading.
        let decided = suspect.as_ref().map_or(next, |suspect| suspect.at);
        if self
            .builder
            .fragment_source()
            .is_some_and(|emitted| emitted < decided)
        {
            let prefix = suspect
                .as_ref()
                .map(|suspect| &suspect.prefix)
                .or(out.as_ref());
            if let Some(prefix) = prefix {
                self.builder
                    .fragment_decoded(decided, prefix.clone().into_owned());
            }
        }
        if self.builder.fragment_source().is_some() {
            counted = (0, 0);
            // Delivered contents no longer belong to the parser. Keep only a suffix whose quote
            // interpretation is pending; a completed fragment needs no duplicate whole value.
            if let Some(suspect) = &mut suspect {
                let prefix = suspect.prefix.code_units().count();
                if prefix != 0 {
                    out = Some(JsonString::Units(Cow::Owned(
                        value(out.take()).code_units().skip(prefix).collect(),
                    )));
                    suspect.prefix = value(None);
                }
            } else {
                out = None;
            }
        }

        while let Some(c) = self.peek() {
            if self.builder.fragment_source().is_some()
                && (self.builder.has_fragments()
                    || (suspect.is_none() && self.at - run >= FRAGMENT_UNITS))
            {
                self.at = self.input.ready_end(self.at);
                self.quoted_run(&mut out, run, suspect.is_none())?;
                self.quoted = Some(
                    QuotedState {
                        open,
                        quote,
                        issues_start,
                        next: self.at,
                        out,
                        counted,
                        suspect,
                        dirty,
                        bad_escape,
                        escaped,
                    }
                    .into_owned(),
                );
                return Err(self.yield_output());
            }
            if suspect.is_none()
                && c == flip(quote)
                && self.input.get(self.at + 1).is_some_and(is_separator)
            {
                self.quoted_run(&mut out, run, true)?;
                suspect = Some(Suspect {
                    at: self.at,
                    prefix: value(out.clone()),
                    dirty,
                    bad_escape,
                });
                run = self.at;
            }
            if c == quote {
                if let Some(wrong) = suspect.take() {
                    match self.closer_fits(self.at) {
                        None => {
                            self.quoted_run(&mut out, run, false)?;
                            return Err(self.pause_quoted(QuotedState {
                                open,
                                quote,
                                issues_start,
                                next: self.at,
                                out,
                                counted,
                                suspect: Some(wrong),
                                dirty,
                                bad_escape,
                                escaped,
                            }));
                        }
                        Some(false) => {
                            return Ok(self.resolve_quote(open, wrong));
                        }
                        Some(true) => suspect = Some(wrong),
                    }
                }
                self.quoted_run(&mut out, run, suspect.is_none())?;
                // An unchanged empty string still borrows its span in the caller's input.
                let text = if self.at == start {
                    self.string_text(start, start)?
                } else {
                    value(out)
                };
                if let Some(suspect) = suspect {
                    self.settle_quote_suffix(&text, &suspect);
                }
                self.at += 1;
                if bad_escape {
                    self.lenient(SwitchableRepair::InvalidEscape, open);
                } else if dirty {
                    self.unspellable(open);
                }
                if dirty && quote != unit::APOSTROPHE {
                    self.edit_string(open, self.at, &text);
                }
                return Ok(text);
            }
            if c != unit::BACKSLASH {
                dirty |= c < 0x20;
                self.at += 1;
                continue;
            }

            self.quoted_run(&mut out, run, suspect.is_none())?;
            escaped = true;
            let escape = self.at;
            self.at += 1;
            let Some(e) = self.peek() else {
                if !self.input_ended() {
                    return Err(self.pause_quoted(QuotedState {
                        open,
                        quote,
                        issues_start,
                        next: escape,
                        out,
                        counted,
                        suspect,
                        dirty,
                        bad_escape,
                        escaped,
                    }));
                }
                // A final backslash escapes no character; it changes the spelling, not the value.
                dirty = true;
                run = self.at;
                break;
            };
            let piece = if e == unit::LOWER_U {
                match self.unicode_escape() {
                    Ok(Some(piece)) => piece,
                    Ok(None) => {
                        // Preserve an invalid Unicode spelling literally, including its backslash.
                        self.at += 1;
                        dirty = true;
                        bad_escape = true;
                        JsonString::Text(Cow::Borrowed("\\u"))
                    }
                    Err(error)
                        if !self.input_ended()
                            && error.kind == crate::scan::ScanErrorKind::UnexpectedEnd =>
                    {
                        return Err(self.pause_quoted(QuotedState {
                            open,
                            quote,
                            issues_start,
                            next: escape,
                            out,
                            counted,
                            suspect,
                            dirty,
                            bad_escape,
                            escaped,
                        }));
                    }
                    Err(error) => return Err(error),
                }
            } else if let Some(mapped) = crate::chars::escape(e) {
                self.at += 1;
                JsonString::Text(Cow::Owned(
                    char::from_u32(mapped).unwrap_or('\u{fffd}').to_string(),
                ))
            } else if e == unit::APOSTROPHE {
                self.at += 1;
                dirty = true;
                JsonString::Text(Cow::Borrowed("'"))
            } else {
                // Leave the character to the raw-run decoder; advancing one byte could split UTF-8.
                dirty = true;
                bad_escape = true;
                JsonString::Text(Cow::Borrowed("\\"))
            };
            if suspect.is_none() && self.builder.fragment_source().is_some() {
                self.builder.fragment_decoded(self.at, piece.into_owned());
            } else {
                append(&mut out, piece);
            }
            run = self.at;
        }

        if !self.input_ended() {
            // An opposite quote at the chunk edge may acquire a separator in the next chunk.
            // Keep that character out of irreversible fragments until its follower is known.
            if suspect.is_none()
                && run < self.at
                && self.input.get(self.at - 1) == Some(flip(quote))
            {
                self.at -= 1;
                self.quoted_run(&mut out, run, true)?;
            } else {
                self.quoted_run(&mut out, run, suspect.is_none())?;
            }
            let state = QuotedState {
                open,
                quote,
                issues_start,
                next: self.at,
                out,
                counted,
                suspect,
                dirty,
                bad_escape,
                escaped,
            }
            .into_owned();
            let units = match &state.out {
                Some(JsonString::Text(_)) => state.counted.1,
                Some(JsonString::Units(units)) => units.len(),
                None => 0,
            };
            self.quoted = Some(state);
            return Err(if retain_partial && !escaped {
                self.pause_string(start, units.saturating_sub(6))
            } else {
                self.pause()
            });
        }
        if let Some(suspect) = suspect {
            return Ok(self.resolve_quote(open, suspect));
        }
        self.quoted_run(&mut out, run, true)?;
        let text = value(out);
        if escaped {
            return Ok(self.unclosed_owned(start, quote, text, dirty, bad_escape));
        }
        self.lenient(SwitchableRepair::UnclosedString, open);
        if quote != unit::APOSTROPHE {
            if dirty {
                self.edit_string(open, self.at, &text);
            } else {
                self.edit(self.at, self.at, Cow::Borrowed("\""));
            }
        }
        Ok(text)
    }

    /// Keep decoded state before releasing the scanner's borrow on the input.
    fn pause_quoted(&mut self, state: QuotedState<'a>) -> ScanError {
        self.quoted = Some(state.into_owned());
        self.pause()
    }

    /// Decode each raw run at its real source boundary; a pending mismatch suppresses delivery.
    fn quoted_run(
        &mut self,
        out: &mut Option<JsonString<'a>>,
        from: usize,
        emit: bool,
    ) -> Result<(), ScanError> {
        if from < self.at {
            let piece = self.string_text(from, self.at)?;
            if emit {
                self.fragment_text(from, self.at, &piece);
            }
            if !emit || self.builder.fragment_source().is_none() {
                append(out, piece);
            }
        }
        Ok(())
    }

    fn resolve_quote(&mut self, open: usize, suspect: Suspect<'a>) -> JsonString<'a> {
        self.lenient(SwitchableRepair::QuoteMismatch, open);
        if suspect.bad_escape {
            self.lenient(SwitchableRepair::InvalidEscape, open);
        } else if suspect.dirty {
            self.unspellable(open);
        }
        self.at = suspect.at + 1;
        self.edit_string(open, self.at, &suspect.prefix);
        suspect.prefix
    }

    /// The true closer accepted the ambiguous suffix; only now may that suffix leave the parser.
    fn settle_quote_suffix(&mut self, text: &JsonString<'_>, suspect: &Suspect<'_>) {
        if self.builder.fragment_source().is_some() {
            let suffix = text
                .code_units()
                .skip(suspect.prefix.code_units().count())
                .collect();
            self.builder
                .fragment_decoded(self.at, JsonString::Units(Cow::Owned(suffix)));
        }
    }
}
