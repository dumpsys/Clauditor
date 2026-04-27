import { Router } from "express";
import { verifySignature } from "../middleware/verifySignature.js";
import { queue } from "../queue.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const router = Router();

const HANDLED_EVENTS = new Set([
  "pull_request_review_comment", // inline review comment on a specific line
  "pull_request_review",         // review summary (Approve / Request changes / Comment)
  "issue_comment",               // plain comment on the PR conversation tab
  "pull_request",                // only the `review_requested` action is processed below
]);

// Each GitHub event uses a different action name for "this just happened":
//   pull_request_review_comment → created
//   issue_comment               → created
//   pull_request_review         → submitted   (NOT "created")
// Other actions (edited / deleted / dismissed) are intentionally skipped.
const ACTION_FOR_EVENT = {
  pull_request_review_comment: "created",
  pull_request_review: "submitted",
  issue_comment: "created",
};

router.post("/webhook", verifySignature, (req, res) => {
  const event = req.headers["x-github-event"];
  const payload = req.body;

  if (!HANDLED_EVENTS.has(event)) {
    return res.status(200).json({ message: `Event '${event}' ignored` });
  }

  // ── pull_request: only review_requested + only when our configured user ────
  if (event === "pull_request") {
    if (payload.action !== "review_requested") {
      return res.status(200).json({ message: `pull_request action '${payload.action}' ignored` });
    }
    if (!config.reviewRequestUser) {
      return res.status(200).json({ message: "GITHUB_REVIEW_REQUEST_USER not configured" });
    }
    // GitHub fires this same event for personal AND team review requests.
    // We only react to direct personal requests for the configured user.
    const requestedUser = payload.requested_reviewer?.login;
    if (requestedUser !== config.reviewRequestUser) {
      return res.status(200).json({
        message: `Review requested for '${requestedUser ?? "team"}', not '${config.reviewRequestUser}'`,
      });
    }
    const branch = payload.pull_request?.head?.ref;
    if (config.protectedBranches.includes(branch)) {
      // Reviewing a protected branch is fine, but we'll keep the existing
      // policy: skip anything that touches protected branches.
      logger.warn(`Refusing to operate on protected branch: ${branch}`);
      return res.status(200).json({ message: `Protected branch '${branch}' skipped` });
    }
    queue.add({ event, payload, receivedAt: new Date().toISOString() });
    logger.info(`Review-request job enqueued for PR #${payload.pull_request?.number}`);
    return res.status(202).json({ message: "Accepted", queued: true });
  }

  // ── comment-style events ───────────────────────────────────────────────────
  const expectedAction = ACTION_FOR_EVENT[event];
  if (payload.action !== expectedAction) {
    return res.status(200).json({
      message: `Action '${payload.action}' ignored for event '${event}' (expected '${expectedAction}')`,
    });
  }

  // issue_comment fires for both Issues and PRs; only PR-attached comments
  // have `issue.pull_request` set.
  if (event === "issue_comment" && !payload.issue?.pull_request) {
    return res.status(200).json({ message: "Issue comment (not on a PR) ignored" });
  }

  // Ignore comments from our own bot (prevent infinite loop).
  const commenter = payload.comment?.user?.login || payload.review?.user?.login;
  if (commenter === config.botUsername) {
    logger.info(`Ignoring comment from bot user: ${commenter}`);
    return res.status(200).json({ message: "Bot comment ignored" });
  }

  // For pull_request_review* events, the head ref is in the payload — reject
  // protected-branch jobs early. For issue_comment the head ref isn't in the
  // payload; that check is deferred to the handler after fetching the PR.
  const branch = payload.pull_request?.head?.ref;
  if (branch && config.protectedBranches.includes(branch)) {
    logger.warn(`Refusing to operate on protected branch: ${branch}`);
    return res.status(200).json({ message: `Protected branch '${branch}' skipped` });
  }

  queue.add({ event, payload, receivedAt: new Date().toISOString() });
  const prNumber = payload.pull_request?.number ?? payload.issue?.number;
  logger.info(`Job enqueued for PR #${prNumber}, event: ${event}`);

  res.status(202).json({ message: "Accepted", queued: true });
});

export default router;
