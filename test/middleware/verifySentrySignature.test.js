import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";
// Set the Sentry secret BEFORE the config module is imported so the
// captured value is non-empty. Individual tests mutate config.sentry to
// cover the "secret not configured" branch.
process.env.SENTRY_CLIENT_SECRET = "sentry-secret";

const { config } = await import("../../src/config.js");
const { verifySentrySignature } = await import("../../src/middleware/verifySentrySignature.js");

function mockRes() {
  const captured = { status: null, body: null };
  return {
    captured,
    status(code) { captured.status = code; return this; },
    json(b) { captured.body = b; return this; },
  };
}

function signed(rawBody, secret = "sentry-secret") {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

describe("verifySentrySignature", () => {
  let originalSecret;
  beforeEach(() => { originalSecret = config.sentry.clientSecret; });
  afterEach(() => { config.sentry.clientSecret = originalSecret; });

  test("calls next() with no secret configured (workflow dormant)", () => {
    config.sentry.clientSecret = "";
    const req = { headers: {}, rawBody: Buffer.from("anything") };
    const res = mockRes();
    let nextCalled = false;
    verifySentrySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.captured.status, null);
  });

  test("calls next() on a valid signature", () => {
    const rawBody = Buffer.from(JSON.stringify({ data: { issue: { id: "1" } } }));
    const req = { headers: { "sentry-hook-signature": signed(rawBody) }, rawBody };
    const res = mockRes();
    let nextCalled = false;
    verifySentrySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.captured.status, null);
  });

  test("rejects 401 when the signature header is missing", () => {
    const req = { headers: {}, rawBody: Buffer.from("x") };
    const res = mockRes();
    let nextCalled = false;
    verifySentrySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.captured.status, 401);
    assert.match(res.captured.body.error, /Missing signature/);
  });

  test("rejects 401 on a tampered body", () => {
    const original = Buffer.from(JSON.stringify({ value: 1 }));
    const sig = signed(original);
    const tampered = Buffer.from(JSON.stringify({ value: 2 }));
    const req = { headers: { "sentry-hook-signature": sig }, rawBody: tampered };
    const res = mockRes();
    let nextCalled = false;
    verifySentrySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.captured.status, 401);
  });

  test("rejects 401 on a signature from the wrong secret", () => {
    const rawBody = Buffer.from("payload");
    const req = {
      headers: { "sentry-hook-signature": signed(rawBody, "different-secret") },
      rawBody,
    };
    const res = mockRes();
    verifySentrySignature(req, res, () => {});
    assert.equal(res.captured.status, 401);
  });

  test("does NOT accept GitHub's 'sha256=<hex>' prefix (Sentry uses bare hex)", () => {
    // Common confusion: Sentry sends the hex digest with no prefix.
    // Posting a GitHub-style "sha256=<hex>" header should fail.
    const rawBody = Buffer.from("payload");
    const wrong = `sha256=${signed(rawBody)}`;
    const req = { headers: { "sentry-hook-signature": wrong }, rawBody };
    const res = mockRes();
    verifySentrySignature(req, res, () => {});
    assert.equal(res.captured.status, 401);
  });

  test("rejects 401 on a length-mismatched signature without throwing", () => {
    const rawBody = Buffer.from("payload");
    const req = { headers: { "sentry-hook-signature": "abc" }, rawBody };
    const res = mockRes();
    assert.doesNotThrow(() => verifySentrySignature(req, res, () => {}));
    assert.equal(res.captured.status, 401);
  });
});
