//! Compile public contract tests together to avoid a compiler and linker invocation per module.
//! Each module still calls the external crate; tests share no parser state.

mod decimal_spelling;
mod deserialize;
mod escaped_delimiters;
mod foreign_literals;
mod number_spelling;
mod object_members;
mod parse_stream;
mod parse_stream_async;
mod quoted_recovery;
mod repair_dropped;
mod root_filter;
mod selection;
mod stream_closed;
mod stream_input;
mod strict_values;
mod string_access;
mod stringify;
mod summary;
mod utf16_input;
mod utf16_scanner;
mod utf8_recovery;
mod views;
mod whitespace_recovery;
