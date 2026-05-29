import crypto from "crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Verify a Sentry webhook signature.
 *
 * Sentry sends the hex HMAC-SHA256 digest of the raw request body using the
 * integration's client secret. The header has changed names across Sentry
 * docs/versions:
 *   - `sentry-hook-signature`   (current, used by Internal Integrations)
 *   - `Sentry-Hook-Signature`   (case variants)
 * Express lowercases headers, so we read `sentry-hook-signature`.
 *
 * Sentry-Hook-Signature is the hex digest only (no "sha256=" prefix), unlike
 * GitHub's `sha256=<hex>`. Compare with timing-safe equality.
 */
export function verifySentrySignature(req, res, next) {
  if (!config.sentry.clientSecret) {
    // Workflow not configured — the route handler will return a friendly 200.
    // Don't try to verify a signature we have no secret for.
    return next();
  }

  const signature = req.headers["sentry-hook-signature"];

  if (!signature) {
    logger.warn("Sentry webhook missing sentry-hook-signature header");
    return res.status(401).json({ error: "Missing signature" });
  }

  const expected = crypto
    .createHmac("sha256", config.sentry.clientSecret)
    .update(req.rawBody)
    .digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn("Invalid Sentry webhook signature - rejecting request");
    return res.status(401).json({ error: "Invalid signature" });
  }

  next();
}
