# Clauditor — Diagrams

These are [Excalidraw](https://excalidraw.com) source files. Open them at
<https://excalidraw.com> (drag & drop the `.excalidraw` file onto the canvas)
or install the Excalidraw extension for VS Code.

| File | What it shows |
|---|---|
| [`clauditor-architecture.excalidraw`](./clauditor-architecture.excalidraw) | High-level architecture: GitHub → Tailscale → Express → Queue → Handlers → Services → External |
| [`clauditor-comment-flow.excalidraw`](./clauditor-comment-flow.excalidraw) | Workflow A — handling PR review comments, review summaries, and PR-attached issue comments. The implementation now routes triage and fixes through the selected harness; this diagram predates that naming change. |
| [`clauditor-review-request-flow.excalidraw`](./clauditor-review-request-flow.excalidraw) | Workflow B — auto-review when the configured user is requested as a reviewer. The implementation now uses a portable review prompt instead of the Claude-specific `/review` shortcut. |
| [`clauditor-impact-comparison.excalidraw`](./clauditor-impact-comparison.excalidraw) | Side-by-side **Before vs After** comparison for the same reviewer comment — human-in-the-loop (hours-to-days, context-switch tax) versus Clauditor-in-the-loop (minutes, no engineer interruption). Includes the JSON decision artifact and an explicit scope note. |
| [`clauditor-sentry-flow.excalidraw`](./clauditor-sentry-flow.excalidraw) | Workflow C — Sentry crash-to-PR. The implementation now routes its fix step through the selected harness; the diagram retains the original Claude-only labels. Companion to [`sentry-integration.md`](./sentry-integration.md). |

The diagrams use a consistent color palette:

| Color | Layer |
|---|---|
| Light blue | External system (GitHub, CLIs) |
| Light yellow | Network layer (Tailscale Funnel) |
| Light orange | App / routing / queue |
| Light pink | Middleware (HMAC verification) |
| Light green | Handlers (and success outcomes) |
| Light purple | Harnesses and services (Claude/Codex / git / GitHub) |
| Light gray | Silent skip outcome (handler returns without posting on the PR) |
| Yellow diamond | Decision point |
