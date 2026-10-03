// JSON values include container objects and scalar fields, not just cells.
// The capture and local-file validators share this bounded structural budget.
// Byte, depth, cell, merge and editable-node limits remain separate checks.
export const MAX_JSON_VALUES = 2_000_000;
