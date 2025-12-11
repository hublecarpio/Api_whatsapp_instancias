#!/bin/sh
set -e

echo "============================================"
echo "Core API - Starting up..."
echo "============================================"

echo "Environment check:"
echo "  CORE_API_PORT: ${CORE_API_PORT:-3001}"
echo "  NODE_ENV: ${NODE_ENV:-development}"
echo "  DATABASE_URL: ${DATABASE_URL:+[SET]}"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set!"
  exit 1
fi

extract_host() {
  echo "$1" | sed -E 's|.*@([^:/]+).*|\1|'
}

extract_port() {
  port=$(echo "$1" | sed -E 's|.*:([0-9]+)/.*|\1|')
  echo "${port:-5432}"
}

DB_HOST=$(extract_host "$DATABASE_URL")
DB_PORT=$(extract_port "$DATABASE_URL")

echo "Database connection:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"

echo ""
echo "Waiting for database to be ready..."

MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
    echo "Database is reachable!"
    break
  fi
  
  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo "  Attempt $RETRY_COUNT/$MAX_RETRIES - Database not ready, waiting 2s..."
  sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "ERROR: Could not connect to database after $MAX_RETRIES attempts"
  echo "Please check:"
  echo "  1. Database is running"
  echo "  2. Network allows connection to $DB_HOST:$DB_PORT"
  echo "  3. DATABASE_URL is correct"
  exit 1
fi

sleep 2

echo ""
echo "Running database migrations..."
if npx prisma db push --skip-generate --accept-data-loss; then
  echo "Migrations completed successfully!"
else
  echo "ERROR: Database migration failed!"
  exit 1
fi

echo ""
echo "Starting Core API on port ${CORE_API_PORT:-3001}..."
exec node dist/index.js
