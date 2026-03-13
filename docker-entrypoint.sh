#!/bin/sh
set -e

echo "[HostPanel] Running database migrations..."
node ./node_modules/prisma/build/index.js migrate deploy

echo "[HostPanel] Starting server..."
exec node server.js
