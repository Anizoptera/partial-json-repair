// SPDX-License-Identifier: Apache-2.0

/** Find contact addresses that could identify real people in published examples. */
export function fixtureEmails(text: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let offset = 0;
  // Bound both sides: malformed fixtures can contain megabytes of uninterrupted scalar text.
  for (const match of text.matchAll(
    /[\w.%+-]{1,64}@([\w.-]{1,253}\.[a-z]{2,63})(?![\w-]|\.[\w-])/giu,
  )) {
    const domain = match[1]?.toLowerCase() ?? "";
    if (/^(?:.*\.)?(?:example\.(?:com|net|org)|test|invalid|localhost|example)$/u.test(domain)) {
      continue;
    }
    while (offset < match.index) {
      if (text.charCodeAt(offset++) === 10) line++;
    }
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines;
}
