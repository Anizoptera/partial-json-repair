// SPDX-License-Identifier: Apache-2.0

/** C ABI signatures shared by every host FFI loader. */

export const FFI_SIGNATURES = {
  pjr_ffi_parse: { parameters: ["buffer", "usize"], result: "pointer" },
  pjr_ffi_parser_create: { parameters: ["buffer", "usize"], result: "pointer" },
  pjr_ffi_parser_execute: {
    parameters: ["pointer", "buffer", "usize"],
    result: "pointer",
  },
  pjr_ffi_parser_execute_controlled: {
    parameters: ["pointer", "buffer", "usize", "pointer"],
    result: "pointer",
  },
  pjr_ffi_parser_execute_async: {
    parameters: ["pointer", "buffer", "usize", "pointer", "pointer"],
    result: "u8",
  },
  pjr_ffi_parser_release: { parameters: ["pointer"], result: "void" },
  pjr_ffi_cancellation_create: { parameters: [], result: "pointer" },
  pjr_ffi_cancellation_abort: { parameters: ["pointer"], result: "void" },
  pjr_ffi_cancellation_release: { parameters: ["pointer"], result: "void" },
  pjr_ffi_stream_create: { parameters: ["pointer", "u8"], result: "pointer" },
  pjr_ffi_stream_feed: {
    parameters: ["pointer", "buffer", "usize"],
    result: "pointer",
  },
  pjr_ffi_stream_end: { parameters: ["pointer"], result: "pointer" },
  pjr_ffi_stream_snapshot: { parameters: ["pointer"], result: "pointer" },
  pjr_ffi_stream_summary: { parameters: ["pointer"], result: "pointer" },
  pjr_ffi_stream_release: { parameters: ["pointer"], result: "void" },
  pjr_ffi_response_pointer: { parameters: ["pointer"], result: "pointer" },
  pjr_ffi_response_length: { parameters: ["pointer"], result: "usize" },
  pjr_ffi_response_release: { parameters: ["pointer"], result: "void" },
} as const;
