#!/bin/bash
# Hovod all-in-one entrypoint.
#
# Responsibilities:
#   1. Load/generate secrets and persist them in /data/.hovod-secrets so the
#      container survives restarts and upgrades.
#   2. Start embedded MariaDB (unless DATABASE_URL is set) and embedded Redis
#      (unless REDIS_URL is set).
#   3. Start the worker and the API, forward SIGTERM to every process, and exit
#      (non-zero) as soon as a core process dies so Docker's restart policy can
#      bring the whole container back in a clean state.
set -eu

log() { echo "[hovod] $*"; }

DATA_DIR="${HOVOD_DATA_DIR:-/data}"
SECRETS_FILE="$DATA_DIR/.hovod-secrets"
mkdir -p "$DATA_DIR"

# ── Secrets (env var wins, then persisted file, then generated) ──────────────
gen_secret() { head -c 96 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c "$1"; }

if [ -f "$SECRETS_FILE" ]; then
  while IFS='=' read -r key value; do
    [ -z "$key" ] && continue
    case "$key" in \#*) continue ;; esac
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < "$SECRETS_FILE"
fi

persist_secret() {
  # persist_secret NAME VALUE — append once, keep the file private
  if ! grep -q "^$1=" "$SECRETS_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$1" "$2" >> "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"
  fi
}

if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET="$(gen_secret 64)"
  persist_secret JWT_SECRET "$JWT_SECRET"
  log "Generated JWT_SECRET (persisted in $SECRETS_FILE)"
fi
export JWT_SECRET

# ── Scratch space for FFmpeg on the persistent volume (not the overlay fs) ──
# Only the worker gets TMPDIR pointed here (see below); MariaDB keeps its own.
WORK_DIR="${WORK_DIR:-$DATA_DIR/tmp}"
mkdir -p "$WORK_DIR"
chmod 1777 "$WORK_DIR"
find "$WORK_DIR" -mindepth 1 -maxdepth 1 -name 'hovod-*' -exec rm -rf {} + 2>/dev/null || true

PIDS=""
MARIADB_STARTED=""
REDIS_STARTED=""
SHUTTING_DOWN=0

# ── MariaDB (embedded, unless DATABASE_URL is set) ──────────────────────────
mysql_ping() { mysqladmin -u root -p"$MARIADB_ROOT_PASSWORD" ping --silent 2>/dev/null; }

wait_for_mysql() {
  # wait_for_mysql SECONDS — returns 0 when the server answers with our password
  for _ in $(seq 1 "$1"); do
    if mysql_ping; then return 0; fi
    sleep 1
  done
  return 1
}

reset_root_password() {
  # Start a temporary server without grant tables and (re)set the root password.
  log "Resetting MariaDB root password..."
  mysqld --user=mysql --datadir="$MYSQL_DATA_DIR" --bind-address=127.0.0.1 --skip-grant-tables --skip-networking &
  local tmp_pid=$!
  for _ in $(seq 1 30); do
    if mysqladmin ping --silent 2>/dev/null; then break; fi
    sleep 1
  done
  mysql -u root -e "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY '${MARIADB_ROOT_PASSWORD}'; FLUSH PRIVILEGES;"
  mysqladmin -u root -p"$MARIADB_ROOT_PASSWORD" shutdown 2>/dev/null || kill "$tmp_pid" 2>/dev/null || true
  wait "$tmp_pid" 2>/dev/null || true
}

if [ -z "${DATABASE_URL:-}" ]; then
  MYSQL_DATA_DIR="$DATA_DIR/mysql"
  mkdir -p "$MYSQL_DATA_DIR" /run/mysqld
  chown -R mysql:mysql "$MYSQL_DATA_DIR" /run/mysqld

  if [ -z "${MARIADB_ROOT_PASSWORD:-}" ]; then
    MARIADB_ROOT_PASSWORD="$(gen_secret 32)"
    persist_secret MARIADB_ROOT_PASSWORD "$MARIADB_ROOT_PASSWORD"
    log "Generated MariaDB root password (persisted in $SECRETS_FILE)"
  fi
  export MARIADB_ROOT_PASSWORD

  if [ ! -d "$MYSQL_DATA_DIR/mysql" ]; then
    log "Initializing MariaDB data directory..."
    mysql_install_db --user=mysql --datadir="$MYSQL_DATA_DIR" --skip-test-db > /dev/null
    reset_root_password
  fi

  log "Starting embedded MariaDB..."
  mysqld --user=mysql --datadir="$MYSQL_DATA_DIR" --bind-address=127.0.0.1 &
  MARIADB_PID=$!
  PIDS="$PIDS $MARIADB_PID"
  MARIADB_STARTED=1

  if ! wait_for_mysql 30; then
    # Data directory exists but our password does not match (e.g. an install
    # created by a version that regenerated the password on every boot).
    if mysqladmin ping --silent 2>/dev/null || kill -0 "$MARIADB_PID" 2>/dev/null; then
      log "MariaDB is up but the stored root password does not match — repairing."
      mysqladmin shutdown 2>/dev/null || kill "$MARIADB_PID" 2>/dev/null || true
      wait "$MARIADB_PID" 2>/dev/null || true
      reset_root_password
      mysqld --user=mysql --datadir="$MYSQL_DATA_DIR" --bind-address=127.0.0.1 &
      MARIADB_PID=$!
      PIDS="$PIDS $MARIADB_PID"
      wait_for_mysql 30 || { log "MariaDB did not become ready"; exit 1; }
    else
      log "MariaDB failed to start"; exit 1
    fi
  fi

  mysql -u root -p"$MARIADB_ROOT_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS hovod;"
  export DATABASE_URL="mysql://root:${MARIADB_ROOT_PASSWORD}@localhost:3306/hovod"
  log "MariaDB ready"
fi

# ── Redis (embedded, unless REDIS_URL is set) ───────────────────────────────
if [ -z "${REDIS_URL:-}" ]; then
  REDIS_DIR="$DATA_DIR/redis"
  mkdir -p "$REDIS_DIR"
  log "Starting embedded Redis..."
  redis-server --dir "$REDIS_DIR" --save 60 1 --loglevel warning --bind 127.0.0.1 \
    --maxmemory "${REDIS_MAXMEMORY:-256mb}" --maxmemory-policy noeviction &
  REDIS_PID=$!
  PIDS="$PIDS $REDIS_PID"
  REDIS_STARTED=1
  for _ in $(seq 1 30); do
    if redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then break; fi
    sleep 1
  done
  export REDIS_URL="redis://127.0.0.1:6379"
  log "Redis ready"
fi

# ── Environment defaults ────────────────────────────────────────────────────
export PORT="${PORT:-3000}"
export NODE_ENV="${NODE_ENV:-production}"

# ── Shutdown handling ───────────────────────────────────────────────────────
shutdown_all() {
  log "Shutting down Hovod..."
  [ -n "${API_PID:-}" ] && kill -TERM "$API_PID" 2>/dev/null || true
  [ -n "${WORKER_PID:-}" ] && kill -TERM "$WORKER_PID" 2>/dev/null || true
  # Give the API and worker up to 25s to finish in-flight work
  for _ in $(seq 1 25); do
    if ! kill -0 "${API_PID:-0}" 2>/dev/null && ! kill -0 "${WORKER_PID:-0}" 2>/dev/null; then break; fi
    sleep 1
  done
  kill -KILL "${API_PID:-0}" "${WORKER_PID:-0}" 2>/dev/null || true
  if [ -n "$REDIS_STARTED" ]; then
    redis-cli -h 127.0.0.1 shutdown 2>/dev/null || kill -TERM "${REDIS_PID:-0}" 2>/dev/null || true
  fi
  if [ -n "$MARIADB_STARTED" ]; then
    mysqladmin -u root -p"$MARIADB_ROOT_PASSWORD" shutdown 2>/dev/null || kill -TERM "${MARIADB_PID:-0}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}

on_signal() { SHUTTING_DOWN=1; }
trap on_signal TERM INT

# ── Worker ──────────────────────────────────────────────────────────────────
log "Starting worker..."
(cd /app/apps/worker && TMPDIR="$WORK_DIR" exec node dist/index.js) &
WORKER_PID=$!

# ── API (also serves the dashboard) ─────────────────────────────────────────
log "Starting API on port $PORT..."
(cd /app/apps/api && exec node dist/index.js) &
API_PID=$!

# Block until a signal arrives or one of the core processes exits.
set +e
wait -n "$API_PID" "$WORKER_PID"
RC=$?
set -e

if [ "$SHUTTING_DOWN" = 1 ]; then
  shutdown_all
  exit 0
fi

log "A core process exited with code $RC — stopping the container so it can be restarted cleanly"
shutdown_all
exit 1
