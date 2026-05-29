import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const { buildPRTitle, buildPRBody, buildCommitMessage } = await import(
  "../../src/handlers/sentryIssue.js"
);

const baseSummary = {
  errorType: "TypeError",
  errorMessage: "Cannot read property 'name' of undefined",
  release: "1.2.3",
  environment: "production",
  topFrame: {
    filename: "src/Profile.tsx",
    function: "render",
    lineno: 42,
  },
};

const baseResult = {
  actionable: true,
  confidence: "high",
  summary: "Guard against undefined user before reading user.profile.name",
  files_modified: ["src/Profile.tsx", "src/types.ts"],
  root_cause: "missing null-check after navigation transition",
  tests_run: true,
  tests_passed: true,
};

const ISSUE_URL = "https://sentry.io/issues/12345/";

describe("buildPRTitle", () => {
  test("uses conventional-commit style with the Sentry issue ID and a trimmed error", () => {
    const title = buildPRTitle(baseSummary, "12345");
    assert.match(title, /^fix\(sentry-12345\):/);
    assert.match(title, /TypeError/);
  });

  test("caps the error portion at 60 chars so the prefix doesn't blow out the title", () => {
    const longErr = {
      ...baseSummary,
      errorMessage: "X".repeat(200),
    };
    const title = buildPRTitle(longErr, "1");
    // 60 char cap is on the error portion only — the prefix `fix(sentry-1): `
    // is added afterward.
    const errorPart = title.replace(/^fix\(sentry-1\): /, "");
    assert.equal(errorPart.length, 60);
  });
});

describe("buildPRBody", () => {
  test("includes Sentry link, confidence, release, environment, and root cause", () => {
    const body = buildPRBody(baseSummary, baseResult, ISSUE_URL, "12345", "a1b2c3def4567890");
    assert.match(body, /\[12345\]\(https:\/\/sentry\.io\/issues\/12345\/\)/);
    assert.match(body, /Confidence:\*\* `high`/);
    assert.match(body, /Release:\*\* `1\.2\.3`/);
    assert.match(body, /Env:\*\* `production`/);
    assert.match(body, /missing null-check/);
  });

  test("renders the error and the top stack frame in a code block", () => {
    const body = buildPRBody(baseSummary, baseResult, ISSUE_URL, "12345", "a1b2c3d");
    assert.match(body, /TypeError: Cannot read property 'name' of undefined/);
    assert.match(body, /at render \(src\/Profile\.tsx:42\)/);
  });

  test("lists modified files; falls back to '(none reported)' when empty", () => {
    const body = buildPRBody(baseSummary, baseResult, ISSUE_URL, "1", "abc1234");
    assert.match(body, /- `src\/Profile\.tsx`/);
    assert.match(body, /- `src\/types\.ts`/);

    const empty = buildPRBody(baseSummary, { ...baseResult, files_modified: [] }, ISSUE_URL, "1", "abc1234");
    assert.match(empty, /\(none reported\)/);
  });

  test("verification line reflects tests_run + tests_passed", () => {
    const passed = buildPRBody(baseSummary, baseResult, ISSUE_URL, "1", "abc1234");
    assert.match(passed, /Tests run and passed/);

    const failed = buildPRBody(baseSummary, { ...baseResult, tests_passed: false }, ISSUE_URL, "1", "abc1234");
    assert.match(failed, /Tests failed/);

    const skipped = buildPRBody(baseSummary, { ...baseResult, tests_run: false }, ISSUE_URL, "1", "abc1234");
    assert.match(skipped, /Tests not run/);
  });

  test("trailer uses a short commit SHA (first 7 chars)", () => {
    const body = buildPRBody(baseSummary, baseResult, ISSUE_URL, "1", "abc1234deadbeef");
    assert.match(body, /Commit: `abc1234`/);
    // Make sure the full SHA isn't accidentally leaked elsewhere.
    assert.doesNotMatch(body, /abc1234deadbeef/);
  });
});

describe("buildCommitMessage", () => {
  test("uses Claude's summary as the subject and references the Sentry URL in the trailer", () => {
    const msg = buildCommitMessage(baseSummary, baseResult, ISSUE_URL);
    const [subject, ...rest] = msg.split("\n\n");
    assert.equal(subject, "Guard against undefined user before reading user.profile.name");
    const trailer = rest.join("\n\n");
    assert.match(trailer, /Resolves Sentry issue: https:\/\/sentry\.io\/issues\/12345\//);
    assert.match(trailer, /Root cause: missing null-check after navigation transition/);
  });

  test("falls back to a generic subject when result.summary is empty", () => {
    const msg = buildCommitMessage(baseSummary, { ...baseResult, summary: "" }, ISSUE_URL);
    assert.match(msg, /^fix crash: TypeError/);
  });

  test("omits the Root cause line when not provided", () => {
    const msg = buildCommitMessage(baseSummary, { ...baseResult, root_cause: undefined }, ISSUE_URL);
    assert.doesNotMatch(msg, /Root cause:/);
    assert.match(msg, /Resolves Sentry issue:/);
  });
});
