#!/usr/bin/env bash
# Build + deploy video-worker on the prod server. Runs from the FE repo checkout
# root (via the self-hosted runner or by hand): ./video-worker/deploy/deploy.sh
# Requires: docker + compose v2, .env at STATE_DIR/video-worker/.env.
set -euo pipefail

STATE_DIR=/home/tbng84/Projects/AI-Story-Book/ai-storybook-editor
HEALTH_URL=http://localhost:4000/health
COMPOSE="docker compose -f video-worker/deploy/compose.yml"
KEEP_TAGS=5

SHA=$(git rev-parse --short HEAD)
echo "==> deploying video-worker:$SHA"

# warn (not fail) on env keys present in .env.example but missing on the server —
# a missing optional var is legitimate, a missing required one fails the health gate
comm -23 <(grep -oE '^[A-Z_]+' video-worker/.env.example | sort -u) \
         <(grep -oE '^[A-Z_]+' "$STATE_DIR/video-worker/.env" | sort -u) \
  | sed 's/^/WARN missing in server .env: /' || true

PREV=$(docker inspect -f '{{.Config.Image}}' video-worker 2>/dev/null || echo "")
echo "==> current image: ${PREV:-<none>}"

# build context = FE repo root (worker resolves deps from parent node_modules +
# bundles src/remotion via the @/ alias)
docker build -t "video-worker:$SHA" .

TAG=$SHA $COMPOSE up -d

# Health gate: server.ts binds 4000 only AFTER warmup() (ensureBrowser + webpack
# bundle of the FE src, ~1–3 min) + probeEncoder — so /health 200 with {"ok":true}
# proves the worker is render-ready. Window ~300s (150 × 2s): the cold first deploy
# (cold webpack, first image, slow disk) can exceed 3 min — headroom over the plan's
# ≥240s floor avoids rolling back a slow-but-healthy boot.
ok=""
for _ in $(seq 1 150); do
  sleep 2
  body=$(curl -sf --max-time 10 "$HEALTH_URL" 2>/dev/null) || continue
  if printf '%s' "$body" | grep -q '"ok":true'; then
    ok=1
    break
  fi
done

if [ -z "$ok" ]; then
  echo "!! HEALTH GATE FAILED for video-worker:$SHA — recent logs:"
  journalctl CONTAINER_NAME=video-worker -n 100 --no-pager || true
  if [ -n "$PREV" ]; then
    echo "!! rolling back to $PREV"
    TAG=${PREV#video-worker:} $COMPOSE up -d
  else
    echo "!! no previous image to roll back to — restart the manual worker per deployment-guide"
  fi
  exit 1
fi
echo "==> healthy: video-worker:$SHA"

# keep the last $KEEP_TAGS images for manual rollback, drop the rest
docker images video-worker --format '{{.Tag}}' \
  | grep -vx "$SHA" | tail -n "+$KEEP_TAGS" \
  | xargs -r -I{} docker rmi "video-worker:{}" 2>/dev/null || true
docker image prune -f >/dev/null

echo "==> deploy done: video-worker:$SHA"
