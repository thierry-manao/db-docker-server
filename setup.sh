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
cd web-ui && npm install --omit=dev --silent && cd ..
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

    // Mark setup_required
    await pool.query(
        \"INSERT INTO config (key, value) VALUES ('setup_required', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()\"
    );
    console.log('  Setup flag set — UI will force reconfiguration');

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

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          db-docker-server setup complete         ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Start the server:                               ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    node web-ui/server.cjs                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Default UI:  ${CYAN}http://localhost:8888${NC}              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Login:       ${YELLOW}admin / admin${NC}                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${RED}⚠  You will be forced to change passwords${NC}      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${RED}   and reconfigure on first login.${NC}              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
