// SPDX-License-Identifier: Apache-2.0

import type { AsyncOverrides, Planned } from "./async-operation";
import type { ParserSettings } from "./options";
import type { Input, Result } from "./types";
import type { WholeRequest } from "./whole-operation";

export type AsyncConfigurationState<Options extends AsyncOverrides = AsyncOverrides> = {
  readonly options: ParserSettings;
  readonly settings: Options;
  readonly prepare: (options?: AsyncOverrides) => Planned;
  readonly execute: (
    operation: WholeRequest,
    input: Input,
    planned: Planned,
    release?: () => void,
  ) => AsyncGenerator<unknown, void, undefined>;
  readonly close: (this: void) => Result<undefined, never>;
};

export class AsyncConfiguration<Options extends AsyncOverrides = AsyncOverrides> {
  // Recognition must not inspect caller option getters or pull task-signal joining into free calls.
  #state: AsyncConfigurationState<Options>;
  readonly close: (this: void) => Result<undefined, never>;

  private constructor(state: AsyncConfigurationState<Options>) {
    this.#state = state;
    this.close = state.close;
  }

  /** @internal */
  static create<Options extends AsyncOverrides>(
    state: AsyncConfigurationState<Options>,
  ): AsyncParser<Options> {
    const parser = new AsyncConfiguration(state);
    // Disposal setup belongs to explicit construction, never module initialization.
    const configured = Object.assign(parser, {
      [Symbol.dispose](): void {
        parser.close();
      },
    });
    Object.freeze(configured);
    return configured;
  }

  get options(): ParserSettings {
    return this.#state.options;
  }

  /** @internal */
  static is(value: object): value is AsyncConfiguration {
    return #state in value;
  }
  /** @internal */
  static state(parser: AsyncConfiguration): AsyncConfigurationState {
    return parser.#state;
  }
}

export type AsyncParser<Options extends AsyncOverrides = AsyncOverrides> =
  AsyncConfiguration<Options> & Disposable;

export const isAsyncParser = (value: unknown): value is AsyncParser =>
  typeof value === "object" && value !== null && AsyncConfiguration.is(value);
