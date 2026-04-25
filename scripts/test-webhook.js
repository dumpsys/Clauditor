#!/usr/bin/env node
/**
 * Test script — simulates a GitHub PR review comment webhook
 * Usage: node scripts/test-webhook.js
 *
 * Set TEST_REPO_OWNER, TEST_REPO_NAME, TEST_PR_NUMBER in .env or as env vars.
 */

import crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Load .env from the repo root
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
try {
  const envContents = readFileSync(envPath, "utf-8");
  envContents.split("\n").forEach((line) => {
    const [key, ...rest] = line.split("=");
    if (key && !key.startsWith("#") && rest.length) {
      process.env[key.trim()] = rest.join("=").trim();
    }
  });
} catch {
  console.warn(".env not found, using environment variables");
}

const PORT = process.env.PORT || 3000;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
if (!SECRET) {
  console.error("GITHUB_WEBHOOK_SECRET not set");
  process.exit(1);
}

const payload = {
  action: "created",
  pull_request: {
    number: parseInt(process.env.TEST_PR_NUMBER || "1"),
    title: "Test PR",
    head: {
      ref: process.env.TEST_BRANCH || "feature/test-branch",
      sha: "abc123def456",
    },
    base: { ref: "main" },
  },
  comment: {
    id: 12345,
    body: process.env.TEST_COMMENT || "Please rename `getData` to `fetchUserData` for clarity.",
    html_url: "https://github.com/test/repo/pull/1#discussion_r12345",
    path: process.env.TEST_FILE || "src/api.js",
    diff_hunk: "@@ -10,6 +10,6 @@\n-function getData() {\n+function fetchUserData() {",
    user: { login: "test-reviewer" },
  },
  repository: {
    full_name: `${process.env.TEST_REPO_OWNER || "your-org"}/${process.env.TEST_REPO_NAME || "your-repo"}`,
    name: process.env.TEST_REPO_NAME || "your-repo",
    clone_url: `https://github.com/${process.env.TEST_REPO_OWNER || "your-org"}/${process.env.TEST_REPO_NAME || "your-repo"}.git`,
    owner: { login: process.env.TEST_REPO_OWNER || "your-org" },
  },
};

const body = JSON.stringify(payload);
const signature = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");

console.log(`Sending test webhook to http://localhost:${PORT}/webhook`);
console.log(`Comment: "${payload.comment.body}"`);
console.log(`File: ${payload.comment.path}`);
console.log("");

const res = await fetch(`http://localhost:${PORT}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-GitHub-Event": "pull_request_review_comment",
    "X-Hub-Signature-256": signature,
    "X-GitHub-Delivery": crypto.randomUUID(),
  },
  body,
});

const result = await res.json();
console.log(`Response ${res.status}:`, result);
