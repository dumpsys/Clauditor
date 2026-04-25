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
]);

router.post("/webhook", verifySignature, (req, res) => {
  const event = req.headers["x-github-event"];
  const payload = req.body;

  if (!HANDLED_EVENTS.has(event)) {
    return res.status(200).json({ message: `Event '${event}' ignored` });
  }

  if (payload.action !== "created") {
    return res.status(200).json({ message: `Action '${payload.action}' ignored` });
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
