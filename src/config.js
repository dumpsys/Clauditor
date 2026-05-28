const required = ["GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_BOT_USERNAME"];

// Sentry vars are only required if SENTRY_CLIENT_SECRET is set (i.e. the
// user opts into Workflow C). When unset, the Sentry route returns 200
// with a "not configured" message and the rest of the app keeps working.
const sentryRequiredWhenEnabled = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_PROJECT_REPO_MAP",
];

export function validateConfig() {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  if (process.env.SENTRY_CLIENT_SECRET) {
    const missingSentry = sentryRequiredWhenEnabled.filter((k) => !process.env[k]);
    if (missingSentry.length) {
      throw new Error(
        `SENTRY_CLIENT_SECRET is set but missing Sentry env vars: ${missingSentry.join(", ")}`
      );
    }
  }
}

/**
 * Read a positive integer from process.env with a safe fallback.
 *
 * Why this exists: `parseInt("abc", 10)` returns `NaN`, and a `NaN` value
 * silently breaks every downstream comparison (`x < NaN` is always false)
 * and `setTimeout(fn, NaN)` fires near-immediately. We've now been bitten
 * by this in three places (concurrency, event-count gate, Claude timeout),
 * so centralize the guard here.
 */
export function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Parse "slug-a:owner/repo-a,slug-b:owner/repo-b" into a Map.
 * Empty / malformed entries are silently dropped (validation happens at
 * use-site so a typo in one entry doesn't break startup for the others).
 *
 * Exported for unit testing — most call sites should just read
 * `config.sentry.projectRepoMap` directly.
 */
export function parseProjectRepoMap(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const entry of raw.split(",")) {
    const [slug, repo] = entry.split(":").map((s) => s.trim());
    if (!slug || !repo || !repo.includes("/")) continue;
    const [owner, name] = repo.split("/");
    if (!owner || !name) continue;
    map.set(slug, { owner, repo: name });
  }
  return map;
}

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  botUsername: process.env.GITHUB_BOT_USERNAME,
  // Username (e.g. "dumpsys") that, when requested as a reviewer, triggers
  // an automated /review run. Empty/unset disables the feature.
  reviewRequestUser: process.env.GITHUB_REVIEW_REQUEST_USER || "",
  // Phrase that opts an existing PR comment into re-verification when the
  // author edits the comment to include it. Case-insensitive match.
  // Empty disables the issue_comment.edited workflow.
  triggerPhrase: (process.env.CLAUDITOR_TRIGGER_PHRASE ?? "Clauditor verify this").trim(),
  protectedBranches: (process.env.PROTECTED_BRANCHES || "main,master,develop")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean),
  // GitHub user's numeric ID. When set, commits are authored with the
  // GitHub no-reply email (`<id>+<username>@users.noreply.github.com`) so
  // pushes aren't rejected by GitHub's email-privacy protection (GH007).
  // Find it at https://api.github.com/users/<username> ("id" field).
  githubNoreplyUserId: (process.env.GITHUB_NOREPLY_USER_ID || "").trim(),
  gitEmail: process.env.GITHUB_NOREPLY_USER_ID?.trim()
    ? `${process.env.GITHUB_NOREPLY_USER_ID.trim()}+${process.env.GITHUB_BOT_USERNAME}@users.noreply.github.com`
    : process.env.GIT_EMAIL || "pr-bot@localhost",
  gitName: process.env.GIT_NAME || "PR Review Bot",
  // Default 5 min — for the comment handler, which makes one targeted edit.
  claudeTimeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS || "300000", 10),
  // Default 20 min — reviews of substantial PRs legitimately need more time.
  // Falls back to claudeTimeoutMs * 4 if explicitly unset to keep things in scale.
  claudeReviewTimeoutMs: parseInt(
    process.env.CLAUDE_REVIEW_TIMEOUT_MS ||
      String(parseInt(process.env.CLAUDE_TIMEOUT_MS || "300000", 10) * 4),
    10
  ),
  logLevel: process.env.LOG_LEVEL?.toLowerCase() || "info",

  // ─── Sentry (Workflow C) ──────────────────────────────────────────────
  sentry: {
    clientSecret: process.env.SENTRY_CLIENT_SECRET || "",
    authToken: process.env.SENTRY_AUTH_TOKEN || "",
    apiBaseUrl: (process.env.SENTRY_API_BASE_URL || "https://sentry.io/api/0").replace(/\/+$/, ""),
    projectRepoMap: parseProjectRepoMap(process.env.SENTRY_PROJECT_REPO_MAP),
    baseBranch: process.env.SENTRY_BASE_BRANCH || "main",
    branchPrefix: process.env.SENTRY_BRANCH_PREFIX || "sentry-fix/",
    // All three of these go through parsePositiveIntEnv so a typo'd env
    // value falls back to the default instead of breaking the count gate,
    // freezing the queue, or making `setTimeout(fn, NaN)` time out instantly.
    minEventCount: parsePositiveIntEnv("SENTRY_MIN_EVENT_COUNT", 1),
    maxConcurrentJobs: parsePositiveIntEnv("SENTRY_MAX_CONCURRENT_JOBS", 2),
    // Sentry fixes can take longer than comment fixes — there's more
    // exploration (find the file, understand the error, reproduce). Default
    // 10 min, separate knob so it doesn't have to track CLAUDE_TIMEOUT_MS.
    claudeTimeoutMs: parsePositiveIntEnv("SENTRY_CLAUDE_TIMEOUT_MS", 600000),
  },
};

/** True iff Sentry workflow is configured well enough to attempt work. */
export function sentryEnabled() {
  return Boolean(
    config.sentry.clientSecret &&
    config.sentry.authToken &&
    config.sentry.projectRepoMap.size > 0
  );
}
