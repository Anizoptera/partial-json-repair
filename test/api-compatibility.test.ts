import { expect, it } from "vitest";
import { incompatibleExports } from "../scripts/api-compatibility";
import { normalizeDeclarations, reachable, records } from "../scripts/api-declarations";

it("follows bound declaration references rather than member names and shadowed parameters", () => {
  const source = `
type Payload = { ok: true };
export interface Parser { options: { hidden: boolean } }
export interface Read<Parser> { parse(value: Parser): Payload; named: typeof stamp; nested: N.Value }
export declare function parse(parser: Parser): number;
declare const stamp: unique symbol;
declare namespace N { export type Value = Payload }
`;
  expect([...reachable(records(normalizeDeclarations(source)), ["Read"])].toSorted()).toEqual([
    "N",
    "Payload",
    "Read",
    "stamp",
  ]);
});

it("distinguishes public constructors from type-only class aliases", async () => {
  const shape = "declare class Value { private state; read(): string; }";
  const types = `${shape} export type { Value as Result };`;
  expect([
    ...(await incompatibleExports(
      types,
      types.replace("read(): string", "read(): string; close(): void"),
    )),
  ]).toEqual([]);
  expect([...(await incompatibleExports(`${shape} export { Value as Result };`, types))]).toEqual([
    "Result",
  ]);
});

it("rejects narrowed generic constraints and changed omitted defaults", async () => {
  const before =
    "export type Box<T = string> = { value: T }; export type Pair<T, U = string> = { value: T; extra: U }; export type Limit<T extends string | number> = T; export declare class Shape { read(): string; }";
  const after =
    "export type Box<T = number> = { value: T }; export type Pair<T, U = number> = { value: T; extra: U }; export type Limit<T extends string> = T; export declare class Shape { read(): string; close(): void; }";
  expect([...(await incompatibleExports(before, after))].toSorted()).toEqual([
    "Box",
    "Limit",
    "Pair",
    "Shape",
  ]);
});

it("detects conditional type and removed-call-argument breaks", async () => {
  const before =
    "export type Result<T> = T extends string ? 1 : 2; export declare function read(value: string, extra?: number): string;";
  const after =
    "export type Result<T> = T extends number ? 1 : 2; export declare function read(value: string): string;";
  expect([...(await incompatibleExports(before, after))].toSorted()).toEqual(["Result", "read"]);
});

it("rejects a removed concrete overload even when generic function assignment accepts it", async () => {
  const generic =
    "type Options = { flag?: boolean }; export declare function read<T extends Options | undefined>(input: string, options: T): unknown;";
  const previous = `${generic} export declare function read(input: string, legacy: "previous-call"): unknown;`;
  const widened = generic.replace("Options | undefined", 'Options | undefined | "previous-call"');
  const [removed, retained] = await Promise.all([
    incompatibleExports(previous, generic),
    incompatibleExports(previous, widened),
  ]);
  expect([...removed]).toEqual(["read"]);
  expect([...retained]).toEqual([]);
});

it("accepts added nominal-class methods and widened private generic constraints", async () => {
  const before =
    "type Input = string; export type Box<T extends Input> = T; export type Constrained<T extends U, U = string> = T; export declare class Parser { private state; parse(): string; }";
  const after =
    "type Input = string | number; export type Box<T extends Input> = T; export type Constrained<T extends U, U = string | number> = T; export declare class Parser { private state; parse(): string; close(): void; }";
  expect([...(await incompatibleExports(before, after))]).toEqual([]);
});
