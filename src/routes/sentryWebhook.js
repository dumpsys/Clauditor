import { Router } from "express";
import { verifySentrySignature } from "../middleware/verifySentrySignature.js";
import { sentryQueue } from "../sentryQueue.js";
import { config, sentryEnabled } from "../config.js";
import { logger } from "../logger.js";

const router = Router();

/**
 * POST /sentry-webhook
 *
 * Sentry "Internal Integration" webhooks deliver:
 *   - Header:  sentry-hook-resource     ("issue" | "event_alert" | ...)
 *   - Header:  sentry-hook-signature    (hex HMAC-SHA256 of raw body)
 *   - Body:    { action, data: { issue, ... }, installation, actor }
 *
 * Workflow C only handles `resource: issue` with action `created`. Regressions
 * are delivered as `action: created` too (with issue.status: "unresolved"
 * and statusDetails.regression populated), so a single check covers both.
 *
 * Filtering layers (cheap → expensive):
 *   1. Workflow enabled?       (env config sanity)
 *   2. Resource + action       (drop event_alert, resolved, assigned, etc.)
 *   3. Project mapped to repo? (drop unmapped projects)
 *   4. Issue event count gate  (drop noise below threshold)
 *   5. In-flight dedup         (drop duplicate webhooks for same issueId)
 */
router.post("/sentry-webhook", verifySentrySignature, (req, res) => {
  if (!sentryEnabled()) {
    return res.status(200).json({ message: "Sentry workflow not configured" });
  }

  const resource = req.headers["sentry-hook-resource"];
  const payload = req.body || {};
  const action = payload.action;

  if (resource !== "issue") {
    return res
      .status(200)
      .json({ message: `Sentry resource '${resource}' ignored` });
  }
  if (action !== "created") {
    // "resolved" / "assigned" / "ignored" → not our concern. New issues
    // and regressions both arrive as "created".
    return res
      .status(200)
      .json({ message: `Sentry action '${action}' ignored` });
  }

  const issue = payload.data?.issue;
  if (!issue || !issue.id) {
    logger.warn("Sentry webhook missing data.issue.id");
    return res.status(400).json({ error: "Malformed payload" });
  }

  // project.slug is on the issue or the installation depending on Sentry
  // setup — check both.
  const projectSlug = issue.project?.slug || payload.data?.project?.slug;
  if (!projectSlug) {
    return res
      .status(200)
      .json({ message: "Sentry payload missing project slug" });
  }
  const repoTarget = config.sentry.projectRepoMap.get(projectSlug);
  if (!repoTarget) {
    logger.info(
      `Sentry project '${projectSlug}' not mapped to any repo — ignoring`,
    );
    return res
      .status(200)
      .json({ message: `Project '${projectSlug}' not mapped` });
  }

  // Event count threshold — Sentry sends a `count` (as string in some
  // payloads, number in others). Treat unparseable as 1 so we don't
  // accidentally drop legitimate first-time issues.
  const count = parseInt(issue.count, 10);
  const effectiveCount = Number.isFinite(count) ? count : 1;
  if (effectiveCount < config.sentry.minEventCount) {
    return res.status(200).json({
      message: `Issue count ${effectiveCount} below threshold ${config.sentry.minEventCount}`,
    });
  }

  const job = {
    issueId: String(issue.id),
    issueUrl:
      issue.web_url ||
      issue.permalink ||
      `https://sentry.io/issues/${issue.id}/`,
    repoTarget,
    receivedAt: new Date().toISOString(),
  };

  const disposition = sentryQueue.add(job);
  if (disposition === "in-flight") {
    return res.status(200).json({
      message: "Issue already being processed",
      issueId: job.issueId,
      dedup: "in-flight",
    });
  }

  logger.info(
    `Sentry job enqueued: issue ${job.issueId} → ${repoTarget.owner}/${repoTarget.repo} ` +
      `(active=${sentryQueue.activeCount()}, pending=${sentryQueue.pendingCount()})`,
  );
  res
    .status(202)
    .json({ message: "Accepted", queued: true, issueId: job.issueId });
});

export default router;
