import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  buildCommentPrompt,
  buildTriagePrompt,
  buildReviewPrompt,
  buildSentryPrompt,
} from "../prompts/index.js";
import {
  commentDecisionSchema,
  triageDecisionSchema,
  sentryDecisionSchema,
} from "./schemas.js";

export const displayName = "Codex";

const STRUCTURED_OUTPUT_SUFFIX = `

The CLI enforces the final response with a JSON Schema. Return only the JSON
object that matches that schema, without Markdown fences or surrounding text.`;

export async function runCommentFix(workDir, context) {
  return runDecision({
    workDir,
    prompt: buildCommentPrompt(context),
    schema: commentDecisionSchema,
    sandbox: "workspace-write",
    timeoutMs: config.harnessTimeoutMs,
  });
}

export async function runTriage(context) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "clauditor-codex-triage-"));
  try {
    return await runDecision({
      workDir,
      prompt: buildTriagePrompt(context),
      schema: triageDecisionSchema,
      sandbox: "read-only",
      timeoutMs: 60_000,
      skipGitRepoCheck: true,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export async function runReview(workDir, context) {
  const args = buildCodexArgs({ sandbox: "read-only" });
  logger.info(
    `Running: codex exec (portable review prompt) on PR #${context.prNumber}, ` +
    `${context.baseBranch}...${context.headBranch}, ` +
    `timeout ${Math.round(config.harnessReviewTimeoutMs / 1000)}s`,
  );
  const output = await spawnCodex(args, buildReviewPrompt(context), workDir, config.harnessReviewTimeoutMs);
  return output.trim();
}

export async function runSentryFix(workDir, context) {
  logger.info(`Running: codex exec (Sentry fix prompt) on issue ${context.sentry.issueId}`);
  return runDecision({
    workDir,
    prompt: buildSentryPrompt(context),
    schema: sentryDecisionSchema,
    sandbox: "workspace-write",
    timeoutMs: config.sentry.harnessTimeoutMs,
  });
}

async function runDecision({
  workDir,
  prompt,
  schema,
  sandbox,
  timeoutMs,
  skipGitRepoCheck = false,
}) {
  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "clauditor-codex-schema-"));
  const schemaPath = path.join(schemaDir, "decision.schema.json");
  try {
    await fs.writeFile(schemaPath, JSON.stringify(schema));
    const args = buildCodexArgs({ sandbox, schemaPath, skipGitRepoCheck });
    const output = await spawnCodex(
      args,
      `${prompt}${STRUCTURED_OUTPUT_SUFFIX}`,
      workDir,
      timeoutMs,
    );
    return parseCodexDecision(output);
  } finally {
    await fs.rm(schemaDir, { recursive: true, force: true });
  }
}

function buildCodexArgs({ sandbox, schemaPath, skipGitRepoCheck = false }) {
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color", "never",
    "--sandbox", sandbox,
    // Keep credentials used by the Clauditor process out of model-generated
    // shell commands while retaining core variables such as PATH and HOME.
    "-c", 'shell_environment_policy.inherit="core"',
    "-c", "shell_environment_policy.ignore_default_excludes=false",
  ];
  if (config.codexModel) args.push("--model", config.codexModel);
  if (skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (schemaPath) args.push("--output-schema", schemaPath);
  args.push("-");
  return args;
}

function spawnCodex(args, prompt, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const proc = spawn("codex", args, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.end(prompt);
    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      logger.debug(`codex stderr: ${chunk.toString()}`);
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code !== 0) {
        const detail = truncate(stderr || stdout);
        logger.error(`Codex exited with code ${code}: ${detail || "(no output)"}`);
        reject(new Error(`Codex failed with exit code ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(stdout);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

function parseCodexDecision(rawOutput) {
  try {
    const parsed = JSON.parse(rawOutput.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (err) {
    logger.error(`Codex output was not valid schema-constrained JSON: ${truncate(rawOutput)}`);
    throw new Error(`Codex returned invalid structured output: ${err.message}`);
  }
}

function truncate(value, limit = 4000) {
  const text = String(value);
  return text.length > limit
    ? `${text.slice(0, limit)}\n…(${text.length - limit} more chars truncated)`
    : text;
}

export { buildCodexArgs, parseCodexDecision };
