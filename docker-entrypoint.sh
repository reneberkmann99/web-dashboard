#!/bin/sh
set -e

echo "[HostPanel] Running database migrations..."
prisma migrate deploy

echo "[HostPanel] Starting server..."
exec node server.js
