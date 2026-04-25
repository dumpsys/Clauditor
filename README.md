# PR Review Bot 🤖

A local webhook server that monitors GitHub pull request review comments and uses **Claude Code** to automatically evaluate, fix, and respond to review feedback.

## How It Works

```
GitHub PR Review Comment
        │
        ▼
Tailscale Funnel (HTTPS → localhost)
        │
        ▼
Webhook Server (Express)
  ├── Verifies HMAC-SHA256 signature
  ├── Filters events (only PR review comments, non-bot, non-protected-branch)
  └── Enqueues job
        │
        ▼
Job Queue (serialized to avoid conflicts)
        │
        ▼
Claude Code (headless: claude -p)
  ├── Reads relevant files
  ├── Evaluates: is this feedback valid and actionable?
  ├── YES → applies minimal targeted fix
  └── NO  → explains why no change was made
        │
        ▼
Git: commit + push changes to PR branch
        │
        ▼
GitHub API: reply to review comment with result
```

---

## Prerequisites

| Tool | Install |
|------|---------|
| Node.js ≥ 18 | https://nodejs.org |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| Tailscale | https://tailscale.com/download |
| Git | Pre-installed on most systems |

---

## Setup

### 1. Clone & Configure

```bash
git clone <this-repo>
cd pr-review-bot
cp .env.example .env
```

Edit `.env`:

```env
GITHUB_TOKEN=ghp_your_token_here
GITHUB_WEBHOOK_SECRET=your_random_secret_string
GITHUB_BOT_USERNAME=your-github-username
```

### 2. GitHub Token Permissions

Create a token at https://github.com/settings/tokens with:
- `repo` → Full control (needed to read code, push commits, comment)
- Or fine-grained: `contents:write`, `pull_requests:write`, `issues:write`

### 3. Authenticate Claude Code

```bash
claude auth login
```

### 4. Start the Bot

```bash
chmod +x start.sh
./start.sh
```

The script will:
1. Validate your `.env`
2. Install npm dependencies
3. Start Tailscale Funnel and print your public webhook URL
4. Start the Express server

### 5. Configure GitHub Webhook

Go to your repo → **Settings → Webhooks → Add webhook**:

| Field | Value |
|-------|-------|
| Payload URL | `https://your-machine.ts.net/webhook` |
| Content type | `application/json` |
| Secret | Same as `GITHUB_WEBHOOK_SECRET` in `.env` |
| Events | ✅ Pull request review comments, ✅ Pull request reviews |

---

## Safety Features

| Concern | How It's Handled |
|---------|-----------------|
| Fake webhooks | HMAC-SHA256 signature verification on every request |
| Bot reply loops | Ignores comments from `GITHUB_BOT_USERNAME` |
| Accidental pushes to main | `PROTECTED_BRANCHES` list blocks any push |
| Runaway Claude | `--max-turns 10` + `CLAUDE_TIMEOUT_MS` limit |
| Concurrent jobs | Single-file queue serializes all jobs |
| Claude changes nothing | Detects empty `git status`, throws error instead of empty commit |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | ✅ | — | GitHub PAT with repo access |
| `GITHUB_WEBHOOK_SECRET` | ✅ | — | Webhook HMAC secret |
| `GITHUB_BOT_USERNAME` | ✅ | — | Your GitHub username (for loop prevention) |
| `PORT` | | `3000` | Local server port |
| `PROTECTED_BRANCHES` | | `main,master,develop` | Branches bot won't push to |
| `GIT_EMAIL` | | `pr-bot@localhost` | Git commit email |
| `GIT_NAME` | | `PR Review Bot` | Git commit name |
| `CLAUDE_TIMEOUT_MS` | | `300000` | Max time for Claude to run (ms) |
| `LOG_LEVEL` | | `info` | `debug` / `info` / `warn` / `error` |

---

## What Claude Decides

Claude evaluates each comment and returns a structured JSON decision:

**Actionable** → Claude modifies the code, commits, pushes, and replies:
```
✅ Addressed by Claude Code (commit `a1b2c3d`)

> Your variable names are unclear, use `userCount` instead of `n`

What was done: Renamed variable `n` to `userCount` in auth.js lines 42-67
```

**Not actionable** → Claude explains why and replies without touching code:
```
🤖 Claude Code reviewed this feedback but determined it may not require a code change

> This looks fine to me

Reason: The comment is an approval, not a request for changes.
```

---

## File Structure

```
pr-review-bot/
├── src/
│   ├── server.js              # Entry point — starts HTTP server
│   ├── app.js                 # Express app (middleware + routes)
│   ├── config.js              # Env loading + validation
│   ├── routes/
│   │   ├── webhook.js         # POST /webhook
│   │   └── health.js          # GET  /health
│   ├── middleware/
│   │   └── verifySignature.js # HMAC-SHA256 signature middleware
│   ├── services/
│   │   ├── claude.js          # Claude Code CLI invocation
│   │   ├── git.js             # Clone, commit, push operations
│   │   └── github.js          # GitHub REST API client
│   ├── queue.js               # In-memory job queue (serialized)
│   ├── handler.js             # PR review orchestration logic
│   └── logger.js              # Simple structured logger
├── scripts/
│   └── test-webhook.js        # Local webhook simulator
├── start.sh                   # Startup script with Tailscale Funnel
├── .env.example               # Environment template
└── package.json
```

---

## Running as a Background Service (optional)

To keep the bot running after you close your terminal:

```bash
# Using PM2
npm install -g pm2
pm2 start src/server.js --name pr-review-bot
pm2 save
pm2 startup
```

---

## Troubleshooting

**Webhook not reaching server:**
```bash
tailscale funnel status
```

**Claude Code not authorized:**
```bash
claude auth login
```

**See detailed logs:**
```bash
LOG_LEVEL=debug node src/server.js
```

**Test webhook locally without GitHub:**
```bash
npm run test:webhook
# or: node scripts/test-webhook.js
```
