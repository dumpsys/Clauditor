import path from "path";
import fs from "fs";
import os from "os";
import { runClaudeReview } from "../services/claude.js";
import { postReview } from "../services/github.js";
import { gitOperations } from "../services/git.js";
import { logger } from "../logger.js";

/**
 * Handler for `pull_request` events with action=review_requested where the
 * configured reviewer was the one requested. Runs Claude Code's `/review`
 * slash command in headless mode and posts the output as a formal PR review.
 */
export async function handleReviewRequest(job) {
  const { payload } = job;
  const pr = payload.pull_request;
  const repo = payload.repository;

  const context = {
    owner: repo.owner.login,
    repoName: repo.name,
    repoFullName: repo.full_name,
    repoCloneUrl: repo.clone_url,
    prNumber: pr.number,
    prTitle: pr.title,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    requester: payload.sender?.login || "unknown",
  };

  logger.info(
    `Reviewing PR #${context.prNumber} "${context.prTitle}" ` +
    `(${context.baseBranch} ← ${context.headBranch}), requested by @${context.requester}`
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `clauditor-review-${context.prNumber}-`));

  try {
    logger.info(`Cloning ${context.repoFullName} into ${workDir} (full clone for diff)`);
    await gitOperations.cloneForReview(
      context.repoCloneUrl,
      workDir,
      context.headBranch,
      context.baseBranch
    );

    logger.info("Running `claude -p /review` in headless mode...");
    const reviewBody = await runClaudeReview(workDir, context);

    if (!reviewBody || !reviewBody.trim()) {
      logger.warn("Claude review returned empty output — skipping post.");
      return;
    }

    logger.info(`Posting formal review to PR #${context.prNumber}`);
    await postReview(context.owner, context.repoName, context.prNumber, reviewBody);

    logger.info("Review posted successfully.");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
