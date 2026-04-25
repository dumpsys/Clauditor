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

source "$BOT_DIR/.env"

for var in GITHUB_TOKEN GITHUB_WEBHOOK_SECRET GITHUB_BOT_USERNAME; do
  if [ -z "${!var:-}" ]; then
    echo "❌ $var is not set in .env"
    exit 1
  fi
done

# ── 2. Check dependencies ─────────────────────────────────
command -v node >/dev/null || { echo "❌ node not found"; exit 1; }
command -v claude >/dev/null || { echo "❌ claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"; exit 1; }
command -v tailscale >/dev/null || { echo "❌ tailscale not found. Install from https://tailscale.com/download"; exit 1; }
command -v git >/dev/null || { echo "❌ git not found"; exit 1; }

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
tailscale funnel --bg "$PORT"

# Get the public HTTPS URL Tailscale assigned
FUNNEL_URL=$(tailscale funnel status 2>/dev/null | grep "https://" | head -1 | awk '{print $1}' || echo "check: tailscale funnel status")

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
