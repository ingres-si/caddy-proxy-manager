#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"

# caddy-blocker-plugin may request a newer cel-go API than the reviewed stable
# Caddy release supports. Derive the compatibility replacement from the exact
# pinned Caddy module instead of hand-maintaining a second version number.
caddy_version="$(go list -m -f '{{.Version}}' github.com/caddyserver/caddy/v2)"
go mod download "github.com/caddyserver/caddy/v2@${caddy_version}"
caddy_mod_file="$(go env GOMODCACHE)/cache/download/github.com/caddyserver/caddy/v2/@v/${caddy_version}.mod"
cel_go_version="$(awk '$1 == "github.com/google/cel-go" { print $2; exit }' "$caddy_mod_file")"

if [ -n "$cel_go_version" ]; then
  go mod edit "-replace=github.com/google/cel-go=github.com/google/cel-go@${cel_go_version}"
elif grep -q '^[[:space:]]*cel\.dev/cel-go ' "$caddy_mod_file"; then
  # Caddy >= 2.11.7 imports cel-go as cel.dev/cel-go, so plugins that still
  # require github.com/google/cel-go no longer change the version Caddy uses.
  go mod edit -dropreplace=github.com/google/cel-go
else
  echo "Unable to resolve Caddy's cel-go compatibility version" >&2
  exit 1
fi
go mod download all
