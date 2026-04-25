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

  const output = await spawnClaude(args, prompt, workDir);
  return parseClaudeOutput(output);
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

function spawnClaude(args, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errorChunks = [];

    const proc = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (chunk) => {
      errorChunks.push(chunk);
      logger.debug(`claude stderr: ${chunk.toString()}`);
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude Code timed out after ${config.claudeTimeoutMs}ms`));
    }, config.claudeTimeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errorChunks).toString("utf-8");

      if (code !== 0) {
        logger.error(`Claude Code exited with code ${code}\nstderr: ${stderr}`);
        reject(new Error(`Claude Code failed with exit code ${code}`));
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
