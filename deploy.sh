#!/usr/bin/env bash
# Deploy main to the VPS in one deliberate command. No CI trigger on purpose:
# a deploy interrupts live SSE streams and drops any held permission prompt —
# it should happen when a human decides, not when a branch merges.
#
# Two modes:
#   default  — the base Caddy compose stack (self-hosted, one static-token or
#              mint workspace, Caddy terminates TLS).
#   hosted   — set SLOPDECK_DEPLOY_MODE=hosted for the always-on mps gateway:
#              layers the Caddy-free docker-compose.mps.yml override, brings up only
#              the gateway (Dokploy's shared Traefik terminates TLS), and keeps
#              the SQLite volume so workspaces survive the rebuild.
set -euo pipefail

host="${1:-${SLOPDECK_DEPLOY_HOST:-}}"

if [[ -z "$host" ]]; then
  {
    echo 'usage: ./deploy.sh [user@host]'
    echo 'or set SLOPDECK_DEPLOY_HOST (and optionally SLOPDECK_DEPLOY_PATH).'
    echo 'set SLOPDECK_DEPLOY_MODE=hosted for the Caddy-free mps gateway.'
  } >&2
  exit 2
fi

remote_path="${SLOPDECK_DEPLOY_PATH:-slopdeck}"

if [[ "${SLOPDECK_DEPLOY_MODE:-}" == 'hosted' ]]; then
  compose_cmd='docker compose -f docker-compose.yml -f docker-compose.mps.yml up -d --build gateway'
else
  compose_cmd='docker compose up -d --build'
fi

echo "Deploying main to $host ($remote_path)..."
ssh "$host" "set -euo pipefail
  cd '$remote_path'
  git switch main
  git pull --ff-only origin main
  cd deploy
  $compose_cmd"
echo 'Deployed. Reminder: a deploy interrupts live streams; any held permission prompt was dropped.'
