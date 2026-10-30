// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";

import { fixtureEmails } from "../scripts/fixture-identities";

const contact = (domain: string) => `reader@${domain}`;

test("rejects contact domains and deceptive example suffixes without printing identities", () => {
  expect(
    fixtureEmails(
      [
        contact("example.com"),
        contact("example.com.attacker.testhost"),
        contact("mail.testhost"),
        contact("EXAMPLE.ORG"),
        contact("sub.example.net"),
        contact("local.invalid"),
      ].join("\n"),
    ),
  ).toEqual([2, 3]);
});

test("finds identities after long malformed scalars and on repeated lines", () => {
  const address = contact("mail.testhost");
  expect(fixtureEmails(`${"x".repeat(100_000)}\n${address} ${address}\n${address}`)).toEqual([
    2, 3,
  ]);
});

test("detects a contact followed by sentence punctuation", () => {
  expect(fixtureEmails(`Contact ${contact("mail.testhost")}.`)).toEqual([1]);
});
