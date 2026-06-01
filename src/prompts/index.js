/**
 * Prompt builders — harness-agnostic.
 *
 * Previously these lived under `src/services/claudePrompts.js` and used
 * Claude-Code-flavored tool names ("the Read tool", "the Bash tool"). They
 * now live under `src/prompts/` so they can be consumed by any harness
 * (Claude Code, Codex CLI, Antigravity CLI). Tool references are written
 * in plain English ("read the file", "run the test command") rather than
 * with proper-noun tool names — every modern coding agent understands the
 * intent, and the harness adapter handles capability gating separately.
 *
 * Each builder is a pure function of its context object — no I/O, no
 * config reads beyond what's passed in. That keeps them trivially testable
 * (the test suite asserts the rendered text directly).
 */

/**
 * Cheap pre-flight triage for the PR-comment handler.
 *
 * Tells the agent: no codebase access, single-turn judgment, output {skip,
 * reason}. Used to short-circuit obviously non-actionable comments
 * (praise, questions, lgtm) before paying the cost of a clone + tool-using
 * run. The prompt is biased toward `skip: false` so genuine bugs aren't
 * dropped at this stage.
 */
export function buildTriagePrompt(context) {
  const fileLine = context.filePath ? `**File:** \`${context.filePath}\`` : "";
  const diffBlock = context.diffHunk
    ? `**Diff hunk:**\n\`\`\`diff\n${context.diffHunk}\n\`\`\``
    : "";

  return `
You are triaging a code review comment. You have NO access to the codebase. Make a single fast judgment from the comment text and (if provided) the diff hunk.

**PR title:** ${context.prTitle}
${fileLine}

**Comment from @${context.commenter}:**
${context.commentBody}

${diffBlock}

**Question:** Could this comment plausibly require a code change?

Mark \`skip: true\` ONLY if the comment is OBVIOUSLY not a request for code changes, such as:
- Pure praise / approval ("lgtm", "nice work", "looks good")
- Pure questions seeking explanation, with no implied change
- Pure discussion / opinion that doesn't request anything
- Comments about CI failures, deployment, process — things outside the code itself

Mark \`skip: false\` for ANYTHING that might warrant a fix:
- Suggestions to rename, refactor, fix bugs, add tests, simplify, etc.
- Pointing out unclear logic, errors, edge cases
- Specific feedback on the code in the diff hunk
- Anything ambiguous — when in doubt, do NOT skip

Output ONLY this JSON object as the very last thing you write:

\`\`\`json
{
  "skip": false,
  "reason": "one short sentence"
}
\`\`\`
`.trim();
}

/**
 * Full comment-handler prompt — runs after triage. The agent reads the
 * file, decides whether the feedback is actionable, applies a minimal edit
 * if so, runs the test suite, and emits a JSON decision.
 *
 * Has an explicit "verify tests pass" step because an earlier prod
 * incident shipped code that broke CI; the rule is enforced in the
 * prompt rather than only in code review.
 */
export function buildCommentPrompt(context) {
  const fileContext = context.filePath
    ? `**File being reviewed:** \`${context.filePath}\``
    : "**General PR review comment (not tied to a specific file)**";

  const diffContext = context.diffHunk
    ? `**Code context (diff hunk):**\n\`\`\`diff\n${context.diffHunk}\n\`\`\``
    : "";

  return `
You are an automated code review assistant. A developer has left a review comment on a pull request.
Your job is to:
1. Carefully evaluate if the feedback is valid, specific, and actionable
2. If actionable: apply the necessary code changes to address the feedback
3. **Verify the changes don't break the test suite** before declaring success
4. Output a structured JSON decision (see format below)

**PR Title:** ${context.prTitle}
**Branch:** ${context.branch}
**Reviewer:** @${context.commenter}
${fileContext}

**Review Feedback:**
${context.commentBody}

${diffContext}

**Step 1 — Decide if the feedback is actionable**
- Read the relevant file(s).
- Evaluate critically: Is it a genuine improvement? Is it clear enough to act on?
- If the feedback is vague, subjective, already implemented, or wrong: do NOT change anything and emit \`actionable: false\` (skip step 2 and 3).

**Step 2 — Make the change**
- Make the minimal, targeted code change to address the feedback. Do NOT refactor unrelated code.

**Step 3 — Verify tests pass (REQUIRED before declaring \`actionable: true\`)**
This is critical: a previous run pushed code that broke CI. You must verify locally.

a. Identify the test runner from the repo. Examples (in priority order):
   - \`package.json\` "scripts.test" → run \`npm test\` (or \`pnpm test\` / \`yarn test\` if those lockfiles exist)
   - \`package.json\` "scripts" with names like \`test:unit\`, \`test:ci\` → prefer the CI-style script
   - \`pyproject.toml\` / \`pytest.ini\` → run \`pytest\`
   - \`go.mod\` → run \`go test ./...\`
   - \`Cargo.toml\` → run \`cargo test\`
   - \`.github/workflows/*.yml\` — read it to learn the actual CI test command and mirror it
   If multiple options exist, prefer the one CI uses.

b. Run the test command.

c. Interpret the result:
   - **All tests pass** → proceed to Step 4 with \`actionable: true\`.
   - **Tests fail because of YOUR change** → fix the code so they pass. You may iterate. If you cannot make them pass while still addressing the original feedback, **revert your changes** (\`git checkout -- <files>\`) and emit \`actionable: false\` with a reason that names the failing test(s).
   - **Tests fail for unrelated reasons** (pre-existing failure on the PR branch before you touched it) → state this explicitly in \`summary\` (e.g., "tests pre-existing failure in X, unrelated to this change") and proceed with \`actionable: true\`. Confirm by checking that the failing tests don't reference files you modified.
   - **No test runner found / tests cannot run locally** (require a database, secrets, network) → set \`tests_run: false\` and explain in \`summary\`. Proceed with \`actionable: true\` only if you are confident your change is safe without running tests.

d. **Never** emit \`actionable: true\` while tests you ran are failing because of your edits. That is the failure mode this rule exists to prevent.

**Step 4 — Output the JSON decision**

Output ONLY one of these JSON objects as the last thing you write:

\`\`\`json
{
  "actionable": true,
  "summary": "Commit-message-style description of WHAT was changed and WHY. The first line MUST be ≤72 chars, written in imperative mood (e.g. 'Validate gradleTask against allowlist before exec'), with no trailing period. Optionally add a blank line and a short body. Do NOT quote the reviewer's words. End with a one-line test note (e.g. 'Tests: 142 passed via npm test' or 'Tests: skipped — no test runner detected').",
  "files_modified": ["path/to/file.js"],
  "tests_run": true,
  "tests_passed": true,
  "reason": ""
}
\`\`\`

OR if not actionable / unfixable:

\`\`\`json
{
  "actionable": false,
  "summary": "",
  "files_modified": [],
  "tests_run": false,
  "tests_passed": false,
  "reason": "Clear explanation — including any failing tests if you tried and reverted"
}
\`\`\`

Remember: do all the thinking, editing, and test-running first. The JSON block is the very last thing in your output.
`.trim();
}

/**
 * Portable PR review prompt — Workflow B.
 *
 * Replaces the earlier `claude -p /review` shortcut so the review workflow
 * works under any harness (Claude Code, Codex, Antigravity). The output
 * is plain markdown suitable for posting as a PR review body (NOT a JSON
 * decision — Workflow B always posts).
 *
 * Mimics the rough shape of a useful human review: a one-paragraph
 * summary, then sections for what was done well, what might be wrong, and
 * suggestions. Keeps the agent grounded by requiring it to actually read
 * the diff (`git diff <base>...HEAD`) before commenting.
 */
export function buildReviewPrompt(context) {
  return `
You are an automated PR reviewer. A reviewer was requested on a pull request and your job is to produce a thoughtful review comment.

**Repo:** ${context.owner}/${context.repoName}
**PR #${context.prNumber}** — base \`${context.baseBranch}\` ← head \`${context.headBranch}\`
**Title:** ${context.prTitle || "(no title)"}

**Step 1 — Read the change**

- Run \`git diff ${context.baseBranch}...HEAD\` to see what changed.
- Run \`git log ${context.baseBranch}..HEAD --oneline\` to see the commit shape.
- Read each modified file to understand the change in context (not just the diff hunk).
- For non-trivial changes, also read the *callers* of the changed code — a tighter signature or renamed function affects consumers that aren't in the diff.

**Step 2 — Evaluate**

Look for:
- **Correctness:** off-by-one, null/undefined access, race conditions, missing await, error swallowed, leaked resource
- **Security:** SQL/command injection, XSS, hardcoded secrets, missing auth/authz check, unsafe deserialization
- **Quality:** unclear naming, duplicated logic, dead code, missing tests for new behavior, broken existing tests
- **Architecture fit:** does this change cohere with surrounding code conventions, or does it introduce inconsistency?

Don't fabricate issues. Don't nitpick formatting if the repo has a formatter. If the change is genuinely fine, say so — empty reviews are noise, but so are forced-issue reviews.

**Step 3 — Output a markdown review body**

Write a PR review comment in markdown. Use this structure when there's enough material; collapse sections that are empty:

\`\`\`markdown
**Summary**

<one paragraph: what the PR does and your overall take>

**Issues** (only include if you found real ones)

- <file:line> — <issue>. Why it matters: <one line>.

**Suggestions** (optional improvements that aren't blocking)

- <file:line> — <suggestion>.

**Looks good**

- <file or area you specifically verified>.
\`\`\`

Tone: direct, technical, peer-to-peer. Don't moralize. Reference specific file paths and line numbers (\`path/to/file.js:42\`) so reviewers can jump.

Output ONLY the markdown review body — no preamble, no "Here's my review:", no closing remarks. The output of this run is posted verbatim to the PR.
`.trim();
}

/**
 * Sentry crash-fix prompt — invoked from the Sentry webhook handler after
 * the source-map gate accepts an event.
 *
 * Centered on root-cause discipline. Earlier iterations had the agent
 * "fixing" production crashes by wrapping the throw site in try/catch
 * (silent bug + lost Sentry signal), so the prompt now leads with an
 * explicit root-cause-not-symptom framing and walks through eight steps:
 * read, trace upstream, state the cause, decide fixability, fix at the
 * right layer (with an anti-pattern list), verify, self-check, emit JSON.
 * Test coverage in test/harnesses/claude.test.js locks the methodology into
 * the prompt against future drift.
 */
export function buildSentryPrompt(context) {
  const s = context.sentry;
  const frame = s.event.topFrame;
  const stackLines = (s.event.inAppStack || [])
    .map((f) => `    at ${f.function || "<anonymous>"} (${f.filename}:${f.lineno})`)
    .join("\n");

  const frameBlock = frame
    ? [
        `**Top in-app frame:** \`${frame.filename}:${frame.lineno}\` in \`${frame.function || "<anonymous>"}\``,
        "",
        "Source context (from Sentry source-map resolution):",
        "```",
        ...(frame.preContext || []).map((l, i) => `${frame.lineno - frame.preContext.length + i}: ${l}`),
        `${frame.lineno}: ${frame.contextLine}   // ← error here`,
        ...(frame.postContext || []).map((l, i) => `${frame.lineno + 1 + i}: ${l}`),
        "```",
      ].join("\n")
    : "_(no in-app frame available)_";

  const breadcrumbBlock = s.event.breadcrumbs?.length
    ? "**Recent breadcrumbs (oldest → newest):**\n" +
      s.event.breadcrumbs
        .map((b) => `- [${b.level || "info"}] ${b.category || "?"}: ${b.message || ""}`)
        .join("\n")
    : "";

  return `
You are an automated crash-fix assistant for a JavaScript / TypeScript / React Native project. A production error was reported by Sentry.

**Your job is to find and fix the ROOT CAUSE — not to suppress the symptom.** The crash you see is a *consequence* of an underlying bug somewhere in the call chain (often upstream from the throw site). Treating the symptom — wrapping a try/catch around the throw, slapping in optional chaining at the access site, adding a silent fallback — usually leaves the real bug live and just hides it from monitoring. That is worse than no fix: the next person debugging this loses Sentry as a signal.

**Project:** ${context.owner}/${context.repoName}
**Sentry issue:** ${s.issueId} — ${s.issueUrl}
**Event count:** ${s.eventCount} occurrences across ${s.userCount || "?"} users
**Release:** ${s.event.release || "(unknown)"}  |  **Environment:** ${s.event.environment || "(unknown)"}  |  **Platform:** ${s.event.platform || "(unknown)"}

**Error:** \`${s.event.errorType}: ${s.event.errorMessage}\`
**Culprit (Sentry's guess):** \`${s.event.culprit || "(none)"}\`

${frameBlock}

**Full in-app stack (top 10 frames):**
\`\`\`
${stackLines || "(stack unavailable)"}
\`\`\`

${breadcrumbBlock}

---

**Step 1 — Read the throw site and form a hypothesis**

- Open the file referenced in the top frame. Read enough surrounding code to understand what the function is *supposed* to do, not just the line that crashed.
- Restate the failure in one plain sentence: *"X was supposed to be Y at line Z, but it was W."* If you can't say that yet, keep reading before editing anything.
- Confirm the line still matches the source context Sentry showed above. If the file has drifted significantly since the release that crashed (\`${s.event.release || "?"}\`), the fix may no longer apply — say so and emit \`actionable: false\`.

**Step 2 — Trace upstream until you find the origin of the bad state**

The throw site is usually a *witness*, not the bug. For a \`Cannot read property 'X' of undefined\`, the bug is wherever the variable was *supposed* to be defined. For a \`X is not a function\`, the bug is wherever the wrong value was assigned/imported. Walk the in-app stack and read the relevant files:

- Who called this function? With what arguments? Are the arguments wrong, or did they look right when constructed?
- Where does the bad value originate? Earlier in this function? A caller? A module-load-time import? An async response handler? A reducer/store update?
- Does the breadcrumb trail (above) suggest what the user did right before the crash?
- Is the contract between caller and callee clear, and which side violated it?

Don't stop at the first file you read. The fix usually lives at the *origin* of the bad state, not the access site.

**Step 3 — State the root cause out loud BEFORE editing**

Write one sentence naming the underlying cause (the thing whose removal makes this whole class of crash go away), distinct from the symptom. Examples of the distinction:

  Symptom: \`user.profile.name\` threw because \`user.profile\` is undefined.
  Root cause: \`getUser()\` returns a partial object before \`/profile\` has loaded; the screen mounts before the data is ready.

  Symptom: \`personalizationService\` threw \`X is not a function\`.
  Root cause: a refactor renamed \`isEnabled\` to \`getStatus\` in the SDK; the consumer still calls the old name.

If you cannot articulate the root cause, do not propose a fix yet — keep investigating. Going to \`actionable: false\` with a clear "I couldn't determine root cause" is better than shipping a guess.

**Step 4 — Decide if this is fixable from this repo**

Emit \`actionable: false\` (skip steps 5–7) when:
- The root cause is in a third-party library / dependency, not this repo's code
- The fix requires information not available (e.g. needs the user's data, infra config, a server response shape that isn't in the codebase)
- The error is environmental (missing env var, native module not linked, RN version mismatch) — these are not code bugs
- The crash is intentional (e.g. a thrown error for validation that's working as designed)
- You could not determine the root cause with confidence — be honest, don't guess

**Step 5 — Fix at the right layer (avoid symptom-suppression)**

The fix must address what you wrote in Step 3, at the layer the root cause lives. Read the following anti-patterns carefully — these are the failure modes this prompt exists to prevent:

❌ **Don't do these unless you can prove they ARE the root cause:**
- Wrap the throwing code in \`try/catch\` and swallow the error (silently or with a console.log). This converts a crash into a silent bug.
- Add \`?.\` / null checks at the access site when an upstream function was supposed to guarantee the value. You're patching the witness, not the bug.
- Return a default/fallback value when the real path failed. The user still sees broken behavior; Sentry just stops noticing.
- Wrap in \`try/catch\` and retry the same operation. If the operation was wrong, retrying it will be wrong again.
- Convert a thrown error into a logged warning to "make the crash go away."

✅ **Do these when they match the root cause:**
- Fix the upstream function so it never returns the bad value (e.g. await the promise it was supposed to wait for, validate before returning, return a clearly-typed empty state callers can handle).
- Correct the API contract violation at its source (e.g. rename the method to the new SDK signature; fix the destructure that pulled the wrong field).
- Add a guard ONLY when the value can legitimately be undefined per the contract (e.g. an optional API field) — and document why with a brief comment.
- Validate at a system boundary (HTTP response parsing, deserialization) so bad data is rejected at the boundary instead of crashing deep in the app.
- Re-order initialization so the value is ready before it's read.

If after honest investigation the *only* sensible fix really is a guard at the access site (e.g. an optional API response field), that's fine — but say so explicitly in \`root_cause\` and explain why a deeper fix isn't appropriate. We should be able to tell from your output that you considered the upstream and decided the boundary was right.

Change the smallest amount of code that addresses the root cause. Do NOT refactor unrelated code. Do NOT broaden the fix beyond the immediate bug.

**Step 6 — Verify**

a. Identify the test runner from \`package.json\`. For React Native: usually \`npm test\` runs Jest.
b. Run the test command. If it requires Metro bundler / a simulator and can't run headless, mark \`tests_run: false\` and explain.
c. If tests fail because of your change: fix or revert. Never declare success with failing tests caused by your edit.
d. If you can't run tests at all (no test runner, requires native build), set \`tests_run: false\` and proceed only if you are confident the change is safe and obviously correct.

**Step 7 — Self-check the fix against the root cause**

Before emitting the JSON, answer these to yourself:

1. *"Would the same crash still happen if I injected the same bad upstream value through a different code path?"* If yes, you fixed the symptom, not the cause — go back to Step 2.
2. *"Could a future contributor read my diff and the root_cause field, and understand WHY this was a bug?"* If the diff just adds defensive code without explanation, no.
3. *"Am I hiding observability?"* Catching errors and silently continuing erases the next person's ability to debug. Acceptable only when the error is truly expected and harmless (and you can explain why).

If any answer is uncomfortable, fix it before outputting JSON. It is better to lower \`confidence\` (or go to \`actionable: false\`) than to ship a misleading "fix."

**Step 8 — Output the JSON decision**

Output ONLY one of these JSON objects as the LAST thing you write:

\`\`\`json
{
  "actionable": true,
  "confidence": "high",
  "summary": "Imperative commit-message-style line ≤72 chars. Describe WHAT and WHY. End with a test note (e.g. 'Tests: 87 passed via npm test' or 'Tests: skipped — RN requires native build').",
  "files_modified": ["path/to/file.ts"],
  "root_cause": "One sentence naming the underlying cause from Step 3 — the thing whose removal eliminates this class of crash. NOT a restatement of the symptom Sentry showed.",
  "tests_run": true,
  "tests_passed": true,
  "reason": ""
}
\`\`\`

\`confidence\` rules:
- \`"high"\` — you traced upstream, found the actual origin of the bad state, fixed it there, AND tests passed (or weren't needed for this kind of change). Only then will the PR be opened non-draft.
- \`"medium"\` — fix looks right but the upstream trace was partial, or there's a plausible alternative interpretation, or you fixed a boundary guard rather than a root cause and that judgment call could go either way.
- \`"low"\` — you patched the symptom because the root cause wasn't reachable from this repo, or your investigation hit a dead end and this is best-effort. Reviewer should treat this as a starting point, not a fix.

OR if not actionable:

\`\`\`json
{
  "actionable": false,
  "confidence": "low",
  "summary": "",
  "files_modified": [],
  "root_cause": "Brief explanation of the underlying cause if known, OR an honest 'could not determine root cause: <what you tried>'.",
  "tests_run": false,
  "tests_passed": false,
  "reason": "Specific reason — e.g. 'crash originates in react-native-image-picker v5.x; needs upstream fix' or 'requires runtime data not in repo' or 'root cause unclear: investigated A, B, C; no clear origin in this codebase'"
}
\`\`\`

The JSON block must be the LAST thing in your output.
`.trim();
}
