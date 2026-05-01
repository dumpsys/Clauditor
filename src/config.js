const required = ["GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_BOT_USERNAME"];

export function validateConfig() {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
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
  gitEmail: process.env.GIT_EMAIL || "pr-bot@localhost",
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
};
