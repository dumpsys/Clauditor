import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const { verifySignature } = await import("../../src/middleware/verifySignature.js");

/** Build a minimal res mock that records status + json body. */
function mockRes() {
  const captured = { status: null, body: null };
  return {
    captured,
    status(code) { captured.status = code; return this; },
    json(b) { captured.body = b; return this; },
  };
}

function signed(rawBody, secret = "test-secret") {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

describe("verifySignature (GitHub HMAC)", () => {
  test("calls next() on a valid signature", () => {
    const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
    const req = { headers: { "x-hub-signature-256": signed(rawBody) }, rawBody };
    const res = mockRes();
    let nextCalled = false;
    verifySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.captured.status, null);
  });

  test("rejects 401 on a missing signature header", () => {
    const req = { headers: {}, rawBody: Buffer.from("x") };
    const res = mockRes();
    let nextCalled = false;
    verifySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.captured.status, 401);
    assert.match(res.captured.body.error, /Missing signature/);
  });

  test("rejects 401 on a tampered body (signature no longer matches)", () => {
    const originalBody = Buffer.from(JSON.stringify({ value: 1 }));
    const sig = signed(originalBody);
    // Attacker replays the same signature with a different body.
    const tamperedBody = Buffer.from(JSON.stringify({ value: 2 }));
    const req = { headers: { "x-hub-signature-256": sig }, rawBody: tamperedBody };
    const res = mockRes();
    let nextCalled = false;
    verifySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.captured.status, 401);
    assert.match(res.captured.body.error, /Invalid signature/);
  });

  test("rejects 401 on a signature signed with the wrong secret", () => {
    const rawBody = Buffer.from("payload");
    const req = {
      headers: { "x-hub-signature-256": signed(rawBody, "wrong-secret") },
      rawBody,
    };
    const res = mockRes();
    let nextCalled = false;
    verifySignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.captured.status, 401);
  });

  test("rejects 401 on a length-mismatched signature (timingSafeEqual guard)", () => {
    // A header shorter than the expected digest must not throw inside
    // timingSafeEqual — middleware should catch the length mismatch first.
    const rawBody = Buffer.from("payload");
    const req = { headers: { "x-hub-signature-256": "sha256=short" }, rawBody };
    const res = mockRes();
    assert.doesNotThrow(() => verifySignature(req, res, () => {}));
    assert.equal(res.captured.status, 401);
  });
});
