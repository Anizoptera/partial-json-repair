// SPDX-License-Identifier: Apache-2.0

// Minifiers preserve these feature-owned literals or properties; consumers control both presence and absence.
export const FEATURE_MARKERS = {
  metrics: "dangerousKeysBlocked",
  // Empty reports are optional too; this field catches their retention without a full assembler.
  "report projection": "entriesComplete",
  // Totals and confidence belong to diagnostics even when no report assembler survives.
  "report tally": "certainty",
  "repair report entries": ".repairs.push(",
  "text edit recording": ".edits.push(",
  transport: "source-failed",
  "stream position history": ".runs.slice(",
  // Match the object method definition, not the optional delegate's `.retain(` call.
  "fragment position pins": ",retain(",
  // A method name: the minifier renames locals, never property names, and only `Snapshotter` has it.
  views: "selectedState",
  "view readers": "pendingMatch",
  "view frame readers": "builtDepth",
  // Only decoded delivery owns this counter; shared failure tags are not codec evidence.
  "scalar fragments": "nextFragment",
  // A reader's optional call retains emission code even when no Picks implementation is imported.
  "fragment emission": ".fragmentData(",
  "source fragment delivery": "delivered scalar source",
  "fragment setup guidance": "takes imported `decodedFragments` for recovered content",
  stringify: "non-plain-object",
  repair: "repair edit run is incomplete",
  "span projection": "one-shot span projection yielded",
  // Single-root projection does not consume individual selected deliveries.
  "multi-value delivery": "consumeDelivery",
} as const;
