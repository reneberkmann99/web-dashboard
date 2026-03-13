#!/bin/sh
set -e

echo "[HostPanel] Running database migrations..."
npx prisma migrate deploy

echo "[HostPanel] Starting server..."
exec node server.js
