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
  describeSourceMapGate,
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

  test("returns the deepest in_app frame (last in the array) when no frames have context", () => {
    // Sentry orders frames oldest → newest. The last in_app frame is the
    // one closest to where the throw happened. With no context anywhere,
    // the fallback path returns the deepest in_app frame for diagnostics.
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

  test("prefers an in_app frame WITH context over a deeper in_app frame without context", () => {
    // The real-world RN/Hermes case: Sentry tags `InternalBytecode.js` as
    // in_app even though it has no source context, and that frame sits
    // *deeper* than the user-code frames. A naive "deepest in_app" rule
    // would pick the bytecode frame and conclude "no source maps", even
    // though personalizationService.ts right above it has full context.
    const withCtx = {
      in_app: true,
      filename: "src/services/personalizationService.ts",
      function: "getPersonalizationPreferences",
      lineno: 153,
      context_line: "    const r = await fetch(url);",
      pre_context: ["async function get() {", "  // ..."],
    };
    const event = eventWithFrames([
      withCtx,
      { in_app: true, filename: "app:///InternalBytecode.js", function: "tryCallOne", lineno: 1, colno: 1181 },
      { in_app: true, filename: "app:///InternalBytecode.js", function: "anonymous", lineno: 1, colno: 1875 },
    ]);
    const frame = topInAppFrame(event);
    assert.equal(frame.filename, "src/services/personalizationService.ts");
    assert.equal(frame.function, "getPersonalizationPreferences");
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

  test("false for app:///InternalBytecode.js (RN Hermes engine internals)", () => {
    // Defense in depth: even if InternalBytecode.js had context_line set
    // (it shouldn't), the bundle-pattern guard catches it. RN tags these
    // as in_app=true but they're never user source.
    const bytecode = { ...goodFrame, filename: "app:///InternalBytecode.js" };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([bytecode])), false);
  });

  test("true when a deeper in_app frame is bytecode but a higher one has user source", () => {
    // The full user-reported scenario: topInAppFrame should walk past the
    // context-less bytecode frame to find personalizationService.ts, and
    // hasResolvedSourceMaps should report true on that.
    const userFrame = {
      in_app: true,
      filename: "src/services/personalizationService.ts",
      function: "getPersonalizationPreferences",
      lineno: 153,
      context_line: "    throw new PersonalizationError(...)",
      pre_context: ["async function get() {", "  // ..."],
      post_context: [],
    };
    const bytecodeFrame = {
      in_app: true,
      filename: "app:///InternalBytecode.js",
      function: "tryCallOne",
      lineno: 1,
    };
    assert.equal(hasResolvedSourceMaps(eventWithFrames([userFrame, bytecodeFrame])), true);
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

describe("describeSourceMapGate (diagnostic string)", () => {
  test("reports 'no exception entry' when the event has no exception", () => {
    const desc = describeSourceMapGate({ entries: [{ type: "breadcrumbs", data: { values: [] } }] });
    assert.match(desc, /no exception entry/);
    assert.match(desc, /breadcrumbs/);
  });

  test("reports 'no in_app frame' when nothing is tagged in_app", () => {
    const desc = describeSourceMapGate(eventWithFrames([
      { in_app: false, filename: "vendor/lib.js" },
      { in_app: false, filename: "node_modules/x.js" },
    ]));
    assert.match(desc, /no in_app frame/);
    assert.match(desc, /0 in_app/);
  });

  test("reports REJECT with the matching pattern when filename is a known non-source", () => {
    const desc = describeSourceMapGate(eventWithFrames([
      { in_app: true, filename: "app:///InternalBytecode.js", lineno: 1 },
    ]));
    assert.match(desc, /REJECT/);
    assert.match(desc, /InternalBytecode/);
  });

  test("reports REJECT when chosen frame has no context_line", () => {
    const desc = describeSourceMapGate(eventWithFrames([
      { in_app: true, filename: "src/A.ts", lineno: 10, function: "fn" },
    ]));
    assert.match(desc, /REJECT/);
    assert.match(desc, /no context_line/);
    assert.match(desc, /context_line=missing/);
  });

  test("reports ACCEPT and includes the chosen frame's filename + lineno", () => {
    const good = {
      in_app: true,
      filename: "src/Profile.tsx",
      function: "render",
      lineno: 42,
      context_line: "const name = user.name;",
      pre_context: ["function render() {", "  // ..."],
    };
    const desc = describeSourceMapGate(eventWithFrames([good]));
    assert.match(desc, /ACCEPT/);
    assert.match(desc, /src\/Profile\.tsx:42/);
    assert.match(desc, /context_line="const name = user\.name;"/);
  });

  test("event-stats summary lists totals for entries/values/frames/in_app/with-context", () => {
    const ctxFrame = {
      in_app: true, filename: "src/A.ts", lineno: 1,
      context_line: "x", pre_context: ["a"],
    };
    const desc = describeSourceMapGate(eventWithFrames([
      { in_app: false, filename: "vendor.js" },
      ctxFrame,
      { in_app: true, filename: "src/B.ts" }, // no context
    ]));
    assert.match(desc, /3 frame\(s\)/);
    assert.match(desc, /2 in_app/);
    assert.match(desc, /1 with context/);
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
      // Default Content-Type for happy-path tests is application/json so the
      // new non-JSON guard in sentryFetch doesn't trip on legit responses.
      const ct = r.contentType || "application/json";
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: r.statusText || "OK",
        headers: { get: (h) => h.toLowerCase() === "content-type" ? ct : null },
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

  test("throws an actionable error when a 2xx response is HTML, not JSON", async () => {
    // Simulates SENTRY_API_BASE_URL pointing at https://sentry.io (no /api/0)
    // or a self-hosted instance returning an SSO login page. We need a clearer
    // error than `Unexpected token '<'` so operators can fix their config.
    globalThis.fetch = async (url) => {
      calls.push({ url });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: (h) => h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null },
        text: async () => "<!DOCTYPE html><html><body>Login</body></html>",
        json: async () => { throw new Error("should not call .json() on HTML"); },
      };
    };
    await assert.rejects(
      () => getIssue("555"),
      (err) => {
        assert.match(err.message, /non-JSON response/);
        assert.match(err.message, /text\/html/);
        assert.match(err.message, /SENTRY_API_BASE_URL/);
        return true;
      },
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
