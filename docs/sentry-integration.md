# Sentry Crash-to-PR Workflow (Workflow C)

Adds a third workflow to Clauditor: when Sentry reports a new (or regressed)
issue, attempt an automated fix and open a draft PR.

Scope of the first iteration: **JavaScript / TypeScript / Node — including
React Native projects.** The architecture is language-agnostic, but the
Claude prompt, source-map heuristics, and verification steps are tuned for
JS/TS stacks first.

> 📐 See [`clauditor-sentry-flow.excalidraw`](./clauditor-sentry-flow.excalidraw)
> for the visual diagram of this workflow.

## Flow

```
Sentry issue alert (new / regression)
        │
        ▼
POST /sentry-webhook  →  verifySentrySignature
        │
        ▼
Filter: action ∈ {created, regression}
        │   project.slug → owner/repo (env-mapped, drop if unmapped)
        │   issue.count  ≥ SENTRY_MIN_EVENT_COUNT
        │   issue not currently in-flight (dedup)
        ▼
Enqueue → sentryQueue (parallel worker pool, max N concurrent, key=issueId)
        │
        ▼
handlers/sentryIssue.js
        │
        ├── Fetch latest event from Sentry API
        ├── Check source maps resolved (in_app frames have real paths)
        │       │
        │       └── no → log + comment back on Sentry "skipped: minified frames"
        │
        ├── branchName = `${SENTRY_BRANCH_PREFIX}${issueId}`
        ├── branch exists on GitHub?
        │       ├── yes → clone that branch                  (push-to-existing)
        │       └── no  → clone BASE_BRANCH + create branch  (fresh fix)
        │
        ├── claude -p  (Sentry-specific prompt, sees stack + breadcrumbs + tags)
        │       │
        │       ├── actionable:false → comment back on Sentry "no fix proposed: <reason>"
        │       └── actionable:true ↓
        │
        ├── git commit + push
        ├── PR exists for branch?
        │       ├── yes → reuse it (no PR creation; new commit shows up)
        │       └── no  → POST /pulls (draft: true unless confidence: "high")
        │
        └── Comment on Sentry issue with PR link
```

## Components

| File | Purpose |
|---|---|
| `src/routes/sentryWebhook.js` | `POST /sentry-webhook`, filters events, enqueues |
| `src/middleware/verifySentrySignature.js` | HMAC-SHA256 of raw body (header: `sentry-hook-signature`) |
| `src/services/sentry.js` | Sentry REST API client + helpers |
| `src/sentryQueue.js` | Parallel worker pool + in-flight dedup |
| `src/handlers/sentryIssue.js` | Orchestration: clone → fix → PR → notify Sentry |
| `src/services/claude.js` | New `runClaudeSentryFix` + `buildSentryPrompt` |
| `src/services/github.js` | New `branchExists`, `findOpenPRByHead`, `createPullRequest` |
| `src/services/git.js` | New `cloneAndCreateBranch` |

## Dedup & concurrency

- **In-flight Map** (`Map<issueId, Promise>`): a webhook arriving while the
  same `issueId` is being processed is dropped at the route layer with a
  `200 {dedup: "in-flight"}` response. This handles the "10 clients crashed
  simultaneously → 10 webhooks for the same issue" case.
- **Persistent dedup** is implicit: the next time the issue fires, the
  bot finds the branch already exists on GitHub and pushes to it instead of
  starting fresh. No local state file required.
- **Worker pool** is sized by `SENTRY_MAX_CONCURRENT_JOBS`. Different issues
  process in parallel; same issue is coalesced.

## Confidence-based PR draft state

Claude returns a `confidence: "high" | "medium" | "low"` field alongside
the usual `actionable / summary / files_modified / reason`. PRs are opened
as **drafts** by default; only `confidence: "high"` opens a regular PR.
Existing PRs are not flipped between draft/non-draft on subsequent commits.

## Source-map gate

For JS/TS/RN projects: the bot only proceeds when Sentry has resolved
source maps for the top in-app frame. Heuristic:

- `frame.in_app === true`
- `frame.filename` does not end with `.min.js` and is not obviously a bundle
  (no `static/js/main.<hash>.js` pattern)
- `frame.context_line` and `frame.pre_context` are present (Sentry only
  populates these after source-map resolution)

If the gate fails, the bot logs the reason and posts a Sentry comment
explaining why no PR was created.

## Sentry comments

The bot posts back on the Sentry issue in **all three** outcomes:

1. ✅ Success — PR link, commit SHA, confidence level
2. ⚠️ Investigated, no fix — Claude's reason (e.g. "root cause is in a
   third-party library; not actionable from this repo")
3. ⏭ Skipped — pre-flight failure (no source maps, project not mapped, etc.)

## Env vars

See `.env.example` for the canonical list. New variables:

```
SENTRY_CLIENT_SECRET          required — HMAC secret
SENTRY_AUTH_TOKEN             required — Sentry API auth (Bearer)
SENTRY_PROJECT_REPO_MAP       required — "slug-a:owner/repo,slug-b:owner/repo"
SENTRY_API_BASE_URL           default https://sentry.io/api/0
SENTRY_BASE_BRANCH            default main
SENTRY_BRANCH_PREFIX          default sentry-fix/
SENTRY_MIN_EVENT_COUNT        default 1
SENTRY_MAX_CONCURRENT_JOBS    default 2
SENTRY_CLAUDE_TIMEOUT_MS      default 600000 (10 min — heavier than comment fix)
```

## Not in this iteration

- Languages other than JS/TS/Node (Python, Go, Java, etc. will need
  tailored prompts and source-map equivalents)
- Cross-repo fixes (one Sentry issue → multiple repos)
- Sentry "resolved" webhook → close PR loop
- Persistent dedup beyond what GitHub branch existence gives us
