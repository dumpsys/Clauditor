import { config } from "../config.js";
import { logger } from "../logger.js";

const GITHUB_API = "https://api.github.com";

function headers() {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is not set");
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function ghFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

/**
 * Check whether a branch exists on the remote. Used by the Sentry handler
 * to decide between "push to existing fix branch" vs "branch off main".
 * Returns false on 404, throws on other errors so caller can react.
 */
export async function branchExists(owner, repo, branch) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return false;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub branch check failed ${res.status}: ${body}`);
  }
  return true;
}

/**
 * Find the open PR whose head is the given branch (in this repo, not a fork).
 * Returns the PR object, or null if no open PR exists.
 */
export async function findOpenPRByHead(owner, repo, branch) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branch}`;
  const list = await ghFetch(url);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

/**
 * Open a new pull request. `draft` defaults to true — the Sentry workflow
 * always opens drafts unless Claude reports high confidence.
 */
export async function createPullRequest(owner, repo, { title, head, base, body, draft = true }) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls`;
  logger.info(`Creating PR ${owner}/${repo} ${head} → ${base} (draft=${draft})`);
  return ghFetch(url, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body, draft }),
  });
}

/**
 * Post a top-level comment on any issue or PR number. Used by the Sentry
 * handler to drop the Sentry issue link into the PR.
 */
export async function postIssueComment(owner, repo, number, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments`;
  return ghFetch(url, { method: "POST", body: JSON.stringify({ body }) });
}

/**
 * Fetch a pull request — needed for `issue_comment` events because that
 * payload only contains the issue, not the PR head ref/sha.
 */
export async function getPullRequest(owner, repo, prNumber) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`;
  return ghFetch(url);
}

/**
 * Reply to a specific pull request review comment (inline code comment).
 */
export async function replyToComment(owner, repo, prNumber, commentId, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`;
  logger.info(`Posting reply to comment ${commentId} on PR #${prNumber}`);
  return ghFetch(url, { method: "POST", body: JSON.stringify({ body }) });
}

/**
 * Submit a formal PR review (Approve / Request changes / plain Comment).
 * Defaults to `event: "COMMENT"` — leaves a review post without a verdict.
 */
export async function postReview(owner, repo, prNumber, body, event = "COMMENT") {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
  logger.info(`Posting formal review (event=${event}) on PR #${prNumber}`);
  return ghFetch(url, {
    method: "POST",
    body: JSON.stringify({ body, event }),
  });
}

/**
 * Post a general comment on a PR (used for non-inline review comments).
 */
export async function replyToReview(owner, repo, prNumber, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  logger.info(`Posting issue comment on PR #${prNumber}`);
  return ghFetch(url, { method: "POST", body: JSON.stringify({ body }) });
}
