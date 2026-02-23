#!/bin/sh
set -e

PIDS=""

cleanup() {
  echo "Shutting down Hovod..."
  for pid in $PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  if [ -n "$MARIADB_STARTED" ]; then
    mysqladmin -u root -p"${MARIADB_ROOT_PASSWORD}" shutdown 2>/dev/null || true
  fi
  wait 2>/dev/null
  exit 0
}

trap cleanup TERM INT

# ── MariaDB (embedded, unless DATABASE_URL is set) ───────────
if [ -z "$DATABASE_URL" ]; then
  echo "[hovod] Starting embedded MariaDB..."
  DATA_DIR="/data/mysql"
  MARIADB_ROOT_PASSWORD="${MARIADB_ROOT_PASSWORD:-$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)}"
  mkdir -p "$DATA_DIR" /run/mysqld
  chown -R mysql:mysql "$DATA_DIR" /run/mysqld

  # Initialize data directory on first run
  if [ ! -d "$DATA_DIR/mysql" ]; then
    echo "[hovod] Initializing MariaDB data directory..."
    mysql_install_db --user=mysql --datadir="$DATA_DIR" --skip-test-db > /dev/null 2>&1

    # Start temporarily to set root password
    mysqld --user=mysql --datadir="$DATA_DIR" --bind-address=127.0.0.1 --skip-grant-tables &
    TEMP_PID=$!
    for i in $(seq 1 30); do
      if mysqladmin ping --silent 2>/dev/null; then break; fi
      sleep 1
    done
    mysql -u root -e "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY '${MARIADB_ROOT_PASSWORD}';" 2>/dev/null
    mysql -u root -p"${MARIADB_ROOT_PASSWORD}" -e "CREATE DATABASE IF NOT EXISTS hovod;" 2>/dev/null
    kill "$TEMP_PID" 2>/dev/null
    wait "$TEMP_PID" 2>/dev/null || true
  fi

  # Start MariaDB with authentication enabled
  mysqld --user=mysql --datadir="$DATA_DIR" --bind-address=127.0.0.1 &
  MARIADB_PID=$!
  PIDS="$PIDS $MARIADB_PID"
  MARIADB_STARTED=1

  # Wait for MariaDB to be ready
  echo "[hovod] Waiting for MariaDB..."
  for i in $(seq 1 30); do
    if mysqladmin -u root -p"${MARIADB_ROOT_PASSWORD}" ping --silent 2>/dev/null; then
      break
    fi
    sleep 1
  done

  # Create database (idempotent)
  mysql -u root -p"${MARIADB_ROOT_PASSWORD}" -e "CREATE DATABASE IF NOT EXISTS hovod;" 2>/dev/null

  export DATABASE_URL="mysql://root:${MARIADB_ROOT_PASSWORD}@localhost:3306/hovod"
  echo "[hovod] MariaDB ready (authentication enabled)"
fi

# ── Redis (embedded, unless REDIS_URL is set) ────────────────
if [ -z "$REDIS_URL" ]; then
  echo "[hovod] Starting embedded Redis..."
  REDIS_DIR="/data/redis"
  mkdir -p "$REDIS_DIR"
  redis-server --daemonize yes --dir "$REDIS_DIR" --save 60 1 --loglevel warning --bind 127.0.0.1
  export REDIS_URL="redis://localhost:6379"
  echo "[hovod] Redis ready"
fi

# ── Environment defaults ─────────────────────────────────────
export PORT="${PORT:-3000}"

# ── Worker ───────────────────────────────────────────────────
echo "[hovod] Starting worker..."
cd /app/apps/worker && node dist/index.js &
WORKER_PID=$!
PIDS="$PIDS $WORKER_PID"

# ── API (also serves dashboard) ──────────────────────────────
echo "[hovod] Starting API on port $PORT..."
cd /app/apps/api && exec node dist/index.js
