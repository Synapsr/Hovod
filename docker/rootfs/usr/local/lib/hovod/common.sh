# Shared helpers for the Hovod image scripts (stage2 hook, mariadb-init,
# hovod-backup, hovod-restore). Sourced by bash scripts — keep it POSIX-ish.

HOVOD_DATA_DIR="${HOVOD_DATA_DIR:-/data}"
HOVOD_SECRETS_FILE="${HOVOD_SECRETS_FILE:-$HOVOD_DATA_DIR/.hovod-secrets}"
HOVOD_CONTENV_DIR=/run/s6/container_environment
MYSQL_SOCKET="${MYSQL_SOCKET:-/run/mysqld/mysqld.sock}"
MYSQL_DATABASE="${MYSQL_DATABASE:-hovod}"

log()  { echo "[hovod] $*"; }
warn() { echo "[hovod] WARNING: $*" >&2; }
die()  { echo "[hovod] FATAL: $1" >&2; exit "${2:-1}"; }

# Generate an alphanumeric secret of the requested length.
gen_secret() { head -c 96 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c "$1"; }

# Load the persisted secrets file into the environment.
# Precedence: a variable already set in the environment wins over the file.
load_secrets_file() {
  [ -f "$HOVOD_SECRETS_FILE" ] || return 0
  while IFS='=' read -r key value; do
    [ -z "$key" ] && continue
    case "$key" in \#*) continue ;; esac
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < "$HOVOD_SECRETS_FILE"
}

# persist_secret NAME VALUE — append once, keep the file private (root:root 600).
persist_secret() {
  if ! grep -q "^$1=" "$HOVOD_SECRETS_FILE" 2>/dev/null; then
    ( umask 077; printf '%s=%s\n' "$1" "$2" >> "$HOVOD_SECRETS_FILE" )
    chmod 600 "$HOVOD_SECRETS_FILE"
  fi
}

# Load the variables the stage2 hook exported for the s6 services (JWT_SECRET,
# MARIADB_ROOT_PASSWORD, DATABASE_URL, ...). Used by scripts run via `docker exec`,
# which do not go through with-contenv.
load_container_env() {
  [ -d "$HOVOD_CONTENV_DIR" ] || return 0
  local f name
  for f in "$HOVOD_CONTENV_DIR"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in *[!A-Za-z0-9_]*) continue ;; esac
    if [ -z "${!name:-}" ]; then
      export "$name=$(cat "$f")"
    fi
  done
}

# Run a MariaDB client command against the embedded server (socket, root).
# The password is passed through MYSQL_PWD so it never shows up in `ps`.
mariadb_root() {
  MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-}" mariadb --protocol=socket --socket="$MYSQL_SOCKET" -u root "$@"
}

mariadb_root_ping() {
  MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-}" mariadb-admin --protocol=socket --socket="$MYSQL_SOCKET" -u root ping --silent >/dev/null 2>&1
}

# True when this container runs the embedded MariaDB (set by the stage2 hook).
embedded_mariadb() {
  [ "${HOVOD_EMBEDDED_MARIADB:-0}" = "1" ]
}
