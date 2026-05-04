# Clauditor — Diagrams

These are [Excalidraw](https://excalidraw.com) source files. Open them at
<https://excalidraw.com> (drag & drop the `.excalidraw` file onto the canvas)
or install the Excalidraw extension for VS Code.

| File | What it shows |
|---|---|
| [`clauditor-architecture.excalidraw`](./clauditor-architecture.excalidraw) | High-level architecture: GitHub → Tailscale → Express → Queue → Handlers → Services → External |
| [`clauditor-comment-flow.excalidraw`](./clauditor-comment-flow.excalidraw) | Workflow A — handling PR review comments, review summaries, and PR-attached issue comments. Shows three decision points in cost order: the **PR-author guard** (`pr.user.login === GITHUB_BOT_USERNAME`?), the **cheap triage pass** (`runClaudeTriage`, no tools, no clone), and finally the **actionable** check after the full Claude run. Each `no` branch ends in a silent skip — only the success path posts a reply. The triage step lets us avoid the expensive clone entirely for obviously non-actionable feedback. |
| [`clauditor-review-request-flow.excalidraw`](./clauditor-review-request-flow.excalidraw) | Workflow B — auto-review when the configured user is requested as a reviewer, using `claude -p /review` and posting a formal PR review. |
| [`clauditor-impact-comparison.excalidraw`](./clauditor-impact-comparison.excalidraw) | Side-by-side **Before vs After** comparison for the same reviewer comment — human-in-the-loop (hours-to-days, context-switch tax) versus Clauditor-in-the-loop (minutes, no engineer interruption). Includes the JSON decision artifact and an explicit scope note. |

The diagrams use a consistent color palette:

| Color | Layer |
|---|---|
| Light blue | External system (GitHub, CLIs) |
| Light yellow | Network layer (Tailscale Funnel) |
| Light orange | App / routing / queue |
| Light pink | Middleware (HMAC verification) |
| Light green | Handlers (and success outcomes) |
| Light purple | Services (claude / git / github) |
| Light gray | Silent skip outcome (handler returns without posting on the PR) |
| Yellow diamond | Decision point |
