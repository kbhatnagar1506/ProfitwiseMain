#!/bin/bash
# Run database migrations

set -e

# Load environment variables
if [ -f .env.local ]; then
  export $(cat .env.local | grep -v '#' | xargs)
fi

# Get database connection string
if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL not set"
  exit 1
fi

# Run migrations using psql
MIGRATIONS_DIR="web/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

echo "Running migrations from $MIGRATIONS_DIR..."

for migration in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  echo "Running: $migration"
  psql "$DATABASE_URL" -f "$migration"
done

echo "Migrations completed successfully!"
