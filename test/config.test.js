import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Set the minimum required env BEFORE importing config so its top-level
// `process.env` reads succeed. Individual tests mutate process.env and call
// validateConfig() (which re-reads env at call time).
process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const { parseProjectRepoMap, parsePositiveIntEnv, validateConfig } = await import("../src/config.js");

describe("parseProjectRepoMap", () => {
  test("returns empty Map for empty / undefined input", () => {
    assert.equal(parseProjectRepoMap("").size, 0);
    assert.equal(parseProjectRepoMap(undefined).size, 0);
    assert.equal(parseProjectRepoMap(null).size, 0);
  });

  test("parses a single mapping", () => {
    const m = parseProjectRepoMap("my-app:owner/repo");
    assert.equal(m.size, 1);
    assert.deepEqual(m.get("my-app"), { owner: "owner", repo: "repo" });
  });

  test("parses multiple comma-separated mappings", () => {
    const m = parseProjectRepoMap("a:o1/r1,b:o2/r2,c:o3/r3");
    assert.equal(m.size, 3);
    assert.deepEqual(m.get("a"), { owner: "o1", repo: "r1" });
    assert.deepEqual(m.get("b"), { owner: "o2", repo: "r2" });
    assert.deepEqual(m.get("c"), { owner: "o3", repo: "r3" });
  });

  test("trims whitespace around each slug:repo entry", () => {
    // The trim happens at the "slug : repo" boundary only — owner/repo are
    // not re-trimmed after splitting on "/". This is fine in practice because
    // env-var lists shouldn't contain internal whitespace, but it's worth
    // pinning the behavior.
    const m = parseProjectRepoMap("  app:owner/repo  ,  other:foo/bar  ");
    assert.deepEqual(m.get("app"), { owner: "owner", repo: "repo" });
    assert.deepEqual(m.get("other"), { owner: "foo", repo: "bar" });
  });

  test("silently drops malformed entries (missing colon, missing slash)", () => {
    const m = parseProjectRepoMap("good:o/r,no-colon-here,bad:no-slash,:no-slug/x,empty:");
    assert.equal(m.size, 1);
    assert.deepEqual(m.get("good"), { owner: "o", repo: "r" });
  });

  test("handles single trailing/leading commas", () => {
    const m = parseProjectRepoMap(",a:o/r,");
    assert.equal(m.size, 1);
    assert.ok(m.has("a"));
  });
});

describe("parsePositiveIntEnv", () => {
  const KEY = "__TEST_PARSE_POS_INT__";
  let saved;
  beforeEach(() => { saved = process.env[KEY]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("returns the parsed value when the env var is a positive integer", () => {
    process.env[KEY] = "42";
    assert.equal(parsePositiveIntEnv(KEY, 1), 42);
  });

  test("returns the fallback when the env var is unset", () => {
    delete process.env[KEY];
    assert.equal(parsePositiveIntEnv(KEY, 99), 99);
  });

  test("returns the fallback when the env var is an empty string", () => {
    process.env[KEY] = "";
    assert.equal(parsePositiveIntEnv(KEY, 99), 99);
  });

  test("returns the fallback on a non-numeric value (this is the NaN guard)", () => {
    process.env[KEY] = "abc";
    assert.equal(parsePositiveIntEnv(KEY, 7), 7);
  });

  test("returns the fallback on zero / negative integers", () => {
    process.env[KEY] = "0";
    assert.equal(parsePositiveIntEnv(KEY, 7), 7);
    process.env[KEY] = "-5";
    assert.equal(parsePositiveIntEnv(KEY, 7), 7);
  });

  test("accepts integers embedded in strings (parseInt semantics)", () => {
    // parseInt("3abc", 10) === 3 — confirm the helper inherits that.
    process.env[KEY] = "3abc";
    assert.equal(parsePositiveIntEnv(KEY, 1), 3);
  });
});

describe("validateConfig", () => {
  // Snapshot only the keys this suite mutates — restore after each test so
  // sibling test files inherit a clean env.
  const KEYS = [
    "GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_BOT_USERNAME",
    "SENTRY_CLIENT_SECRET", "SENTRY_AUTH_TOKEN", "SENTRY_PROJECT_REPO_MAP",
  ];
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("passes when all required GitHub vars are present", () => {
    process.env.GITHUB_TOKEN = "x";
    process.env.GITHUB_WEBHOOK_SECRET = "y";
    process.env.GITHUB_BOT_USERNAME = "z";
    delete process.env.SENTRY_CLIENT_SECRET;
    assert.doesNotThrow(() => validateConfig());
  });

  test("throws when GITHUB_TOKEN is missing", () => {
    delete process.env.GITHUB_TOKEN;
    assert.throws(() => validateConfig(), /GITHUB_TOKEN/);
  });

  test("throws when multiple GitHub vars are missing, listing all of them", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_BOT_USERNAME;
    assert.throws(() => validateConfig(), (err) => {
      assert.match(err.message, /GITHUB_TOKEN/);
      assert.match(err.message, /GITHUB_BOT_USERNAME/);
      return true;
    });
  });

  test("requires Sentry vars only when SENTRY_CLIENT_SECRET is set", () => {
    // No Sentry secret → Sentry vars not required.
    delete process.env.SENTRY_CLIENT_SECRET;
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_PROJECT_REPO_MAP;
    assert.doesNotThrow(() => validateConfig());

    // Sentry secret set but other Sentry vars missing → throws.
    process.env.SENTRY_CLIENT_SECRET = "secret";
    assert.throws(
      () => validateConfig(),
      /SENTRY_CLIENT_SECRET is set but missing/,
    );

    // All Sentry vars present → passes.
    process.env.SENTRY_AUTH_TOKEN = "tok";
    process.env.SENTRY_PROJECT_REPO_MAP = "a:o/r";
    assert.doesNotThrow(() => validateConfig());
  });
});
