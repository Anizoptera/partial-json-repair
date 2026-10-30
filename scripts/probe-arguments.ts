// SPDX-License-Identifier: Apache-2.0

/**
 * Argument parsing shared by the slow packed probes (`size-check`, `platform-check`). Each run builds
 * every bundler and host, so an argument the parser ignores is the costliest bug a CLI can have: a
 * typo (`--fixtur`) or a guessed `--help` silently starts the complete matrix instead of the narrow
 * probe the caller asked for. Every argument must therefore be a declared flag or a declared option
 * with its value; anything else stops before any work, naming the usage.
 *
 * Kept free of bundler imports so its tests exercise only this contract.
 */
export const probeArguments = (
  args: readonly string[],
  spec: {
    readonly usage: string;
    readonly flags: readonly string[];
    readonly options: readonly string[];
  },
) => {
  const rest = args[Symbol.iterator]();
  for (const arg of rest) {
    if (spec.flags.includes(arg)) continue;
    if (!spec.options.includes(arg))
      throw new Error(`unknown argument ${arg}; usage: ${spec.usage}`);
    // The value is consumed here, so the loop never reads it as an argument of its own.
    const value = rest.next().value;
    // A missing value must not swallow the next flag and turn a narrow probe into a full build.
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${arg} requires a value; usage: ${spec.usage}`);
  }
  return {
    flag: (name: string): boolean => args.includes(name),
    option: (name: string): string | undefined => {
      const at = args.indexOf(name);
      return at === -1 ? undefined : args[at + 1];
    },
  };
};
