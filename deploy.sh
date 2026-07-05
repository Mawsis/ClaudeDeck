#!/usr/bin/env bash
# Deploy main to the VPS in one deliberate command. No CI trigger on purpose:
# gateway state is in-memory, so a deploy drops held permission prompts —
# it should happen when a human decides, not when a branch merges.
set -euo pipefail

host="${1:-${SLOPDECK_DEPLOY_HOST:-}}"

if [[ -z "$host" ]]; then
  {
    echo 'usage: ./deploy.sh [user@host]'
    echo 'or set SLOPDECK_DEPLOY_HOST (and optionally SLOPDECK_DEPLOY_PATH).'
  } >&2
  exit 2
fi

remote_path="${SLOPDECK_DEPLOY_PATH:-slopdeck}"

echo "Deploying main to $host ($remote_path)..."
ssh "$host" "set -euo pipefail
  cd '$remote_path'
  git switch main
  git pull --ff-only origin main
  cd deploy
  docker compose up -d --build"
echo 'Deployed. Reminder: gateway state is in-memory — any held permission prompt was dropped.'
