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
 * Extract the top in-app frame from a Sentry event.
 * React Native / web JS errors typically have frames in
 * `event.entries[].type === "exception"`. We pick the deepest in-app frame
 * (Sentry frames are ordered oldest → newest; the last in-app frame is the
 * one closest to where the throw happened).
 */
export function topInAppFrame(event) {
  const exception = (event?.entries || []).find((e) => e.type === "exception");
  const values = exception?.data?.values || [];
  // Iterate exception values newest-thrown-first (last in array is most recent
  // in Sentry's convention; some events nest causes in earlier entries).
  for (let i = values.length - 1; i >= 0; i--) {
    const frames = values[i]?.stacktrace?.frames || [];
    for (let j = frames.length - 1; j >= 0; j--) {
      if (frames[j].in_app) return frames[j];
    }
  }
  return null;
}

/**
 * Heuristic: did Sentry resolve source maps for the top in-app frame?
 *
 * For JS / TS / React Native we need:
 *   - the frame to be in_app (not a vendor lib)
 *   - the filename to look like real source, not a bundle
 *   - context_line and pre_context populated (Sentry only fills these
 *     after source-map resolution)
 *
 * If false, we shouldn't attempt a fix — Claude can't find the code from
 * a minified frame like `index.android.bundle:1:184523`.
 */
export function hasResolvedSourceMaps(event) {
  const frame = topInAppFrame(event);
  if (!frame) return false;

  const filename = frame.filename || frame.abs_path || "";
  if (!filename) return false;

  // Common bundle / minified patterns: skip.
  const bundlePatterns = [
    /\.min\.js$/i,
    /index\.(android|ios)\.bundle/i,
    /static\/js\/main\.[a-f0-9]+\.js$/i,
    /^https?:\/\//, // raw URL bundle, no source map applied
  ];
  if (bundlePatterns.some((re) => re.test(filename))) return false;

  // Source-map resolution populates these.
  const hasContext =
    typeof frame.context_line === "string" &&
    Array.isArray(frame.pre_context) &&
    frame.pre_context.length > 0;
  return hasContext;
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
