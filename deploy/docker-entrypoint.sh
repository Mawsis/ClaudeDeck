#!/bin/sh
# Ensure the SQLite directory is writable by the unprivileged runtime user, then
# drop to it. A freshly-created Docker named volume mounts as root, so without
# this the `node` user (uid 1000) cannot create the DB file and the gateway
# crash-loops on ERR_SQLITE_ERROR (issue #38). Runs as root only for the chown;
# all app code runs as `node` via su-exec.
set -eu

# Directory that will hold the SQLite file, if a file path is configured.
if [ -n "${SLOPDECK_DB_PATH:-}" ]; then
  db_dir=$(dirname "$SLOPDECK_DB_PATH")
  # Only meaningful — and only permitted — when we start as root (uid 0).
  if [ "$(id -u)" = '0' ]; then
    mkdir -p "$db_dir"
    chown -R node:node "$db_dir"
  fi
fi

# Step down to the unprivileged user for the actual process. If we're already
# non-root (e.g. a platform that pins the uid), just exec in place.
if [ "$(id -u)" = '0' ]; then
  exec su-exec node "$@"
fi
exec "$@"
