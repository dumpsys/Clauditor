import { spawn } from "child_process";
import os from "os";
import { config } from "../config.js";
import { logger } from "../logger.js";
// Prompt builders live in a sibling file so prompt iteration (which happens
// often, in response to operator observations) doesn't clutter the diff of
// the CLI plumbing (which iterates rarely).
import {
  buildPrompt,
  buildTriagePrompt,
  buildSentryPrompt,
  buildReviewCommand,
} from "./claudePrompts.js";

// Load ONLY the operator's own (user-scoped) settings — never the cloned
// repo's `project`/`local` settings.
//
// Every runClaude* flow below spawns the CLI with cwd set to a throwaway
// clone of a (possibly external) PR / Sentry branch. A repo can ship a
// `.claude/settings.json` carrying permission allow-lists, hooks, and MCP
// servers; honoring those from untrusted code would let a malicious PR run
// arbitrary commands through our bot. Claude already refuses to load them
// because the temp workspace isn't trusted — emitting the noisy
//   "Ignoring N permissions.allow entries … this workspace has not been trusted"
// warning on stderr for every run. Passing `--setting-sources user` makes
// that intent explicit: there are no project settings to ignore, so the
// warning disappears, and our per-call `--allowedTools` stays the single
// source of truth for what the agent may do.
const SETTING_SOURCES = ["--setting-sources", "user"];

/**
 * Invoke Claude Code in headless mode (-p flag) to:
 * 1. Evaluate if the review feedback is valid and actionable
 * 2. If so, apply the necessary code changes
 *
 * Returns: { actionable: bool, reason: string, summary: string, files_modified: string[] }
 */
export async function runClaudeCode(workDir, context) {
  const prompt = buildPrompt(context);

  logger.info(`Running: claude -p --output-format json [prompt via stdin]`);

  const args = [
    "-p",
    "--output-format", "json",
    ...SETTING_SOURCES,
    "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
    // Higher than the original 10 — the test-verify-and-fix loop
    // (edit → run tests → fix failures → re-run) can take several turns
    // beyond the initial change.
    "--max-turns", "25",
  ];

  const output = await spawnClaude(args, prompt, workDir, config.claudeTimeoutMs);
  return parseClaudeOutput(output);
}

/**
 * Cheap pre-flight triage: ask Claude (no tools, no clone) whether the
 * comment plausibly requires a code change. Returns { skip, reason }.
 *
 * We bias toward `skip: false` — when in doubt, proceed to the full flow.
 * Used to short-circuit the expensive clone + tool-using run for
 * obviously-non-actionable feedback (praise, questions, lgtm, etc.).
 */
export async function runClaudeTriage(context) {
  const prompt = buildTriagePrompt(context);

  const args = [
    "-p",
    "--output-format", "json",
    ...SETTING_SOURCES,
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
 * Run the built-in `/review` slash command in headless mode and return
 * Claude's review text (suitable for posting as a PR review body).
 *
 * Per https://www.linkedin.com/posts/markshust_til-you-can-run-claude-code-slash-commands-share-7407042756113489939-5pfS/
 * `claude -p "/review"` triggers the built-in review slash command in headless mode.
 */
export async function runClaudeReview(workDir, context) {
  // Slash command goes via the prompt argument (not stdin) — that's how
  // the CLI parses it as a command rather than free-form text. We pass the
  // PR number explicitly (or a branch-resolution instruction when the
  // context lacks one) so `/review` never has to guess which PR the
  // throwaway clone corresponds to.
  const reviewCommand = buildReviewCommand(context);
  const args = [
    "-p", reviewCommand,
    "--output-format", "json",
    ...SETTING_SOURCES,
    "--allowedTools", "Read,Glob,Grep,Bash",
    "--max-turns", "50",
  ];

  logger.info(
    `Running: claude -p "${reviewCommand}" (PR #${context.prNumber ?? "unknown"}, ` +
    `${context.baseBranch}...${context.headBranch}, ` +
    `timeout ${Math.round(config.claudeReviewTimeoutMs / 1000)}s)`
  );

  const output = await spawnClaude(args, /* stdinPrompt */ null, workDir, config.claudeReviewTimeoutMs);
  return extractReviewText(output);
}

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

/**
 * Run Claude Code with a Sentry-specific prompt: given a stack trace +
 * surrounding source context, locate the bug in the repo and propose a
 * minimal fix. Mirrors `runClaudeCode` but uses its own timeout and prompt.
 *
 * Returns the parsed JSON decision with an extra `confidence` field
 * ("high" | "medium" | "low") that the handler uses to decide PR draft state.
 */
export async function runClaudeSentryFix(workDir, context) {
  const prompt = buildSentryPrompt(context);

  logger.info(`Running: claude -p (Sentry fix prompt) on issue ${context.sentry.issueId}`);

  const args = [
    "-p",
    "--output-format", "json",
    ...SETTING_SOURCES,
    "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
    "--max-turns", "30",
  ];

  const output = await spawnClaude(args, prompt, workDir, config.sentry.claudeTimeoutMs);
  return parseSentryOutput(output);
}

function parseSentryOutput(rawOutput) {
  // Reuse the same extraction pattern as parseClaudeOutput, but require a
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
function parseClaudeOutput(rawOutput) {
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
// Not part of the public service API — production callers go through the
// `runClaude*` functions above. Tests import these directly so the pure
// parsers and prompt builders can be exercised without spawning the CLI.
export {
  buildPrompt,
  buildTriagePrompt,
  buildSentryPrompt,
  buildReviewCommand,
  parseClaudeOutput,
  parseTriageOutput,
  parseSentryOutput,
  extractReviewText,
};
