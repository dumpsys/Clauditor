import crypto from "crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 * GitHub sends: "sha256=<hex_digest>"
 *
 * Used as Express middleware — rejects with 401 on failure.
 */
export function verifySignature(req, res, next) {
  const signatureHeader = req.headers["x-hub-signature-256"];

  if (!signatureHeader) {
    logger.warn("Webhook missing X-Hub-Signature-256 header");
    return res.status(401).json({ error: "Missing signature" });
  }

  const expected = "sha256=" +
    crypto.createHmac("sha256", config.webhookSecret).update(req.rawBody).digest("hex");

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);

  // timingSafeEqual throws if buffers differ in length, so check first.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn("Invalid webhook signature - rejecting request");
    return res.status(401).json({ error: "Invalid signature" });
  }

  next();
}
