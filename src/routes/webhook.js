import { Router } from "express";
import { verifySignature } from "../middleware/verifySignature.js";
import { queue } from "../queue.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const router = Router();

const HANDLED_EVENTS = new Set(["pull_request_review_comment", "pull_request_review"]);

router.post("/webhook", verifySignature, (req, res) => {
  const event = req.headers["x-github-event"];
  const payload = req.body;

  if (!HANDLED_EVENTS.has(event)) {
    return res.status(200).json({ message: `Event '${event}' ignored` });
  }

  if (payload.action !== "created") {
    return res.status(200).json({ message: `Action '${payload.action}' ignored` });
  }

  // Ignore comments from our own bot (prevent infinite loop)
  const commenter = payload.comment?.user?.login || payload.review?.user?.login;
  if (commenter === config.botUsername) {
    logger.info(`Ignoring comment from bot user: ${commenter}`);
    return res.status(200).json({ message: "Bot comment ignored" });
  }

  // Refuse to operate on protected branches
  const branch = payload.pull_request?.head?.ref;
  if (config.protectedBranches.includes(branch)) {
    logger.warn(`Refusing to operate on protected branch: ${branch}`);
    return res.status(200).json({ message: `Protected branch '${branch}' skipped` });
  }

  queue.add({ event, payload, receivedAt: new Date().toISOString() });
  logger.info(`Job enqueued for PR #${payload.pull_request?.number}, branch: ${branch}`);

  res.status(202).json({ message: "Accepted", queued: true });
});

export default router;
