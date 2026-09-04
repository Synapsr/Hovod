#!/bin/bash
# Embedded MariaDB initialisation (s6-rc oneshot `mariadb-init`, runs as root,
# with the container environment already loaded by with-contenv).
#
#   * first boot: create the data directory and set the root password
#   * every boot: make sure the stored root password actually works — installs
#     created by a version that regenerated the password on every boot are
#     repaired automatically, and MARIADB_ROOT_PASSWORD changes are applied
#   * make sure the `hovod` database exists
#
# The check needs a running server, so it is done against a temporary,
# socket-only mysqld. To keep boots fast it only runs when the password is not
# yet known to work (marker file inside the data directory, so it travels with
# the data).
set -euo pipefail

. /usr/local/lib/hovod/common.sh

DATADIR="${MYSQL_DATA_DIR:-$HOVOD_DATA_DIR/mysql}"
MARKER="$DATADIR/.hovod-root-password.sha256"
TMP_PID=""

[ -n "${MARIADB_ROOT_PASSWORD:-}" ] || die "MARIADB_ROOT_PASSWORD is not set (stage2 hook did not run?)"

mkdir -p "$DATADIR" /run/mysqld
chown mysql:mysql "$DATADIR" /run/mysqld

password_fingerprint() { printf '%s' "$MARIADB_ROOT_PASSWORD" | sha256sum | cut -d' ' -f1; }

start_temp_server() {
  # start_temp_server [extra mysqld args] — socket only, never reachable over TCP
  mysqld --user=mysql --datadir="$DATADIR" --socket="$MYSQL_SOCKET" \
         --skip-networking "$@" 2>&1 &
  TMP_PID=$!
  local i
  for i in $(seq 1 60); do
    if mariadb-admin --protocol=socket --socket="$MYSQL_SOCKET" ping --silent >/dev/null 2>&1; then
      return 0
    fi
    kill -0 "$TMP_PID" 2>/dev/null || die "temporary MariaDB exited during startup"
    sleep 1
  done
  die "temporary MariaDB did not become ready in 60s"
}

stop_temp_server() {
  [ -n "$TMP_PID" ] || return 0
  # SIGTERM is a normal shutdown for mysqld; fall back to the admin command
  kill -TERM "$TMP_PID" 2>/dev/null || true
  local i
  for i in $(seq 1 60); do
    kill -0 "$TMP_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$TMP_PID" 2>/dev/null; then
    MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-admin --protocol=socket --socket="$MYSQL_SOCKET" -u root shutdown 2>/dev/null || true
    wait "$TMP_PID" 2>/dev/null || true
  fi
  TMP_PID=""
}
trap 'stop_temp_server' EXIT

reset_root_password() {
  # Start without grant tables and (re)set the root password.
  log "Setting MariaDB root password..."
  start_temp_server --skip-grant-tables
  mariadb --protocol=socket --socket="$MYSQL_SOCKET" -u root -e \
    "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY '${MARIADB_ROOT_PASSWORD//\'/\'\'}'; FLUSH PRIVILEGES;"
  stop_temp_server
}

# ── First boot ──────────────────────────────────────────────────────────────
fresh=0
if [ ! -d "$DATADIR/mysql" ]; then
  log "Initializing MariaDB data directory in $DATADIR..."
  mysql_install_db --user=mysql --datadir="$DATADIR" --skip-test-db >/dev/null
  fresh=1
fi

# ── Verify / repair the root password, ensure the database exists ───────────
want="$(password_fingerprint)"
have="$(cat "$MARKER" 2>/dev/null || true)"

if [ "$fresh" = 1 ] || [ "$want" != "$have" ]; then
  if [ "$fresh" = 1 ]; then
    reset_root_password
  else
    log "Verifying MariaDB root password..."
    start_temp_server
    if ! mariadb_root -e 'SELECT 1' >/dev/null 2>&1; then
      log "Stored root password does not match the data directory — repairing."
      stop_temp_server
      reset_root_password
    else
      stop_temp_server
    fi
  fi

  start_temp_server
  mariadb_root -e 'SELECT 1' >/dev/null || die "root password still rejected after reset"
  mariadb_root -e "CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\`;"
  stop_temp_server

  printf '%s' "$want" > "$MARKER"
  chown mysql:mysql "$MARKER"
  chmod 600 "$MARKER"
  log "MariaDB root password verified"
fi

log "MariaDB data directory ready"
