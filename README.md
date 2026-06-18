# db-docker-server

A CLI + Web UI tool for managing multiple Docker-based database instances (MariaDB, MySQL, PostgreSQL) with seed management, backups, credential handling, and optional MinIO object storage.

## Features

- **Multi-engine support** — MariaDB, MySQL, PostgreSQL
- **Instance isolation** — each instance has its own container, port, and volume
- **Seed management** — import `.sql` / `.sql.gz` files into running databases
- **Backup & restore** — timestamped SQL dumps per instance, auto-synced to MinIO
- **Credential management** — create/drop DB users, change passwords, manage privileges
- **Clone instances** — duplicate an instance with its configuration and data
- **Web UI** — React-based dashboard with authentication, admin management, and task monitoring
- **MinIO integration** — optional S3-compatible object storage for seed files and backups
- **Port conflict detection** — automatic port assignment and conflict warnings
- **Windows + Linux** — works natively or via WSL

## Prerequisites

- Docker + Docker Compose plugin
- Node.js v18+
- Bash (Git Bash / WSL on Windows)

## Quick Start

```bash
# 1. Run setup (installs deps, starts MinIO + PostgreSQL for the UI)
./setup.sh

# 2. Create a database instance
./dbserver myapp init --engine mariadb --version 11 --db myapp_db

# 3. Start it
./dbserver myapp up

# 4. Seed data
./dbserver myapp seed myapp.sql

# 5. Start the web UI
./dbserver ui start
```

On Windows, use `dbserver.cmd` instead of `./dbserver`.

## Project Structure

```
db-docker-server/
├── dbserver              # CLI entry point (Linux/macOS)
├── dbserver.cmd          # CLI entry point (Windows)
├── setup.sh              # First-time setup script
├── docker-compose.yml    # Template for DB instances (mariadb/mysql/postgres + admin UIs)
├── docker-compose.minio.yml  # MinIO + PostgreSQL for the web UI backend
├── .env.example          # Template for instance .env files
├── instances/            # Per-instance directories (each with .env)
├── seed/                 # SQL seed files (.sql, .sql.gz)
├── backups/              # Database backup dumps
├── scripts/
│   └── dbserver.sh       # Main CLI logic
└── web-ui/
    ├── server.cjs        # Node.js backend (API + static serving)
    ├── package.json      # React + Vite frontend
    └── dist/             # Built frontend (after npm run build)
```

## CLI Usage

```
dbserver <instance> <command> [options]
dbserver list
dbserver ports
dbserver ui <action> [options]
```

### Instance Commands

| Command   | Description                                  |
|-----------|----------------------------------------------|
| `init`    | Create a new DB instance                     |
| `up`      | Start the instance containers                |
| `down`    | Stop the instance containers                 |
| `destroy` | Remove instance and its volumes              |
| `status`  | Show instance status                         |
| `seed`    | Import a SQL file into the running DB        |
| `backup`  | Dump database(s) to a timestamped folder     |
| `clone`   | Clone an instance (config + data)            |
| `exec`    | Run arbitrary SQL on the instance            |
| `creds`   | Manage DB users (list/create/drop/passwd)    |
| `logs`    | Tail container logs                          |
| `shell`   | Open a shell in the DB container             |

### Global Commands

| Command | Description                              |
|---------|------------------------------------------|
| `list`  | List all instances                       |
| `ports` | Show all used ports & detect conflicts   |
| `ui`    | Manage the web UI (start/stop/status)    |

### Examples

```bash
# Create a MariaDB instance with auto-assigned ports
dbserver gescom init --engine mariadb --version 11 --db gescom

# Create a PostgreSQL instance on specific ports
dbserver analytics init --engine postgres --version 16 --port 5433 --admin-port 8081

# Seed a database
dbserver gescom seed gescom.sql

# Seed into a specific database
dbserver gescom seed dump.sql --db other_db

# Backup all databases
dbserver gescom backup

# Backup specific databases (comma-separated)
dbserver gescom backup gtpdb500001,licencesdb

# Manage credentials
dbserver gescom creds create devuser pass123 --db gescom --privileges "SELECT,INSERT,UPDATE"
dbserver gescom creds list
dbserver gescom creds passwd devuser newpass
dbserver gescom creds drop devuser

# Clone an instance
dbserver gescom clone gescom-staging

# Execute SQL
dbserver gescom exec "SHOW DATABASES"
```

## Web UI

The web UI provides a browser-based dashboard for managing instances, seeds, backups, and MinIO configuration.

### Start the UI

```bash
dbserver ui start              # Default port 9090
dbserver ui start 8888         # Custom port
dbserver ui start --password secret 9090
```

### UI Features

- Login with session-based authentication
- Create/start/stop/destroy instances
- Upload and manage seed files (local + MinIO)
- Trigger seed imports and backups as background tasks
- Manage DB credentials per instance
- View real-time container logs (SSE)
- Admin user management (superadmin role)
- Port conflict overview

### UI Backend

The UI backend (`web-ui/server.cjs`) uses:
- **PostgreSQL** for admin accounts and configuration storage
- **MinIO** (optional) for centralized seed file storage
- **In-memory sessions** with 12-hour TTL

Environment variables for the UI backend:

| Variable                | Default     | Description                |
|-------------------------|-------------|----------------------------|
| `DBSERVER_UI_PORT`      | `9090`      | Web UI listen port         |
| `DBSERVER_PG_HOST`      | `localhost` | PostgreSQL host            |
| `DBSERVER_PG_PORT`      | `5480`      | PostgreSQL port            |
| `DBSERVER_PG_DB`        | `dbserver`  | PostgreSQL database        |
| `DBSERVER_PG_USER`      | `dbserver`  | PostgreSQL user            |
| `DBSERVER_PG_PASSWORD`  | `dbserver`  | PostgreSQL password        |
| `DBSERVER_UI_USERNAME`  | `admin`     | Default admin username     |
| `DBSERVER_UI_PASSWORD`  | `admin`     | Default admin password     |

## Instance Configuration

Each instance is stored in `instances/<name>/.env`:

```env
PROJECT_NAME=mydb
DB_ENGINE=mariadb
DB_VERSION=11
DB_ROOT_PASSWORD=root
DB_DATABASE=mydb
DB_PORT=23306
DB_ADMIN_PORT=28080
DB_ADMIN_BIND=127.0.0.1
```

### Admin UI access (phpMyAdmin / pgAdmin)

By default the admin UI binds to **`127.0.0.1` only** (`DB_ADMIN_BIND=127.0.0.1`), so it is
**not reachable from the network or the internet** — only from the host itself. This is the
correct control because Docker's published ports bypass UFW; a loopback bind, not a firewall
rule, is what keeps the port closed to the outside.

To reach it from your machine, open an SSH tunnel to the instance's `DB_ADMIN_PORT`:

```bash
ssh -L 28080:127.0.0.1:28080 user@server   # then browse http://localhost:28080
```

The `Admin: http://localhost:<port>` link printed by the CLI only resolves through such a
tunnel once `DB_ADMIN_BIND=127.0.0.1`. To allow direct access from a trusted network, set
`DB_ADMIN_BIND` to a VPN/LAN interface IP; avoid `0.0.0.0` (exposes it to everyone).

Supported engines:
- `mariadb` — with phpMyAdmin admin UI
- `mysql` — with phpMyAdmin admin UI
- `postgres` — with pgAdmin admin UI

## MinIO (Optional)

MinIO provides S3-compatible object storage for sharing seed files and backups across environments.

```bash
# Started automatically by setup.sh via docker-compose.minio.yml
# Default ports: API 9002, Console 9003
# Default credentials: minioadmin / minioadmin
```

Configure MinIO connection in the Web UI settings or via the API.

When MinIO is configured, backups are automatically uploaded after each successful dump. Each backup run creates a timestamped folder (e.g. `backups/backup_licences_20250430_150000/`) containing individual `.sql` files per database.

## Development

```bash
# Install dependencies
cd web-ui && npm install

# Start frontend dev server (Vite)
npm run dev

# Start backend (in another terminal)
node server.cjs

# Build frontend for production
npm run build
```
