const stringArray = {
  type: "array",
  items: { type: "string" },
};

export const commentDecisionSchema = {
  type: "object",
  properties: {
    actionable: { type: "boolean" },
    summary: { type: "string" },
    files_modified: stringArray,
    tests_run: { type: "boolean" },
    tests_passed: { type: "boolean" },
    reason: { type: "string" },
  },
  required: [
    "actionable",
    "summary",
    "files_modified",
    "tests_run",
    "tests_passed",
    "reason",
  ],
  additionalProperties: false,
};

export const triageDecisionSchema = {
  type: "object",
  properties: {
    skip: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["skip", "reason"],
  additionalProperties: false,
};

export const sentryDecisionSchema = {
  type: "object",
  properties: {
    actionable: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    summary: { type: "string" },
    files_modified: stringArray,
    root_cause: { type: "string" },
    tests_run: { type: "boolean" },
    tests_passed: { type: "boolean" },
    reason: { type: "string" },
  },
  required: [
    "actionable",
    "confidence",
    "summary",
    "files_modified",
    "root_cause",
    "tests_run",
    "tests_passed",
    "reason",
  ],
  additionalProperties: false,
};
