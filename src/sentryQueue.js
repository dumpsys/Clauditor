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
export class SentryQueue {
  /**
   * @param {number} maxConcurrent
   * @param {(job: any) => Promise<void>} [handler] — defaults to the real
   *   Sentry issue handler. Tests inject a controllable async function so
   *   they can observe in-flight state without doing real work.
   */
  constructor(maxConcurrent, handler = handleSentryIssue) {
    // Guard against non-numeric env values (Math.max(1, NaN) === NaN, which
    // would make the < comparison in _drain() permanently false and freeze
    // the queue). Fall back to 1 worker rather than silently breaking.
    const n = Number(maxConcurrent);
    this._maxConcurrent = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    this._handler = handler;
    this._pending = [];      // jobs waiting for a worker slot
    this._inFlight = new Map(); // issueId → Promise (currently running)
    // Pending issue IDs — needed so duplicates that arrive while the pool is
    // saturated also coalesce (a job sitting in `_pending` isn't yet in
    // `_inFlight`). Cleared at the moment the job moves into `_inFlight`.
    this._pendingIds = new Set();
  }

  /**
   * @returns {"queued"|"in-flight"} the disposition of this enqueue attempt.
   * "in-flight" means a job for this issueId is already either running OR
   * waiting in the pending queue, and the incoming webhook is dropped as
   * a duplicate.
   */
  add(job) {
    const issueId = job.issueId;
    if (!issueId) {
      // Defensive — the route should have rejected this already.
      logger.warn("Sentry job missing issueId; dropping");
      return "in-flight";
    }
    if (this._inFlight.has(issueId) || this._pendingIds.has(issueId)) {
      logger.info(`Sentry issue ${issueId} already queued/in-flight — dropping duplicate webhook`);
      return "in-flight";
    }
    this._pending.push(job);
    this._pendingIds.add(issueId);
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
      this._pendingIds.delete(issueId);
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
      await this._handler(job);
      logger.info(`Sentry job done: issue ${job.issueId}`);
    } catch (err) {
      logger.error(`Sentry job failed for issue ${job.issueId}: ${err.message}`, { stack: err.stack });
    }
  }
}

export const sentryQueue = new SentryQueue(config.sentry.maxConcurrentJobs);
