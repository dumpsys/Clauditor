import express from "express";
import webhookRouter from "./routes/webhook.js";
import sentryWebhookRouter from "./routes/sentryWebhook.js";
import healthRouter from "./routes/health.js";
import { logger } from "./logger.js";

export function createApp() {
  const app = express();

  // Raw body needed for HMAC signature verification (both GitHub and Sentry).
  app.use(express.json({
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
