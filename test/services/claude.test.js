import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const {
  buildPrompt,
  buildTriagePrompt,
  buildSentryPrompt,
  parseClaudeOutput,
  parseTriageOutput,
  parseSentryOutput,
  extractReviewText,
} = await import("../../src/services/claude.js");

/** Wrap a model "result" payload the way --output-format json does. */
function outerJson(resultText) {
  return JSON.stringify({ type: "result", result: resultText });
}

describe("parseClaudeOutput (comment-handler decision)", () => {
  test("extracts a fenced JSON block from the inner result text", () => {
    const inner = "thinking out loud...\n```json\n{ \"actionable\": true, \"summary\": \"x\" }\n```";
    const parsed = parseClaudeOutput(outerJson(inner));
    assert.equal(parsed.actionable, true);
    assert.equal(parsed.summary, "x");
  });

  test("falls back to a bare JSON object when no fence is present", () => {
    const inner = "no fence here { \"actionable\": false, \"reason\": \"nope\" }";
    const parsed = parseClaudeOutput(outerJson(inner));
    assert.equal(parsed.actionable, false);
    assert.equal(parsed.reason, "nope");
  });

  test("handles raw output that isn't wrapped in the outer result envelope", () => {
    const raw = "```json\n{ \"actionable\": true }\n```";
    assert.equal(parseClaudeOutput(raw).actionable, true);
  });

  test("throws when the fenced block contains invalid JSON", () => {
    const inner = "```json\n{ not real json\n```";
    assert.throws(
      () => parseClaudeOutput(outerJson(inner)),
      /Claude returned invalid JSON/,
    );
  });

  test("throws when no parseable decision is anywhere in the output", () => {
    assert.throws(
      () => parseClaudeOutput(outerJson("just some prose without a decision")),
      /Could not extract actionable decision/,
    );
  });
});

describe("parseTriageOutput", () => {
  test("returns the fenced { skip, reason } block", () => {
    const inner = "```json\n{ \"skip\": true, \"reason\": \"lgtm comment\" }\n```";
    const parsed = parseTriageOutput(outerJson(inner));
    assert.equal(parsed.skip, true);
    assert.equal(parsed.reason, "lgtm comment");
  });

  test("falls back to an inline JSON object containing 'skip'", () => {
    const inner = "preamble { \"skip\": false, \"reason\": \"could be a fix\" } trailing";
    const parsed = parseTriageOutput(outerJson(inner));
    assert.equal(parsed.skip, false);
  });

  test("defaults to skip:false when output is unparseable (bias toward proceed)", () => {
    const parsed = parseTriageOutput(outerJson("garbage with no JSON in sight"));
    assert.equal(parsed.skip, false);
    assert.match(parsed.reason, /not parseable/);
  });

  test("rejects a parsed block where skip is missing/non-boolean (treats as unparseable)", () => {
    const inner = "```json\n{ \"reason\": \"missing skip key\" }\n```";
    const parsed = parseTriageOutput(outerJson(inner));
    assert.equal(parsed.skip, false);
    assert.match(parsed.reason, /not parseable/);
  });
});

describe("parseSentryOutput", () => {
  test("extracts the actionable JSON and preserves the confidence field", () => {
    const inner = "```json\n" + JSON.stringify({
      actionable: true,
      confidence: "high",
      summary: "Guard against undefined user",
      files_modified: ["src/Profile.tsx"],
      tests_run: true,
      tests_passed: true,
    }) + "\n```";
    const parsed = parseSentryOutput(outerJson(inner));
    assert.equal(parsed.actionable, true);
    assert.equal(parsed.confidence, "high");
    assert.equal(parsed.summary, "Guard against undefined user");
  });

  test("defaults confidence to 'low' when Claude omitted it but said actionable", () => {
    const inner = "```json\n" + JSON.stringify({ actionable: true, summary: "x" }) + "\n```";
    const parsed = parseSentryOutput(outerJson(inner));
    assert.equal(parsed.confidence, "low");
  });

  test("does NOT default confidence when actionable is false", () => {
    const inner = "```json\n" + JSON.stringify({ actionable: false, reason: "third-party lib" }) + "\n```";
    const parsed = parseSentryOutput(outerJson(inner));
    assert.equal(parsed.actionable, false);
    assert.equal(parsed.confidence, undefined);
  });

  test("throws when no decision is parseable", () => {
    assert.throws(
      () => parseSentryOutput(outerJson("free-form thinking, no JSON")),
      /Could not extract actionable decision/,
    );
  });
});

describe("extractReviewText", () => {
  test("unwraps the outer result envelope for /review output", () => {
    assert.equal(extractReviewText(outerJson("## Review\nLooks good")), "## Review\nLooks good");
  });

  test("returns raw string when the input isn't JSON", () => {
    assert.equal(extractReviewText("plain text review"), "plain text review");
  });

  test("returns raw input when JSON lacks a string 'result' field", () => {
    const wrapped = JSON.stringify({ type: "other", result: { not: "string" } });
    assert.equal(extractReviewText(wrapped), wrapped);
  });
});

describe("buildPrompt (comment handler)", () => {
  const ctx = {
    prTitle: "Add login flow",
    branch: "feature/login",
    commenter: "alice",
    filePath: "src/auth.ts",
    commentBody: "Please rename `n` to `userCount` here.",
    diffHunk: "@@ -1 +1 @@\n-const n = 0;\n+const n = users.length;",
  };

  test("includes PR title, branch, reviewer, file path, and the comment body", () => {
    const p = buildPrompt(ctx);
    assert.match(p, /Add login flow/);
    assert.match(p, /feature\/login/);
    assert.match(p, /@alice/);
    assert.match(p, /src\/auth\.ts/);
    assert.match(p, /rename `n` to `userCount`/);
  });

  test("renders the diff hunk inside a fenced diff block", () => {
    const p = buildPrompt(ctx);
    assert.match(p, /```diff\n@@ -1 \+1 @@/);
  });

  test("falls back to 'general comment' framing when filePath is null", () => {
    const p = buildPrompt({ ...ctx, filePath: null });
    assert.match(p, /General PR review comment/);
  });

  test("omits the diff block when diffHunk is null", () => {
    const p = buildPrompt({ ...ctx, diffHunk: null });
    assert.doesNotMatch(p, /```diff/);
  });

  test("requires the JSON decision to be the LAST thing Claude writes", () => {
    // The protocol depends on this — Claude's downstream parser slices the
    // last fenced JSON block. Make sure the prompt actually says so.
    assert.match(buildPrompt(ctx), /last thing in your output|JSON block is the very last/i);
  });
});

describe("buildTriagePrompt", () => {
  const ctx = {
    prTitle: "Refactor auth",
    commenter: "bob",
    filePath: "src/auth.ts",
    commentBody: "lgtm 👍",
    diffHunk: null,
  };

  test("frames the task as a single-turn judgment with no code access", () => {
    const p = buildTriagePrompt(ctx);
    assert.match(p, /You have NO access to the codebase/);
  });

  test("biases toward skip:false in ambiguous cases", () => {
    assert.match(buildTriagePrompt(ctx), /when in doubt, do NOT skip/i);
  });

  test("omits the diff block when no hunk is provided", () => {
    assert.doesNotMatch(buildTriagePrompt(ctx), /```diff/);
  });
});

describe("buildSentryPrompt", () => {
  const ctx = {
    owner: "hakim",
    repoName: "rn-app",
    sentry: {
      issueId: "12345",
      issueUrl: "https://sentry.io/issues/12345/",
      eventCount: 23,
      userCount: 8,
      event: {
        errorType: "TypeError",
        errorMessage: "Cannot read property 'name' of undefined",
        culprit: "src/Profile.tsx in render",
        platform: "javascript",
        release: "1.2.3",
        environment: "production",
        topFrame: {
          filename: "src/Profile.tsx",
          function: "render",
          lineno: 42,
          contextLine: "  const name = user.profile.name;",
          preContext: ["function render() {", "  // ..."],
          postContext: ["  return <Text>{name}</Text>;"],
        },
        inAppStack: [
          { filename: "src/A.ts", function: "outer", lineno: 10 },
          { filename: "src/Profile.tsx", function: "render", lineno: 42 },
        ],
        breadcrumbs: [
          { category: "navigation", message: "to /profile", level: "info" },
        ],
      },
    },
  };

  test("includes the Sentry issue link and event-count framing", () => {
    const p = buildSentryPrompt(ctx);
    assert.match(p, /12345/);
    assert.match(p, /https:\/\/sentry\.io\/issues\/12345\//);
    assert.match(p, /23 occurrences across 8 users/);
  });

  test("renders the top frame's source context", () => {
    const p = buildSentryPrompt(ctx);
    assert.match(p, /src\/Profile\.tsx:42/);
    assert.match(p, /← error here/);
  });

  test("renders the in-app stack as 'at fn (file:line)' lines", () => {
    const p = buildSentryPrompt(ctx);
    assert.match(p, /at render \(src\/Profile\.tsx:42\)/);
    assert.match(p, /at outer \(src\/A\.ts:10\)/);
  });

  test("renders breadcrumbs only when present", () => {
    const p = buildSentryPrompt(ctx);
    assert.match(p, /Recent breadcrumbs/);
    assert.match(p, /navigation: to \/profile/);

    const noBreadcrumbs = {
      ...ctx, sentry: { ...ctx.sentry, event: { ...ctx.sentry.event, breadcrumbs: [] } },
    };
    assert.doesNotMatch(buildSentryPrompt(noBreadcrumbs), /Recent breadcrumbs/);
  });

  test("explains the confidence-gated draft state to Claude", () => {
    // The prompt needs to teach Claude when to use each confidence level;
    // otherwise the downstream PR draft logic gets unreliable signals.
    const p = buildSentryPrompt(ctx);
    assert.match(p, /"high"/);
    assert.match(p, /"medium"/);
    assert.match(p, /"low"/);
  });

  test("handles a null topFrame gracefully (no crash; fallback message)", () => {
    const ctx2 = {
      ...ctx,
      sentry: { ...ctx.sentry, event: { ...ctx.sentry.event, topFrame: null } },
    };
    const p = buildSentryPrompt(ctx2);
    assert.match(p, /no in-app frame available/);
  });
});
