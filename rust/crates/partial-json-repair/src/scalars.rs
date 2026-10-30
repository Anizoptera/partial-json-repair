//! The scalars: strings, numbers and bare words, and what each one MEANS.
//!
//! Split from the structure walker because they are a different subject and the reference draws the
//! same line (`src/scalar-reader.ts`): the walker decides where a value sits in a document, and this
//! decides what a run of characters says. Everything the remaining recovery kinds touch — quote
//! ambiguity, escapes, number spellings — lands here.
//!
//! Kept as methods on the scanner rather than free functions over a slice: every reader consults the
//! recovery policy, records repairs and edits, and marks the candidacy evidence. Threading four
//! borrows through each of them would buy nothing but a longer signature.

use alloc::borrow::Cow;
use alloc::string::{String, ToString};

use crate::chars::{ends_scalar, is_delimiter, is_separator, is_ws, unit};
use crate::outcome::ScalarKind;
use crate::report::{SourcePath, SwitchableRepair};
use crate::scan::{ScanError, ScanErrorKind, Scanner, Units};
use crate::value::{JsonString, Number, Value};

mod decoding;
mod numeric;
pub(crate) use numeric::NumberState;
mod quoted;
mod word;
pub(crate) use quoted::QuotedState;
pub(crate) use word::WordState;

const NEGATIVE_INFINITY: &[u8] = b"-Infinity";

/// Bare tokens can finish the available decoder piece; strings and trivia stop inside it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextMode {
    Bare,
    String,
    Discard,
}

/// Compare ASCII literals without allocating or truncating a native UTF-16 unit to a byte.
fn word_matches(word: &JsonString<'_>, token: &str, fold: bool) -> bool {
    match word {
        JsonString::Text(text) => {
            if fold {
                text.eq_ignore_ascii_case(token)
            } else {
                text == token
            }
        }
        JsonString::Units(units) => {
            units.len() == token.len()
                && units.iter().zip(token.bytes()).all(|(&unit, byte)| {
                    u8::try_from(unit).is_ok_and(|unit| {
                        if fold {
                            unit.eq_ignore_ascii_case(&byte)
                        } else {
                            unit == byte
                        }
                    })
                })
        }
    }
}

impl<'a> Scanner<'a> {
    /// Emits a completed bare scalar only after its final type and source extent are known.
    pub(super) fn fragment_bare(
        &mut self,
        start: usize,
        end: usize,
        value: &Value<'_>,
        spelling: JsonString<'static>,
    ) {
        let scalar = match value {
            Value::Number(_) => ScalarKind::Number,
            Value::Bool(_) | Value::Null | Value::Undefined => ScalarKind::Literal,
            Value::String(_) => ScalarKind::String,
            Value::Array(_) | Value::Object(_) => return,
        };
        if self
            .builder
            .begin_fragmented_scalar(start, self.candidate.established(), scalar)
        {
            self.builder.fragment_decoded(end, spelling);
        }
    }

    /// What a bare word means as a value.
    ///
    /// **`js-literal` is the ONE switch that changes the VALUE rather than only the report**, and
    /// necessarily so: `undefined` and the string `"undefined"` cannot both be produced from the
    /// same bytes, so a caller who declines the leniency gets the word as text. Every other switch
    /// leaves the tree identical and moves only the bookkeeping.
    fn decode_word(&mut self, word: JsonString<'a>, at: usize, end: usize) -> Value<'a> {
        // Container words retain their first location across decoder pieces. Root words retain
        // their source for candidacy and obtain a location only when the word finishes.
        let observed_at = if self.builder.stack.is_empty() {
            self.at
        } else {
            at
        };
        for (token, value) in [
            ("true", Value::Bool(true)),
            ("false", Value::Bool(false)),
            ("null", Value::Null),
        ] {
            if word_matches(&word, token, false) {
                return value;
            }
        }
        // Match the whole word only: a prefix or quoted text is not a foreign literal.
        let recovered = if word_matches(&word, "true", true) {
            Some((SwitchableRepair::LiteralCase, "true", Value::Bool(true)))
        } else if word_matches(&word, "false", true) {
            Some((SwitchableRepair::LiteralCase, "false", Value::Bool(false)))
        } else if word_matches(&word, "null", true) {
            Some((SwitchableRepair::LiteralCase, "null", Value::Null))
        } else if word_matches(&word, "none", true) || word_matches(&word, "nil", true) {
            Some((SwitchableRepair::NullAlias, "null", Value::Null))
        } else {
            None
        };
        if let Some((kind, canonical, value)) = recovered {
            self.lenient_at(kind, at, observed_at);
            self.edit(at, end, Cow::Borrowed(canonical));
            return value;
        }
        let literal = [
            ("undefined", Value::Undefined),
            ("NaN", Value::Number(Number::Double(f64::NAN))),
            ("Infinity", Value::Number(Number::Double(f64::INFINITY))),
        ]
        .into_iter()
        .find_map(|(token, value)| word_matches(&word, token, false).then_some(value));
        let kind = match literal {
            Some(_) => SwitchableRepair::JsLiteral,
            None => SwitchableRepair::UnquotedString,
        };
        let allowed = self.options.recover.allows(kind);
        self.lenient_at(kind, at, observed_at);
        // A JS literal accepted AS one becomes `null` in repaired text: JSON has no spelling for
        // `undefined`, `NaN` or `Infinity`, so the nearest thing another parser will read is the
        // absence of a value. Declined, the word is the string it was read as, and quoting it is
        // exactly what the tree now holds.
        // The reader consumes trailing whitespace; a text edit must leave it untouched.
        match literal {
            Some(_) if allowed => self.edit(at, end, Cow::Borrowed("null")),
            _ => self.edit_string(at, end, &word),
        }
        match literal {
            Some(value) if allowed => value,
            _ => Value::String(word),
        }
    }

    /// Any value that is not a container.
    ///
    /// `true`, `false` and `null` are read as WORDS rather than matched as literals, because that is
    /// the only reading that keeps `tru` and `nulll` whole: matched literally they leave a tail that
    /// becomes an invented key, and one word reader means there is no second opinion about where a
    /// bare token ends.
    pub(crate) fn scalar(&mut self) -> Result<Value<'a>, ScanError> {
        let start = self.at;
        // Resume by the token's saved delimiter; the source opener may have been released.
        match self.quoted.as_ref().map_or_else(
            || {
                self.word.as_ref().map_or_else(
                    || {
                        self.number_extent
                            .as_ref()
                            .and_then(|number| number.raw.as_bytes().first().copied())
                            .map(u32::from)
                            .or_else(|| self.peek())
                    },
                    |word| Some(word.first),
                )
            },
            |state| Some(state.quote),
        ) {
            Some(unit::QUOTE | unit::APOSTROPHE) => {
                if !self.builder.stack.is_empty() {
                    self.builder.begin_fragmented_scalar(
                        start,
                        self.candidate.established(),
                        ScalarKind::String,
                    );
                }
                return Ok(Value::String(self.string(true)?));
            }
            Some(c)
                if self.word.is_none()
                    && (matches!(c, unit::MINUS | unit::PLUS | unit::DOT)
                        || (unit::ZERO..=unit::NINE).contains(&c)) =>
            {
                if let Some(value) = self.negative_infinity() {
                    return Ok(value);
                }
                // A number is only a number if what FOLLOWS it could follow a scalar. `1_000` read
                // as `1` hands back a value the source never wrote and leaves `_000` to become an
                // invented key that swallows the next member; re-read whole it comes back as the
                // source text. The same rewind covers a token the number grammar refuses outright.
                //
                // Everything the number reader logged is RETRACTED with it: those entries described
                // a token that is not in the tree, and leaving them would report a repair to a value
                // no caller can see — and splice an edit into text the word reader is about to
                // rewrite differently.
                let mark = self.mark();
                let number = self.number();
                // Missing input has not disproved the numeric reading. Only a decided rejection
                // may start a word continuation; otherwise a later digit would become string data.
                if number.is_err() && self.wants_more() {
                    return number;
                }
                // A resource stop is terminal, not evidence that the token should become a word.
                if matches!(&number, Err(error) if error.kind == ScanErrorKind::ScalarBudget) {
                    return number;
                }
                if number.is_ok() && self.at.saturating_sub(start) > self.options.max_scalar.get() {
                    return Err(self.pause_scalar(start));
                }
                let escaped_delimiter = self.peek() == Some(unit::BACKSLASH)
                    && self.input.get(self.at + 1).is_some_and(is_delimiter);
                if number.is_ok() && (ends_scalar(self.peek()) || escaped_delimiter) {
                    return number;
                }
                if !self.input_ended() && self.numeric_may_continue(start) {
                    self.at = self.input.end();
                    return Err(self.pause_scalar(start));
                }
                self.retract(mark);
                self.at = start;
            }
            None => return self.fail(ScanErrorKind::UnexpectedEnd),
            Some(_) => {}
        }
        let structural = self.builder.stack.is_empty();
        let (word, end) = self.word(structural)?;
        if word.code_units().next().is_none() {
            return self.fail(ScanErrorKind::UnexpectedUnit);
        }
        if end.saturating_sub(start) > self.options.max_scalar.get() {
            return Err(self.pause_scalar(start));
        }
        let spelling = word.clone().into_owned();
        let value = self.decode_word(word, start, end);
        self.fragment_bare(start, end, &value, spelling);
        Ok(value)
    }

    /// `-Infinity`, which is one token rather than a negated word.
    ///
    /// Unlike a bare string, this numeric token ends at a space: `[-Infinity 2]` retains two
    /// numbers. Wait for its boundary so a chunk ending at `-Infinity` cannot split `-Infinityx`.
    fn negative_infinity(&mut self) -> Option<Value<'a>> {
        if !self.input.starts_with(self.at, NEGATIVE_INFINITY) {
            return None;
        }
        let end = self.at + NEGATIVE_INFINITY.len();
        let after = self.input.get(end);
        if after.is_none() && !self.input_ended() {
            return None;
        }
        let escaped =
            after == Some(unit::BACKSLASH) && self.input.get(end + 1).is_some_and(is_delimiter);
        if !escaped
            && self.input.whitespace(end) == 0
            && !after.is_none_or(|c| is_ws(c) || is_separator(c))
        {
            return None;
        }
        let start = self.at;
        self.at += NEGATIVE_INFINITY.len();
        let allowed = self.options.recover.allows(SwitchableRepair::JsLiteral);
        self.lenient(SwitchableRepair::JsLiteral, start);
        let value = match allowed {
            true => Value::Number(Number::Double(f64::NEG_INFINITY)),
            false => Value::String(JsonString::Text(Cow::Borrowed("-Infinity"))),
        };
        self.fragment_bare(
            start,
            self.at,
            &value,
            JsonString::Text(Cow::Borrowed("-Infinity")),
        );
        Some(value)
    }

    /// A string, however the source chose to quote it.
    ///
    /// The apostrophe is the only spelling that needs anything said about it, so it is the only one
    /// with a branch: everything else about reading a string is the same either way, which is what
    /// keeps one reader deciding where a string ends.
    pub(crate) fn string(&mut self, retain_partial: bool) -> Result<JsonString<'a>, ScanError> {
        self.candidate.saw_quoted();
        let quote = self
            .quoted
            .as_ref()
            .map_or_else(|| self.peek(), |state| Some(state.quote));
        if quote != Some(unit::APOSTROPHE) {
            return self.quoted(unit::QUOTE, retain_partial);
        }
        let open = self.at;
        if self.quoted.is_none() {
            self.lenient(SwitchableRepair::SingleQuote, open);
        }
        let logged = self.mark();
        let value = self.quoted(unit::APOSTROPHE, retain_partial)?;
        // The WHOLE token is replaced, opening quote to closing: an apostrophe-quoted string may
        // hold a double quote the source never escaped, so rewriting the two delimiters alone would
        // produce text that ends early.
        //
        // Unless the reader already rewrote it. A mismatched quote replaces the token with a span
        // ENDING somewhere else, and adding this one on top would leave the splice two overlapping
        // rewrites of the same bytes — which it neither can nor should reconcile, since the reader
        // that saw the mismatch is the one that knows where the token really ended.
        if self.logged_since(logged) == 0 {
            self.edit_string(open, self.at, &value);
        }
        Ok(value)
    }

    /// Whether the closer at `at` is where this string really ends.
    ///
    /// Asked only once the WRONG quote has already appeared somewhere a closer would fit, which
    /// makes two readings possible and this the tie-break: `{"a": "value','b": "x"}` can be one
    /// string containing an apostrophe and a comma, or two members whose first closed with the wrong
    /// quote. What decides it is what FOLLOWS the candidate closer — a member ends at a comma, at
    /// the container's closer, or at the input; a key ends at a colon. Anything else means this
    /// closer cannot be the end of a member, so the earlier one was.
    ///
    /// `None` when the deciding bytes have not arrived. In a stream a missing follower is not the
    /// end of the document, and reading it as one commits the wrong of the two readings for good:
    /// `{"key1": "value1","key2": "value2','key3": "value3"}` cut immediately after the true closer
    /// came back as one member holding an apostrophe, where the same bytes whole are two members.
    fn closer_fits(&self, at: usize) -> Option<bool> {
        let mut next = at + 1;
        while self.input.get(next).is_some_and(is_ws) {
            next += 1;
        }
        let Some(follower) = self.input.get(next) else {
            return self.input_ended().then_some(true);
        };
        // Key position is READ OFF the stack rather than tracked: an open object with no key waiting
        // is precisely where a key belongs. A flag set and cleared around each call would be the
        // same fact stored twice, and the copy that can drift is the one nothing checks.
        if self
            .builder
            .stack
            .last()
            .is_some_and(|frame| frame.is_object() && frame.pending().is_none())
        {
            return Some(follower == unit::COLON);
        }
        Some(
            follower == unit::COMMA
                || (!self.builder.stack.is_empty()
                    && matches!(follower, unit::CLOSE_BRACE | unit::CLOSE_BRACKET)),
        )
    }

    /// String decoding may replace malformed bytes without allocating for valid source text.
    pub(crate) fn string_text(
        &mut self,
        start: usize,
        end: usize,
    ) -> Result<JsonString<'a>, ScanError> {
        if let Units::Utf16(input) = self.input.slice(start..end) {
            return Ok(JsonString::Units(Cow::Borrowed(input)));
        }
        if let Units::Mixed(input) = self.input.slice(start..end) {
            return self
                .mixed_text(input, start, end, TextMode::String)
                .map(|(text, _)| text);
        }
        if let Units::Joined(..) = self.input.slice(start..end) {
            let source = self.input.slice(start..end);
            let input = source.encoded();
            return self
                .mixed_text(&input, start, end, TextMode::String)
                .map(|(text, _)| joined_text(source, text));
        }
        self.decode_text(start, end, TextMode::String)
            .map(JsonString::Text)
    }

    /// Trivia needs decoder errors but never an allocated replacement string.
    pub(crate) fn decode_text(
        &mut self,
        start: usize,
        end: usize,
        mode: TextMode,
    ) -> Result<Cow<'a, str>, ScanError> {
        if let Units::Mixed(input) = self.input.slice(start..end) {
            self.mixed_text(input, start, end, mode)?;
            return Ok(Cow::Borrowed(""));
        }
        if let Units::Joined(..) = self.input.slice(start..end) {
            let input = self.input.slice(start..end).encoded();
            self.mixed_text(&input, start, end, mode)?;
            return Ok(Cow::Borrowed(""));
        }
        let Units::Bytes(bytes) = self.input.slice(start..end) else {
            // Native code units need no byte decoder; trivia does not retain its source.
            return Ok(Cow::Borrowed(""));
        };
        if let Ok(text) = core::str::from_utf8(bytes) {
            return Ok(Cow::Borrowed(text));
        }
        let mut text = String::new();
        let mut at = start;
        for chunk in bytes.utf8_chunks() {
            if mode != TextMode::Discard {
                text.push_str(chunk.valid());
            }
            at += chunk.valid().len();
            if !chunk.invalid().is_empty() {
                let stopped = self.invalid_utf8(at, at + chunk.invalid().len(), mode)?;
                if mode != TextMode::Discard {
                    text.push('\u{fffd}');
                }
                at += chunk.invalid().len();
                // The reference makes one further decoder piece available before observing the
                // stop. A bare token can finish that piece, but cannot consume the queued suffix.
                if stopped {
                    self.decode_stopped = true;
                    self.at = at;
                    break;
                }
            }
        }
        Ok(Cow::Owned(text))
    }

    fn number_text(&self, start: usize, end: usize) -> Result<Cow<'a, str>, ScanError> {
        let text = match self.input.slice(start..end) {
            Units::Bytes(input) => core::str::from_utf8(input)
                .map(Cow::Borrowed)
                .map_err(|_| ()),
            Units::Utf16(input) => String::from_utf16(input).map(Cow::Owned).map_err(|_| ()),
            Units::Mixed(input) => String::from_utf16(&crate::scan::mixed::text(input))
                .map(Cow::Owned)
                .map_err(|_| ()),
            Units::Joined(..) => String::from_utf16(&self.input.slice(start..end).text())
                .map(Cow::Owned)
                .map_err(|_| ()),
        };
        text.map_err(|()| ScanError {
            kind: ScanErrorKind::BadUtf8,
            at: start,
            path: SourcePath::new(),
        })
    }

    /// Closes a string the input ended inside, on the owned path.
    ///
    /// Everything read between the quotes was written by the source, so it is the value; nothing is
    /// appended to mark where the writing stopped, because a marker is the one thing a consumer could
    /// not tell from content. `dirty` decides how `repair(text)` gets there — the token's own bytes no
    /// longer spell the value, so the whole thing is re-serialised rather than given a closing quote.
    ///
    /// The splice is gated on the leniency, unlike the borrowed path's: a refused `unclosed-string`
    /// still yields the value, and editing the text anyway would repair a document the options say
    /// was never accepted.
    fn unclosed_owned(
        &mut self,
        start: usize,
        quote: u32,
        value: JsonString<'a>,
        dirty: bool,
        bad_escape: bool,
    ) -> JsonString<'a> {
        self.lenient(SwitchableRepair::UnclosedString, start - 1);
        if bad_escape {
            self.lenient(SwitchableRepair::InvalidEscape, start - 1);
        }
        // An apostrophe-quoted token is rewritten WHOLE by the caller, which already spells the value
        // as JSON, so a second edit over the same bytes would leave the splice two to reconcile.
        if quote != unit::APOSTROPHE
            && self
                .options
                .recover
                .allows(SwitchableRepair::UnclosedString)
        {
            if dirty {
                self.edit_string(start - 1, self.at, &value);
            } else {
                self.edit(self.at, self.at, Cow::Borrowed("\""));
            }
        }
        value
    }

    /// Decode one escape without owning the complete string, joining pairs and preserving lone units.
    /// The caller decides whether to accumulate the piece or deliver it incrementally.
    ///
    /// A lone surrogate is preserved rather than replaced because `HLD.md` rules it must survive
    /// across engines: replacing it with U+FFFD would be inventing a character the source did not
    /// write, which is the one thing this package must never do.
    fn unicode_escape(&mut self) -> Result<Option<JsonString<'static>>, ScanError> {
        let Some(high) = self.four_hex()? else {
            return Ok(None);
        };
        // A high surrogate can still acquire its low half in the next chunk. Nothing is emitted
        // until the following units decide that question; fragments cannot retract prior output.
        if (0xd800..0xdc00).contains(&high)
            && !self.input_ended()
            && (self.peek().is_none()
                || (self.peek() == Some(unit::BACKSLASH) && self.input.get(self.at + 1).is_none()))
        {
            return self.fail(ScanErrorKind::UnexpectedEnd);
        }
        let scalar = if (0xd800..0xdc00).contains(&high) && self.looks_like_low_surrogate() {
            let save = self.at;
            self.at += 1; // the backslash; `four_hex` steps over the `u` itself
            match self.four_hex()? {
                Some(low) if (0xdc00..0xe000).contains(&low) => {
                    Some(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00))
                }
                // Not a low surrogate, or not four digits: the high one stands alone and whatever
                // follows is read from the backslash again as its own escape.
                _ => {
                    self.at = save;
                    None
                }
            }
        } else if (0xd800..0xe000).contains(&high) {
            None
        } else {
            Some(high)
        };
        match scalar.and_then(char::from_u32) {
            Some(c) => Ok(Some(JsonString::Text(Cow::Owned(c.to_string())))),
            None => {
                // Unpaired: return the original code unit; a Rust string cannot represent it.
                let unit = u16::try_from(high).unwrap_or(0xfffd);
                Ok(Some(JsonString::Units(Cow::Owned(alloc::vec![unit]))))
            }
        }
    }

    fn looks_like_low_surrogate(&self) -> bool {
        self.input.get(self.at) == Some(unit::BACKSLASH)
            && self.input.get(self.at + 1) == Some(unit::LOWER_U)
    }

    /// Four hex digits after `u`; pause on incomplete input, or restore position on invalid digits.
    ///
    /// Restoring on failure is what lets the caller choose the reading: a short escape is recovered
    /// as the literal characters the source wrote, and a `\u` cut off by a chunk boundary is a pause
    /// that must re-read the whole escape rather than half of it.
    fn four_hex(&mut self) -> Result<Option<u32>, ScanError> {
        let save = self.at;
        self.at += 1; // the `u`
        let mut value = 0;
        for _ in 0..4 {
            if self.peek().is_none() && !self.input_ended() {
                return self.fail(ScanErrorKind::UnexpectedEnd);
            }
            let Some(digit) = self.peek().and_then(crate::chars::hex_value) else {
                self.at = save;
                return Ok(None);
            };
            value = (value << 4) | digit;
            self.at += 1;
        }
        Ok(Some(value))
    }
}

fn joined_text(source: Units<'_>, text: JsonString<'static>) -> JsonString<'static> {
    if source.is_bytes() {
        let JsonString::Units(text) = text else {
            return text;
        };
        JsonString::Text(Cow::Owned(String::from_utf16_lossy(&text)))
    } else {
        text
    }
}
