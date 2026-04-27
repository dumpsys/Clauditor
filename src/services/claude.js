import { spawn } from "child_process";
import { config } from "../config.js";
import { logger } from "../logger.js";

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
    "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep",
    "--max-turns", "10",
  ];

  const output = await spawnClaude(args, prompt, workDir, config.claudeTimeoutMs);
  return parseClaudeOutput(output);
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
  // the CLI parses it as a command rather than free-form text.
  const args = [
    "-p", "/review",
    "--output-format", "json",
    "--allowedTools", "Read,Glob,Grep,Bash",
    "--max-turns", "50",
  ];

  logger.info(
    `Running: claude -p /review (PR #${context.prNumber}, ${context.baseBranch}...${context.headBranch}, ` +
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

function buildPrompt(context) {
  const fileContext = context.filePath
    ? `**File being reviewed:** \`${context.filePath}\``
    : "**General PR review comment (not tied to a specific file)**";

  const diffContext = context.diffHunk
    ? `**Code context (diff hunk):**\n\`\`\`diff\n${context.diffHunk}\n\`\`\``
    : "";

  return `
You are an automated code review assistant. A developer has left a review comment on a pull request.
Your job is to:
1. Carefully evaluate if the feedback is valid, specific, and actionable
2. If actionable: apply the necessary code changes to address the feedback
3. Output a structured JSON decision (see format below)

**PR Title:** ${context.prTitle}
**Branch:** ${context.branch}
**Reviewer:** @${context.commenter}
${fileContext}

**Review Feedback:**
${context.commentBody}

${diffContext}

**Instructions:**
- Read the relevant file(s) using the Read tool
- Evaluate the feedback critically: Is it a genuine improvement? Is it clear enough to act on?
- If YES: make the minimal, targeted code change to address the feedback. Do NOT refactor unrelated code.
- If the feedback is vague, subjective, already implemented, or wrong: do NOT change anything.
- After your work, output ONLY a JSON object as the last thing you write, in this exact format:

\`\`\`json
{
  "actionable": true,
  "summary": "Brief description of what was changed and why",
  "files_modified": ["path/to/file.js"],
  "reason": ""
}
\`\`\`

OR if not actionable:

\`\`\`json
{
  "actionable": false,
  "summary": "",
  "files_modified": [],
  "reason": "Clear explanation of why no change was made"
}
\`\`\`

Remember: Only output the JSON block at the very end. Do your thinking and file operations first.
`.trim();
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
