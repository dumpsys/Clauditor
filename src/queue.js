import { handlePullRequestReviewComment } from "./handler.js";
import { logger } from "./logger.js";

class JobQueue {
  constructor() {
    this._queue = [];
    this._running = false;
  }

  size() {
    return this._queue.length;
  }

  add(job) {
    this._queue.push(job);
    if (!this._running) this._process();
  }

  async _process() {
    this._running = true;
    while (this._queue.length > 0) {
      const job = this._queue.shift();
      try {
        logger.info(`Processing job: PR #${job.payload.pull_request?.number}`);
        await handlePullRequestReviewComment(job.payload);
      } catch (err) {
        logger.error(`Job failed: ${err.message}`, { stack: err.stack });
      }
    }
    this._running = false;
  }
}

export const queue = new JobQueue();
