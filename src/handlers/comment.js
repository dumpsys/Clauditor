import path from "path";
import fs from "fs";
import os from "os";
import { runClaudeCode } from "../services/claude.js";
import { replyToComment, replyToReview, getPullRequest } from "../services/github.js";
import { gitOperations } from "../services/git.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Build a normalized job context regardless of which webhook event triggered it.
 *
 * Differences across events:
 * - pull_request_review_comment: payload.pull_request + payload.comment (with path/diff_hunk)
 * - pull_request_review:         payload.pull_request + payload.review
 * - issue_comment:               payload.issue (no head/base/sha) + payload.comment
 *                                → must fetch the PR via the API to learn the branch
 */
async function buildContext(job) {
  const { event, payload } = job;
  const repo = payload.repository;

  let pr;
  let comment;

  if (event === "issue_comment") {
    pr = await getPullRequest(repo.owner.login, repo.name, payload.issue.number);
    comment = payload.comment;
  } else {
    pr = payload.pull_request;
    comment = payload.comment || payload.review;
  }

  return {
    event,
    owner: repo.owner.login,
    repoName: repo.name,
    repoFullName: repo.full_name,
    repoCloneUrl: repo.clone_url,
    prNumber: pr.number,
    prTitle: pr.title,
    prAuthor: pr.user?.login || "",
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    commentId: comment.id,
    commentBody: comment.body,
    commentUrl: comment.html_url,
    diffHunk: comment.diff_hunk || null,
    filePath: comment.path || null,
    commitSha: pr.head.sha,
    commenter: comment.user.login,
  };
}

/**
 * Main handler for PR review / issue comment events.
 */
export async function handleComment(job) {
  const context = await buildContext(job);

  // Only act on PRs the bot's owner actually authored. Comments on someone
  // else's PR don't get auto-fixed — the bot must not push commits to a
  // branch it doesn't own.
  if (context.prAuthor !== config.botUsername) {
    logger.info(
      `Skipping: PR #${context.prNumber} is authored by @${context.prAuthor || "unknown"}; ` +
      `bot only acts on PRs by @${config.botUsername}`
    );
    return;
  }

  // Protected-branch check: webhook layer already covers events whose payload
  // includes head.ref directly. For issue_comment we only learn the branch
  // after fetching the PR, so guard here too.
  if (config.protectedBranches.includes(context.branch)) {
    logger.warn(`Refusing to operate on protected branch: ${context.branch}`);
    return;
  }

  logger.info(
    `Handling ${context.event} on PR #${context.prNumber}: "${context.commentBody.substring(0, 80)}..."`
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `clauditor-${context.prNumber}-`));

  try {
    logger.info(`Cloning ${context.repoFullName} into ${workDir}`);
    await gitOperations.clone(context.repoCloneUrl, workDir, context.branch);

    logger.info("Running Claude Code to evaluate review feedback...");
    const result = await runClaudeCode(workDir, context);

    if (!result.actionable) {
      // Stay silent on the PR — no comment, no noise. Just log for ourselves.
      logger.info(
        `Skipping reply: Claude decided feedback is not actionable. ` +
        `Reason: ${result.reason || "(no reason given)"}`
      );
      return;
    }

    logger.info("Committing and pushing Claude's changes...");
    const commitSha = await gitOperations.commitAndPush(
      workDir,
      context.branch,
      `fix: address review feedback from @${context.commenter}\n\n${context.commentBody.substring(0, 200)}`
    );

    await postReply(context, buildSuccessReply(context, result, commitSha));
    logger.info(`Done! Changes pushed as commit ${commitSha}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function postReply(context, body) {
  // Inline review comments can be replied to inline (threaded). Everything else
  // (review summaries, issue comments) becomes a top-level PR comment.
  if (context.event === "pull_request_review_comment" && context.filePath) {
    await replyToComment(context.owner, context.repoName, context.prNumber, context.commentId, body);
  } else {
    await replyToReview(context.owner, context.repoName, context.prNumber, body);
  }
}

function buildSuccessReply(context, result, commitSha) {
  const repoUrl = `https://github.com/${context.owner}/${context.repoName}`;
  return [
    `✅ **Addressed by Claude Code** (commit [\`${commitSha.substring(0, 7)}\`](${repoUrl}/commit/${commitSha}))`,
    "",
    `> ${context.commentBody}`,
    "",
    `**What was done:** ${result.summary}`,
    "",
    `_This change was applied automatically. Please review the commit to confirm it meets your expectations._`,
  ].join("\n");
}

