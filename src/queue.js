import { handleComment } from "./handlers/comment.js";
import { handleReviewRequest } from "./handlers/reviewRequest.js";
import { logger } from "./logger.js";

const dispatch = {
  pull_request_review_comment: handleComment,
  pull_request_review: handleComment,
  issue_comment: handleComment,
  pull_request: handleReviewRequest, // only review_requested action reaches the queue
};

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
        const prNumber =
          job.payload.pull_request?.number ?? job.payload.issue?.number;
        logger.info(`Processing job: PR #${prNumber} (${job.event})`);

        const handler = dispatch[job.event];
        if (!handler) {
          logger.warn(`No handler registered for event: ${job.event}`);
          continue;
        }
        await handler(job);
      } catch (err) {
        logger.error(`Job failed: ${err.message}`, { stack: err.stack });
      }
    }
    this._running = false;
  }
}

export const queue = new JobQueue();
