# Clauditor 🔎

> *Claude + auditor.* An autonomous PR auditor powered by [Claude Code](https://www.anthropic.com/claude-code).

A local webhook server that watches GitHub pull requests and uses Claude Code to:

1. **Address review feedback** — when a reviewer leaves a comment, Clauditor evaluates it, applies the fix, commits, and replies.
2. **Auto-review on request** — when a configured user is requested as a reviewer, Clauditor runs `claude -p /review` and posts a formal PR review.

All HMAC-verified, queue-serialized, and confined to non-protected branches.

> 📐 **Visual diagrams** — see [`docs/`](./docs) for Excalidraw diagrams of the architecture and both workflows.

## How It Works

The bot handles two distinct workflows, dispatched by GitHub event type:

### A. Review-comment workflow

```
PR review / inline comment / PR-attached issue comment
        │
        ▼
Webhook → Queue → handlers/comment.js
        │
        ▼
Guard: PR author == GITHUB_BOT_USERNAME ?
        │
        ├── no  → log + return (no clone, no Claude run, no reply)
        │
        └── yes ↓
                Clone PR branch (shallow)
                        │
                        ▼
                claude -p (custom prompt) → { actionable, summary, reason }
                        │
                        ├── actionable     → Edit files → commit + push → reply ✅
                        └── not actionable → log + return (silent on the PR)
```

### B. Review-request workflow

```
PR review_requested for $GITHUB_REVIEW_REQUEST_USER
        │
        ▼
Webhook → Queue → handlers/reviewRequest.js
        │
        ▼
Full clone (head + base for diffing)
        │
        ▼
claude -p /review  (built-in slash command, headless)
        │
        ▼
GitHub API: POST /pulls/{n}/reviews   (event: COMMENT)
```

Both workflows go through the same Express server, HMAC-verified webhook, and a single in-memory job queue.

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
cd clauditor
cp .env.example .env
```

Edit `.env` (see `.env.example` for the full list):

```env
# Required
GITHUB_TOKEN=ghp_your_token_here
GITHUB_WEBHOOK_SECRET=your_random_secret_string
GITHUB_BOT_USERNAME=your-github-username       # also acts as the PR-author allow-list

# Optional — enables Workflow B (auto-review when this user is requested)
GITHUB_REVIEW_REQUEST_USER=your-github-username

# Optional — only needed if `tailscale` is not on PATH inside scripts
# (common on macOS when only Tailscale.app is installed)
# TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale
```

The server loads `.env` automatically via [`dotenv`](https://www.npmjs.com/package/dotenv), so `npm start` works as well as `./start.sh`.

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
| Events | ✅ Pull request review comments, ✅ Pull request reviews, ✅ Issue comments, ✅ Pull requests |

### Supported event types

| GitHub event | What it covers | Action |
|---|---|---|
| `pull_request_review_comment` | Inline comment on a specific line of code in a review | Apply targeted fix |
| `pull_request_review` | Review summary (Approve / Request changes / Comment) | Apply targeted fix |
| `issue_comment` | Plain comment on the PR conversation tab (PR-attached only) | Apply targeted fix |
| `pull_request` (`review_requested`) | Configured user requested as PR reviewer | Run `claude -p /review` and post a formal review |

Notes:
- `issue_comment` also fires for plain issues — the bot ignores those. For PR-attached issue comments the head ref isn't in the payload, so the bot fetches the PR via the GitHub API to learn the branch.
- `pull_request` covers many actions; only `review_requested` is processed, and only when the requested reviewer matches `GITHUB_REVIEW_REQUEST_USER`. Team review requests are ignored. Leave the env var unset to disable the feature.

### Comment-handler scoping rules

The comment handler (Workflow A) applies two important guards before doing any work:

1. **PR-author scope** — the bot only acts on PRs **authored by `GITHUB_BOT_USERNAME`**. Comments on someone else's PR are logged and skipped (no clone, no Claude run, no commit, no reply). This prevents the bot from pushing commits to branches you don't own.
2. **Silent on non-actionable feedback** — when Claude decides the comment is vague, subjective, already-handled, or simply not a request for a change, the bot logs the reason locally and posts **nothing** on the PR. Only successful fixes generate a reply on GitHub.

Together these mean the bot is silent on the PR unless it has actually made a commit on your behalf.

### Re-triggering on an existing comment

If you've already posted feedback on a PR and then realize you'd like Clauditor to act on it, you don't need to delete and repost. **Edit the existing comment to include the trigger phrase** (default: `Clauditor verify this`, configurable via `CLAUDITOR_TRIGGER_PHRASE`).

- Only `issue_comment.edited` events with the phrase trigger the workflow. Edits without the phrase are ignored.
- The phrase itself is stripped before Claude sees the body, so it doesn't pollute the prompt or commit message.
- All the usual guards still apply (PR-author scope, protected branches, etc.).
- The bot's own replies use a different commenter, so editing them won't loop back into the workflow.

---

## Safety Features

| Concern | How It's Handled |
|---------|-----------------|
| Fake webhooks | HMAC-SHA256 signature verification on every request (timing-safe) |
| Bot reply loops | Ignores comments from `GITHUB_BOT_USERNAME` |
| Accidental pushes to main | `PROTECTED_BRANCHES` list blocks any push |
| Pushes to PRs you don't own | Comment handler only acts on PRs **authored by `GITHUB_BOT_USERNAME`**; comments on someone else's PR are skipped before any clone or Claude run |
| Noise on PR threads | Bot stays silent when feedback is non-actionable — no "🤖 nothing to do" replies |
| Runaway Claude (comment) | `--max-turns 10` + `CLAUDE_TIMEOUT_MS` limit |
| Runaway Claude (review) | `--max-turns 50` + `CLAUDE_REVIEW_TIMEOUT_MS` limit (separate, larger) |
| Concurrent jobs | In-memory FIFO queue serializes all jobs (single worker) |
| Claude changes nothing | Detects empty `git status`, throws error instead of empty commit |
| Token leakage | Auth flows through `git -c http.extraHeader=…` instead of being baked into the remote URL |
| Auth misconfig surfaces clearly | 401 / API-key errors are decoded from Claude's JSON envelope into the rejection message |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | ✅ | — | GitHub PAT with repo access |
| `GITHUB_WEBHOOK_SECRET` | ✅ | — | Webhook HMAC secret |
| `GITHUB_BOT_USERNAME` | ✅ | — | Your GitHub username (for loop prevention) |
| `GITHUB_REVIEW_REQUEST_USER` | | _empty_ | When this user is requested as a PR reviewer, the bot runs `/review` and posts a formal review. Empty disables the feature. |
| `CLAUDITOR_TRIGGER_PHRASE` | | `Clauditor verify this` | Editing an existing issue_comment to include this phrase re-triggers the comment workflow on that comment. Case-insensitive. Empty disables `issue_comment.edited` handling. |
| `PORT` | | `3000` | Local server port |
| `PROTECTED_BRANCHES` | | `main,master,develop` | Branches bot won't push to |
| `GIT_EMAIL` | | `pr-bot@localhost` | Git commit email |
| `GIT_NAME` | | `PR Review Bot` | Git commit name |
| `CLAUDE_TIMEOUT_MS` | | `300000` | Max time for the comment handler's Claude run (ms) |
| `CLAUDE_REVIEW_TIMEOUT_MS` | | `4 × CLAUDE_TIMEOUT_MS` | Max time for `/review` jobs — reviews are heavier than comment fixes (ms) |
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

**Not actionable** → the bot stays silent on the PR. The reason is logged locally for debugging, but no comment is posted (this avoids noise on threads where Claude has nothing useful to add).

---

## File Structure

```
clauditor/
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
│   ├── handlers/
│   │   ├── comment.js         # Review/issue-comment orchestration
│   │   └── reviewRequest.js   # `/review` orchestration on review-request
│   ├── queue.js               # In-memory job queue (serialized)
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
pm2 start src/server.js --name clauditor
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
