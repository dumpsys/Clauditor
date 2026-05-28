import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.GITHUB_TOKEN ??= "test-token";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";
process.env.GITHUB_BOT_USERNAME ??= "test-bot";

const { SentryQueue } = await import("../src/sentryQueue.js");

/**
 * Build a controllable async handler whose completion can be triggered
 * per-call. Used to keep jobs "in flight" so the test can observe state
 * mid-run without races on real I/O.
 */
function controllableHandler() {
  const calls = [];
  const handler = (job) => {
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    calls.push({ job, ...deferred });
    return deferred.promise;
  };
  return { handler, calls };
}

/** Wait one macrotask so queued microtasks (drain, finally) flush. */
const tick = () => new Promise((r) => setImmediate(r));

describe("SentryQueue concurrency", () => {
  test("runs up to maxConcurrent jobs in parallel; queues the rest", async () => {
    const { handler, calls } = controllableHandler();
    const q = new SentryQueue(2, handler);

    assert.equal(q.add({ issueId: "A" }), "queued");
    assert.equal(q.add({ issueId: "B" }), "queued");
    assert.equal(q.add({ issueId: "C" }), "queued");
    await tick();

    assert.equal(q.activeCount(), 2, "two slots should be in flight");
    assert.equal(q.pendingCount(), 1, "C waits for a slot");
    assert.deepEqual(calls.map((c) => c.job.issueId), ["A", "B"]);

    // Finish A → C should be picked up.
    calls[0].resolve();
    await tick();
    await tick();

    assert.equal(q.activeCount(), 2, "B + C in flight after A completes");
    assert.equal(q.pendingCount(), 0);
    assert.deepEqual(calls.map((c) => c.job.issueId), ["A", "B", "C"]);

    // Drain remaining so the test doesn't leak unresolved promises.
    calls[1].resolve();
    calls[2].resolve();
    await tick();
    assert.equal(q.activeCount(), 0);
  });

  test("falls back to 1 worker when maxConcurrent is NaN or non-positive", async () => {
    for (const bad of [NaN, undefined, 0, -3, "abc"]) {
      const { handler, calls } = controllableHandler();
      const q = new SentryQueue(bad, handler);
      q.add({ issueId: "A" });
      q.add({ issueId: "B" });
      await tick();
      assert.equal(q.activeCount(), 1, `bad value ${String(bad)} should yield 1 worker, not freeze`);
      calls[0].resolve();
      await tick(); await tick();
      calls[1].resolve();
      await tick();
    }
  });
});

describe("SentryQueue dedup", () => {
  test("returns 'in-flight' for a duplicate of a currently-running job", async () => {
    const { handler, calls } = controllableHandler();
    const q = new SentryQueue(2, handler);

    assert.equal(q.add({ issueId: "X" }), "queued");
    await tick();
    assert.equal(q.add({ issueId: "X" }), "in-flight", "second add for X should dedup");
    assert.equal(q.add({ issueId: "X" }), "in-flight");

    calls[0].resolve();
    await tick();
    // After completion, the same issueId should be acceptable again.
    assert.equal(q.add({ issueId: "X" }), "queued");
    await tick();
    calls[1].resolve();
    await tick();
  });

  test("returns 'in-flight' for a duplicate sitting in the pending queue", async () => {
    // This is the regression Copilot's review caught: when the pool is
    // saturated, the second webhook for the SAME issueId used to be
    // added to _pending repeatedly because we only checked _inFlight.
    const { handler, calls } = controllableHandler();
    const q = new SentryQueue(1, handler);

    assert.equal(q.add({ issueId: "A" }), "queued"); // takes the one slot
    assert.equal(q.add({ issueId: "X" }), "queued"); // sits in _pending
    await tick();
    assert.equal(q.activeCount(), 1);
    assert.equal(q.pendingCount(), 1);

    // Duplicate webhooks for X (still pending) should dedup.
    assert.equal(q.add({ issueId: "X" }), "in-flight");
    assert.equal(q.add({ issueId: "X" }), "in-flight");
    assert.equal(q.pendingCount(), 1, "no extra entries piled into _pending");

    // Drain.
    calls[0].resolve();
    await tick(); await tick();
    calls[1].resolve();
    await tick();
  });

  test("drops jobs that arrive without an issueId", () => {
    const { handler } = controllableHandler();
    const q = new SentryQueue(2, handler);
    assert.equal(q.add({}), "in-flight");
    assert.equal(q.add({ issueId: null }), "in-flight");
    assert.equal(q.add({ issueId: "" }), "in-flight");
    assert.equal(q.activeCount(), 0);
    assert.equal(q.pendingCount(), 0);
  });
});

describe("SentryQueue error handling", () => {
  test("a handler that throws still frees its slot", async () => {
    const failing = () => Promise.reject(new Error("boom"));
    const q = new SentryQueue(1, failing);

    q.add({ issueId: "A" });
    await tick(); await tick();
    assert.equal(q.activeCount(), 0, "slot must free after handler rejection");

    // Same id should be acceptable again — the in-flight entry cleaned up.
    assert.equal(q.add({ issueId: "A" }), "queued");
    await tick(); await tick();
    assert.equal(q.activeCount(), 0);
  });
});
