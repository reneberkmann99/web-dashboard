#!/usr/bin/env bash
# Enroll/rotate a node's secure agent transport via the real Noderaft ADMIN API.
# Usage: scripts/enroll-node-tls.sh <nodeId> <tlsApiBaseUrl>
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_ID="${1:?nodeId required}"
TLS_URL="${2:?tlsApiBaseUrl required (e.g. https://agent:9081)}"

EMAIL="$(grep '^SEED_ADMIN_EMAIL=' .env | cut -d= -f2- | tr -d '"')"
PASSWORD="$(grep '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2- | tr -d '"')"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "→ logging in as admin…"
curl -s -c "$JAR" -X POST http://localhost:1337/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" -o /dev/null

echo "→ issuing CSRF cookie…"
curl -s -b "$JAR" -c "$JAR" http://localhost:1337/api/auth/me -o /dev/null

CSRF="$(awk '$6=="hostpanel_csrf"{print $7}' "$JAR")"
if [ -z "$CSRF" ]; then
  echo "ERROR: no CSRF cookie issued" >&2
  exit 1
fi

echo "→ enrolling node $NODE_ID secure transport (verify against $TLS_URL)…"
curl -s -b "$JAR" -X POST "http://localhost:1337/api/admin/nodes/$NODE_ID/tls" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $CSRF" \
  -d "{\"action\":\"enroll\",\"tlsApiBaseUrl\":\"$TLS_URL\"}"
echo
