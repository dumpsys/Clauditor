import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const { buildReviewPrompt } = await import("../../src/prompts/index.js");

const ctx = {
  owner: "acme",
  repoName: "widget",
  prNumber: 123,
  prTitle: "Add dark mode toggle",
  baseBranch: "main",
  headBranch: "feature/dark-mode",
};

describe("buildReviewPrompt", () => {
  test("includes the repo, PR number, base/head branches, and title", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /acme\/widget/);
    assert.match(p, /PR #123/);
    assert.match(p, /main/);
    assert.match(p, /feature\/dark-mode/);
    assert.match(p, /Add dark mode toggle/);
  });

  test("instructs the agent to run `git diff` against the base branch", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /git diff main\.\.\.HEAD/);
    assert.match(p, /git log main\.\.HEAD/);
  });

  test("covers the four review dimensions (correctness, security, quality, fit)", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /Correctness/i);
    assert.match(p, /Security/i);
    assert.match(p, /Quality/i);
    assert.match(p, /Architecture fit/i);
  });

  test("forbids fabricating issues and forced-issue reviews", () => {
    const p = buildReviewPrompt(ctx);
    assert.match(p, /Don't fabricate/i);
    assert.match(p, /forced-issue reviews/i);
  });

  test("requires raw markdown output with no preamble", () => {
    // The output is posted verbatim to GitHub. A "Here's my review:" preamble
    // would get rendered as part of the PR comment.
    const p = buildReviewPrompt(ctx);
    assert.match(p, /no preamble/);
    assert.match(p, /posted verbatim/);
  });

  test("uses generic intent wording, not Claude-Code-specific tool names", () => {
    const p = buildReviewPrompt(ctx);
    assert.doesNotMatch(p, /the Read tool/i);
    assert.doesNotMatch(p, /the Bash tool/i);
    assert.doesNotMatch(p, /using the Read/i);
  });

  test("falls back gracefully when prTitle is missing", () => {
    const p = buildReviewPrompt({ ...ctx, prTitle: undefined });
    assert.match(p, /\(no title\)/);
  });
});
