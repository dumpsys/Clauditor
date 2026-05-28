import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";
process.env.SENTRY_AUTH_TOKEN = "sentry-tok";
process.env.SENTRY_API_BASE_URL = "https://sentry.test/api/0";

const {
  topInAppFrame,
  hasResolvedSourceMaps,
  summarizeEvent,
  issueIdFromPayload,
  getIssue,
  getLatestEvent,
  postIssueComment,
} = await import("../../src/services/sentry.js");

/** Build a minimal Sentry-style event with a single exception value. */
function eventWithFrames(frames, extra = {}) {
  return {
    entries: [
      {
        type: "exception",
        data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames } }] },
      },
    ],
    ...extra,
  };
}

describe("topInAppFrame", () => {
  test("returns null when no exception entry is present", () => {
    assert.equal(topInAppFrame({ entries: [] }), null);
    assert.equal(topInAppFrame({}), null);
    assert.equal(topInAppFrame(null), null);
  });

  test("returns null when there are no in_app frames", () => {
    const event = eventWithFrames([
      { in_app: false, filename: "node_modules/react/index.js" },
      { in_app: false, filename: "node_modules/express/lib/router.js" },
    ]);
    assert.equal(topInAppFrame(event), null);
  });

  test("returns the deepest in_app frame (last in the array)", () => {
    // Sentry orders frames oldest → newest. The last in_app frame is the
    // one closest to where the throw happened.
    const event = eventWithFrames([
      { in_app: false, filename: "vendor/lib.js" },
      { in_app: true,  filename: "src/screens/A.tsx", function: "render" },
      { in_app: false, filename: "node_modules/react/index.js" },
      { in_app: true,  filename: "src/screens/B.tsx", function: "click" }, // expected
    ]);
    const frame = topInAppFrame(event);
    assert.equal(frame.filename, "src/screens/B.tsx");
    assert.equal(frame.function, "click");
  });
});

describe("hasResolvedSourceMaps", () => {
  const goodFrame = {
    in_app: true,
    filename: "src/screens/Profile.tsx",
    lineno: 42,
    context_line: "  const name = user.profile.name;",
    pre_context: ["function render() {", "  // ..."],
    post_context: ["  return <Text>{name}</Text>;"],
  };

  test("true for an in-app frame with real source context", () => {
    assert.equal(hasResolvedSourceMaps(eventWithFrames([goodFrame])), true);
  });

  test("false when no in-app frame exists", () => {
    assert.equal(hasResolvedSourceMaps(eventWithFrames([])), false);
  });

  test("false when context lines are missing (Sentry didn't apply source maps)", () => {
    const stripped = { ...goodFrame, context_line: undefined, pre_context: [] };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([stripped])), false);
  });

  test("false for React Native bundle filenames", () => {
    const rn = { ...goodFrame, filename: "index.android.bundle" };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([rn])), false);

    const iosBundle = { ...goodFrame, filename: "/path/index.ios.bundle" };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([iosBundle])), false);
  });

  test("false for minified bundle patterns", () => {
    const min = { ...goodFrame, filename: "app.min.js" };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([min])), false);

    const cra = { ...goodFrame, filename: "static/js/main.abc123.js" };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([cra])), false);
  });

  test("false for raw URL filenames (unbundled / no map applied)", () => {
    const urlFrame = { ...goodFrame, filename: "https://cdn.example.com/bundle.js" };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([urlFrame])), false);
  });
});

describe("summarizeEvent", () => {
  test("extracts error type, message, top frame, and tags", () => {
    const event = {
      platform: "javascript",
      tags: [["release", "1.2.3"], ["environment", "production"]],
      entries: [
        {
          type: "exception",
          data: {
            values: [{
              type: "TypeError",
              value: "Cannot read property 'name' of undefined",
              stacktrace: {
                frames: [
                  { in_app: true, filename: "src/A.ts", function: "outer", lineno: 10 },
                  { in_app: true, filename: "src/B.ts", function: "inner", lineno: 25, context_line: "x.name" },
                ],
              },
            }],
          },
        },
        {
          type: "breadcrumbs",
          data: {
            values: [
              { category: "navigation", message: "to /home", level: "info" },
              { category: "ui.click",    message: "tap button",  level: "info" },
            ],
          },
        },
      ],
    };
    const summary = summarizeEvent(event, { title: "fallback title", culprit: "src/B.ts in inner" });

    assert.equal(summary.errorType, "TypeError");
    assert.equal(summary.errorMessage, "Cannot read property 'name' of undefined");
    assert.equal(summary.culprit, "src/B.ts in inner");
    assert.equal(summary.platform, "javascript");
    assert.equal(summary.release, "1.2.3");
    assert.equal(summary.environment, "production");
    assert.equal(summary.topFrame.filename, "src/B.ts");
    assert.equal(summary.topFrame.lineno, 25);
    assert.equal(summary.inAppStack.length, 2);
    assert.equal(summary.breadcrumbs.length, 2);
    assert.equal(summary.breadcrumbs[0].category, "navigation");
  });

  test("falls back to issue title when exception value is missing", () => {
    const summary = summarizeEvent({ entries: [] }, { title: "Crash on launch", type: "Error" });
    assert.equal(summary.errorMessage, "Crash on launch");
    assert.equal(summary.errorType, "Error");
  });

  test("caps in-app stack at 10 frames and keeps the most recent", () => {
    const frames = Array.from({ length: 15 }, (_, i) => ({
      in_app: true,
      filename: `src/file${i}.ts`,
      function: `fn${i}`,
      lineno: i,
    }));
    const event = eventWithFrames(frames);
    const summary = summarizeEvent(event, {});
    assert.equal(summary.inAppStack.length, 10);
    // Slice(-10) keeps frames 5..14 — assert the last one matches.
    assert.equal(summary.inAppStack.at(-1).filename, "src/file14.ts");
  });

  test("caps breadcrumbs at 5 and keeps the most recent", () => {
    const event = {
      entries: [
        {
          type: "breadcrumbs",
          data: {
            values: Array.from({ length: 8 }, (_, i) => ({
              category: "test", message: `crumb-${i}`, level: "info",
            })),
          },
        },
      ],
    };
    const summary = summarizeEvent(event, {});
    assert.equal(summary.breadcrumbs.length, 5);
    assert.equal(summary.breadcrumbs.at(-1).message, "crumb-7");
  });
});

describe("Sentry HTTP client", () => {
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

  test("getIssue hits /issues/{id}/ with the auth token", async () => {
    respondWith = { status: 200, body: { id: "111", title: "Boom" } };
    const issue = await getIssue("111");
    assert.equal(calls[0].url, "https://sentry.test/api/0/issues/111/");
    assert.equal(calls[0].options.headers.Authorization, "Bearer sentry-tok");
    assert.equal(issue.id, "111");
  });

  test("getLatestEvent hits /issues/{id}/events/latest/", async () => {
    respondWith = { status: 200, body: { eventID: "abc" } };
    const ev = await getLatestEvent("222");
    assert.equal(calls[0].url, "https://sentry.test/api/0/issues/222/events/latest/");
    assert.equal(ev.eventID, "abc");
  });

  test("postIssueComment POSTs { text } to /issues/{id}/comments/", async () => {
    respondWith = { status: 201, body: { id: 1 } };
    await postIssueComment("333", "hello sentry");
    assert.equal(calls[0].url, "https://sentry.test/api/0/issues/333/comments/");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { text: "hello sentry" });
  });

  test("throws a descriptive error on non-2xx", async () => {
    respondWith = { status: 403, statusText: "Forbidden", body: "missing scope" };
    await assert.rejects(
      () => getIssue("444"),
      /Sentry API error 403 Forbidden: missing scope/,
    );
  });
});

describe("issueIdFromPayload", () => {
  test("reads from data.issue.id (Sentry webhook shape)", () => {
    assert.equal(issueIdFromPayload({ data: { issue: { id: "12345" } } }), "12345");
  });

  test("falls back to issue.id (API shape)", () => {
    assert.equal(issueIdFromPayload({ issue: { id: "999" } }), "999");
  });

  test("returns null when no id is present", () => {
    assert.equal(issueIdFromPayload({}), null);
    assert.equal(issueIdFromPayload({ data: {} }), null);
  });
});
