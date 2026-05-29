import express from "express";
import webhookRouter from "./routes/webhook.js";
import sentryWebhookRouter from "./routes/sentryWebhook.js";
import healthRouter from "./routes/health.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

export function createApp() {
  const app = express();

  // Raw body needed for HMAC signature verification (both GitHub and Sentry).
  // `limit` overrides Express's 100 KB default — real Sentry/GitHub webhook
  // payloads (stack traces, breadcrumbs, large PR reviews) routinely exceed
  // 100 KB and would otherwise 413 before reaching our HMAC middleware.
  app.use(express.json({
    limit: config.webhookBodyLimit,
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  app.use(healthRouter);
  app.use(webhookRouter);
  app.use(sentryWebhookRouter);

  // Centralized error handler
  app.use((err, _req, res, _next) => {
    logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
