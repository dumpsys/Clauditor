import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN = "ghp_test_token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const {
  getPullRequest,
  branchExists,
  findOpenPRByHead,
  createPullRequest,
  postIssueComment,
  replyToComment,
  postReview,
  replyToReview,
} = await import("../../src/services/github.js");

/** Replace global.fetch with a controllable stub for each test. */
let originalFetch;
let calls;
let respondWith;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  respondWith = { status: 200, body: {} };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const r = respondWith;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.statusText || "OK",
      json: async () => r.body,
      text: async () => typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    };
  };
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe("github API client — request shape", () => {
  test("includes Bearer auth header and API version on every call", async () => {
    respondWith = { status: 200, body: { number: 1 } };
    await getPullRequest("o", "r", 1);
    assert.equal(calls.length, 1);
    const h = calls[0].options.headers;
    assert.equal(h.Authorization, "Bearer ghp_test_token");
    assert.equal(h.Accept, "application/vnd.github+json");
    assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
  });

  test("throws a descriptive error on non-2xx responses", async () => {
    respondWith = { status: 422, statusText: "Unprocessable", body: "validation failed" };
    await assert.rejects(
      () => getPullRequest("o", "r", 99),
      /GitHub API error 422 Unprocessable: validation failed/,
    );
  });
});

describe("getPullRequest", () => {
  test("hits the /pulls/{n} endpoint", async () => {
    respondWith = { status: 200, body: { number: 42, title: "x" } };
    const pr = await getPullRequest("owner", "repo", 42);
    assert.equal(calls[0].url, "https://api.github.com/repos/owner/repo/pulls/42");
    assert.equal(pr.number, 42);
  });
});

describe("branchExists", () => {
  test("returns true on 200", async () => {
    respondWith = { status: 200, body: { name: "feature" } };
    assert.equal(await branchExists("o", "r", "feature"), true);
  });

  test("returns false on 404 (the documented contract)", async () => {
    respondWith = { status: 404, body: "Not Found" };
    assert.equal(await branchExists("o", "r", "nope"), false);
  });

  test("throws on other non-2xx (so callers can distinguish 'missing' from 'broken')", async () => {
    respondWith = { status: 500, statusText: "Server Error", body: "boom" };
    await assert.rejects(
      () => branchExists("o", "r", "x"),
      /GitHub branch check failed 500/,
    );
  });

  test("URL-encodes branch names that contain special characters", async () => {
    respondWith = { status: 200, body: {} };
    await branchExists("o", "r", "feature/foo bar");
    assert.match(calls[0].url, /branches\/feature%2Ffoo%20bar$/);
  });
});

describe("findOpenPRByHead", () => {
  test("returns the first PR when list is non-empty", async () => {
    respondWith = { status: 200, body: [{ number: 7 }, { number: 8 }] };
    const pr = await findOpenPRByHead("o", "r", "branch");
    assert.equal(pr.number, 7);
    assert.match(calls[0].url, /state=open&head=o:branch/);
  });

  test("returns null when no open PR matches", async () => {
    respondWith = { status: 200, body: [] };
    assert.equal(await findOpenPRByHead("o", "r", "branch"), null);
  });

  test("returns null on a non-array response shape (defensive)", async () => {
    respondWith = { status: 200, body: {} };
    assert.equal(await findOpenPRByHead("o", "r", "b"), null);
  });
});

describe("createPullRequest", () => {
  test("POSTs the right body with draft=true by default", async () => {
    respondWith = { status: 201, body: { number: 99, html_url: "https://example/99" } };
    const pr = await createPullRequest("o", "r", {
      title: "fix: x", head: "feature", base: "main", body: "details",
    });
    assert.equal(pr.number, 99);
    assert.equal(calls[0].options.method, "POST");
    const sent = JSON.parse(calls[0].options.body);
    assert.deepEqual(sent, {
      title: "fix: x", head: "feature", base: "main", body: "details", draft: true,
    });
  });

  test("can open a non-draft PR when draft: false is passed", async () => {
    respondWith = { status: 201, body: { number: 100 } };
    await createPullRequest("o", "r", {
      title: "ship it", head: "f", base: "main", body: "", draft: false,
    });
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(sent.draft, false);
  });
});

describe("postIssueComment / replyToComment / postReview / replyToReview", () => {
  test("postIssueComment hits /issues/{n}/comments with the body", async () => {
    respondWith = { status: 201, body: { id: 1 } };
    await postIssueComment("o", "r", 5, "hello");
    assert.equal(calls[0].url, "https://api.github.com/repos/o/r/issues/5/comments");
    assert.deepEqual(JSON.parse(calls[0].options.body), { body: "hello" });
  });

  test("replyToComment hits /pulls/{n}/comments/{id}/replies", async () => {
    respondWith = { status: 201, body: { id: 1 } };
    await replyToComment("o", "r", 5, 42, "reply text");
    assert.equal(
      calls[0].url,
      "https://api.github.com/repos/o/r/pulls/5/comments/42/replies",
    );
    assert.deepEqual(JSON.parse(calls[0].options.body), { body: "reply text" });
  });

  test("postReview defaults to event: COMMENT", async () => {
    respondWith = { status: 201, body: { id: 1 } };
    await postReview("o", "r", 5, "review body");
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(sent.event, "COMMENT");
    assert.equal(sent.body, "review body");
  });

  test("postReview accepts a custom event (APPROVE / REQUEST_CHANGES)", async () => {
    respondWith = { status: 201, body: { id: 1 } };
    await postReview("o", "r", 5, "lgtm", "APPROVE");
    assert.equal(JSON.parse(calls[0].options.body).event, "APPROVE");
  });

  test("replyToReview hits the same /issues/{n}/comments endpoint", async () => {
    respondWith = { status: 201, body: { id: 1 } };
    await replyToReview("o", "r", 5, "thanks!");
    assert.equal(calls[0].url, "https://api.github.com/repos/o/r/issues/5/comments");
  });
});
