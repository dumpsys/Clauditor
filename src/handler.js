import path from "path";
import fs from "fs";
import os from "os";
import { runClaudeCode } from "./services/claude.js";
import { replyToComment, replyToReview } from "./services/github.js";
import { gitOperations } from "./services/git.js";
import { logger } from "./logger.js";

/**
 * Main handler for PR review comment events.
 */
export async function handlePullRequestReviewComment(payload) {
  const pr = payload.pull_request;
  const comment = payload.comment || payload.review;
  const repo = payload.repository;

  const context = {
    owner: repo.owner.login,
    repoName: repo.name,
    repoFullName: repo.full_name,
    repoCloneUrl: repo.clone_url,
    prNumber: pr.number,
    prTitle: pr.title,
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

  logger.info(`Handling review comment on PR #${context.prNumber}: "${context.commentBody.substring(0, 80)}..."`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `pr-bot-${context.prNumber}-`));

  try {
    logger.info(`Cloning ${context.repoFullName} into ${workDir}`);
    await gitOperations.clone(context.repoCloneUrl, workDir, context.branch);

    logger.info("Running Claude Code to evaluate review feedback...");
    const result = await runClaudeCode(workDir, context);

    if (!result.actionable) {
      logger.info(`Claude decided feedback is not actionable: ${result.reason}`);
      await postReply(context, buildNotActionableReply(context, result));
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
  if (context.filePath) {
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

function buildNotActionableReply(context, result) {
  return [
    `🤖 **Claude Code reviewed this feedback** but determined it may not require a code change:`,
    "",
    `> ${context.commentBody}`,
    "",
    `**Reason:** ${result.reason}`,
    "",
    `_If you believe a change is needed, please clarify the feedback or make the edit directly._`,
  ].join("\n");
}
