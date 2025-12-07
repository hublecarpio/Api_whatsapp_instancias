#!/bin/sh
set -e

echo "Waiting for database to be ready..."
sleep 5

echo "Running database migrations..."
npx prisma db push --skip-generate

echo "Starting Core API..."
exec node dist/index.js
