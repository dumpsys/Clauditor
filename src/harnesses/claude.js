import { spawn } from "child_process";
import os from "os";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  buildCommentPrompt,
  buildTriagePrompt,
  buildReviewPrompt,
  buildSentryPrompt,
} from "../prompts/index.js";

/**
 * Claude Code harness — implementation of the four harness entry points
 * (runCommentFix / runTriage / runReview / runSentryFix) on top of the
 * `claude` CLI in headless mode (`-p` flag).
 *
 * Sister harnesses (Codex, Antigravity) will live next to this file and
 * implement the same four method signatures. Selection happens via
 * src/harnesses/index.js based on the HARNESS env var.
 */

/**
 * Run the comment-handler workflow: evaluate review feedback, apply
 * changes if actionable, verify tests, return a JSON decision.
 *
 * Returns: { actionable, reason, summary, files_modified, tests_run, tests_passed }
 */
export async function runCommentFix(workDir, context) {
  const prompt = buildCommentPrompt(context);

  logger.info(`Running: claude -p --output-format json [prompt via stdin]`);

  const args = [
    "-p",
    "--output-format", "json",
    "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
    // Higher than the original 10 — the test-verify-and-fix loop
    // (edit → run tests → fix failures → re-run) can take several turns
    // beyond the initial change.
    "--max-turns", "25",
  ];

  const output = await spawnClaude(args, prompt, workDir, config.claudeTimeoutMs);
  return parseDecisionOutput(output);
}

/**
 * Cheap pre-flight triage: ask the model (no tools, no clone) whether the
 * comment plausibly requires a code change. Returns { skip, reason }.
 *
 * Bias toward `skip: false` — when in doubt, proceed to the full flow.
 * Used to short-circuit the expensive clone + tool-using run for
 * obviously non-actionable feedback (praise, questions, lgtm, etc.).
 */
export async function runTriage(context) {
  const prompt = buildTriagePrompt(context);

  const args = [
    "-p",
    "--output-format", "json",
    // No tools — model judgment only. Can't read files, run commands, etc.
    "--allowedTools", "",
    // Single turn is enough; no tool loop needed.
    "--max-turns", "1",
  ];

  logger.info(
    `Triaging comment on PR #${context.prNumber}: "${(context.commentBody || "").substring(0, 60)}..."`
  );

  // No workdir needed — the call doesn't touch the repo. Use os.tmpdir()
  // as a safe cwd. Tight 60s timeout — single-turn no-tool calls return fast.
  const output = await spawnClaude(args, prompt, os.tmpdir(), 60_000);
  return parseTriageOutput(output);
}

/**
 * Run the portable review prompt — replaces the earlier `claude -p /review`
 * shortcut so the review workflow works under any harness. Returns the
 * markdown review body (NOT a JSON decision — Workflow B always posts).
 *
 * The /review slash command was Claude-Code-specific; bringing our own
 * prompt also means we can tune the review style and the same prompt is
 * portable to Codex/Antigravity once those adapters land.
 */
export async function runReview(workDir, context) {
  const prompt = buildReviewPrompt(context);

  const args = [
    "-p",
    "--output-format", "json",
    "--allowedTools", "Read,Glob,Grep,Bash",
    "--max-turns", "50",
  ];

  logger.info(
    `Running: claude -p (portable review prompt) on PR #${context.prNumber}, ` +
    `${context.baseBranch}...${context.headBranch}, ` +
    `timeout ${Math.round(config.claudeReviewTimeoutMs / 1000)}s`
  );

  const output = await spawnClaude(args, prompt, workDir, config.claudeReviewTimeoutMs);
  return extractReviewText(output);
}

/**
 * Run the Sentry crash-fix workflow: given a stack trace + surrounding
 * source context, locate the bug in the repo and propose a minimal fix.
 *
 * Returns the parsed JSON decision with an extra `confidence` field
 * ("high" | "medium" | "low") that the handler uses to decide PR draft state.
 */
export async function runSentryFix(workDir, context) {
  const prompt = buildSentryPrompt(context);

  logger.info(`Running: claude -p (Sentry fix prompt) on issue ${context.sentry.issueId}`);

  const args = [
    "-p",
    "--output-format", "json",
    "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
    "--max-turns", "30",
  ];

  const output = await spawnClaude(args, prompt, workDir, config.sentry.claudeTimeoutMs);
  return parseSentryOutput(output);
}

// ─── internals ───────────────────────────────────────────────────────────

function extractReviewText(rawOutput) {
  // --output-format json wraps as { type: "result", result: "<text>", ... }
  try {
    const outer = JSON.parse(rawOutput);
    if (typeof outer.result === "string") return outer.result;
  } catch {
    // Not JSON — fall through and return raw.
  }
  return rawOutput;
}

function parseSentryOutput(rawOutput) {
  // Reuse the same extraction pattern as parseDecisionOutput, but require a
  // confidence field so downstream draft-state logic doesn't break.
  let text = rawOutput;
  try {
    const outer = JSON.parse(rawOutput);
    if (outer.result) text = outer.result;
  } catch { /* fall through */ }

  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  let parsed = null;
  if (fenced) {
    try { parsed = JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  if (!parsed) {
    const inline = text.match(/\{[\s\S]*"actionable"[\s\S]*\}(?=[^{}]*$)/);
    if (inline) {
      try { parsed = JSON.parse(inline[0]); } catch { /* fall through */ }
    }
  }
  if (!parsed) {
    logger.error(`Sentry-fix output did not contain a parseable decision:\n${text}`);
    throw new Error("Could not extract actionable decision from Claude (Sentry) output");
  }

  // Default confidence to "low" if Claude omitted it but said actionable.
  if (parsed.actionable && !parsed.confidence) parsed.confidence = "low";
  return parsed;
}

function parseTriageOutput(rawOutput) {
  let text = rawOutput;
  try {
    const outer = JSON.parse(rawOutput);
    if (outer.result) text = outer.result;
  } catch { /* not outer JSON, fall through */ }

  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (typeof parsed.skip === "boolean") return parsed;
    } catch { /* fall through */ }
  }

  const inline = text.match(/\{[\s\S]*"skip"[\s\S]*?\}/);
  if (inline) {
    try {
      const parsed = JSON.parse(inline[0]);
      if (typeof parsed.skip === "boolean") return parsed;
    } catch { /* fall through */ }
  }

  // Unparseable — proceed conservatively rather than dropping the job.
  logger.warn(`Triage output not parseable; proceeding with full flow. Output: ${text.substring(0, 300)}`);
  return { skip: false, reason: "triage output not parseable; defaulted to proceed" };
}

function spawnClaude(args, prompt, cwd, timeoutMs = config.claudeTimeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errorChunks = [];

    const proc = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (prompt) {
      proc.stdin.write(prompt);
    }
    proc.stdin.end();

    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (chunk) => {
      errorChunks.push(chunk);
      logger.debug(`claude stderr: ${chunk.toString()}`);
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude Code timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errorChunks).toString("utf-8");

      if (code !== 0) {
        // With --output-format json, Claude often emits its error envelope on
        // stdout, not stderr — so log both. Truncate to keep logs readable.
        const truncate = (s, n = 4000) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more chars truncated)` : s);
        logger.error(
          `Claude Code exited with code ${code}\n` +
          `stderr: ${truncate(stderr) || "(empty)"}\n` +
          `stdout: ${truncate(stdout) || "(empty)"}`
        );

        // Surface the actual reason in the rejection error if Claude returned
        // a structured error envelope (auth failures, rate limits, etc.).
        let detail = "";
        try {
          const parsed = JSON.parse(stdout);
          if (parsed?.is_error) {
            const status = parsed.api_error_status ? ` HTTP ${parsed.api_error_status}` : "";
            const msg = parsed.result || parsed.error || "unknown error";
            detail = ` —${status} ${msg}`;
            if (parsed.api_error_status === 401) {
              detail += ` (hint: unset ANTHROPIC_API_KEY if you rely on \`claude auth login\`, or set a valid key)`;
            }
          }
        } catch { /* not JSON, ignore */ }

        reject(new Error(`Claude Code failed with exit code ${code}${detail}`));
        return;
      }

      resolve(stdout);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Extract the JSON decision block from Claude's output.
 * `--output-format json` wraps the model output as { type: "result", result: "..." }.
 */
function parseDecisionOutput(rawOutput) {
  let text = rawOutput;

  try {
    const outerJson = JSON.parse(rawOutput);
    if (outerJson.result) text = outerJson.result;
  } catch {
    // Not outer JSON; fall through to raw text.
  }

  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (err) {
      logger.error(`Failed to parse Claude's JSON decision: ${jsonMatch[1]}`);
      throw new Error(`Claude returned invalid JSON: ${err.message}`);
    }
  }

  const fallbackMatch = text.match(/\{[\s\S]*"actionable"[\s\S]*\}(?=[^{}]*$)/);
  if (fallbackMatch) {
    try {
      return JSON.parse(fallbackMatch[0]);
    } catch {
      // ignore
    }
  }

  logger.error(`Claude output did not contain a parseable decision:\n${text}`);
  throw new Error("Could not extract actionable decision from Claude output");
}

// ─── Internals exposed for unit testing ──────────────────────────────────
// Tests import these directly so the pure parsers can be exercised without
// spawning the CLI. Not part of the harness public API — production callers
// go through the four runX functions above.
export {
  parseDecisionOutput,
  parseTriageOutput,
  parseSentryOutput,
  extractReviewText,
};
