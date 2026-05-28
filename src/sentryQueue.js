import { handleSentryIssue } from "./handlers/sentryIssue.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Sentry-specific worker pool.
 *
 * Why this is separate from `queue.js`:
 *   - GitHub comment/review jobs share a working directory pattern and
 *     touch the same PR branch; serializing them prevents races.
 *   - Sentry jobs target *different* Sentry issues — each lands on its
 *     own branch in (potentially) different repos. Running them serially
 *     would slow throughput unnecessarily.
 *
 * Concurrency model:
 *   - Up to `SENTRY_MAX_CONCURRENT_JOBS` workers run in parallel.
 *   - An in-flight Map<issueId, Promise> deduplicates: webhooks for an
 *     issue that's already being processed are dropped at enqueue time
 *     (the route returns 200 with dedup:"in-flight").
 *   - After a job completes (success or failure), its issueId leaves the
 *     in-flight Map. The next webhook for that issue will be accepted.
 */
class SentryQueue {
  constructor(maxConcurrent) {
    this._maxConcurrent = Math.max(1, maxConcurrent);
    this._pending = [];      // jobs waiting for a worker slot
    this._inFlight = new Map(); // issueId → Promise (currently running)
  }

  /**
   * @returns {"queued"|"in-flight"} the disposition of this enqueue attempt.
   * "in-flight" means a job for this issueId is already running and the
   * incoming webhook is being dropped as a duplicate.
   */
  add(job) {
    const issueId = job.issueId;
    if (!issueId) {
      // Defensive — the route should have rejected this already.
      logger.warn("Sentry job missing issueId; dropping");
      return "in-flight";
    }
    if (this._inFlight.has(issueId)) {
      logger.info(`Sentry issue ${issueId} already in-flight — dropping duplicate webhook`);
      return "in-flight";
    }
    this._pending.push(job);
    this._drain();
    return "queued";
  }

  /** Number of jobs currently running. */
  activeCount() { return this._inFlight.size; }

  /** Number of jobs waiting for a slot. */
  pendingCount() { return this._pending.length; }

  _drain() {
    while (this._pending.length > 0 && this._inFlight.size < this._maxConcurrent) {
      const job = this._pending.shift();
      const issueId = job.issueId;
      // Re-check just in case a duplicate snuck into _pending before _drain
      // got around to running. With the current `add()` flow this can't
      // happen, but defensive: cheap.
      if (this._inFlight.has(issueId)) {
        logger.warn(`Skipping pending duplicate for issue ${issueId}`);
        continue;
      }
      const promise = this._run(job).finally(() => {
        this._inFlight.delete(issueId);
        // Another job may now fit. Drain again. Use setImmediate so we don't
        // grow the stack arbitrarily on bursts.
        setImmediate(() => this._drain());
      });
      this._inFlight.set(issueId, promise);
    }
  }

  async _run(job) {
    logger.info(`Sentry job start: issue ${job.issueId} (active=${this._inFlight.size + 1}/${this._maxConcurrent})`);
    try {
      await handleSentryIssue(job);
      logger.info(`Sentry job done: issue ${job.issueId}`);
    } catch (err) {
      logger.error(`Sentry job failed for issue ${job.issueId}: ${err.message}`, { stack: err.stack });
    }
  }
}

export const sentryQueue = new SentryQueue(config.sentry.maxConcurrentJobs);
