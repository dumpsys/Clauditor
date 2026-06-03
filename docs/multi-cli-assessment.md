# Multi-CLI Support — Assessment

**Branch:** `research/multi-cli-support`
**Question:** Can Clauditor support harnesses other than Claude Code — specifically OpenAI's Codex CLI (`codex exec`) and Google's Antigravity CLI (`agy`) — so operators who prefer those tools can adopt the workflow?

**Short answer:** Yes, feasible. The abstraction is natural (every harness has a `headless prompt → JSON decision → file edits → tests` shape) and one of the three (Codex via `--output-schema`) is actually a *cleaner* fit for structured output than what we do today. The real work is (a) writing tool-agnostic prompt text, (b) replacing our `claude -p /review` shortcut with a portable review prompt, and (c) maintaining N adapter parsers as each CLI evolves. Rough scope: **3–5 focused days** for Claude + Codex, +0.5 day for Antigravity.

---

## 1. What's Claude-specific today

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

What is **already** harness-agnostic (good news):
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
| Headless invocation | `codex exec "<prompt>"` — dedicated non-interactive subcommand (separate from interactive TUI) |
| Structured output | **Three options:** `--json` for a JSONL event stream; `-o/--output-last-message <path>` for final message to file; `--output-schema <schema.json>` to *enforce* a JSON Schema on the final output ([docs](https://developers.openai.com/codex/noninteractive)) |
| Tool gating | Sandbox-based: `--sandbox workspace-write` (read + edit + run inside cwd); `--sandbox read-only`; `--sandbox danger-full-access`. Plus `--ask-for-approval never \| on-request \| untrusted` |
| Iteration bound | No explicit max-turns; relies on model self-termination + shell timeout |
| Slash commands | Yes ([docs](https://developers.openai.com/codex/cli/slash-commands)) — TUI-leaning; no documented `/review` equivalent we could reuse for free |
| Auth | `OPENAI_API_KEY` env var or `codex login` |
| Error reporting | Non-zero exit + stderr; structured if `--json` |

**The `--output-schema` flag is a feature we don't currently exploit.** Codex will *guarantee* the final stdout output conforms to a supplied JSON Schema — meaning we get parse-safe decisions without prompt-instruction-and-pray. For our `{actionable, confidence, summary, files_modified, root_cause, ...}` shape this would eliminate an entire class of "Claude emitted prose around the JSON" parse-failure cases.

The typical headless invocation for our use case:
```bash
codex exec \
  --sandbox workspace-write \
  --ask-for-approval never \
  --output-schema /tmp/decision.schema.json \
  -o /tmp/last.json \
  "<prompt>"
```

### 2.3 Google Antigravity CLI (`agy`)

| Aspect | Detail |
|---|---|
| Headless invocation | `agy -p "<prompt>"` (alias `--print`) |
| Structured output | `--output-format json` ([docs](https://antigravity.google/docs/cli-using)) — exact envelope shape less well documented than Codex; treat as "needs reverse-engineering before commit" |
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
| (no tools, judgment only — triage) | `--allowedTools ""` | `--sandbox read-only` + `--ask-for-approval never` | settings.json: empty allow |

### 3.2 Structured output: prompt-instruction vs schema enforcement

- Claude / Antigravity: prompt instructs "output ONLY this JSON object" + downstream regex extracts it. Reliable but not enforced.
- Codex with `--output-schema`: hard-enforced; final stdout *is* JSON matching the schema. No envelope unwrap, no regex extraction.

The adapter parser will diverge here. Each adapter exposes a `parseDecision(rawOutput, schema)` method. Codex's implementation is just `JSON.parse(stdout)`; the others are the existing fenced/inline JSON extraction.

### 3.3 The `claude -p /review` shortcut

The Workflow B "auto-review when someone is requested as a reviewer" handler uses Claude Code's built-in `/review` slash command. Codex and Antigravity have slash commands too, but neither documents a `/review` equivalent we can rely on through headless mode without iteration.

**The right move regardless of multi-CLI: write our own review prompt and use it for all harnesses including Claude.** Reasons:
- It's one extra prompt template, an afternoon to write.
- Removes a dependency on Claude Code's specific slash-command catalog evolving in a compatible direction.
- Lets us tune the review style (today we get whatever Claude Code's `/review` does; if that ever changes, we have no recourse).
- Makes the Workflow B test surface symmetric with Workflow A and C.

This change is independently valuable and clears the only Claude-Code-specific behavior we *can't* express in a portable prompt.

---

## 4. Proposed architecture

### 4.1 Adapter interface (illustrative — TBD on detail)

```js
// src/harnesses/types.js
/**
 * @typedef {Object} HarnessRunOptions
 * @property {string} prompt
 * @property {string} workDir
 * @property {("read_files"|"edit_files"|"run_shell"|"search")[]} capabilities
 * @property {object} [schema]            // JSON Schema for the decision; codex enforces, others rely on prompt
 * @property {number} timeoutMs
 * @property {number} [maxTurns]          // honored by claude; ignored by others
 */
export class Harness {
  /** Invoke headless, return parsed decision + raw text. */
  async runWithDecision(opts) {
    /* returns { decision, rawText } */
  }
}
```

### 4.2 File layout

```
src/
├─ harnesses/
│  ├─ index.js              # getHarness(name) factory; reads HARNESS env
│  ├─ claude.js             # current spawn/parse code, refactored
│  ├─ codex.js              # codex exec adapter (uses --output-schema)
│  ├─ antigravity.js        # agy --print adapter
│  └─ types.js              # interface + capability constants
├─ services/
│  ├─ prompts/              # rename claudePrompts.js → prompts/sentry.js, prompts/comment.js, prompts/review.js
│  └─ … (unchanged)
└─ handlers/                # call `harness.runWithDecision(...)` instead of runClaudeX
```

### 4.3 Configuration

```
HARNESS=claude            # claude | codex | antigravity (default: claude)
HARNESS_TIMEOUT_MS=300000 # applies to whichever harness is selected
HARNESS_REVIEW_TIMEOUT_MS=1200000
SENTRY_HARNESS_TIMEOUT_MS=600000

# Existing CLAUDE_* env vars stay supported as aliases for backwards compat,
# but the docs steer users toward HARNESS_*.
```

### 4.4 Prompt portability

In `src/services/prompts/` references like *"Open the file referenced in the top frame with the Read tool"* become *"Open the file referenced in the top frame"*. Each harness already understands "read the file" as an intent. The tool *names* drop out, the *capabilities* are gated by the harness adapter.

The eight-step Sentry-fix methodology, the JSON schemas, the anti-pattern lists — all stay verbatim. They're already harness-agnostic; only the tool labels are renamed.

---

## 5. What doesn't port cleanly

| Issue | Severity | Mitigation |
|---|---|---|
| Behavior differences between models | High | Same prompt, different model → different fix quality. Each harness needs its own integration test suite (or at minimum a smoke test). The `confidence: high\|medium\|low` field already exists and naturally absorbs cross-model quality differences. |
| Codex has no `--max-turns` | Medium | Codex relies on shell timeout + model self-termination. Less precise than Claude's hard turn cap. Document the trade-off; our existing timeout knobs still apply via shell. |
| Antigravity headless auth on a server | Medium | OAuth + keyring requires one-time interactive setup. Document the procedure. Watch the open issue for bring-your-own-key support. |
| Workflow B `/review` slash command | Low | Replace with our own portable review prompt (good change regardless). |
| Codex `--json` stream is JSONL, not a single envelope | Low | Use `--output-schema` + `-o <path>` instead and parse the file. Avoids JSONL stream walking entirely. |
| Test fixtures encode Claude output envelope | Low | Tests in `test/services/claude.test.js` need to be parameterized per adapter (or split into `test/harnesses/{claude,codex,antigravity}.test.js`). Easy mechanical change. |

---

## 6. Scope estimate

**Phase 1 — Claude + Codex (~3 days)**
- Extract `src/harnesses/` directory and interface (½ day)
- Move existing Claude code into `harnesses/claude.js`, no behavior change (½ day)
- Implement `harnesses/codex.js` using `codex exec --output-schema` + `--sandbox workspace-write` + `--ask-for-approval never` (1 day)
- Make prompts tool-agnostic; write portable `/review` prompt (½ day)
- Adapter selection via `HARNESS` env; per-harness tests (½ day)

**Phase 2 — Antigravity (~½ day extra)**
- Implement `harnesses/antigravity.js` once we've confirmed the `--output-format json` envelope shape against a live install
- Document the server-side OAuth one-time setup

**Phase 3 — Docs + CI (~½ day)**
- Update README, .env.example, architecture diagram
- Optional CI matrix that exercises each harness against a smoke-test prompt

**Total: ~3–5 focused days end-to-end.** Not a rewrite — most of the surface area (queue, git, GitHub API, Sentry API, signature verification, route logic, prompt methodology) is untouched.

---

## 7. Recommendation

**Go ahead, but in two pull requests:**

1. **First PR — portable foundation.** Extract the harness interface, move existing Claude code into `harnesses/claude.js` unchanged, replace `/review` with our own portable prompt, make tool names in prompts generic. Behavior on Claude stays identical. This is risk-free reorg that benefits readability whether or not we ever add another adapter.

2. **Second PR — Codex adapter.** Add `harnesses/codex.js` with `--output-schema`. Add `HARNESS=codex` selection. Add per-harness integration smoke tests. Document the trade-offs.

3. **Third PR (later) — Antigravity adapter.** Wait for either bring-your-own-key support or a clearer headless-auth story. The platform is still new; the cost/benefit is better in a few months.

This sequencing means each PR is small, reviewable, and reversible. It avoids a big-bang refactor that mixes concerns (architecture + new adapter + new tests + new docs).

---

## Sources

- [Non-interactive mode – Codex | OpenAI Developers](https://developers.openai.com/codex/noninteractive)
- [Command line options – Codex CLI | OpenAI Developers](https://developers.openai.com/codex/cli/reference)
- [Sandbox – Codex | OpenAI Developers](https://developers.openai.com/codex/concepts/sandboxing)
- [Agent approvals & security – Codex | OpenAI Developers](https://developers.openai.com/codex/agent-approvals-security)
- [Slash commands in Codex CLI | OpenAI Developers](https://developers.openai.com/codex/cli/slash-commands)
- [Build Code Review with the Codex SDK | OpenAI Cookbook](https://developers.openai.com/cookbook/examples/codex/build_code_review_with_codex_sdk)
- [Headless Execution Mode (codex exec) | DeepWiki](https://deepwiki.com/openai/codex/4.2-headless-execution-mode-(codex-exec))
- [Google Antigravity CLI Overview](https://antigravity.google/docs/cli-overview)
- [Using AGY CLI | Google Antigravity Docs](https://antigravity.google/docs/cli-using)
- [Antigravity CLI Features](https://antigravity.google/docs/cli-features)
- [Antigravity CLI: A Hands-On Guide to Google's Terminal Coding Agent | DEV](https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7)
- [AGY CLI Allow to bring own API key | Google AI Developers Forum](https://discuss.ai.google.dev/t/agy-cli-allow-to-bring-own-api-key/147289)
