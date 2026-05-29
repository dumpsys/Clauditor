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
        ├── no  → log + return (no triage, no clone, no Claude run, no reply)
        │
        └── yes ↓
                Triage: claude -p (no tools, max-turns 1) → { skip, reason }
                        │
                        ├── skip → log + return (no clone — saved expensive work)
                        │
                        └── proceed ↓
                                Clone PR branch (shallow)
                                        │
                                        ▼
                                claude -p (full prompt) → { actionable, summary, reason }
                                        │
                                        ├── actionable     → Edit files → commit + push → reply ✅
                                        └── not actionable → log + return (silent on the PR)
```

### C. Sentry crash-to-PR workflow

```
Sentry issue (new / regression) for JS/TS/RN project
        │
        ▼
Webhook → verifySentrySignature → sentryQueue (parallel, dedup by issue ID)
        │
        ▼
handlers/sentryIssue.js
        │
        ├── Source-map gate (skip + Sentry-comment if frames are minified)
        │
        ├── Branch `sentry-fix/<issueId>` exists on GitHub?
        │       ├── yes → clone it (incremental fix on the existing PR)
        │       └── no  → clone base branch + create the new branch locally
        │
        ├── claude -p (Sentry-specific prompt: stack + source context + breadcrumbs)
        │       │
        │       ├── actionable:false → Sentry-comment "no fix proposed: <reason>"
        │       └── actionable:true ↓
        │
        ├── git commit + push
        ├── Open PR if none exists (draft unless confidence: "high")
        └── Sentry-comment with PR link
```

See [`docs/sentry-integration.md`](./docs/sentry-integration.md) for the full design.

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

The comment handler (Workflow A) applies three guards, each cheaper than the next, before running the heavyweight flow:

1. **PR-author scope** — the bot only acts on PRs **authored by `GITHUB_BOT_USERNAME`**. Comments on someone else's PR are logged and skipped (no clone, no triage, no Claude run, no reply). This prevents the bot from pushing commits to branches you don't own.
2. **Cheap triage pass** — before cloning anything, the handler asks Claude (no tools, single turn) whether the comment plausibly requires a code change. Pure praise, lgtm, questions, discussion, CI complaints — all skipped without ever cloning the repo. The triage is biased toward "proceed" when in doubt: the full flow is the second-line filter.
3. **Silent on non-actionable feedback** — even after triage proceeds, the full Claude run can still decide the change isn't warranted (e.g., once it sees the code, the request is already implemented). In that case the bot logs the reason locally and posts **nothing** on the PR. Only successful fixes generate a reply.

Together these mean the bot is silent on the PR unless it has actually made a commit on your behalf, and the expensive clone+Claude path runs only when the comment has at least a plausible chance of being actionable.

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
| `GIT_EMAIL` | | `pr-bot@localhost` | Git commit email (ignored when `GITHUB_NOREPLY_USER_ID` is set) |
| `GIT_NAME` | | `PR Review Bot` | Git commit name |
| `GITHUB_NOREPLY_USER_ID` | | — | Bot account's numeric GitHub user ID. When set, commits use the GitHub no-reply email (`<id>+<username>@users.noreply.github.com`) — required if the account keeps its email private, otherwise pushes fail with `GH007` |
| `CLAUDE_TIMEOUT_MS` | | `300000` | Max time for the comment handler's Claude run (ms) |
| `CLAUDE_REVIEW_TIMEOUT_MS` | | `4 × CLAUDE_TIMEOUT_MS` | Max time for `/review` jobs — reviews are heavier than comment fixes (ms) |
| `LOG_LEVEL` | | `info` | `debug` / `info` / `warn` / `error` |
| `WEBHOOK_BODY_LIMIT` | | `5mb` | Max request body size accepted by `express.json()`. Override Express's 100 KB default so real Sentry/GitHub payloads (stack traces, large PR reviews) don't 413 before HMAC verification. Accepts `bytes`-style strings: `500kb`, `5mb`, `10mb`, etc. |
| `LOG_UTC` | | _empty_ | When set to `true`, log timestamps are emitted in UTC (e.g. `…Z`) instead of the machine's local time with offset (e.g. `…+07:00`). |
| `SENTRY_CLIENT_SECRET` | | _empty_ | Internal Integration client secret. Setting this enables Workflow C and makes the other `SENTRY_*` vars required. |
| `SENTRY_AUTH_TOKEN` | when Sentry enabled | — | Sentry API token (`event:read`, `project:read`, `issue:write`) |
| `SENTRY_PROJECT_REPO_MAP` | when Sentry enabled | — | `slug-a:owner/repo-a,slug-b:owner/repo-b` |
| `SENTRY_API_BASE_URL` | | `https://sentry.io/api/0` | Self-hosted Sentry endpoint override |
| `SENTRY_BASE_BRANCH` | | `main` | Branch new fix branches are created from |
| `SENTRY_BRANCH_PREFIX` | | `sentry-fix/` | Branch name is `${prefix}${issueId}` |
| `SENTRY_MIN_EVENT_COUNT` | | `1` | Skip issues below this event-count threshold |
| `SENTRY_MAX_CONCURRENT_JOBS` | | `2` | Parallel Sentry workers; duplicates per issue ID are coalesced |
| `SENTRY_CLAUDE_TIMEOUT_MS` | | `600000` | Per-job Claude timeout for Sentry fixes (ms) |

---

## What Claude Decides

Claude evaluates each comment and returns a structured JSON decision:

**Actionable** → Claude modifies the code, commits, pushes, and replies:
```
✅ **Addressed by Claude Code** (commit [`a1b2c3d`](…/commit/a1b2c3d…))

Re: [original comment](…)

**What was done:** Renamed variable `n` to `userCount` in auth.js lines 42-67

_This change was applied automatically. Please review the commit to confirm it meets your expectations._
```

The reviewer's feedback is linked (not inline-quoted) to keep the reply compact, and the commit message describes what changed rather than echoing the comment.

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
│   │   ├── webhook.js         # POST /webhook            (GitHub)
│   │   ├── sentryWebhook.js   # POST /sentry-webhook     (Sentry, Workflow C)
│   │   └── health.js          # GET  /health
│   ├── middleware/
│   │   ├── verifySignature.js       # GitHub HMAC-SHA256 signature middleware
│   │   └── verifySentrySignature.js # Sentry HMAC-SHA256 signature middleware
│   ├── services/
│   │   ├── claude.js          # Claude Code CLI invocation (+ Sentry-fix prompt)
│   │   ├── git.js             # Clone, commit, push operations
│   │   ├── github.js          # GitHub REST API client
│   │   └── sentry.js          # Sentry REST API client + event helpers
│   ├── handlers/
│   │   ├── comment.js         # Review/issue-comment orchestration
│   │   ├── reviewRequest.js   # `/review` orchestration on review-request
│   │   └── sentryIssue.js     # Sentry crash-to-PR orchestration
│   ├── queue.js               # In-memory job queue (serialized, GitHub events)
│   ├── sentryQueue.js         # Parallel worker pool with in-flight dedup
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

---

## License

Licensed under the [Apache License 2.0](./LICENSE).
