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
  protectedBranches: (process.env.PROTECTED_BRANCHES || "main,master,develop")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean),
  gitEmail: process.env.GIT_EMAIL || "pr-bot@localhost",
  gitName: process.env.GIT_NAME || "PR Review Bot",
  claudeTimeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS || "300000", 10),
  logLevel: process.env.LOG_LEVEL?.toLowerCase() || "info",
};
