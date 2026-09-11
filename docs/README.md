# Clauditor — Diagrams

These are [Excalidraw](https://excalidraw.com) source files. Open them at
<https://excalidraw.com> (drag & drop the `.excalidraw` file onto the canvas)
or install the Excalidraw extension for VS Code.

| File | What it shows |
|---|---|
| [`clauditor-architecture.excalidraw`](./clauditor-architecture.excalidraw) | GitHub webhook architecture: GitHub → Tailscale → Express → serialized queue → handlers → selected harness/services. Workflow C has its own detailed diagram. |
| [`clauditor-comment-flow.excalidraw`](./clauditor-comment-flow.excalidraw) | Workflow A — handling PR review comments, review summaries, and PR-attached issue comments through harness triage and targeted fixes. |
| [`clauditor-review-request-flow.excalidraw`](./clauditor-review-request-flow.excalidraw) | Workflow B — auto-review using the shared portable prompt when the configured user is requested as a reviewer. |
| [`clauditor-impact-comparison.excalidraw`](./clauditor-impact-comparison.excalidraw) | Side-by-side **Before vs After** comparison for the same reviewer comment — human-in-the-loop (hours-to-days, context-switch tax) versus Clauditor-in-the-loop (minutes, no engineer interruption). Includes the JSON decision artifact and an explicit scope note. |
| [`clauditor-sentry-flow.excalidraw`](./clauditor-sentry-flow.excalidraw) | Workflow C — Sentry crash-to-PR: convergence, filtering, source-map gate, selected harness, and reported outcomes. Companion to [`sentry-integration.md`](./sentry-integration.md). |

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
