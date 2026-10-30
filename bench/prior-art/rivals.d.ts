/**
 * The rivals that ship no type declarations, given the SHAPE this comparison actually calls.
 *
 * Not `declare module "x";` — that form makes every use silently `any`, which defeats the reason
 * this directory is type-checked at all: a rival changing its entry point should fail here, before a
 * measurement runs, rather than as a dash in a published table that reads like a capability result.
 */

declare module "json-repair-js" {
  export const loads: (text: string) => unknown;
}

declare module "json-bigint" {
  const jsonBigint: { parse: (text: string) => unknown };
  export default jsonBigint;
}
