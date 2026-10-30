// SPDX-License-Identifier: Apache-2.0

/** Define every native package target and derive host candidates from observed capabilities. */

export type NativeTarget = {
  readonly id: string;
  readonly package: `partial-json-repair-native-${string}`;
  readonly os: "darwin" | "linux" | "win32";
  readonly cpu: "arm64" | "x64";
  readonly libc?: "glibc" | "musl";
  readonly rust: string;
  readonly library: "dll" | "dylib" | "so";
};

const target = (
  id: string,
  os: NativeTarget["os"],
  cpu: NativeTarget["cpu"],
  rust: string,
  library: NativeTarget["library"],
  libc?: NativeTarget["libc"],
): NativeTarget => ({
  id,
  package: `partial-json-repair-native-${id}`,
  os,
  cpu,
  rust,
  library,
  ...(libc === undefined ? {} : { libc }),
});

export const NATIVE_TARGETS: readonly NativeTarget[] = Object.freeze([
  target("darwin-arm64", "darwin", "arm64", "aarch64-apple-darwin", "dylib"),
  target("darwin-x64", "darwin", "x64", "x86_64-apple-darwin", "dylib"),
  target("linux-arm64-gnu", "linux", "arm64", "aarch64-unknown-linux-gnu", "so", "glibc"),
  target("linux-arm64-musl", "linux", "arm64", "aarch64-unknown-linux-musl", "so", "musl"),
  target("linux-x64-gnu", "linux", "x64", "x86_64-unknown-linux-gnu", "so", "glibc"),
  target("linux-x64-musl", "linux", "x64", "x86_64-unknown-linux-musl", "so", "musl"),
  target("win32-arm64", "win32", "arm64", "aarch64-pc-windows-msvc", "dll"),
  target("win32-x64", "win32", "x64", "x86_64-pc-windows-msvc", "dll"),
]);

export const nativeTargetsForHost = (
  os: string | undefined,
  cpu: string | undefined,
  glibc: boolean | undefined,
): readonly NativeTarget[] => {
  const normalizedOs = os === "windows" ? "win32" : os;
  const normalizedCpu = cpu === "aarch64" ? "arm64" : cpu === "x86_64" ? "x64" : cpu;
  return NATIVE_TARGETS.filter(
    (candidate) =>
      candidate.os === normalizedOs &&
      candidate.cpu === normalizedCpu &&
      (candidate.libc === undefined ||
        glibc === undefined ||
        (candidate.libc === "glibc") === glibc),
  );
};
