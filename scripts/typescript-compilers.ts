import { resolve } from "node:path";

// HLD's compiler matrix also governs packed consumers; a new supported major enters here once.
export const TYPESCRIPT_PACKAGES = ["typescript-6", "typescript"] as const;
export const typeScriptCheckers = TYPESCRIPT_PACKAGES.map((name): string[] => [
  "node",
  resolve("node_modules", name, "bin/tsc"),
  "-p",
  ".",
  "--pretty",
  "false",
]);
