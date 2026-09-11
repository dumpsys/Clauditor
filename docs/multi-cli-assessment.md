# Multi-CLI Support — Assessment

**Branch:** `research/multi-cli-support`
**Last verified:** 2026-09-11 against OpenAI Codex CLI 0.154.0 and the current official non-interactive-mode documentation.
**Question:** Can Clauditor support harnesses other than Claude Code — specifically OpenAI's Codex CLI (`codex exec`) and Google's Antigravity CLI (`agy`) — so operators who prefer those tools can adopt the workflow?

The Codex sections were revalidated for this implementation. The Antigravity
notes remain from the original assessment and must be revalidated before that
adapter is implemented.

**Short answer:** Yes. Claude Code and Codex CLI are now implemented behind one harness boundary. Codex uses `--output-schema` for structured decisions, while reviews use a shared portable prompt. Antigravity remains a future adapter.

### Implementation status

- Portable foundation: complete (`src/harnesses/`, generic prompts, portable review workflow).
- Codex adapter: complete (`HARNESS=codex`, schema-constrained decisions, explicit sandboxes, isolated configuration, regression tests).
- Antigravity adapter: still deferred pending a stable headless-auth story.
- Important CLI change since the original assessment: Codex CLI 0.154.0
  exposes `--ask-for-approval` as a top-level `codex` option, not as an option
  following `codex exec`. The adapter avoids relying on that placement, uses
  explicit sandbox modes, and does not opt into `--approve-for-me`.

---

## 1. What was Claude-specific before the portable foundation

Audit of every line that assumes Claude Code (not language-specific things like JS/TS in the Sentry prompt, which are user-codebase choices):

| Where | What it assumes |
|---|---|
| `src/services/claude.js:194` | Binary name `claude` hardcoded in `spawn` |
| `src/services/claude.js:27–33, 53–57, 80–84, 121–124` | Flag set: `-p`, `--output-format json`, `--allowedTools <list>`, `--max-turns N` |
| `src/services/claude.js:29` etc. | Tool whitelist using Claude Code's tool names (`Read,Edit,Write,Bash,Glob,Grep`) |
| `src/services/claude.js:81` | Slash command `/review` — Claude Code's built-in PR review |
| `src/services/claude.js:97`, `parseClaudeOutput` | Output envelope `{type:"result", result:"<text>"}` |
| `src/services/claude.js:222–241` | Error envelope `{is_error, api_error_status, result}` + `ANTHROPIC_API_KEY` auth hint |
| `src/config.js:89,92,121` | Env vars `CLAUDE_TIMEOUT_MS`, `CLAUDE_REVIEW_TIMEOUT_MS`, `SENTRY_CLAUDE_TIMEOUT_MS` |
| `src/services/claudePrompts.js` (Sentry prompt) | Refers to "Read tool", "Bash tool" — Claude Code's tool *names* |
| `src/handlers/*` | Imports specific `runClaudeCode` / `runClaudeReview` / `runClaudeTriage` / `runClaudeSentryFix` |

What was **already** harness-agnostic before implementation:
- The four workflows (review-comment-fix, PR review-on-request, Sentry crash-to-PR, triage) — abstract behavior, not Claude-tied
- The JSON decision *schemas* (`{actionable, summary, files_modified, ...}` and `{skip, reason}` and `{actionable, confidence, root_cause, ...}`) — every modern coding agent can be instructed to emit these
- The git operations, GitHub API client, Sentry client, queue, signature middleware — none touch the model
- The prompt *methodology* (root-cause discipline, verify-with-tests, anti-patterns) is portable; only the tool-name references inside it are Claude-flavored

---

## 2. How the three CLIs compare

### 2.1 Claude Code (`claude`) — current

| Aspect | Detail |
|---|---|
| Headless invocation | `claude -p "<prompt>"` or prompt via stdin |
| Structured output | `--output-format json` → `{type:"result", result:"<text>"}` (still need to extract a fenced JSON block from `result`) |
| Tool gating | Named whitelist: `--allowedTools "Read,Edit,Write,Bash,Glob,Grep"` |
| Iteration bound | `--max-turns N` (hard cap) |
| Slash commands | Yes, built-in (e.g. `/review`) — works in headless mode |
| Auth | `claude auth login` or `ANTHROPIC_API_KEY` |
| Error reporting | JSON envelope on stdout with `is_error: true, api_error_status` |

### 2.2 OpenAI Codex CLI (`codex exec`)

| Aspect | Detail |
|---|---|
| Headless invocation | `codex exec "<prompt>"` or prompt via stdin — dedicated non-interactive subcommand |
| Structured output | `stdout` contains the final agent message; `--json` switches to JSONL events; `-o/--output-last-message` also writes the final message to a file; `--output-schema <schema.json>` constrains the final response ([docs](https://learn.chatgpt.com/docs/non-interactive-mode)) |
| Tool gating | Sandbox-based: `--sandbox read-only`, `workspace-write`, or `danger-full-access`. CLI 0.154.0 exposes `--ask-for-approval` before the `exec` subcommand rather than after it; Clauditor does not depend on that global option or opt into `--approve-for-me`. |
| Iteration bound | No explicit max-turns; relies on model self-termination + shell timeout |
| Run isolation | `--ephemeral --ignore-user-config --ignore-rules`; `project_doc_max_bytes=0` suppresses repository `AGENTS.md`, and workspace-write excludes the shared `$TMPDIR` and `/tmp` roots. Clauditor also applies a restricted shell-environment policy so child commands do not inherit token/secret/key variables. |
| Auth | Saved `codex login` authentication, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, or workload identity (deployment-dependent) |
| Error reporting | Non-zero exit + progress/diagnostics on stderr; structured events are available with `--json` |

**The implementation uses `--output-schema`.** Codex constrains the final stdout response to the workflow's JSON Schema, eliminating the fenced-block extraction needed by the Claude adapter.

The implemented headless shape is:
```bash
codex exec \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  -c project_doc_max_bytes=0 \
  --sandbox workspace-write \
  -c 'shell_environment_policy.inherit="core"' \
  -c shell_environment_policy.ignore_default_excludes=false \
  -c sandbox_workspace_write.exclude_tmpdir_env_var=true \
  -c sandbox_workspace_write.exclude_slash_tmp=true \
  --output-schema /tmp/decision.schema.json \
  -
```

The prompt is sent on stdin. Review-only runs use `--sandbox read-only` and
plain final-message stdout; mutating comment/Sentry workflows use
`workspace-write` plus strict JSON schemas.

### 2.3 Google Antigravity CLI (`agy`)

| Aspect | Detail |
|---|---|
| Headless invocation | `agy -p "<prompt>"` (alias `--print`) |
| Structured output | `--output-format json` ([docs](https://antigravity.google/docs/cli/using)) — exact envelope shape less well documented than Codex; treat as "needs reverse-engineering before commit" |
| Tool gating | Permissions via `settings.json` `allow`/`deny` arrays, or `--dangerously-skip-permissions` for full auto |
| Iteration bound | `--print-timeout` (wall-clock, default 5m). No max-turns equivalent surfaced. |
| Slash commands | Yes — TUI-leaning |
| Auth | Google OAuth on first run; cached in OS keyring (Keychain / Credential Manager / libsecret). No env var by default (an [open community request](https://discuss.ai.google.dev/t/agy-cli-allow-to-bring-own-api-key/147289) exists for bring-your-own-key) |
| Misc | Pure Go, fast startup, no Node dep |

The auth model is the awkward bit for our use case: a headless server can't run an interactive OAuth flow. Antigravity does have a remote-session detection that prints an auth URL + one-time code, but for a long-running background process that's a one-time setup, not an automatic on-boarding. We'd document this caveat.

---

## 3. Common shape vs. real differences

Every harness fits the same conceptual shape:

```
(prompt, workdir, capabilities, timeout) → (raw stdout, final structured decision)
```

But the surfaces differ in three load-bearing ways:

### 3.1 Tool gating: whitelist vs sandbox vs permission file

- Claude: **named whitelist** (`Read,Edit,Bash,Grep,Glob,Write`)
- Codex: **sandbox** with capability levels (`workspace-write` covers read+edit+shell)
- Antigravity: **permission file** with allow/deny arrays per-command

These don't map 1:1. The right abstraction is *capabilities* — `[read_files, edit_files, run_shell, search]` — and each adapter translates:

| Capability | Claude flag | Codex flag | Antigravity flag |
|---|---|---|---|
| read_files | `--allowedTools Read,Glob,Grep` | `--sandbox read-only` | settings.json: `read:*` allow |
| edit_files | `…,Edit,Write` | `--sandbox workspace-write` | `write:*` allow |
| run_shell | `…,Bash` | `--sandbox workspace-write` | `shell:*` allow |
| (no tools, judgment only — triage) | `--allowedTools ""` | isolated temp directory + `--sandbox read-only` | settings.json: empty allow |

### 3.2 Structured output: prompt-instruction vs schema enforcement

- Claude / Antigravity: prompt instructs "output ONLY this JSON object" + downstream regex extracts it. Reliable but not enforced.
- Codex with `--output-schema`: hard-enforced; final stdout *is* JSON matching the schema. No envelope unwrap, no regex extraction.

The adapter parsers diverge here. Each workflow exposes the same public method
on both adapters. Codex parses schema-constrained final-message stdout with
`JSON.parse`; Claude unwraps its result envelope and extracts fenced or inline
JSON.

### 3.3 The former `claude -p /review` shortcut

Workflow B formerly used Claude Code's built-in `/review` slash command. It now uses a repository-owned review prompt for both Claude and Codex.

This was the right move regardless of multi-CLI because it:

- Removes a dependency on Claude Code's specific slash-command catalog evolving in a compatible direction.
- Lets us tune and test the review style.
- Makes the Workflow B test surface symmetric with Workflow A and C.

This change is independently valuable and removed the only Claude-Code-specific behavior that was not portable.

---

## 4. Implemented architecture

### 4.1 Adapter interface

```js
const harness = await getHarness();
await harness.runTriage(context);
await harness.runCommentFix(workDir, context);
await harness.runReview(workDir, context);
await harness.runSentryFix(workDir, context);
```

### 4.2 File layout

```
src/
├─ harnesses/
│  ├─ index.js              # getHarness(name) factory; reads HARNESS env
│  ├─ claude.js             # current spawn/parse code, refactored
│  ├─ codex.js              # codex exec adapter (uses --output-schema)
│  └─ schemas.js            # strict Codex structured-output schemas
├─ prompts/
│  └─ index.js              # portable workflow prompts
├─ services/                 # git, GitHub, Sentry (unchanged boundary)
└─ handlers/                 # call the selected adapter's workflow method
```

### 4.3 Configuration

```
HARNESS=claude            # claude | codex (default: claude)
HARNESS_TIMEOUT_MS=300000 # applies to whichever harness is selected
HARNESS_REVIEW_TIMEOUT_MS=1200000
SENTRY_HARNESS_TIMEOUT_MS=600000

# Existing CLAUDE_* env vars stay supported as aliases for backwards compat,
# but the docs steer users toward HARNESS_*.
```

### 4.4 Prompt portability

In `src/prompts/` references like *"Open the file referenced in the top frame with the Read tool"* became *"Open the file referenced in the top frame"*. Each harness understands "read the file" as an intent. Tool names drop out; capabilities are gated by the harness adapter.

The eight-step Sentry-fix methodology, the JSON schemas, the anti-pattern lists — all stay verbatim. They're already harness-agnostic; only the tool labels are renamed.

---

## 5. What doesn't port cleanly

| Issue | Severity | Mitigation |
|---|---|---|
| Behavior differences between models | High | Same prompt, different model → different fix quality. Each harness needs its own integration test suite (or at minimum a smoke test). The `confidence: high\|medium\|low` field already exists and naturally absorbs cross-model quality differences. |
| Codex has no `--max-turns` | Medium | Codex relies on shell timeout + model self-termination. Less precise than Claude's hard turn cap. Document the trade-off; our existing timeout knobs still apply via shell. |
| Antigravity headless auth on a server | Medium | OAuth + keyring requires one-time interactive setup. Document the procedure. Watch the open issue for bring-your-own-key support. |
| Workflow B `/review` slash command | Resolved | Repository-owned portable review prompt is used by both adapters. |
| Codex `--json` stream is JSONL, not a single envelope | Resolved | Use `--output-schema` and parse final-message stdout; no event-stream walking. |
| Test fixtures encode Claude output envelope | Resolved | Adapter-specific tests live in `test/harnesses/`. |

---

## 6. Implementation status against the original estimate

**Phase 1 — Claude + Codex: complete**

- Extracted the `src/harnesses/` boundary and retained all four workflow entry points.
- Moved existing Claude behavior into `harnesses/claude.js`.
- Implemented `harnesses/codex.js` with strict schemas and explicit read/write sandboxes.
- Made prompts tool-agnostic and replaced `/review` with a portable review prompt.
- Added `HARNESS=codex`, generic timeout settings, adapter tests, and live smoke checks.

**Phase 2 — Antigravity: deferred**

- Revalidate the CLI, output envelope, permission model, and unattended authentication against a live install before estimating or implementing it.

**Phase 3 — Docs + CI**

- README, `.env.example`, and this assessment are updated.
- A live CI matrix remains optional because it requires harness credentials and incurs model usage.

As expected, this was not a rewrite: queues, API clients, signature verification, route logic, and git orchestration remain outside the harness boundary.

---

## 7. Follow-up recommendation

Claude + Codex support is implemented. Remaining work is deliberately limited to:

1. Exercise both installed harnesses periodically with the smoke-test prompts as their CLIs evolve.
2. Add Antigravity later, after confirming its output envelope and unattended authentication against a live install.

---

## Sources

- [Codex CLI | OpenAI](https://learn.chatgpt.com/docs/codex/cli)
- [Non-interactive mode | OpenAI](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex commands | OpenAI](https://learn.chatgpt.com/docs/reference/commands)
- [Codex configuration reference | OpenAI](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Sandboxing | OpenAI](https://learn.chatgpt.com/docs/sandboxing)
- [Agent approvals and security | OpenAI](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Google Antigravity CLI Overview](https://antigravity.google/docs/cli/overview)
- [Using AGY CLI | Google Antigravity Docs](https://antigravity.google/docs/cli/using)
- [Antigravity CLI Features](https://antigravity.google/docs/cli/features)
- [Antigravity CLI: A Hands-On Guide to Google's Terminal Coding Agent | DEV](https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7)
- [AGY CLI Allow to bring own API key | Google AI Developers Forum](https://discuss.ai.google.dev/t/agy-cli-allow-to-bring-own-api-key/147289)
