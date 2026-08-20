#!/bin/sh
set -e

echo "[Noderaft] Running database migrations..."
node ./node_modules/prisma/build/index.js migrate deploy

echo "[Noderaft] Starting server..."
exec node server.js
