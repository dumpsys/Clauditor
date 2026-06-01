import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

describe("harness factory (src/harnesses/index.js)", () => {
  let savedHarness;
  beforeEach(() => { savedHarness = process.env.HARNESS; });
  afterEach(() => {
    if (savedHarness === undefined) delete process.env.HARNESS;
    else process.env.HARNESS = savedHarness;
  });

  // The factory captures HARNESS at module-load time, so each scenario uses
  // a dynamic import after setting the env var. Cache-bust with a query.
  async function loadFresh(label) {
    return import(`../../src/harnesses/index.js?t=${label}`);
  }

  test("exports a harness with all four entry points (claude default)", async () => {
    process.env.HARNESS = "claude";
    const { harness } = await loadFresh("default");
    assert.equal(harness.name, "claude");
    assert.equal(typeof harness.runCommentFix, "function");
    assert.equal(typeof harness.runTriage, "function");
    assert.equal(typeof harness.runReview, "function");
    assert.equal(typeof harness.runSentryFix, "function");
  });

  test("HARNESS is case-insensitive and trims whitespace", async () => {
    process.env.HARNESS = "  Claude  ";
    const { harness } = await loadFresh("case");
    assert.equal(harness.name, "claude");
  });

  test("throws a helpful error on unknown HARNESS values", async () => {
    process.env.HARNESS = "gpt5-cli-doesnt-exist";
    await assert.rejects(
      () => loadFresh("unknown"),
      (err) => {
        assert.match(err.message, /Unknown HARNESS=/);
        assert.match(err.message, /Supported: claude/);
        return true;
      },
    );
  });

  test("defaults to claude when HARNESS is unset", async () => {
    delete process.env.HARNESS;
    const { harness } = await loadFresh("unset");
    assert.equal(harness.name, "claude");
  });
});
