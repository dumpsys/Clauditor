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
 * Reply to a specific pull request review comment (inline code comment).
 */
export async function replyToComment(owner, repo, prNumber, commentId, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`;
  logger.info(`Posting reply to comment ${commentId} on PR #${prNumber}`);
  return ghFetch(url, { method: "POST", body: JSON.stringify({ body }) });
}

/**
 * Post a general comment on a PR (used for non-inline review comments).
 */
export async function replyToReview(owner, repo, prNumber, body) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  logger.info(`Posting issue comment on PR #${prNumber}`);
  return ghFetch(url, { method: "POST", body: JSON.stringify({ body }) });
}
