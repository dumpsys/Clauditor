import { config } from "../config.js";
import { logger } from "../logger.js";

function headers() {
  if (!config.sentry.authToken) throw new Error("SENTRY_AUTH_TOKEN is not set");
  return {
    Authorization: `Bearer ${config.sentry.authToken}`,
    "Content-Type": "application/json",
  };
}

async function sentryFetch(url, options = {}) {
  logger.debug(`Sentry API request: ${options.method || "GET"} ${url}`);
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Sentry API error ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
  }
  // Sentry occasionally responds 2xx with an HTML body when something's wrong
  // upstream — a misconfigured base URL (e.g. https://sentry.io instead of
  // https://sentry.io/api/0) returns the marketing site; a self-hosted
  // instance behind SSO can return a login page when auth is bad. Catch this
  // BEFORE res.json() so the operator sees an actionable error instead of
  // `Unexpected token '<', "<!DOCTYPE ..."`.
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const body = await res.text();
    const preview = body.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(
      `Sentry API returned non-JSON response (HTTP ${res.status}, Content-Type: "${contentType}") from ${url}. ` +
      `First 200 chars: "${preview}". ` +
      `Likely causes: SENTRY_API_BASE_URL is wrong (must end with /api/0), ` +
      `SENTRY_AUTH_TOKEN is invalid/expired (self-hosted Sentry may redirect to an HTML login page), ` +
      `or you're hitting a self-hosted instance behind SSO/a proxy.`,
    );
  }
  return res.json();
}

/**
 * Fetch the issue resource. Useful for full tags, counts, and culprit
 * — the webhook payload's `data.issue` is sometimes thin.
 */
export async function getIssue(issueId) {
  const url = `${config.sentry.apiBaseUrl}/issues/${issueId}/`;
  return sentryFetch(url);
}

/**
 * Fetch the latest event for an issue. This has the full stack trace with
 * source-resolved frames (when source maps are uploaded).
 */
export async function getLatestEvent(issueId) {
  const url = `${config.sentry.apiBaseUrl}/issues/${issueId}/events/latest/`;
  return sentryFetch(url);
}

/**
 * Post a comment back on the Sentry issue. Used to link the PR (or report
 * skip/no-fix reasons) so the Sentry-side reviewer has the full picture.
 *
 * The Sentry comment API expects { text } and posts under the integration's
 * identity (which is what we want — visible "auto-fix" provenance).
 */
export async function postIssueComment(issueId, text) {
  const url = `${config.sentry.apiBaseUrl}/issues/${issueId}/comments/`;
  logger.info(`Posting Sentry comment on issue ${issueId}`);
  return sentryFetch(url, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/**
 * True if a frame has resolved source context attached — the `context_line`
 * plus surrounding `pre_context` Sentry populates only after source maps
 * have been applied. Without these, Claude has no source code to read.
 */
function frameHasContext(frame) {
  return (
    typeof frame?.context_line === "string" &&
    Array.isArray(frame?.pre_context) &&
    frame.pre_context.length > 0
  );
}

/**
 * Extract the top in-app frame from a Sentry event.
 *
 * Sentry frames are ordered oldest → newest, so the last in-app frame is the
 * one closest to where the throw happened. **Preference order:**
 *
 *   1. Deepest in_app frame that ALSO has resolved source context. This is
 *      what we actually want — a frame Claude can read and reason about.
 *   2. Fallback: deepest in_app frame even without context, so callers like
 *      `hasResolvedSourceMaps` can still report what they saw.
 *
 * Why the two-pass walk: in React Native (Hermes), Sentry tags engine
 * internals such as `app:///InternalBytecode.js` as `in_app: true`, but those
 * frames are bytecode with no user source. A naive "deepest in_app wins"
 * rule would pick the InternalBytecode frame and conclude "no source maps"
 * even when the user-code frames immediately above it have perfect context.
 */
export function topInAppFrame(event) {
  const exception = (event?.entries || []).find((e) => e.type === "exception");
  const values = exception?.data?.values || [];
  // Iterate exception values newest-thrown-first (last in array is most recent
  // in Sentry's convention; some events nest causes in earlier entries).
  for (let i = values.length - 1; i >= 0; i--) {
    const frames = values[i]?.stacktrace?.frames || [];
    // Pass 1: deepest in_app frame with resolved context.
    for (let j = frames.length - 1; j >= 0; j--) {
      const f = frames[j];
      if (f.in_app && frameHasContext(f)) return f;
    }
    // Pass 2: fallback — deepest in_app frame even without context.
    for (let j = frames.length - 1; j >= 0; j--) {
      if (frames[j].in_app) return frames[j];
    }
  }
  return null;
}

// Patterns we treat as definitively NOT user source even if Sentry tagged
// the frame as in_app. Most are minified-bundle filenames; the last is RN's
// Hermes bytecode runtime, which gets in_app=true but has no source maps.
const NON_SOURCE_PATTERNS = [
  /\.min\.js$/i,
  /index\.(android|ios)\.bundle/i,
  /static\/js\/main\.[a-f0-9]+\.js$/i,
  /^https?:\/\//,                  // raw URL bundle, no source map applied
  /InternalBytecode\.js$/i,        // React Native / Hermes engine internals
];

/**
 * Diagnostic — explains in one line why `hasResolvedSourceMaps` would
 * accept or reject this event. Use from operator-facing debug logs so
 * "skipping: no resolved source context" can be turned into something
 * actionable ("we picked frame X, it has filename Y, context_line is
 * missing"). Pure function; safe to call at any log level.
 */
export function describeSourceMapGate(event) {
  const exception = (event?.entries || []).find((e) => e.type === "exception");
  const values = exception?.data?.values || [];
  if (values.length === 0) {
    return `no exception entry in event (entries=${(event?.entries || []).map((e) => e.type).join(",") || "none"})`;
  }
  const allFrames = values.flatMap((v) => v.stacktrace?.frames || []);
  const inAppFrames = allFrames.filter((f) => f.in_app);
  const withContext = inAppFrames.filter(frameHasContext);

  const frame = topInAppFrame(event);
  if (!frame) {
    return (
      `no in_app frame found ` +
      `(${values.length} exception values, ${allFrames.length} total frames, 0 in_app)`
    );
  }

  const filename = frame.filename || frame.abs_path || "(no filename)";
  const matchedPattern = NON_SOURCE_PATTERNS.find((re) => re.test(filename));
  const hasCtx = frameHasContext(frame);
  const verdict = matchedPattern
    ? `REJECT (filename matches non-source pattern ${matchedPattern})`
    : !hasCtx
      ? `REJECT (no context_line / pre_context on chosen frame)`
      : `ACCEPT`;

  return (
    `chose frame ${filename}:${frame.lineno ?? "?"} ` +
    `(fn=${frame.function || "?"}, in_app=${frame.in_app}, ` +
    `context_line=${typeof frame.context_line === "string" ? `"${frame.context_line.slice(0, 60)}"` : "missing"}, ` +
    `pre_context=${(frame.pre_context || []).length} lines) — ${verdict}. ` +
    `Event stats: ${values.length} exception value(s), ${allFrames.length} frame(s), ` +
    `${inAppFrames.length} in_app, ${withContext.length} with context.`
  );
}

/**
 * Heuristic: did Sentry resolve source maps for a frame Claude can use?
 *
 * Returns true iff the frame chosen by `topInAppFrame` looks like real
 * user source (not a bundle / Hermes internal) AND has the context_line +
 * pre_context that Sentry only populates after source-map resolution.
 *
 * `topInAppFrame` already prefers frames with context, so this function
 * mostly confirms what was picked. If the only in_app frames in the event
 * are minified / bytecode, both checks fail and we skip the issue.
 */
export function hasResolvedSourceMaps(event) {
  const frame = topInAppFrame(event);
  if (!frame) return false;

  const filename = frame.filename || frame.abs_path || "";
  if (!filename) return false;
  if (NON_SOURCE_PATTERNS.some((re) => re.test(filename))) return false;

  return frameHasContext(frame);
}

/**
 * Compose a short, deterministic identifier for the issue used in branch
 * names and PR titles. Sentry issue IDs are numeric strings already — we
 * pass them through as-is.
 */
export function issueIdFromPayload(payload) {
  // The webhook payload nests it as data.issue.id; the API call returns it as id.
  return payload?.data?.issue?.id || payload?.issue?.id || null;
}

/**
 * Build a compact context object for the handler / Claude prompt.
 * Extracts only the fields we actually use — keeps the prompt focused.
 */
export function summarizeEvent(event, issue) {
  const frame = topInAppFrame(event);
  const exception = (event?.entries || []).find((e) => e.type === "exception");
  const exc = exception?.data?.values?.[exception.data.values.length - 1] || {};
  const breadcrumbsEntry = (event?.entries || []).find((e) => e.type === "breadcrumbs");
  const breadcrumbs = breadcrumbsEntry?.data?.values || [];

  // Tags are an array of [key, value] tuples in event payloads.
  const tagsArr = Array.isArray(event?.tags) ? event.tags : [];
  const tags = Object.fromEntries(
    tagsArr.map((t) => (Array.isArray(t) ? t : [t.key, t.value])).filter(([k]) => k)
  );

  return {
    errorType: exc.type || issue?.type || "Error",
    errorMessage: exc.value || issue?.title || "",
    culprit: issue?.culprit || event?.culprit || "",
    platform: event?.platform || issue?.platform || "",
    release: tags.release || event?.release || "",
    environment: tags.environment || event?.environment || "",
    topFrame: frame
      ? {
          filename: frame.filename || frame.abs_path,
          function: frame.function,
          lineno: frame.lineno,
          colno: frame.colno,
          contextLine: frame.context_line,
          preContext: frame.pre_context || [],
          postContext: frame.post_context || [],
        }
      : null,
    // Full in-app stack (top 10) for richer prompt context.
    inAppStack: (exc.stacktrace?.frames || [])
      .filter((f) => f.in_app)
      .slice(-10)
      .map((f) => ({
        filename: f.filename || f.abs_path,
        function: f.function,
        lineno: f.lineno,
        contextLine: f.context_line,
      })),
    breadcrumbs: breadcrumbs.slice(-5).map((b) => ({
      category: b.category,
      message: b.message,
      level: b.level,
      timestamp: b.timestamp,
    })),
    tags,
  };
}
