/**
 * Harness selection.
 *
 * Every harness exposes the same four entry points:
 *
 *   - runCommentFix(workDir, context) → JSON decision (Workflow A)
 *   - runTriage(context)              → { skip, reason }
 *   - runReview(workDir, context)     → markdown review body (Workflow B)
 *   - runSentryFix(workDir, context)  → JSON decision w/ confidence (Workflow C)
 *
 * Claude Code and Codex are supported. Antigravity remains deferred until
 * its headless-auth story settles. See docs/multi-cli-assessment.md.
 *
 * The `HARNESS` env var picks which adapter to use (default `claude`).
 * Unknown values throw at startup so a typo doesn't silently fall back.
 */

import * as claudeHarness from "./claude.js";
import * as codexHarness from "./codex.js";

const REGISTRY = {
  claude: claudeHarness,
  codex: codexHarness,
};

const HARNESS_NAME = (process.env.HARNESS || "claude").trim().toLowerCase();

/**
 * The active harness for this process. Selected once at module load — if
 * you want to change it for tests, mutate process.env.HARNESS before
 * importing this module or import the adapter directly.
 */
export const harness = (() => {
  const impl = REGISTRY[HARNESS_NAME];
  if (!impl) {
    const supported = Object.keys(REGISTRY).join(", ");
    throw new Error(
      `Unknown HARNESS="${HARNESS_NAME}". Supported: ${supported}.`,
    );
  }
  return {
    name: HARNESS_NAME,
    displayName: impl.displayName || HARNESS_NAME,
    runCommentFix: impl.runCommentFix,
    runTriage: impl.runTriage,
    runReview: impl.runReview,
    runSentryFix: impl.runSentryFix,
  };
})();
