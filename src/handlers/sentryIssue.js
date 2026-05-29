import path from "path";
import fs from "fs";
import os from "os";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { runClaudeSentryFix } from "../services/claude.js";
import { gitOperations } from "../services/git.js";
import {
  branchExists,
  findOpenPRByHead,
  createPullRequest,
  postIssueComment as postGithubIssueComment,
} from "../services/github.js";
import {
  getIssue,
  getLatestEvent,
  postIssueComment as postSentryComment,
  hasResolvedSourceMaps,
  summarizeEvent,
} from "../services/sentry.js";

/**
 * Main handler for Sentry issue events. Idempotent on the issue ID:
 * - If a fix branch already exists, push a new commit to it.
 * - If a PR already exists for that branch, don't open another.
 * - Always post a comment back on the Sentry issue (success, no-fix, or skip).
 */
export async function handleSentryIssue(job) {
  const { issueId, repoTarget, issueUrl } = job;
  const { owner, repo } = repoTarget;

  // Fetch fresh data — the webhook payload may be stale or thin.
  const [issue, event] = await Promise.all([
    getIssue(issueId),
    getLatestEvent(issueId),
  ]);

  // Source-map gate. Without resolved source positions, Claude is shooting
  // in the dark.
  if (!hasResolvedSourceMaps(event)) {
    const reason =
      "Top in-app frame has no resolved source context — upload source maps for this release to enable auto-fixes.";
    logger.info(`Sentry ${issueId}: skipping. ${reason}`);
    await safeSentryComment(issueId, `⏭ **Clauditor skipped this issue.**\n\n${reason}`);
    return;
  }

  const eventSummary = summarizeEvent(event, issue);
  const branchName = `${config.sentry.branchPrefix}${issueId}`;
  const repoCloneUrl = `https://github.com/${owner}/${repo}.git`;

  // Branch state determines clone strategy + PR creation behavior.
  const existing = await branchExists(owner, repo, branchName);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `sentry-${issueId}-`));

  try {
    if (existing) {
      logger.info(`Sentry ${issueId}: branch '${branchName}' exists — cloning it for incremental fix`);
      gitOperations.clone(repoCloneUrl, workDir, branchName);
    } else {
      logger.info(`Sentry ${issueId}: creating new branch '${branchName}' off '${config.sentry.baseBranch}'`);
      gitOperations.cloneAndCreateBranch(repoCloneUrl, workDir, config.sentry.baseBranch, branchName);
    }

    const claudeContext = {
      owner,
      repoName: repo,
      branch: branchName,
      baseBranch: config.sentry.baseBranch,
      sentry: {
        issueId,
        issueUrl,
        eventCount: issue.count || 0,
        userCount: issue.userCount || 0,
        event: eventSummary,
      },
    };

    const result = await runClaudeSentryFix(workDir, claudeContext);

    if (!result.actionable) {
      const reason = result.reason || "(no reason given)";
      logger.info(`Sentry ${issueId}: not actionable — ${reason}`);
      await safeSentryComment(
        issueId,
        `⚠️ **Clauditor investigated this issue but did not propose a fix.**\n\n**Reason:** ${reason}\n\n_Root cause analysis: ${result.root_cause || "n/a"}_`,
      );
      return;
    }

    // Apply changes → commit → push.
    const commitSha = gitOperations.commitAndPush(
      workDir,
      branchName,
      buildCommitMessage(eventSummary, result, issueUrl),
    );

    // PR step: existing PR keeps its draft state; new PR is draft unless high confidence.
    const existingPR = existing ? await findOpenPRByHead(owner, repo, branchName) : null;
    let pr = existingPR;
    if (!pr) {
      pr = await createPullRequest(owner, repo, {
        title: buildPRTitle(eventSummary, issueId),
        head: branchName,
        base: config.sentry.baseBranch,
        body: buildPRBody(eventSummary, result, issueUrl, issueId, commitSha),
        draft: result.confidence !== "high",
      });
      // Drop the Sentry link as a PR comment too — surfaces it in PR notifications.
      await postGithubIssueComment(
        owner,
        repo,
        pr.number,
        `🛰 Auto-generated from Sentry issue [${issueId}](${issueUrl}).\n\n**Confidence:** ${result.confidence}\n**Root cause:** ${result.root_cause || "n/a"}`,
      ).catch((err) => logger.warn(`Could not post PR comment: ${err.message}`));
    } else {
      logger.info(`Sentry ${issueId}: PR #${pr.number} already open — added commit ${commitSha.slice(0, 7)}`);
    }

    await safeSentryComment(
      issueId,
      [
        `✅ **Clauditor opened an auto-fix PR.**`,
        ``,
        `**PR:** ${pr.html_url}`,
        `**Commit:** \`${commitSha.slice(0, 7)}\``,
        `**Confidence:** ${result.confidence}`,
        `**Summary:** ${result.summary}`,
        ``,
        `_Please review before merging. This change was generated automatically from the stack trace and source context Sentry provided._`,
      ].join("\n"),
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function buildPRTitle(eventSummary, issueId) {
  const error = `${eventSummary.errorType}: ${eventSummary.errorMessage}`.slice(0, 60);
  return `fix(sentry-${issueId}): ${error}`;
}

function buildPRBody(eventSummary, result, issueUrl, issueId, commitSha) {
  const frame = eventSummary.topFrame;
  return [
    `## Auto-generated from Sentry`,
    ``,
    `**Sentry issue:** [${issueId}](${issueUrl})`,
    `**Confidence:** \`${result.confidence}\``,
    `**Release:** \`${eventSummary.release || "(unknown)"}\` · **Env:** \`${eventSummary.environment || "(unknown)"}\``,
    ``,
    `### Error`,
    "```",
    `${eventSummary.errorType}: ${eventSummary.errorMessage}`,
    frame ? `  at ${frame.function || "<anon>"} (${frame.filename}:${frame.lineno})` : "",
    "```",
    ``,
    `### Root cause`,
    result.root_cause || "_(not provided)_",
    ``,
    `### What changed`,
    result.summary || "_(not provided)_",
    ``,
    `### Files modified`,
    (result.files_modified || []).map((f) => `- \`${f}\``).join("\n") || "_(none reported)_",
    ``,
    `### Verification`,
    result.tests_run
      ? result.tests_passed
        ? "✅ Tests run and passed."
        : "❌ Tests failed — see commit/log."
      : "⏭ Tests not run (no runner detected or requires native build).",
    ``,
    `---`,
    `_🤖 This PR was generated automatically by Clauditor from a Sentry crash report. Commit: \`${commitSha.slice(0, 7)}\`. Please review carefully before merging._`,
  ].join("\n");
}

function buildCommitMessage(eventSummary, result, issueUrl) {
  const summary = (result.summary || `fix crash: ${eventSummary.errorType}`).trim();
  const trailer = [
    `Resolves Sentry issue: ${issueUrl}`,
    result.root_cause ? `Root cause: ${result.root_cause}` : null,
  ].filter(Boolean).join("\n");
  return `${summary}\n\n${trailer}`;
}

async function safeSentryComment(issueId, text) {
  try {
    await postSentryComment(issueId, text);
  } catch (err) {
    // Sentry commenting is best-effort. Don't blow up the whole job if the
    // Sentry auth token is missing a permission — the PR is still useful.
    logger.warn(`Could not post Sentry comment on issue ${issueId}: ${err.message}`);
  }
}

// Exposed for unit testing — pure string-building helpers with no I/O.
export { buildPRTitle, buildPRBody, buildCommitMessage };
