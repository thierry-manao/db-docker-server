#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[setup]${NC} $*"; }
ok()    { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
fail()  { echo -e "${RED}[setup]${NC} $*"; exit 1; }

# ── Update mode (rebuild frontend + restart service) ──────────────────────────

if [[ "${1:-}" == "update" ]]; then
    info "Updating db-docker-server..."

    # Ensure node/npm are in PATH (nvm, fnm, volta, or /usr/local)
    for p in "$HOME/.nvm/versions/node"/*/bin "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.volta/bin" /usr/local/bin; do
        [[ -d "$p" ]] && export PATH="$p:$PATH" && break
    done
    command -v npm >/dev/null 2>&1 || fail "npm not found. Install Node.js on this server."

    [[ -d "$SCRIPT_DIR/web-ui" ]] || fail "web-ui directory not found in $SCRIPT_DIR"

    info "Installing npm dependencies..."
    (cd "$SCRIPT_DIR/web-ui" && npm install --silent)
    ok "npm dependencies installed ✓"

    info "Building frontend..."
    (cd "$SCRIPT_DIR/web-ui" && npm run build --silent)
    ok "Frontend built ✓"

    info "Pruning dev dependencies..."
    (cd "$SCRIPT_DIR/web-ui" && npm prune --omit=dev --silent)
    ok "Dev dependencies removed ✓"

    # Restart service if systemd is available
    if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled dbserver-ui >/dev/null 2>&1; then
        info "Restarting dbserver-ui service..."
        sudo systemctl restart dbserver-ui
        sleep 2
        if systemctl is-active --quiet dbserver-ui; then
            ok "Service dbserver-ui restarted ✓"
        else
            warn "Service may have failed. Check: journalctl -u dbserver-ui -f"
        fi
    else
        warn "No systemd service found. Restart the UI manually: dbserver ui restart"
    fi

    echo ""
    ok "Update complete!"
    exit 0
fi

# ── Check dependencies ────────────────────────────────────────────────────────

info "Checking dependencies..."
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
command -v node >/dev/null 2>&1   || fail "node is not installed (need v18+)"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is not installed"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
[[ "$NODE_VER" -ge 18 ]] || fail "Node.js v18+ required (found v$NODE_VER)"
ok "docker, docker compose, node v$(node -v) ✓"

# ── Install npm dependencies ─────────────────────────────────────────────────

info "Installing npm dependencies..."
cd web-ui && npm install --silent && cd ..
ok "npm dependencies installed ✓"

# ── Environment file ─────────────────────────────────────────────────────────

ENV_FILE="$SCRIPT_DIR/.env.minio"

if [[ ! -f "$ENV_FILE" ]]; then
    info "Creating default .env.minio..."
    cat > "$ENV_FILE" <<'EOF'
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
MINIO_API_PORT=9002
MINIO_CONSOLE_PORT=9003
DBSERVER_PG_PORT=5480
DBSERVER_PG_USER=dbserver
DBSERVER_PG_PASSWORD=dbserver
EOF
    ok ".env.minio created with defaults"
else
    warn ".env.minio already exists, keeping it"
fi

# Source env for PG connection
set -a
source "$ENV_FILE"
set +a

PG_PORT="${DBSERVER_PG_PORT:-5480}"
PG_USER="${DBSERVER_PG_USER:-dbserver}"
PG_PASSWORD="${DBSERVER_PG_PASSWORD:-dbserver}"

# ── Start services ────────────────────────────────────────────────────────────

info "Starting MinIO + PostgreSQL containers..."
docker compose -f docker-compose.minio.yml --env-file "$ENV_FILE" -p dbserver-minio up -d

info "Waiting for PostgreSQL to be healthy..."
for i in $(seq 1 30); do
    if docker exec dbserver-minio-postgres-1 pg_isready -U "$PG_USER" >/dev/null 2>&1; then
        ok "PostgreSQL is ready ✓"
        break
    fi
    [[ $i -eq 30 ]] && fail "PostgreSQL did not start in time"
    sleep 1
done

info "Waiting for MinIO to be healthy..."
for i in $(seq 1 30); do
    if docker exec dbserver-minio-minio-1 mc ready local >/dev/null 2>&1; then
        ok "MinIO is ready ✓"
        break
    fi
    [[ $i -eq 30 ]] && fail "MinIO did not start in time"
    sleep 1
done

# ── Initialize database ──────────────────────────────────────────────────────

info "Initializing database tables and default admin..."
node -e "
const { Pool } = require('./web-ui/node_modules/pg');
const crypto = require('crypto');

const pool = new Pool({
    host: 'localhost', port: ${PG_PORT},
    database: 'dbserver', user: '${PG_USER}', password: '${PG_PASSWORD}'
});

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.scryptSync(plain, salt, 64).toString('hex');
    return salt + ':' + key;
}

(async () => {
    await pool.query(\`
        CREATE TABLE IF NOT EXISTS admins (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role VARCHAR(20) DEFAULT 'admin',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    \`);
    await pool.query(\`
        CREATE TABLE IF NOT EXISTS config (
            key VARCHAR(100) PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    \`);

    // Seed default admin
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM admins');
    if (Number(rows[0].count) === 0) {
        await pool.query(
            'INSERT INTO admins (username, password, role) VALUES (\$1, \$2, \$3)',
            ['admin', hashPassword('admin'), 'superadmin']
        );
        console.log('  Default admin created: admin / admin');
    } else {
        console.log('  Admin table already has users, skipping seed');
    }

    // Mark setup_required only on first run
    await pool.query(
        \"INSERT INTO config (key, value) VALUES ('setup_required', 'true') ON CONFLICT (key) DO NOTHING\"
    );
    console.log('  Setup flag checked');

    // Seed default MinIO config
    const minio = {
        endPoint: 'localhost',
        port: Number('${MINIO_API_PORT:-9002}'),
        useSSL: false,
        accessKey: '${MINIO_ROOT_USER:-minioadmin}',
        secretKey: '${MINIO_ROOT_PASSWORD:-minioadmin}',
        bucket: 'dbserver-seeds'
    };
    await pool.query(
        \"INSERT INTO config (key, value) VALUES ('minio', \$1) ON CONFLICT (key) DO NOTHING\",
        [JSON.stringify(minio)]
    );
    console.log('  MinIO config seeded');

    pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
"

ok "Database initialized ✓"

# ── Build frontend ────────────────────────────────────────────────────────────

info "Building frontend..."
cd web-ui && npm run build --silent && cd ..
ok "Frontend built ✓"

info "Pruning dev dependencies..."
cd web-ui && npm prune --omit=dev --silent && cd ..
ok "Dev dependencies removed ✓"

# ── Install systemd service ──────────────────────────────────────────────────

SERVICE_NAME="dbserver-ui"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(command -v node)"
UI_PORT="${DBSERVER_UI_PORT:-8888}"

info "Installing systemd service (${SERVICE_NAME})..."

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=db-docker-server Web UI
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_BIN} ${SCRIPT_DIR}/web-ui/server.cjs
Restart=always
RestartSec=5
Environment=DBSERVER_UI_PORT=${UI_PORT}
Environment=DBSERVER_PG_HOST=localhost
Environment=DBSERVER_PG_PORT=${PG_PORT}
Environment=DBSERVER_PG_USER=${PG_USER}
Environment=DBSERVER_PG_PASSWORD=${PG_PASSWORD}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

# Check if it started OK
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Service ${SERVICE_NAME} is running ✓"
else
    warn "Service may have failed to start. Check: journalctl -u ${SERVICE_NAME} -f"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          db-docker-server setup complete         ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Service:     ${CYAN}systemctl status dbserver-ui${NC}       ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Logs:        ${CYAN}journalctl -u dbserver-ui -f${NC}       ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Restart:     ${CYAN}systemctl restart dbserver-ui${NC}      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Default UI:  ${CYAN}http://localhost:${UI_PORT}${NC}              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Login:       ${YELLOW}admin / admin${NC}                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${RED}⚠  You will be forced to change passwords${NC}      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${RED}   and reconfigure on first login.${NC}              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
