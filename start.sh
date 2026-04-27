#!/usr/bin/env bash
# =============================================================
# start.sh — Start Clauditor with Tailscale Funnel
# =============================================================
set -euo pipefail

PORT="${PORT:-3000}"
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Clauditor — Startup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Validate environment ────────────────────────────────
if [ ! -f "$BOT_DIR/.env" ]; then
  echo "❌ .env file not found. Copy .env.example → .env and fill in your values."
  exit 1
fi

# Load .env into the script's own environment so its sanity-check loop and
# the tailscale step can read values from it. Node loads .env separately via
# `dotenv/config`, so children get their own copy regardless.
set -a
# shellcheck disable=SC1091
source "$BOT_DIR/.env"
set +a

for var in GITHUB_TOKEN GITHUB_WEBHOOK_SECRET GITHUB_BOT_USERNAME; do
  if [ -z "${!var:-}" ]; then
    echo "❌ $var is not set in .env"
    exit 1
  fi
done

# ── 2. Check dependencies ─────────────────────────────────
command -v node >/dev/null || { echo "❌ node not found"; exit 1; }
command -v claude >/dev/null || { echo "❌ claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"; exit 1; }
command -v git >/dev/null || { echo "❌ git not found"; exit 1; }

# Resolve tailscale binary. Shell aliases in ~/.zshrc do NOT propagate into
# non-interactive scripts, so we cannot rely on `command -v tailscale` finding
# a user-level alias. Probe in this order:
#   1. $TAILSCALE_BIN   — explicit override (set in .env or environment)
#   2. PATH             — works for Homebrew installs + manual symlinks
#   3. macOS standalone app bundle
#   4. Common install prefixes
TAILSCALE="${TAILSCALE_BIN:-}"
if [ -z "$TAILSCALE" ]; then
  if command -v tailscale >/dev/null 2>&1; then
    TAILSCALE="$(command -v tailscale)"
  elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
    TAILSCALE="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  elif [ -x "/opt/homebrew/bin/tailscale" ]; then
    TAILSCALE="/opt/homebrew/bin/tailscale"
  elif [ -x "/usr/local/bin/tailscale" ]; then
    TAILSCALE="/usr/local/bin/tailscale"
  fi
fi

if [ -z "$TAILSCALE" ] || [ ! -x "$TAILSCALE" ]; then
  echo "❌ tailscale CLI not found."
  echo "   Looked in: PATH, /Applications/Tailscale.app/Contents/MacOS/Tailscale,"
  echo "              /opt/homebrew/bin/tailscale, /usr/local/bin/tailscale"
  echo "   Override:  TAILSCALE_BIN=/path/to/tailscale ./start.sh"
  echo "   Or set TAILSCALE_BIN in .env."
  echo "   Install from https://tailscale.com/download"
  exit 1
fi
echo "→ Using tailscale: $TAILSCALE"

# ── 3. Check Claude Code auth ─────────────────────────────
echo "→ Checking Claude Code authentication..."
if ! claude -p "say ok" --allowedTools "" --max-turns 1 2>/dev/null | grep -qi "ok"; then
  echo "⚠️  Claude Code may not be authenticated. Run: claude auth login"
fi

# ── 4. Install npm dependencies ──────────────────────────
echo "→ Installing dependencies..."
cd "$BOT_DIR"
npm install --silent

# ── 5. Start Tailscale Funnel ─────────────────────────────
echo "→ Starting Tailscale Funnel on port $PORT..."
"$TAILSCALE" funnel --bg "$PORT"

# Get the public HTTPS URL Tailscale assigned
FUNNEL_URL=$("$TAILSCALE" funnel status 2>/dev/null | grep "https://" | head -1 | awk '{print $1}' || echo "check: tailscale funnel status")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Tailscale Funnel active"
echo "  📡 Webhook URL: ${FUNNEL_URL}/webhook"
echo ""
echo "  Set this URL in GitHub:"
echo "  Repo → Settings → Webhooks → Add webhook"
echo "    Payload URL: ${FUNNEL_URL}/webhook"
echo "    Content type: application/json"
echo "    Secret: (your GITHUB_WEBHOOK_SECRET)"
echo "    Events: Pull request review comments ✓"
echo "            Pull request reviews ✓"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 6. Start the bot server ───────────────────────────────
echo "→ Starting bot server..."
exec node src/server.js
