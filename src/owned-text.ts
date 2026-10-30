// SPDX-License-Identifier: Apache-2.0

const selectTextCopier = (): ((text: string) => string) => {
  if (typeof structuredClone !== "function")
    return (text) => JSON.parse(JSON.stringify(text)) as string;
  const clone = structuredClone;
  // Deno's primitive shortcut returns borrowed strings unchanged; explicit options bypass it.
  // No inherited transfer setting or supplied iterable may detach data while copying text.
  const options = { __proto__: null } as NonNullable<Parameters<typeof clone>[1]>;
  // Clone setup differs by engine; keep unmeasured hosts on their existing copier.
  const host = globalThis as {
    Deno?: unknown;
    process?: { versions?: { node?: unknown; bun?: unknown } };
  };
  if (
    host.Deno !== undefined ||
    (host.process?.versions?.node !== undefined && host.process.versions.bun === undefined)
  )
    return (text) => {
      // Short Node chunks and Deno repair matches avoid clone setup. One construction avoids the
      // retained-storage growth of concatenated copies; longer text keeps bounded JS work.
      if (text.length > 64) return clone(text, options);
      const units: number[] = [];
      for (let index = 0; index < text.length; index++) units.push(text.charCodeAt(index));
      return String.fromCharCode.apply(undefined, units);
    };
  return (text) => clone(text, options);
};
// Resolve host support once; every route preserves lone UTF-16 units. PURE removes unused selection.
const copyText = /* @__PURE__ */ selectTextCopier();

export const ownText = (text: string): string => {
  // Tiny tokens need owned storage too; rebuilding code units avoids a native clone per token.
  // Do not iterate code points: a lone surrogate is source content, and pairs need both units.
  switch (text.length) {
    case 0:
      return "";
    case 1:
      return String.fromCharCode(text.charCodeAt(0));
    case 2:
      return String.fromCharCode(text.charCodeAt(0), text.charCodeAt(1));
    case 3:
      return String.fromCharCode(text.charCodeAt(0), text.charCodeAt(1), text.charCodeAt(2));
    case 4:
      return String.fromCharCode(
        text.charCodeAt(0),
        text.charCodeAt(1),
        text.charCodeAt(2),
        text.charCodeAt(3),
      );
    default:
      return copyText(text);
  }
};
