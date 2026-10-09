#!/bin/sh
set -e

DB_PATH="${DATABASE_PATH:-/app/data/ingressi.db}"
DB_DIR=$(dirname "$DB_PATH")

echo "Ensuring database directory exists..."
mkdir -p "$DB_DIR"

# Idle keep-alive connections stay open longer than a reverse proxy in front
# keeps them (Caddy: 2 minutes). With Node's 5 second default the server
# closes a connection Caddy is about to reuse, Caddy answers 502 and, with
# passive health checks, takes the dashboard out of rotation.
export KEEP_ALIVE_TIMEOUT="${KEEP_ALIVE_TIMEOUT:-125000}"

# High availability (ee/docs/high-availability.md): the supervisor holds the
# leader lease, runs Litestream and starts the application itself, as the
# leader or as a standby.
case "$(printf '%s' "${HA_ENABLED:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "Starting the high availability supervisor..."
    exec bun /app/ha/supervisor.js
    ;;
esac

echo "Starting application..."
exec env HOSTNAME=0.0.0.0 bun server.js
