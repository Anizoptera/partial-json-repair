// SPDX-License-Identifier: Apache-2.0

/** Adapt host FFI symbols to the one byte binding consumed by `NativeEngine`. */

import type { NativeFactories } from "./native-engine";

export type FfiPointer = bigint | number | object | null;

export type FfiSymbols<
  Pointer extends FfiPointer = FfiPointer,
  ArgumentLength extends bigint | number = number,
  ReturnLength extends bigint | number = ArgumentLength,
> = {
  pjr_ffi_parse(bytes: Uint8Array, length: ArgumentLength): Pointer;
  pjr_ffi_parser_create(bytes: Uint8Array, length: ArgumentLength): Pointer;
  pjr_ffi_parser_execute(parser: Pointer, bytes: Uint8Array, length: ArgumentLength): Pointer;
  pjr_ffi_parser_execute_controlled(
    parser: Pointer,
    bytes: Uint8Array,
    length: ArgumentLength,
    cancellation: Pointer,
  ): Pointer;
  pjr_ffi_parser_execute_async(
    parser: Pointer,
    bytes: Uint8Array,
    length: ArgumentLength,
    cancellation: Pointer,
    completion: Pointer,
  ): number;
  pjr_ffi_parser_release(parser: Pointer): void;
  pjr_ffi_cancellation_create(): Pointer;
  pjr_ffi_cancellation_abort(cancellation: Pointer): void;
  pjr_ffi_cancellation_release(cancellation: Pointer): void;
  pjr_ffi_stream_create(parser: Pointer, mode: number): Pointer;
  pjr_ffi_stream_feed(stream: Pointer, bytes: Uint8Array, length: ArgumentLength): Pointer;
  pjr_ffi_stream_end(stream: Pointer): Pointer;
  pjr_ffi_stream_snapshot(stream: Pointer): Pointer;
  pjr_ffi_stream_summary(stream: Pointer): Pointer;
  pjr_ffi_stream_release(stream: Pointer): void;
  pjr_ffi_response_pointer(response: Pointer): Pointer;
  pjr_ffi_response_length(response: Pointer): ReturnLength;
  pjr_ffi_response_release(response: Pointer): void;
};

export type FfiMemory<Pointer extends FfiPointer = FfiPointer> = {
  copy(pointer: Pointer, length: number): Uint8Array;
};

const absent = (pointer: FfiPointer): boolean =>
  pointer === null || pointer === 0 || pointer === 0n;

export const createFfiBinding = <Pointer extends FfiPointer, Length extends bigint | number>(
  symbols: FfiSymbols<Pointer, Length, bigint | number>,
  memory: FfiMemory<Pointer>,
  encodeLength: (length: number) => Length,
  defaultConfiguration: Uint8Array,
  retain?: object,
  release?: () => void,
  executeControlled?: (
    parser: Pointer,
    bytes: Uint8Array,
    length: Length,
    cancellation: Pointer,
  ) => Promise<Pointer>,
): NativeFactories => {
  const response = (handle: Pointer): Uint8Array => {
    if (absent(handle)) throw new Error("native FFI operation failed");
    try {
      const length = Number(symbols.pjr_ffi_response_length(handle));
      if (!Number.isSafeInteger(length) || length < 0)
        throw new Error("native FFI returned an invalid response length");
      const pointer = symbols.pjr_ffi_response_pointer(handle);
      if (absent(pointer) && length !== 0)
        throw new Error("native FFI returned an invalid response pointer");
      return memory.copy(pointer, length);
    } finally {
      symbols.pjr_ffi_response_release(handle);
    }
  };

  const call = (bytes: Uint8Array): Uint8Array =>
    response(symbols.pjr_ffi_parse(bytes, encodeLength(bytes.byteLength)));

  const stream = (handle: Pointer) => {
    if (absent(handle)) throw new Error("native FFI stream creation failed");
    let open = true;
    return {
      feed: (bytes: Uint8Array) =>
        response(symbols.pjr_ffi_stream_feed(handle, bytes, encodeLength(bytes.byteLength))),
      end: () => response(symbols.pjr_ffi_stream_end(handle)),
      snapshot: () => response(symbols.pjr_ffi_stream_snapshot(handle)),
      summary: () => response(symbols.pjr_ffi_stream_summary(handle)),
      close: () => {
        if (!open) return;
        open = false;
        symbols.pjr_ffi_stream_release(handle);
      },
    };
  };

  const createParser = (configuration: Uint8Array) => {
    const handle = symbols.pjr_ffi_parser_create(
      configuration,
      encodeLength(configuration.byteLength),
    );
    if (absent(handle)) throw new Error("native FFI parser creation failed");
    let open = true;
    const parser = {
      execute: (bytes: Uint8Array) =>
        response(symbols.pjr_ffi_parser_execute(handle, bytes, encodeLength(bytes.byteLength))),
      createStream: (mode: number) => stream(symbols.pjr_ffi_stream_create(handle, mode)),
      close: () => {
        if (!open) return;
        open = false;
        symbols.pjr_ffi_parser_release(handle);
      },
    };
    return executeControlled === undefined
      ? parser
      : {
          ...parser,
          executeAsync: async (bytes: Uint8Array, cancellation?: { readonly opaque?: unknown }) => {
            const cancellationHandle = cancellation?.opaque as Pointer | undefined;
            if (cancellationHandle === undefined || absent(cancellationHandle))
              throw new Error("native FFI cancellation is required");
            return response(
              await executeControlled(
                handle,
                bytes,
                encodeLength(bytes.byteLength),
                cancellationHandle,
              ),
            );
          },
        };
  };

  const createStream = () => {
    const parser = createParser(defaultConfiguration);
    try {
      return parser.createStream(0);
    } finally {
      parser.close();
    }
  };

  const createCancellation =
    executeControlled === undefined
      ? undefined
      : () => {
          const handle = symbols.pjr_ffi_cancellation_create();
          if (absent(handle)) throw new Error("native FFI cancellation creation failed");
          let open = true;
          return {
            opaque: handle,
            abort: () => {
              symbols.pjr_ffi_cancellation_abort(handle);
            },
            close: () => {
              if (!open) return;
              open = false;
              symbols.pjr_ffi_cancellation_release(handle);
            },
          };
        };

  return {
    parse: call,
    createParser,
    createStream,
    ...(createCancellation === undefined ? {} : { createCancellation }),
    ...(retain === undefined ? {} : { retain }),
    ...(release === undefined ? {} : { release }),
  };
};
