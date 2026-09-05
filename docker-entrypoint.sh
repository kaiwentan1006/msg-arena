#!/bin/sh
set -e

DATA="/data"
CERTS="$DATA/certs"

# Auto-generate self-signed SSL certs if none exist (skip if FORCE_HTTP=true, or
# on Railway/PaaS where TLS is terminated at the edge and the app serves HTTP).
# (HTTPS is otherwise needed for voice chat to work over the network)
if [ "${FORCE_HTTP:-false}" = "true" ] || [ -n "${RAILWAY_ENVIRONMENT}${RAILWAY_PROJECT_ID}${RAILWAY_SERVICE_ID}${RAILWAY_PUBLIC_DOMAIN}" ]; then
  echo "⚡ HTTP mode (FORCE_HTTP or Railway) — skipping SSL certificate generation"
elif [ ! -f "$CERTS/cert.pem" ] || [ ! -f "$CERTS/key.pem" ]; then
  echo "🔐 Generating self-signed SSL certificate..."
  mkdir -p "$CERTS"
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$CERTS/key.pem" \
    -out "$CERTS/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=MSG Arena" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    2>/dev/null
  chown node:node "$CERTS/cert.pem" "$CERTS/key.pem" 2>/dev/null || true
  echo "✅ SSL certificate created"
fi

# Fix ownership on bind-mounted volumes (Synology / NAS friendly)
# Only recurse if the data dir isn't already owned by node (uid 1000)
OWNER=$(stat -c '%u' "$DATA" 2>/dev/null || echo "unknown")
if [ "$OWNER" != "1000" ]; then
  chown -R node:node "$DATA" 2>/dev/null || true
fi

exec su-exec node "$@"
