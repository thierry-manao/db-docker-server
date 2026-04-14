#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTANCES_DIR="$PROJECT_DIR/instances"
SEED_DIR="$PROJECT_DIR/seed"
TEMPLATE_PATH="$PROJECT_DIR/.env.example"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

# ── Helpers ──────────────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage: dbserver <instance> <command> [options]

Commands:
  init          Create a new DB instance
  up            Start the instance
  down          Stop the instance
  destroy       Remove instance and its volumes
  status        Show instance status
  seed          Import a SQL file into the running DB
  logs          Tail container logs
  shell         Open a shell in the DB container
  list          List all instances

Options (init):
  --engine <mariadb|mysql|postgres>   DB engine (default: mariadb)
  --version <tag>                     DB image version (default: 11)
  --port <port>                       Host DB port (auto-assigned if omitted)
  --admin-port <port>                 Host admin UI port (auto-assigned if omitted)
  --db <name>                         Database name to create
  --root-password <pw>                Root password (default: root)

Examples:
  dbserver gescom init --engine mariadb --version 11 --db gescom
  dbserver gescom up
  dbserver gescom seed gescom.sql
  dbserver list
EOF
    exit 0
}

# ── Instance helpers ─────────────────────────────────────────────────────────

instance_dir() {
    echo "$INSTANCES_DIR/$1"
}

instance_env() {
    echo "$(instance_dir "$1")/.env"
}

require_instance() {
    local name="$1"
    [[ -d "$(instance_dir "$name")" ]] || die "Instance '$name' does not exist. Run: dbserver $name init"
    [[ -f "$(instance_env "$name")" ]] || die "Instance '$name' is missing .env file."
}

load_instance_env() {
    local env_file
    env_file="$(instance_env "$1")"
    # Strip Windows \r before sourcing
    local clean
    clean="$(tr -d '\r' < "$env_file")"
    # shellcheck disable=SC1090
    set -a; eval "$clean"; set +a
}

auto_port() {
    local base="$1"
    local count
    count=$(find "$INSTANCES_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    echo $(( base + count * 10 ))
}

compose_cmd() {
    local name="$1"; shift
    local env_file
    env_file="$(instance_env "$name")"

    load_instance_env "$name"

    docker compose \
        -f "$COMPOSE_FILE" \
        --env-file "$env_file" \
        -p "dbserver_${name}" \
        --profile "${DB_ENGINE:-mariadb}" \
        "$@"
}

get_db_container() {
    local name="$1"
    load_instance_env "$name"
    echo "dbserver_${name}-${DB_ENGINE:-mariadb}-1"
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_init() {
    local name="$1"; shift
    local engine="mariadb"
    local version=""
    local db_port=""
    local admin_port=""
    local database=""
    local root_password="root"
    local seed_file=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --engine)       engine="$2"; shift 2 ;;
            --version)      version="$2"; shift 2 ;;
            --port)         db_port="$2"; shift 2 ;;
            --admin-port)   admin_port="$2"; shift 2 ;;
            --db)           database="$2"; shift 2 ;;
            --root-password) root_password="$2"; shift 2 ;;
            --seed)         seed_file="$2"; shift 2 ;;
            *)              die "Unknown option: $1" ;;
        esac
    done

    case "$engine" in
        mariadb|mysql|postgres) ;;
        *) die "Unsupported engine: $engine. Use mariadb, mysql, or postgres." ;;
    esac

    # Default version per engine
    if [[ -z "$version" ]]; then
        case "$engine" in
            mariadb)  version="11" ;;
            mysql)    version="8.0" ;;
            postgres) version="16" ;;
        esac
    fi

    # Default ports
    local base_db_port=23306
    local base_admin_port=28080
    if [[ "$engine" == "postgres" ]]; then
        base_db_port=25432
    fi
    [[ -z "$db_port" ]]    && db_port=$(auto_port "$base_db_port")
    [[ -z "$admin_port" ]] && admin_port=$(auto_port "$base_admin_port")

    local dir
    dir="$(instance_dir "$name")"

    [[ -d "$dir" ]] && die "Instance '$name' already exists at $dir"
    [[ -f "$TEMPLATE_PATH" ]] || die "Template .env.example not found at $TEMPLATE_PATH"

    mkdir -p "$dir"

    sed \
        -e "s|^PROJECT_NAME=.*|PROJECT_NAME=$name|" \
        -e "s|^DB_ENGINE=.*|DB_ENGINE=$engine|" \
        -e "s|^DB_VERSION=.*|DB_VERSION=$version|" \
        -e "s|^DB_PORT=.*|DB_PORT=$db_port|" \
        -e "s|^DB_ADMIN_PORT=.*|DB_ADMIN_PORT=$admin_port|" \
        -e "s|^DB_DATABASE=.*|DB_DATABASE=$database|" \
        -e "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=$root_password|" \
        -e "s|^DB_SEED_FILES=.*|DB_SEED_FILES=$seed_file|" \
        -e 's/\r$//' \
        "$TEMPLATE_PATH" > "$(instance_env "$name")"

    green "Instance '$name' created."
    echo "  Engine:     $engine:$version"
    echo "  DB port:    $db_port"
    echo "  Admin port: $admin_port"
    echo "  Config:     $(instance_env "$name")"
    echo ""
    echo "Next: dbserver $name up"
}

cmd_up() {
    local name="$1"; shift
    require_instance "$name"
    load_instance_env "$name"

    bold "Starting instance '$name' (${DB_ENGINE}:${DB_VERSION})..."
    compose_cmd "$name" up -d

    # Auto-seed on first startup if DB_SEED_FILES is set
    local seed_log
    seed_log="$(instance_dir "$name")/.seeded"
    if [[ -n "${DB_SEED_FILES:-}" ]]; then
        yellow "Waiting for DB to be ready..."
        local container
        container="$(get_db_container "$name")"
        local retries=30
        # Wait for the DB server to actually accept connections
        case "$DB_ENGINE" in
            mariadb)
                while ! docker exec "$container" mariadb -uroot -p"${DB_ROOT_PASSWORD}" -e "SELECT 1" &>/dev/null && [[ $retries -gt 0 ]]; do
                    sleep 2; retries=$((retries - 1))
                done ;;
            mysql)
                while ! docker exec "$container" mysql -uroot -p"${DB_ROOT_PASSWORD}" -e "SELECT 1" &>/dev/null && [[ $retries -gt 0 ]]; do
                    sleep 2; retries=$((retries - 1))
                done ;;
            postgres)
                while ! docker exec "$container" pg_isready -U "${DB_USER:-postgres}" &>/dev/null && [[ $retries -gt 0 ]]; do
                    sleep 2; retries=$((retries - 1))
                done ;;
        esac
        [[ $retries -gt 0 ]] || yellow "Warning: DB may not be ready yet."

        # Parse comma-separated entries: file.sql or file.sql:dbname
        IFS=',' read -ra seed_entries <<< "$DB_SEED_FILES"
        for entry in "${seed_entries[@]}"; do
            entry="$(echo "$entry" | xargs)"  # trim whitespace
            local seed_file="${entry%%:*}"
            local seed_db="${entry#*:}"
            [[ "$seed_db" == "$seed_file" ]] && seed_db=""

            # Skip if already seeded (check log)
            local seed_key="${seed_file}:${seed_db}"
            if [[ -f "$seed_log" ]] && grep -qF "$seed_key" "$seed_log"; then
                echo "  Already seeded: $seed_file${seed_db:+ -> $seed_db}. Skipping."
                continue
            fi

            if [[ -f "$SEED_DIR/$seed_file" ]]; then
                if [[ -n "$seed_db" ]]; then
                    bold "Auto-seeding '$seed_file' into database '$seed_db'..."
                    cmd_seed "$name" "$seed_file" --db "$seed_db"
                else
                    bold "Auto-seeding '$seed_file'..."
                    cmd_seed "$name" "$seed_file"
                fi
            else
                yellow "Warning: seed file '$seed_file' not found in seed/. Skipping."
            fi
        done
    fi

    green "Instance '$name' is up."
    echo "  DB:    localhost:${DB_PORT}"
    local admin_label="phpMyAdmin"
    [[ "$DB_ENGINE" == "postgres" ]] && admin_label="pgAdmin"
    echo "  Admin: http://localhost:${DB_ADMIN_PORT}  ($admin_label)"
}

cmd_down() {
    local name="$1"
    require_instance "$name"
    compose_cmd "$name" down
    green "Instance '$name' stopped."
}

cmd_destroy() {
    local name="$1"; shift
    require_instance "$name"

    local force=false
    [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && force=true

    if [[ "$force" != true ]]; then
        printf "Destroy instance '%s' and all its data? [y/N] " "$name"
        read -r confirm
        [[ "$confirm" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }
    fi

    compose_cmd "$name" down -v 2>/dev/null || true
    rm -rf "$(instance_dir "$name")"
    green "Instance '$name' destroyed."
}

cmd_status() {
    local name="$1"
    require_instance "$name"
    load_instance_env "$name"

    bold "Instance: $name"
    echo "  Engine:   ${DB_ENGINE}:${DB_VERSION}"
    echo "  DB port:  ${DB_PORT}"
    echo "  Admin:    ${DB_ADMIN_PORT}"
    echo "  Database: ${DB_DATABASE:-<none>}"
    echo ""

    compose_cmd "$name" ps
}

cmd_seed() {
    local name="$1"; shift
    require_instance "$name"
    load_instance_env "$name"

    local file=""
    local db_override=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --db) db_override="$2"; shift 2 ;;
            -*)   die "Unknown option: $1" ;;
            *)    file="$1"; shift ;;
        esac
    done

    [[ -n "$file" ]] || die "Usage: dbserver $name seed <filename.sql> [--db <database>]"

    local filepath="$SEED_DIR/$file"
    [[ -f "$filepath" ]] || die "Seed file not found: $filepath"

    local container
    container="$(get_db_container "$name")"

    local db_target="${db_override:-${DB_DATABASE:-}}"

    # Auto-create the database if it doesn't exist
    if [[ -n "$db_target" ]]; then
        case "$DB_ENGINE" in
            mariadb)
                docker exec -i "$container" mariadb -uroot -p"${DB_ROOT_PASSWORD}" \
                    -e "CREATE DATABASE IF NOT EXISTS \`${db_target}\`;" 2>/dev/null || true
                ;;
            mysql)
                docker exec -i "$container" mysql -uroot -p"${DB_ROOT_PASSWORD}" \
                    -e "CREATE DATABASE IF NOT EXISTS \`${db_target}\`;" 2>/dev/null || true
                ;;
            postgres)
                docker exec -i "$container" sh -c \
                    "psql -U '${DB_USER:-postgres}' -tc \"SELECT 1 FROM pg_database WHERE datname='${db_target}'\" | grep -q 1 || psql -U '${DB_USER:-postgres}' -c \"CREATE DATABASE \\\"${db_target}\\\"\"" 2>/dev/null || true
                ;;
        esac
    fi

    bold "Importing '$file' into ${db_target:-(no database)} on instance '$name'..."

    case "$DB_ENGINE" in
        mariadb|mysql)
            local db_client="mysql"
            [[ "$DB_ENGINE" == "mariadb" ]] && db_client="mariadb"
            if [[ -z "$db_target" ]]; then
                yellow "No database specified — importing without target database."
                docker exec -i "$container" sh -c "exec $db_client -uroot -p'${DB_ROOT_PASSWORD}'" < "$filepath"
            else
                docker exec -i "$container" sh -c "exec $db_client -uroot -p'${DB_ROOT_PASSWORD}' '${db_target}'" < "$filepath"
            fi
            ;;
        postgres)
            docker exec -i "$container" sh -c "exec psql -U '${DB_USER:-postgres}' -d '${db_target:-postgres}'" < "$filepath"
            ;;
    esac

    # Record successful seed in instance log
    local seed_log
    seed_log="$(instance_dir "$name")/.seeded"
    echo "$(date -u '+%Y-%m-%d %H:%M:%S') | $file | ${db_target:-<default>}" >> "$seed_log"

    green "Seed file '$file' imported into '${db_target:-default}'."
}

cmd_logs() {
    local name="$1"; shift
    require_instance "$name"
    compose_cmd "$name" logs -f "$@"
}

cmd_shell() {
    local name="$1"
    require_instance "$name"
    load_instance_env "$name"

    local container
    container="$(get_db_container "$name")"

    case "$DB_ENGINE" in
        mariadb)
            docker exec -it "$container" mariadb -uroot -p"${DB_ROOT_PASSWORD}"
            ;;
        mysql)
            docker exec -it "$container" mysql -uroot -p"${DB_ROOT_PASSWORD}"
            ;;
        postgres)
            docker exec -it "$container" psql -U "${DB_USER:-postgres}" -d "${DB_DATABASE:-postgres}"
            ;;
    esac
}

cmd_list() {
    if [[ ! -d "$INSTANCES_DIR" ]] || [[ -z "$(ls -A "$INSTANCES_DIR" 2>/dev/null)" ]]; then
        echo "No instances found."
        exit 0
    fi

    printf "%-20s %-12s %-10s %-10s %-10s %-8s\n" "NAME" "ENGINE" "VERSION" "DB PORT" "ADMIN" "STATUS"
    printf "%-20s %-12s %-10s %-10s %-10s %-8s\n" "----" "------" "-------" "-------" "-----" "------"

    for dir in "$INSTANCES_DIR"/*/; do
        [[ -d "$dir" ]] || continue
        local inst_name
        inst_name="$(basename "$dir")"
        local env_file="$dir/.env"
        [[ -f "$env_file" ]] || continue

        (
            set -a; source "$env_file"; set +a

            local status="stopped"
            local container="dbserver_${inst_name}-${DB_ENGINE:-mariadb}-1"
            if docker inspect --format='{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
                status="running"
            fi

            printf "%-20s %-12s %-10s %-10s %-10s %-8s\n" \
                "$inst_name" "${DB_ENGINE:-mariadb}" "${DB_VERSION:-?}" \
                "${DB_PORT:-?}" "${DB_ADMIN_PORT:-?}" "$status"
        )
    done
}

# ── Main ─────────────────────────────────────────────────────────────────────

[[ $# -ge 1 ]] || usage

# Special case: `dbserver list` has no instance name
if [[ "$1" == "list" ]]; then
    cmd_list
    exit 0
fi

if [[ "$1" == "help" || "$1" == "--help" || "$1" == "-h" ]]; then
    usage
fi

[[ $# -ge 2 ]] || die "Usage: dbserver <instance> <command> [options]"

INSTANCE_NAME="$1"; shift
COMMAND="$1"; shift

# Validate instance name
[[ "$INSTANCE_NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || die "Invalid instance name: '$INSTANCE_NAME'. Use only letters, numbers, hyphens, underscores."

case "$COMMAND" in
    init)    cmd_init    "$INSTANCE_NAME" "$@" ;;
    up)      cmd_up      "$INSTANCE_NAME" "$@" ;;
    down)    cmd_down    "$INSTANCE_NAME" "$@" ;;
    destroy) cmd_destroy "$INSTANCE_NAME" "$@" ;;
    status)  cmd_status  "$INSTANCE_NAME" "$@" ;;
    seed)    cmd_seed    "$INSTANCE_NAME" "$@" ;;
    logs)    cmd_logs    "$INSTANCE_NAME" "$@" ;;
    shell)   cmd_shell   "$INSTANCE_NAME" "$@" ;;
    *)       die "Unknown command: $COMMAND. Run 'dbserver help' for usage." ;;
esac
