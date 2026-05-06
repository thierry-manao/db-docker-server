const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const Minio = require('minio');
const { Pool } = require('pg');

const execFileAsync = promisify(execFile);

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(__dirname, 'dist');
const INSTANCES_DIR = path.join(PROJECT_DIR, 'instances');
const SEED_DIR = path.join(PROJECT_DIR, 'seed');
const BACKUPS_DIR = path.join(PROJECT_DIR, 'backups');
const SCRIPT_PATH = path.join(PROJECT_DIR, 'scripts', 'dbserver.sh');
const CONFIG_FILE = path.join(PROJECT_DIR, '.dbserver-config.json');

// ── Global config (stored in PostgreSQL) ─────────────────────────────────────

async function loadConfig() {
    try {
        const { rows } = await pool.query('SELECT key, value FROM config');
        const cfg = {};
        for (const row of rows) cfg[row.key] = row.value;
        return cfg;
    } catch { return {}; }
}

async function saveConfig(cfg) {
    for (const [key, value] of Object.entries(cfg)) {
        await pool.query(
            `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, JSON.stringify(value)]
        );
    }
}

async function deleteConfigKey(key) {
    await pool.query('DELETE FROM config WHERE key = $1', [key]);
}

let minioClient = null;

async function getMinioClient() {
    const cfg = await loadConfig();
    const m = cfg.minio;
    if (!m || !m.endPoint || !m.accessKey || !m.secretKey) return null;
    // Recreate client if config changed
    if (!minioClient || minioClient._configHash !== JSON.stringify(m)) {
        minioClient = new Minio.Client({
            endPoint: m.endPoint,
            port: m.port ? Number(m.port) : (m.useSSL ? 443 : 9000),
            useSSL: !!m.useSSL,
            accessKey: m.accessKey,
            secretKey: m.secretKey,
        });
        minioClient._configHash = JSON.stringify(m);
        minioClient._bucket = m.bucket || 'dbserver-seeds';
    }
    return minioClient;
}

async function ensureMinioBucket(client) {
    const bucket = client._bucket;
    const exists = await client.bucketExists(bucket);
    if (!exists) await client.makeBucket(bucket);
    return bucket;
}

async function listMinioFiles() {
    const client = await getMinioClient();
    if (!client) return [];
    const bucket = await ensureMinioBucket(client);
    return new Promise((resolve, reject) => {
        const files = [];
        const stream = client.listObjectsV2(bucket, '', true);
        stream.on('data', (obj) => {
            if (obj.name && /\.sql(\.gz)?$/i.test(obj.name)) {
                files.push({ name: obj.name, size: obj.size, lastModified: obj.lastModified });
            }
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(files.sort((a, b) => a.name.localeCompare(b.name))));
    });
}

// Convert a Windows path to a WSL path: D:\foo\bar -> /mnt/d/foo/bar
function toWslPath(winPath) {
    const p = winPath.replace(/\\/g, '/');
    const m = p.match(/^([A-Za-z]):(\/.*)/);
    if (m) return `/mnt/${m[1].toLowerCase()}${m[2]}`;
    return p;
}

// Detect if docker/bash are available natively, otherwise fall back to WSL
let USE_WSL = false;
if (process.platform === 'win32') {
    try {
        execFileSync('docker', ['--version'], { stdio: 'ignore', timeout: 5000 });
        USE_WSL = false;
    } catch {
        USE_WSL = true;
    }
}
console.log(`[dbserver-ui] Docker mode: ${USE_WSL ? 'WSL' : 'native'}`);

const PORT = Number(process.argv[2]) || Number(process.env.DBSERVER_UI_PORT) || 9090;

// ── Password hashing ─────────────────────────────────────────────────────────

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.scryptSync(plain, salt, 64).toString('hex');
    return `${salt}:${key}`;
}

function verifyPassword(plain, stored) {
    if (!stored.includes(':')) {
        return timingSafeEquals(plain, stored);
    }
    const [salt, key] = stored.split(':');
    const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
    return timingSafeEquals(derived, key);
}

// ── PostgreSQL database ──────────────────────────────────────────────────────

const PG_HOST = process.env.DBSERVER_PG_HOST || 'localhost';
const PG_PORT = Number(process.env.DBSERVER_PG_PORT || 5480);
const PG_DB = process.env.DBSERVER_PG_DB || 'dbserver';
const PG_USER = process.env.DBSERVER_PG_USER || 'dbserver';
const PG_PASSWORD = process.env.DBSERVER_PG_PASSWORD || 'dbserver';

const pool = new Pool({
    host: PG_HOST, port: PG_PORT, database: PG_DB,
    user: PG_USER, password: PG_PASSWORD,
    max: 5, idleTimeoutMillis: 30000,
});

// Prevent unhandled pool errors from crashing the process
pool.on('error', (err) => {
    console.error('[dbserver-ui] PostgreSQL pool error (will reconnect):', err.message);
});

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS admins (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role VARCHAR(20) DEFAULT 'admin',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS config (
            key VARCHAR(100) PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS avatar_key TEXT');
    // Migrate file-based config to DB if exists and DB is empty
    const { rows: cfgRows } = await pool.query("SELECT COUNT(*) as count FROM config");
    if (Number(cfgRows[0].count) === 0) {
        try {
            const fileConfig = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
            for (const [key, value] of Object.entries(fileConfig)) {
                await pool.query('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, JSON.stringify(value)]);
            }
            console.log('[dbserver-ui] Migrated file config to database');
        } catch {}
    }
    // Seed default admin from env vars if table is empty
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM admins');
    if (Number(rows[0].count) === 0) {
        const defaultUser = String(process.env.DBSERVER_UI_USERNAME || 'admin').trim();
        const defaultPass = String(process.env.DBSERVER_UI_PASSWORD || 'admin').trim();
        await pool.query(
            'INSERT INTO admins (username, password, role) VALUES ($1, $2, $3)',
            [defaultUser, hashPassword(defaultPass), 'superadmin']
        );
        console.log(`[dbserver-ui] Default admin '${defaultUser}' created in database`);
    }
}

async function findUserByUsername(username) {
    const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    return rows[0] || null;
}

async function listAdmins() {
    const { rows } = await pool.query('SELECT id, username, role, avatar_key, created_at, updated_at FROM admins ORDER BY id');
    return rows;
}

async function updateAdminAvatarKey(id, key) {
    await pool.query('UPDATE admins SET avatar_key = $1, updated_at = NOW() WHERE id = $2', [key, id]);
}

async function createAdmin(username, password, role = 'admin') {
    const hashed = hashPassword(password);
    const { rows } = await pool.query(
        'INSERT INTO admins (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
        [username, hashed, role]
    );
    return rows[0];
}

async function updateAdminPassword(id, newPassword) {
    const hashed = hashPassword(newPassword);
    await pool.query('UPDATE admins SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, id]);
}

async function updateAdminUsername(id, newUsername) {
    await pool.query('UPDATE admins SET username = $1, updated_at = NOW() WHERE id = $2', [newUsername, id]);
}

async function updateAdminRole(id, role) {
    await pool.query('UPDATE admins SET role = $1, updated_at = NOW() WHERE id = $2', [role, id]);
}

async function deleteAdmin(id) {
    await pool.query('DELETE FROM admins WHERE id = $1', [id]);
}

async function isSetupRequired() {
    try {
        const { rows } = await pool.query("SELECT value FROM config WHERE key = 'setup_required'");
        return rows.length > 0 && rows[0].value === true;
    } catch { return false; }
}

async function completeSetup() {
    await pool.query("DELETE FROM config WHERE key = 'setup_required'");
}

const SESSION_COOKIE = 'dbserver_ui_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();
const lastSeen = new Map(); // username -> timestamp (heartbeat)

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(res, code, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
}

function sendJson(res, code, data) {
    send(res, code, JSON.stringify(data), MIME_TYPES['.json']);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

function readBodyRaw(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function parseMultipart(raw, boundary) {
    const sep = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;
    while (true) {
        const idx = raw.indexOf(sep, start);
        if (idx === -1) break;
        if (start > 0) parts.push(raw.slice(start, idx));
        start = idx + sep.length;
        // skip \r\n after boundary
        if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;
    }
    for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (!filenameMatch) continue;
        let data = part.slice(headerEnd + 4);
        // trim trailing \r\n
        if (data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) data = data.slice(0, -2);
        return { fileName: filenameMatch[1], fileData: data };
    }
    return { fileName: null, fileData: null };
}

function parseJsonBody(req) {
    return readBody(req).then((raw) => {
        if (!raw) return {};
        return JSON.parse(raw);
    });
}

function redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || '';
    const cookies = {};
    for (const pair of cookieHeader.split(';')) {
        const sepIndex = pair.indexOf('=');
        if (sepIndex === -1) continue;
        const key = pair.slice(0, sepIndex).trim();
        const value = pair.slice(sepIndex + 1).trim();
        cookies[key] = decodeURIComponent(value);
    }
    return cookies;
}

function setSessionCookie(res, token) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function createSession(username, role = 'admin') {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, role, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

function getSession(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { token, ...session };
}

function timingSafeEquals(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeValue(value) {
    if (value == null) return '';
    return String(value).trim();
}

// ── Shell helper ─────────────────────────────────────────────────────────────

async function runScript(args, { timeout = 300000 } = {}) {
    const cmd = USE_WSL ? 'wsl' : 'bash';
    const scriptPath = USE_WSL ? toWslPath(SCRIPT_PATH) : SCRIPT_PATH;
    const cmdArgs = USE_WSL ? ['bash', scriptPath, ...args] : [scriptPath, ...args];
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
        cwd: PROJECT_DIR,
        timeout,
    });
    return { stdout, stderr };
}

function spawnScript(args) {
    const cmd = USE_WSL ? 'wsl' : 'bash';
    const scriptPath = USE_WSL ? toWslPath(SCRIPT_PATH) : SCRIPT_PATH;
    const cmdArgs = USE_WSL ? ['bash', scriptPath, ...args] : [scriptPath, ...args];
    return spawn(cmd, cmdArgs, { cwd: PROJECT_DIR });
}

// ── Background task system ───────────────────────────────────────────────────

const tasks = new Map();
let taskIdCounter = 0;

// ── Per-instance metrics ─────────────────────────────────────────────────────

const instanceMetrics = new Map(); // name -> { actions: { up: [...], backup: [...], ... } }

function recordAction(instanceName, action, details = {}) {
    if (!instanceMetrics.has(instanceName)) {
        instanceMetrics.set(instanceName, { actions: [] });
    }
    const m = instanceMetrics.get(instanceName);
    m.actions.push({ action, at: Date.now(), ...details });
    // Keep last 200 actions per instance
    if (m.actions.length > 200) m.actions = m.actions.slice(-200);
}

function getInstanceMetricsSummary(instanceName) {
    const m = instanceMetrics.get(instanceName);
    if (!m) return { totalActions: 0, actions: [], summary: {} };
    const summary = {};
    for (const a of m.actions) {
        if (!summary[a.action]) summary[a.action] = { count: 0, last: null };
        summary[a.action].count++;
        summary[a.action].last = a.at;
    }
    return { totalActions: m.actions.length, actions: m.actions.slice(-50), summary };
}

async function getContainerStats(instanceName, engine) {
    const container = `dbserver_${instanceName}-${engine}-1`;
    try {
        const cmd = USE_WSL ? 'wsl' : 'docker';
        const cmdArgs = USE_WSL
            ? ['docker', 'stats', container, '--no-stream', '--format', '{{json .}}']
            : ['stats', container, '--no-stream', '--format', '{{json .}}'];
        const { stdout } = await execFileAsync(cmd, cmdArgs, { timeout: 10000 });
        const raw = JSON.parse(stdout.trim());
        return {
            cpu: raw.CPUPerc,
            memory: raw.MemUsage,
            memPercent: raw.MemPerc,
            netIO: raw.NetIO,
            blockIO: raw.BlockIO,
            pids: raw.PIDs,
        };
    } catch { return null; }
}

async function getContainerDiskUsage(instanceName, engine) {
    const container = `dbserver_${instanceName}-${engine}-1`;
    try {
        const cmd = USE_WSL ? 'wsl' : 'docker';
        // Get volume size via exec
        let duArgs;
        if (engine === 'postgres') {
            duArgs = USE_WSL
                ? ['docker', 'exec', container, 'du', '-sh', '/var/lib/postgresql/data']
                : ['exec', container, 'du', '-sh', '/var/lib/postgresql/data'];
        } else {
            duArgs = USE_WSL
                ? ['docker', 'exec', container, 'du', '-sh', '/var/lib/mysql']
                : ['exec', container, 'du', '-sh', '/var/lib/mysql'];
        }
        const { stdout } = await execFileAsync(cmd, duArgs, { timeout: 15000 });
        const size = stdout.trim().split(/\s+/)[0];
        return { dataDir: size };
    } catch { return null; }
}

async function getDbEngineStats(instanceName, engine, config) {
    const container = `dbserver_${instanceName}-${engine}-1`;
    try {
        const cmd = USE_WSL ? 'wsl' : 'docker';
        let cmdArgs;
        if (engine === 'postgres') {
            const user = config.DB_USER || 'postgres';
            const query = `
                SELECT json_build_object(
                    'connections', (SELECT json_build_object(
                        'active', (SELECT count(*) FROM pg_stat_activity WHERE state = 'active'),
                        'idle', (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle'),
                        'total', (SELECT count(*) FROM pg_stat_activity),
                        'max', (SELECT setting::int FROM pg_settings WHERE name = 'max_connections')
                    )),
                    'databases', (SELECT json_agg(json_build_object(
                        'name', datname,
                        'size', pg_database_size(datname),
                        'sizeHuman', pg_size_pretty(pg_database_size(datname)),
                        'numbackends', numbackends,
                        'xact_commit', xact_commit,
                        'xact_rollback', xact_rollback,
                        'blks_hit', blks_hit,
                        'blks_read', blks_read,
                        'tup_returned', tup_returned,
                        'tup_fetched', tup_fetched,
                        'tup_inserted', tup_inserted,
                        'tup_updated', tup_updated,
                        'tup_deleted', tup_deleted
                    )) FROM pg_stat_database WHERE datname NOT IN ('template0','template1','postgres')),
                    'uptime', (SELECT extract(epoch FROM now() - pg_postmaster_start_time()))
                );`;
            cmdArgs = USE_WSL
                ? ['docker', 'exec', container, 'psql', '-U', user, '-t', '-A', '-c', query]
                : ['exec', container, 'psql', '-U', user, '-t', '-A', '-c', query];
        } else {
            // MariaDB/MySQL
            const pw = config.DB_ROOT_PASSWORD || 'root';
            const client = engine === 'mariadb' ? 'mariadb' : 'mysql';
            const query = `SELECT JSON_OBJECT(
                'connections', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Threads_connected'),
                'maxConnections', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_VARIABLES WHERE VARIABLE_NAME = 'max_connections'),
                'totalQueries', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Questions'),
                'slowQueries', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Slow_queries'),
                'uptime', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Uptime'),
                'bytesReceived', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Bytes_received'),
                'bytesSent', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Bytes_sent'),
                'abortedConnections', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Aborted_connects'),
                'openTables', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Open_tables'),
                'tableLocksWaited', (SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Table_locks_waited')
            ) AS stats;`;
            cmdArgs = USE_WSL
                ? ['docker', 'exec', container, client, '-uroot', `-p${pw}`, '-N', '-e', query]
                : ['exec', container, client, '-uroot', `-p${pw}`, '-N', '-e', query];
        }
        const { stdout } = await execFileAsync(cmd, cmdArgs, { timeout: 15000 });
        const stats = JSON.parse(stdout.trim());

        // Get table sizes for mysql/mariadb
        if (engine !== 'postgres') {
            const sizeQuery = `SELECT JSON_ARRAYAGG(JSON_OBJECT(
                'name', TABLE_SCHEMA,
                'size', SUM(DATA_LENGTH + INDEX_LENGTH),
                'sizeHuman', CONCAT(ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1048576, 1), ' MB'),
                'tables', COUNT(*)
            )) FROM information_schema.TABLES
            WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
            GROUP BY TABLE_SCHEMA;`;
            const sizeCmdArgs = USE_WSL
                ? ['docker', 'exec', container, engine === 'mariadb' ? 'mariadb' : 'mysql', '-uroot', `-p${config.DB_ROOT_PASSWORD || 'root'}`, '-N', '-e', sizeQuery]
                : ['exec', container, engine === 'mariadb' ? 'mariadb' : 'mysql', '-uroot', `-p${config.DB_ROOT_PASSWORD || 'root'}`, '-N', '-e', sizeQuery];
            try {
                const { stdout: sizeOut } = await execFileAsync(cmd, sizeCmdArgs, { timeout: 10000 });
                stats.databases = JSON.parse(sizeOut.trim());
            } catch { stats.databases = []; }
        }

        return stats;
    } catch (err) { return { error: err.message }; }
}

// ── Metrics history (periodic snapshots) ─────────────────────────────────────

const metricsHistory = new Map(); // name -> { snapshots: [{ ts, cpu, mem, queries, connections }] }
const METRICS_MAX_SNAPSHOTS = 60; // keep ~30 minutes at 30s intervals
const METRICS_INTERVAL_MS = 30000;

function getMetricsHistory(instanceName) {
    if (!metricsHistory.has(instanceName)) metricsHistory.set(instanceName, { snapshots: [] });
    return metricsHistory.get(instanceName);
}

async function collectMetricsSnapshot(instanceName, engine, config) {
    const h = getMetricsHistory(instanceName);
    const container = `dbserver_${instanceName}-${engine}-1`;
    try {
        const cmd = USE_WSL ? 'wsl' : 'docker';
        // Get container stats
        const statsArgs = USE_WSL
            ? ['docker', 'stats', container, '--no-stream', '--format', '{{.CPUPerc}}|{{.MemPerc}}|{{.MemUsage}}']
            : ['stats', container, '--no-stream', '--format', '{{.CPUPerc}}|{{.MemPerc}}|{{.MemUsage}}'];
        const { stdout } = await execFileAsync(cmd, statsArgs, { timeout: 10000 });
        const [cpuStr, memStr] = stdout.trim().split('|');
        const cpu = parseFloat(cpuStr) || 0;
        const mem = parseFloat(memStr) || 0;

        // Get query count
        let queries = 0, connections = 0;
        if (engine === 'postgres') {
            const user = config.DB_USER || 'postgres';
            const qArgs = USE_WSL
                ? ['docker', 'exec', container, 'psql', '-U', user, '-t', '-A', '-c', "SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database;"]
                : ['exec', container, 'psql', '-U', user, '-t', '-A', '-c', "SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database;"];
            const cArgs = USE_WSL
                ? ['docker', 'exec', container, 'psql', '-U', user, '-t', '-A', '-c', "SELECT count(*) FROM pg_stat_activity;"]
                : ['exec', container, 'psql', '-U', user, '-t', '-A', '-c', "SELECT count(*) FROM pg_stat_activity;"];
            try {
                const { stdout: qOut } = await execFileAsync(cmd, qArgs, { timeout: 5000 });
                queries = parseInt(qOut.trim()) || 0;
            } catch {}
            try {
                const { stdout: cOut } = await execFileAsync(cmd, cArgs, { timeout: 5000 });
                connections = parseInt(cOut.trim()) || 0;
            } catch {}
        } else {
            const client = engine === 'mariadb' ? 'mariadb' : 'mysql';
            const pw = config.DB_ROOT_PASSWORD || 'root';
            const qArgs = USE_WSL
                ? ['docker', 'exec', container, client, '-uroot', `-p${pw}`, '-N', '-e', "SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Questions';"]
                : ['exec', container, client, '-uroot', `-p${pw}`, '-N', '-e', "SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Questions';"];
            const cArgs = USE_WSL
                ? ['docker', 'exec', container, client, '-uroot', `-p${pw}`, '-N', '-e', "SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Threads_connected';"]
                : ['exec', container, client, '-uroot', `-p${pw}`, '-N', '-e', "SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'Threads_connected';"];
            try {
                const { stdout: qOut } = await execFileAsync(cmd, qArgs, { timeout: 5000 });
                queries = parseInt(qOut.trim()) || 0;
            } catch {}
            try {
                const { stdout: cOut } = await execFileAsync(cmd, cArgs, { timeout: 5000 });
                connections = parseInt(cOut.trim()) || 0;
            } catch {}
        }

        h.snapshots.push({ ts: Date.now(), cpu, mem, queries, connections });
        if (h.snapshots.length > METRICS_MAX_SNAPSHOTS) h.snapshots.shift();
        if (h.snapshots.length <= 3) console.log(`[metrics] ${instanceName}: cpu=${cpu}% mem=${mem}% queries=${queries} conns=${connections} (${h.snapshots.length} snapshots)`);
    } catch (err) { /* instance not running or stats failed */ }
}

// Periodic metrics collector
let metricsCollectorInterval = null;

async function startMetricsCollector() {
    if (metricsCollectorInterval) return;
    // Collect immediately on start
    try {
        const instances = await listInstances();
        for (const inst of instances) {
            if (!inst.running) continue;
            const engine = inst.config.DB_ENGINE || 'mariadb';
            collectMetricsSnapshot(inst.name, engine, inst.config).catch(() => {});
        }
    } catch {}
    metricsCollectorInterval = setInterval(async () => {
        try {
            const instances = await listInstances();
            for (const inst of instances) {
                if (!inst.running) continue;
                const engine = inst.config.DB_ENGINE || 'mariadb';
                collectMetricsSnapshot(inst.name, engine, inst.config).catch(() => {});
            }
        } catch {}
    }, METRICS_INTERVAL_MS);
}

// ── Slow queries ─────────────────────────────────────────────────────────────

async function getSlowQueries(instanceName, engine, config, limit = 20) {
    const container = `dbserver_${instanceName}-${engine}-1`;
    const cmd = USE_WSL ? 'wsl' : 'docker';
    try {
        let cmdArgs;
        if (engine === 'postgres') {
            const user = config.DB_USER || 'postgres';
            const query = `
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
                        RAISE NOTICE 'has_pgss';
                    END IF;
                END $$;
                SELECT COALESCE(
                    (SELECT json_agg(q) FROM (
                        SELECT query, calls, total_exec_time::numeric(12,2) as total_ms,
                            mean_exec_time::numeric(12,2) as mean_ms,
                            rows, shared_blks_hit, shared_blks_read
                        FROM pg_stat_statements
                        WHERE query NOT LIKE '%pg_stat%'
                        ORDER BY total_exec_time DESC LIMIT ${limit}
                    ) q),
                    (SELECT json_agg(q) FROM (
                        SELECT query, state, wait_event_type, wait_event,
                            extract(epoch FROM now() - query_start)::numeric(10,2) as duration_s,
                            datname, usename
                        FROM pg_stat_activity
                        WHERE state != 'idle' AND query NOT LIKE '%pg_stat%' AND pid != pg_backend_pid()
                        ORDER BY query_start ASC LIMIT ${limit}
                    ) q)
                );`;
            cmdArgs = USE_WSL
                ? ['docker', 'exec', container, 'psql', '-U', user, '-t', '-A', '-c', query]
                : ['exec', container, 'psql', '-U', user, '-t', '-A', '-c', query];
            const { stdout } = await execFileAsync(cmd, cmdArgs, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
            const trimmed = stdout.trim();
            if (!trimmed || trimmed === '' || trimmed === 'null') return [];
            return JSON.parse(trimmed) || [];
        } else {
            // MariaDB/MySQL: try 3 sources in order:
            // 1. performance_schema (best — query digests with stats)
            // 2. mysql.slow_log table (if log_output=TABLE)
            // 3. SHOW PROCESSLIST (currently running)
            const client = engine === 'mariadb' ? 'mariadb' : 'mysql';
            const pw = config.DB_ROOT_PASSWORD || 'root';
            const baseArgs = USE_WSL
                ? ['docker', 'exec', container, client, '-uroot', `-p${pw}`, '--batch', '--skip-column-names', '-e']
                : ['exec', container, client, '-uroot', `-p${pw}`, '--batch', '--skip-column-names', '-e'];

            // Source 1: performance_schema digests
            try {
                const q1 = `SELECT IFNULL(SCHEMA_NAME,'—'), LEFT(IFNULL(DIGEST_TEXT,'?'),200), COUNT_STAR, ROUND(SUM_TIMER_WAIT/1000000000,2), ROUND(AVG_TIMER_WAIT/1000000000,2), ROUND(MAX_TIMER_WAIT/1000000000,2), SUM_ROWS_SENT, SUM_ROWS_EXAMINED FROM performance_schema.events_statements_summary_by_digest ORDER BY SUM_TIMER_WAIT DESC LIMIT ${limit};`;
                const { stdout: out1 } = await execFileAsync(cmd, [...baseArgs, q1], { timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
                const trimmed1 = out1.trim();
                if (trimmed1) {
                    const rows = trimmed1.split('\n').map(line => {
                        const [schema, digest_text, count, totalTime, avgTime, maxTime, rows_sent, rows_examined] = line.split('\t');
                        return { source: 'performance_schema', schema, digest_text, count: Number(count), totalTime: Number(totalTime), avgTime: Number(avgTime), maxTime: Number(maxTime), rows_sent: Number(rows_sent), rows_examined: Number(rows_examined) };
                    });
                    if (rows.length > 0) return rows;
                }
            } catch {}

            // Source 2: mysql.slow_log table
            try {
                const q2 = `SELECT db, LEFT(sql_text,200), query_time, lock_time, rows_sent, rows_examined FROM mysql.slow_log ORDER BY start_time DESC LIMIT ${limit};`;
                const { stdout: out2 } = await execFileAsync(cmd, [...baseArgs, q2], { timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
                const trimmed2 = out2.trim();
                if (trimmed2) {
                    const rows = trimmed2.split('\n').map(line => {
                        const [schema, digest_text, queryTime, lockTime, rows_sent, rows_examined] = line.split('\t');
                        return { source: 'slow_log', schema, digest_text, count: 1, totalTime: queryTime, avgTime: queryTime, maxTime: lockTime, rows_sent: Number(rows_sent), rows_examined: Number(rows_examined) };
                    });
                    if (rows.length > 0) return rows;
                }
            } catch {}

            // Source 3: SHOW FULL PROCESSLIST (current running queries)
            try {
                const q3 = `SELECT db, LEFT(info,200), time, state FROM information_schema.processlist WHERE command != 'Sleep' AND info IS NOT NULL AND info NOT LIKE '%processlist%' ORDER BY time DESC LIMIT ${limit};`;
                const { stdout: out3 } = await execFileAsync(cmd, [...baseArgs, q3], { timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
                const trimmed3 = out3.trim();
                if (trimmed3) {
                    const rows = trimmed3.split('\n').map(line => {
                        const [schema, digest_text, time, state] = line.split('\t');
                        return { source: 'processlist', schema, digest_text: `[${state}] ${digest_text}`, count: 1, totalTime: Number(time), avgTime: Number(time), maxTime: 0, rows_sent: 0, rows_examined: 0 };
                    });
                    if (rows.length > 0) return rows;
                }
            } catch {}

            return [];
        }
    } catch (err) { return { error: err.message }; }
}


function createTask(label, instance) {
    const id = String(++taskIdCounter);
    const task = { id, label, instance, status: 'running', startedAt: Date.now(), output: '', error: null };
    tasks.set(id, task);
    // Keep at most 50 finished tasks
    const finished = [...tasks.values()].filter(t => t.status !== 'running');
    if (finished.length > 50) {
        finished.sort((a, b) => a.startedAt - b.startedAt);
        for (let i = 0; i < finished.length - 50; i++) tasks.delete(finished[i].id);
    }
    return task;
}

function runTaskScript(task, args, { timeout = 300000 } = {}) {
    execFileAsync(
        USE_WSL ? 'wsl' : 'bash',
        USE_WSL ? ['bash', toWslPath(SCRIPT_PATH), ...args] : [SCRIPT_PATH, ...args],
        { cwd: PROJECT_DIR, timeout }
    ).then(({ stdout }) => {
        task.status = 'done';
        task.output = stdout.trim();
        task.finishedAt = Date.now();
    }).catch((err) => {
        task.status = 'error';
        task.error = err.stderr || err.message;
        task.finishedAt = Date.now();
    });
    return task;
}

// ── Instance helpers ─────────────────────────────────────────────────────────

function parseEnvFile(content) {
    const config = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return config;
}

async function listInstances() {
    const instances = [];
    try {
        const entries = await fs.readdir(INSTANCES_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const envPath = path.join(INSTANCES_DIR, entry.name, '.env');
            try {
                const content = await fs.readFile(envPath, 'utf-8');
                const config = parseEnvFile(content);
                const running = await isInstanceRunning(entry.name, config.DB_ENGINE || 'mariadb');
                const seedHistory = await readSeedHistory(entry.name);
                const credentials = await readCredentials(entry.name);
                instances.push({ name: entry.name, config, running, seedHistory, credentials });
            } catch { continue; }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return instances.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSeedHistory(name) {
    const logPath = path.join(INSTANCES_DIR, name, '.seeded');
    try {
        const content = await fs.readFile(logPath, 'utf-8');
        return content.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split(' | ');
            return { date: (parts[0] || '').trim(), file: (parts[1] || '').trim(), database: (parts[2] || '').trim() };
        });
    } catch { return []; }
}

async function readCredentials(name) {
    const credsPath = path.join(INSTANCES_DIR, name, '.credentials');
    try {
        const content = await fs.readFile(credsPath, 'utf-8');
        return content.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split(' | ');
            return {
                date: (parts[0] || '').trim(),
                user: (parts[1] || '').trim(),
                database: (parts[2] || '').trim(),
                privileges: (parts[3] || '').trim(),
            };
        });
    } catch { return []; }
}

async function isInstanceRunning(name, engine) {
    try {
        const container = `dbserver_${name}-${engine}-1`;
        const cmd = USE_WSL ? 'wsl' : 'docker';
        const cmdArgs = USE_WSL
            ? ['docker', 'inspect', '--format', '{{.State.Running}}', container]
            : ['inspect', '--format', '{{.State.Running}}', container];
        const { stdout } = await execFileAsync(cmd, cmdArgs);
        return stdout.trim() === 'true';
    } catch { return false; }
}

async function getInstance(name) {
    const envPath = path.join(INSTANCES_DIR, name, '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    const config = parseEnvFile(content);
    const running = await isInstanceRunning(name, config.DB_ENGINE || 'mariadb');
    const seedHistory = await readSeedHistory(name);
    const credentials = await readCredentials(name);
    return { name, config, running, seedHistory, credentials };
}

async function listSeedFiles() {
    try {
        const entries = await fs.readdir(SEED_DIR, { withFileTypes: true });
        return entries.filter((e) => e.isFile() && /\.sql(\.gz)?$/i.test(e.name)).map((e) => e.name).sort();
    } catch { return []; }
}

async function listBackups() {
    try {
        await fs.mkdir(BACKUPS_DIR, { recursive: true });
        const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true });
        const backups = [];
        for (const e of entries) {
            if (e.isDirectory() && e.name.startsWith('backup_')) {
                // New folder-based backups
                const folderPath = path.join(BACKUPS_DIR, e.name);
                const folderStat = await fs.stat(folderPath);
                const files = await fs.readdir(folderPath);
                const sqlFiles = files.filter(f => f.endsWith('.sql'));
                let totalSize = 0;
                for (const f of sqlFiles) {
                    const s = await fs.stat(path.join(folderPath, f));
                    totalSize += s.size;
                }
                backups.push({
                    name: e.name,
                    type: 'folder',
                    files: sqlFiles,
                    size: totalSize,
                    date: folderStat.mtime.toISOString(),
                });
            } else if (e.isFile() && e.name.endsWith('.sql')) {
                // Legacy flat file backups
                const stat = await fs.stat(path.join(BACKUPS_DIR, e.name));
                backups.push({ name: e.name, type: 'file', size: stat.size, date: stat.mtime.toISOString() });
            }
        }
        return backups.sort((a, b) => b.date.localeCompare(a.date));
    } catch { return []; }
}

async function updateInstanceEnv(name, updates) {
    const envPath = path.join(INSTANCES_DIR, name, '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    const lines = content.split('\n');
    const result = [];
    const applied = new Set();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { result.push(line); continue; }
        const eq = trimmed.indexOf('=');
        if (eq === -1) { result.push(line); continue; }
        const key = trimmed.slice(0, eq).trim();
        if (key in updates) { result.push(`${key}=${updates[key]}`); applied.add(key); }
        else result.push(line);
    }
    for (const [key, value] of Object.entries(updates)) {
        if (!applied.has(key)) result.push(`${key}=${value}`);
    }
    await fs.writeFile(envPath, result.join('\n'));
}

// Check which ports are used by all instances
async function getPortMap() {
    const portMap = [];
    try {
        const entries = await fs.readdir(INSTANCES_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const envPath = path.join(INSTANCES_DIR, entry.name, '.env');
            try {
                const content = await fs.readFile(envPath, 'utf-8');
                const config = parseEnvFile(content);
                const running = await isInstanceRunning(entry.name, config.DB_ENGINE || 'mariadb');
                if (config.DB_PORT) portMap.push({ instance: entry.name, port: Number(config.DB_PORT), type: 'db', running });
                if (config.DB_ADMIN_PORT) portMap.push({ instance: entry.name, port: Number(config.DB_ADMIN_PORT), type: 'admin', running });
            } catch { continue; }
        }
    } catch {}
    return portMap.sort((a, b) => a.port - b.port);
}

// ── Route handling ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // --- CORS for dev (Vite on different port) ---
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // --- Auth API routes (public) ---

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await parseJsonBody(req);
        const username = normalizeValue(body.username);
        const password = normalizeValue(body.password);
        if (!username || !password) return sendJson(res, 400, { error: 'Username and password required.' });
        try {
            const user = await findUserByUsername(username);
            if (!user || !verifyPassword(password, user.password)) {
                return sendJson(res, 401, { error: 'Invalid username or password.' });
            }
            const token = createSession(username, user.role);
            setSessionCookie(res, token);
            const setupRequired = await isSetupRequired();
            return sendJson(res, 200, { ok: true, username, role: user.role, setupRequired });
        } catch (err) { return sendJson(res, 500, { error: 'Database error: ' + err.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const session = getSession(req);
        if (session) sessions.delete(session.token);
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        const setupRequired = await isSetupRequired();
        return sendJson(res, 200, { ok: true, username: session.username, role: session.role, setupRequired });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        const body = await parseJsonBody(req);
        const currentPw = normalizeValue(body.currentPassword);
        const newPw = normalizeValue(body.newPassword);
        const newUsername = normalizeValue(body.username);
        if (!currentPw || !newPw) return sendJson(res, 400, { error: 'Current and new passwords are required.' });
        if (newPw.length < 4) return sendJson(res, 400, { error: 'New password must be at least 4 characters.' });
        try {
            const user = await findUserByUsername(session.username);
            if (!user || !verifyPassword(currentPw, user.password)) {
                return sendJson(res, 403, { error: 'Current password is incorrect.' });
            }
            await updateAdminPassword(user.id, newPw);
            if (newUsername && newUsername !== user.username) {
                await updateAdminUsername(user.id, newUsername);
            }
            // Invalidate all sessions for this user
            for (const [tok, sess] of sessions) {
                if (sess.username === session.username) sessions.delete(tok);
            }
            clearSessionCookie(res);
            return sendJson(res, 200, { ok: true, message: 'Credentials updated. Please log in again.' });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/setup/complete') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        if (session.role !== 'superadmin') return sendJson(res, 403, { error: 'Superadmin access required.' });
        try {
            await completeSetup();
            return sendJson(res, 200, { ok: true, message: 'Setup completed.' });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // ── Admin user management (superadmin only) ──────────────────────────────

    if (url.pathname === '/api/admins') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });

        // Check superadmin role for write operations
        const requireSuperadmin = () => {
            if (session.role !== 'superadmin') {
                sendJson(res, 403, { error: 'Superadmin access required.' });
                return false;
            }
            return true;
        };

        if (req.method === 'GET') {
            try {
                const admins = await listAdmins();
                return sendJson(res, 200, { admins });
            } catch (err) { return sendJson(res, 500, { error: err.message }); }
        }

        if (req.method === 'POST') {
            if (!requireSuperadmin()) return;
            const body = await parseJsonBody(req);
            const username = normalizeValue(body.username);
            const password = normalizeValue(body.password);
            const role = body.role === 'superadmin' ? 'superadmin' : 'admin';
            if (!username || !password) return sendJson(res, 400, { error: 'Username and password required.' });
            if (password.length < 4) return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
            try {
                const existing = await findUserByUsername(username);
                if (existing) return sendJson(res, 409, { error: `User '${username}' already exists.` });
                const admin = await createAdmin(username, password, role);
                return sendJson(res, 201, { ok: true, admin });
            } catch (err) { return sendJson(res, 500, { error: err.message }); }
        }

        if (req.method === 'DELETE') {
            if (!requireSuperadmin()) return;
            const body = await parseJsonBody(req);
            const id = Number(body.id);
            if (!id) return sendJson(res, 400, { error: 'Missing user id.' });
            try {
                // Prevent deleting yourself
                const user = await findUserByUsername(session.username);
                if (user && user.id === id) return sendJson(res, 400, { error: 'Cannot delete your own account.' });
                // Prevent deleting last superadmin
                const { rows } = await pool.query("SELECT COUNT(*) as count FROM admins WHERE role = 'superadmin'");
                const target = (await pool.query('SELECT role FROM admins WHERE id = $1', [id])).rows[0];
                if (target?.role === 'superadmin' && Number(rows[0].count) <= 1) {
                    return sendJson(res, 400, { error: 'Cannot delete the last superadmin.' });
                }
                await deleteAdmin(id);
                // Invalidate sessions for deleted user
                for (const [tok, sess] of sessions) {
                    const u = await findUserByUsername(sess.username);
                    if (!u) sessions.delete(tok);
                }
                return sendJson(res, 200, { ok: true });
            } catch (err) { return sendJson(res, 500, { error: err.message }); }
        }
    }

    const adminRoleMatch = url.pathname.match(/^\/api\/admins\/(\d+)\/role$/);
    if (req.method === 'PUT' && adminRoleMatch) {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        if (session.role !== 'superadmin') return sendJson(res, 403, { error: 'Superadmin access required.' });
        const id = Number(adminRoleMatch[1]);
        const body = await parseJsonBody(req);
        const role = body.role === 'superadmin' ? 'superadmin' : 'admin';
        try {
            await updateAdminRole(id, role);
            return sendJson(res, 200, { ok: true });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    const adminPasswdMatch = url.pathname.match(/^\/api\/admins\/(\d+)\/password$/);
    if (req.method === 'POST' && adminPasswdMatch) {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        if (session.role !== 'superadmin') return sendJson(res, 403, { error: 'Superadmin access required.' });
        const id = Number(adminPasswdMatch[1]);
        const body = await parseJsonBody(req);
        const newPassword = normalizeValue(body.password);
        if (!newPassword || newPassword.length < 4) return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
        try {
            await updateAdminPassword(id, newPassword);
            return sendJson(res, 200, { ok: true, message: 'Password updated.' });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // ── Profile avatars ───────────────────────────────────────────────────────

    // GET /api/profile/avatar/:username — serve avatar from MinIO
    const avatarGetMatch = url.pathname.match(/^\/api\/profile\/avatar\/([a-zA-Z0-9_.-]+)$/);
    if (req.method === 'GET' && avatarGetMatch) {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        const username = decodeURIComponent(avatarGetMatch[1]);
        try {
            const admin = await findUserByUsername(username);
            if (!admin || !admin.avatar_key) return send(res, 404, 'No avatar');
            const client = await getMinioClient();
            if (!client) return send(res, 503, 'MinIO not configured');
            const bucket = await ensureMinioBucket(client);
            const ext = admin.avatar_key.split('.').pop().toLowerCase();
            const contentType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
            const stream = await new Promise((resolve, reject) =>
                client.getObject(bucket, admin.avatar_key, (err, s) => err ? reject(err) : resolve(s))
            );
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' });
            stream.pipe(res);
        } catch {
            return send(res, 404, 'Not found');
        }
        return;
    }

    // POST /api/profile/avatar — upload own avatar (max 2 MB, jpg/png/gif/webp)
    if (req.method === 'POST' && url.pathname === '/api/profile/avatar') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        const ct = req.headers['content-type'] || '';
        const boundaryMatch = ct.match(/boundary=(.+)$/);
        if (!boundaryMatch) return sendJson(res, 400, { error: 'Expected multipart/form-data.' });
        const raw = await readBodyRaw(req);
        if (raw.length > 2 * 1024 * 1024) return sendJson(res, 413, { error: 'Fichier trop grand (max 2 Mo).' });
        const { fileName, fileData } = parseMultipart(raw, boundaryMatch[1]);
        if (!fileName || !fileData) return sendJson(res, 400, { error: 'No file received.' });
        const ext = fileName.split('.').pop().toLowerCase();
        const ALLOWED_IMG = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        if (!ALLOWED_IMG.includes(ext)) return sendJson(res, 400, { error: 'Formats autorisés : jpg, png, gif, webp.' });
        const contentType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext];
        try {
            const client = await getMinioClient();
            if (!client) return sendJson(res, 503, { error: 'MinIO non configuré.' });
            const bucket = await ensureMinioBucket(client);
            const admin = await findUserByUsername(session.username);
            if (!admin) return sendJson(res, 404, { error: 'User not found.' });
            const newKey = `avatars/${session.username}.${ext}`;
            if (admin.avatar_key && admin.avatar_key !== newKey) {
                await client.removeObject(bucket, admin.avatar_key).catch(() => {});
            }
            await client.putObject(bucket, newKey, fileData, fileData.length, { 'Content-Type': contentType });
            await updateAdminAvatarKey(admin.id, newKey);
            return sendJson(res, 200, { ok: true, key: newKey });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // DELETE /api/profile/avatar — remove own avatar
    if (req.method === 'DELETE' && url.pathname === '/api/profile/avatar') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        try {
            const admin = await findUserByUsername(session.username);
            if (admin?.avatar_key) {
                const client = await getMinioClient();
                if (client) {
                    const bucket = await ensureMinioBucket(client);
                    await client.removeObject(bucket, admin.avatar_key).catch(() => {});
                }
                await updateAdminAvatarKey(admin.id, null);
            }
            return sendJson(res, 200, { ok: true });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // ── Heartbeat (any authenticated user) ────────────────────────────────

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        lastSeen.set(session.username, Date.now());
        return sendJson(res, 200, { ok: true });
    }

    // ── Online users (superadmin only) ──────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/online-users') {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
        if (session.role !== 'superadmin') return sendJson(res, 403, { error: 'Superadmin access required.' });
        const ONLINE_THRESHOLD_MS = 60 * 1000; // 60 s
        const cutoff = Date.now() - ONLINE_THRESHOLD_MS;
        const onlineUsernames = [];
        for (const [username, ts] of lastSeen.entries()) {
            if (ts > cutoff) onlineUsernames.push(username);
        }
        return sendJson(res, 200, { online: onlineUsernames });
    }

    // --- Public API (allow ocompose to fetch instances) ---
    const isPublicApi = url.pathname === '/api/instances' && req.method === 'GET';

    // --- Authentication gate ---
    if (!isPublicApi && url.pathname.startsWith('/api/')) {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { error: 'Authentication required.' });
    }

    // ── Instances CRUD ───────────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/instances') {
        const instances = await listInstances();
        return sendJson(res, 200, { instances });
    }

    if (req.method === 'GET' && /^\/api\/instances\/([a-zA-Z0-9_-]+)$/.test(url.pathname)) {
        const name = url.pathname.split('/')[3];
        try {
            const instance = await getInstance(name);
            return sendJson(res, 200, instance);
        } catch { return sendJson(res, 404, { error: 'Instance not found' }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/instances') {
        const body = await parseJsonBody(req);
        const { name, engine, version, db, seed, port, adminPort, rootPassword } = body;
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return sendJson(res, 400, { error: 'Invalid instance name' });
        const args = [name, 'init'];
        if (engine) args.push('--engine', engine);
        if (version) args.push('--version', version);
        if (port) args.push('--port', String(port));
        if (adminPort) args.push('--admin-port', String(adminPort));
        if (db) args.push('--db', db);
        if (rootPassword) args.push('--root-password', rootPassword);
        if (seed) args.push('--seed', seed);
        const task = createTask(`Create instance ${name}${seed ? ' + seed ' + seed : ''}`, name);
        runTaskScript(task, args);
        return sendJson(res, 202, { message: 'Instance creation started', taskId: task.id });
    }

    if (req.method === 'PUT' && /^\/api\/instances\/([a-zA-Z0-9_-]+)$/.test(url.pathname)) {
        const name = url.pathname.split('/')[3];
        const body = await parseJsonBody(req);
        try {
            await updateInstanceEnv(name, body);
            const instance = await getInstance(name);
            return sendJson(res, 200, instance);
        } catch { return sendJson(res, 404, { error: 'Instance not found' }); }
    }

    // ── Background tasks ────────────────────────────────────────────────────

    if (url.pathname === '/api/tasks') {
        if (req.method === 'GET') {
            const list = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
            return sendJson(res, 200, { tasks: list });
        }
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (taskMatch) {
        const task = tasks.get(taskMatch[1]);
        if (!task) return sendJson(res, 404, { error: 'Task not found' });
        if (req.method === 'GET') return sendJson(res, 200, { task });
        if (req.method === 'DELETE') {
            if (task.status === 'running') return sendJson(res, 400, { error: 'Cannot delete a running task' });
            tasks.delete(taskMatch[1]);
            return sendJson(res, 200, { ok: true });
        }
    }

    // ── Instance metrics ───────────────────────────────────────────────────────

    const metricsMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/metrics$/);
    if (req.method === 'GET' && metricsMatch) {
        const name = metricsMatch[1];
        try {
            const inst = await getInstance(name);
            const engine = inst.config.DB_ENGINE || 'mariadb';
            const result = { instance: name, engine };

            // Action history
            result.history = getInstanceMetricsSummary(name);

            // Metrics time series (snapshots)
            const mh = getMetricsHistory(name);
            result.timeSeries = mh.snapshots;

            if (inst.running) {
                // Container resource stats
                result.container = await getContainerStats(name, engine);
                // Disk usage
                result.disk = await getContainerDiskUsage(name, engine);
                // DB engine stats
                result.db = await getDbEngineStats(name, engine, inst.config);
            } else {
                result.container = null;
                result.disk = null;
                result.db = null;
            }

            return sendJson(res, 200, result);
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    }

    // Slow queries endpoint
    const slowMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/slow-queries$/);
    if (req.method === 'GET' && slowMatch) {
        const name = slowMatch[1];
        try {
            const inst = await getInstance(name);
            if (!inst.running) return sendJson(res, 200, { queries: [] });
            const engine = inst.config.DB_ENGINE || 'mariadb';
            const queries = await getSlowQueries(name, engine, inst.config);
            return sendJson(res, 200, { queries });
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    }

    // ── Deploy webhook (authenticates with superadmin credentials) ──────────

    if (req.method === 'POST' && url.pathname === '/api/webhook/deploy') {
        const body = await parseJsonBody(req).catch(() => ({}));
        const username = normalizeValue(body.username);
        const password = normalizeValue(body.password);
        if (!username || !password) return sendJson(res, 401, { error: 'Missing username or password' });
        try {
            const user = await findUserByUsername(username);
            if (!user || !verifyPassword(password, user.password)) {
                return sendJson(res, 403, { error: 'Invalid credentials' });
            }
            if (user.role !== 'superadmin') return sendJson(res, 403, { error: 'Superadmin access required' });
        } catch (err) { return sendJson(res, 500, { error: 'Auth error: ' + err.message }); }

        const branch = body.branch || 'main';
        const installPath = path.resolve(__dirname, '..');

        // Run deploy in background
        const { exec } = require('child_process');
        const script = `cd "${installPath}" && git fetch origin ${branch} && git reset --hard origin/${branch} && bash setup.sh update`;
        exec(script, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) console.error('[webhook] Deploy failed:', err.message, stderr);
            else console.log('[webhook] Deploy success:', stdout.slice(-200));
        });
        return sendJson(res, 200, { status: 'deploy started', branch });
    }

    // ── Instance actions ─────────────────────────────────────────────────────

    // List databases (GET)
    const dbsMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/databases$/);
    if (req.method === 'GET' && dbsMatch) {
        const name = dbsMatch[1];
        const inst = await getInstance(name);
        const engine = inst.config.DB_ENGINE || 'mariadb';
        const container = `dbserver_${name}-${engine}-1`;
        try {
            let cmd, cmdArgs;
            if (engine === 'postgres') {
                cmd = USE_WSL ? 'wsl' : 'docker';
                cmdArgs = USE_WSL
                    ? ['docker', 'exec', container, 'psql', '-U', inst.config.DB_USER || 'postgres', '-t', '-A', '-c', "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres' ORDER BY datname;"]
                    : ['exec', container, 'psql', '-U', inst.config.DB_USER || 'postgres', '-t', '-A', '-c', "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres' ORDER BY datname;"];
            } else {
                cmd = USE_WSL ? 'wsl' : 'docker';
                cmdArgs = USE_WSL
                    ? ['docker', 'exec', container, engine === 'mariadb' ? 'mariadb' : 'mysql', '-uroot', `-p${inst.config.DB_ROOT_PASSWORD}`, '-N', '-e', "SHOW DATABASES;"]
                    : ['exec', container, engine === 'mariadb' ? 'mariadb' : 'mysql', '-uroot', `-p${inst.config.DB_ROOT_PASSWORD}`, '-N', '-e', "SHOW DATABASES;"];
            }
            const { stdout } = await execFileAsync(cmd, cmdArgs, { timeout: 10000 });
            const systemDbs = ['information_schema', 'performance_schema', 'mysql', 'sys'];
            const databases = stdout.trim().split('\n').map(d => d.trim()).filter(d => d && !systemDbs.includes(d));
            return sendJson(res, 200, { databases });
        } catch (err) {
            return sendJson(res, 500, { error: 'Could not list databases', details: err.message });
        }
    }

    const actionMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/actions\/(up|down|destroy|seed|backup|databases|clone|exec)$/);
    if (req.method === 'POST' && actionMatch) {
        const name = actionMatch[1];
        const action = actionMatch[2];

        // Record action metric (except databases which is just a query)
        if (action !== 'databases') recordAction(name, action);

        if (action === 'seed') {
            const body = await parseJsonBody(req);
            const { file, db } = body;
            if (!file) return sendJson(res, 400, { error: 'Missing seed file' });
            const args = [name, 'seed', file];
            if (db) args.push('--db', db);
            const task = createTask(`Seed ${file} → ${name}${db ? '/' + db : ''}`, name);
            runTaskScript(task, args);
            return sendJson(res, 202, { message: 'Seeding started', taskId: task.id });
        }

        if (action === 'databases') {
            // List databases available in this instance
            const inst = await getInstance(name);
            const engine = inst.config.DB_ENGINE || 'mariadb';
            const container = `dbserver_${name}-${engine}-1`;
            try {
                let cmd, cmdArgs;
                if (engine === 'postgres') {
                    cmd = USE_WSL ? 'wsl' : 'docker';
                    cmdArgs = USE_WSL
                        ? ['docker', 'exec', container, 'psql', '-U', inst.config.DB_USER || 'postgres', '-t', '-A', '-c', "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres' ORDER BY datname;"]
                        : ['exec', container, 'psql', '-U', inst.config.DB_USER || 'postgres', '-t', '-A', '-c', "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres' ORDER BY datname;"];
                } else {
                    cmd = USE_WSL ? 'wsl' : 'docker';
                    cmdArgs = USE_WSL
                        ? ['docker', 'exec', container, engine === 'mariadb' ? 'mariadb' : 'mysql', '-uroot', `-p${inst.config.DB_ROOT_PASSWORD}`, '-N', '-e', "SHOW DATABASES;"]
                        : ['exec', container, engine === 'mariadb' ? 'mariadb' : 'mysql', '-uroot', `-p${inst.config.DB_ROOT_PASSWORD}`, '-N', '-e', "SHOW DATABASES;"];
                }
                const { stdout } = await execFileAsync(cmd, cmdArgs, { timeout: 10000 });
                const systemDbs = ['information_schema', 'performance_schema', 'mysql', 'sys'];
                const databases = stdout.trim().split('\n').map(d => d.trim()).filter(d => d && !systemDbs.includes(d));
                return sendJson(res, 200, { databases });
            } catch (err) {
                return sendJson(res, 500, { error: 'Could not list databases', details: err.message });
            }
        }

        if (action === 'backup') {
            const body = await parseJsonBody(req);
            const args = [name, 'backup'];
            // Support multiple databases: body.databases (array) or body.db (string)
            let dbLabel = '';
            if (body.databases && Array.isArray(body.databases) && body.databases.length > 0) {
                args.push(body.databases.join(','));
                dbLabel = body.databases.join(',');
            } else if (body.db) {
                args.push(body.db);
                dbLabel = body.db;
            }
            const task = createTask(`Backup ${name}${dbLabel ? '/' + dbLabel : ''} → MinIO`, name);
            // Run backup then sync to MinIO
            execFileAsync(
                USE_WSL ? 'wsl' : 'bash',
                USE_WSL ? ['bash', toWslPath(SCRIPT_PATH), ...args] : [SCRIPT_PATH, ...args],
                { cwd: PROJECT_DIR, timeout: 300000 }
            ).then(async ({ stdout }) => {
                // Strip ANSI color codes from script output
                const cleanOutput = stdout.replace(/\x1b\[[0-9;]*m/g, '');
                task.output = cleanOutput.trim();
                // Extract backup folder from output (e.g. "Backup folder: /path/to/backup_name_timestamp")
                const folderMatch = cleanOutput.match(/Backup folder:\s*(.+)/);
                if (folderMatch) {
                    const backupFolder = folderMatch[1].trim();
                    const folderName = path.basename(backupFolder);
                    try {
                        const client = await getMinioClient();
                        if (client) {
                            const bucket = await ensureMinioBucket(client);
                            // Upload all .sql files from the backup folder
                            const localFolder = path.join(BACKUPS_DIR, folderName);
                            const files = await fs.readdir(localFolder);
                            for (const file of files) {
                                if (!file.endsWith('.sql')) continue;
                                const filePath = path.join(localFolder, file);
                                await client.fPutObject(bucket, `backups/${folderName}/${file}`, filePath, { 'Content-Type': 'application/sql' });
                            }
                            task.output += `\nUploaded to MinIO: backups/${folderName}/ (${files.filter(f => f.endsWith('.sql')).length} files)`;
                        } else {
                            task.output += '\nMinIO not configured, skipping sync.';
                        }
                    } catch (err) {
                        task.output += `\nMinIO upload failed: ${err.message}`;
                    }
                }
                task.status = 'done';
                task.finishedAt = Date.now();
            }).catch((err) => {
                task.status = 'error';
                task.error = err.stderr || err.message;
                task.finishedAt = Date.now();
            });
            return sendJson(res, 202, { message: 'Backup started', taskId: task.id });
        }

        if (action === 'clone') {
            const body = await parseJsonBody(req);
            if (!body.target) return sendJson(res, 400, { error: 'Missing target name' });
            try {
                const { stdout } = await runScript([name, 'clone', body.target]);
                return sendJson(res, 200, { message: stdout.trim() });
            } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
        }

        if (action === 'exec') {
            const body = await parseJsonBody(req);
            if (!body.sql) return sendJson(res, 400, { error: 'Missing SQL query' });
            const args = [name, 'exec', body.sql];
            if (body.db) args.push('--db', body.db);
            try {
                const cmd = USE_WSL ? 'wsl' : 'bash';
                const scriptPath = USE_WSL ? toWslPath(SCRIPT_PATH) : SCRIPT_PATH;
                const cmdArgs = USE_WSL ? ['bash', scriptPath, ...args] : [scriptPath, ...args];
                const { stdout } = await execFileAsync(cmd, cmdArgs, {
                    cwd: PROJECT_DIR,
                    timeout: 30000,
                    maxBuffer: 50 * 1024 * 1024, // 50 MB
                });
                return sendJson(res, 200, { result: stdout.trim() });
            } catch (err) {
                if (err.message && err.message.includes('maxBuffer')) {
                    return sendJson(res, 413, { error: 'Query result too large. Add a LIMIT clause to reduce output.' });
                }
                return sendJson(res, 500, { error: err.stderr || err.message });
            }
        }

        const destroyFlag = action === 'destroy' ? ['--yes'] : [];
        try {
            const { stdout } = await runScript([name, action, ...destroyFlag]);
            return sendJson(res, 200, { message: stdout.trim() });
        } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
    }

    // ── Credentials management ───────────────────────────────────────────────

    const credsMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/creds$/);
    if (credsMatch) {
        const name = credsMatch[1];

        if (req.method === 'GET') {
            try {
                const { stdout } = await runScript([name, 'creds', 'list']);
                const credentials = await readCredentials(name);
                return sendJson(res, 200, { result: stdout.trim(), credentials });
            } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
        }

        if (req.method === 'POST') {
            const body = await parseJsonBody(req);
            const { user, password, db, privileges } = body;
            if (!user || !password) return sendJson(res, 400, { error: 'Missing user or password' });
            const args = [name, 'creds', 'create', user, password];
            if (db) args.push('--db', db);
            if (privileges) args.push('--privileges', privileges);
            try {
                const { stdout } = await runScript(args);
                return sendJson(res, 200, { message: stdout.trim() });
            } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
        }

        if (req.method === 'DELETE') {
            const body = await parseJsonBody(req);
            if (!body.user) return sendJson(res, 400, { error: 'Missing user' });
            try {
                const { stdout } = await runScript([name, 'creds', 'drop', body.user]);
                return sendJson(res, 200, { message: stdout.trim() });
            } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
        }
    }

    const credsPasswdMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/creds\/passwd$/);
    if (req.method === 'POST' && credsPasswdMatch) {
        const name = credsPasswdMatch[1];
        const body = await parseJsonBody(req);
        if (!body.user || !body.password) return sendJson(res, 400, { error: 'Missing user or password' });
        try {
            const { stdout } = await runScript([name, 'creds', 'passwd', body.user, body.password]);
            return sendJson(res, 200, { message: stdout.trim() });
        } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
    }

    const rootPasswdMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/creds\/root-passwd$/);
    if (req.method === 'POST' && rootPasswdMatch) {
        const name = rootPasswdMatch[1];
        const body = await parseJsonBody(req);
        if (!body.password) return sendJson(res, 400, { error: 'Missing password' });
        try {
            const { stdout } = await runScript([name, 'creds', 'root-passwd', body.password]);
            return sendJson(res, 200, { message: stdout.trim() });
        } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
    }

    const credsGrantsMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/creds\/grants$/);
    if (req.method === 'GET' && credsGrantsMatch) {
        const name = credsGrantsMatch[1];
        const user = url.searchParams.get('user');
        if (!user) return sendJson(res, 400, { error: 'Missing user param' });
        try {
            const { stdout } = await runScript([name, 'creds', 'grants', user]);
            return sendJson(res, 200, { result: stdout.trim() });
        } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
    }

    // ── Logs streaming (SSE) ─────────────────────────────────────────────────

    const logsMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/logs$/);
    if (req.method === 'GET' && logsMatch) {
        const name = logsMatch[1];
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });

        const child = spawnScript([name, 'logs', '--tail', '100']);
        child.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line) res.write(`data: ${line}\n\n`);
            }
        });
        child.stderr.on('data', (data) => {
            res.write(`data: ${data.toString()}\n\n`);
        });
        child.on('close', () => res.end());
        req.on('close', () => child.kill());
        return;
    }

    // ── Seed files & backups ─────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/seed-files') {
        const files = await listSeedFiles();
        return sendJson(res, 200, { files });
    }

    if (req.method === 'GET' && url.pathname === '/api/backups') {
        const backups = await listBackups();
        return sendJson(res, 200, { backups });
    }

    // ── MinIO / Seed Store ───────────────────────────────────────────────────

    if (url.pathname === '/api/config/minio') {
        if (req.method === 'GET') {
            const cfg = await loadConfig();
            const m = cfg.minio || {};
            // Don't expose secretKey in full
            return sendJson(res, 200, {
                configured: !!(m.endPoint && m.accessKey && m.secretKey),
                endPoint: m.endPoint || '',
                port: m.port || '',
                useSSL: !!m.useSSL,
                accessKey: m.accessKey || '',
                bucket: m.bucket || 'dbserver-seeds',
            });
        }
        if (req.method === 'POST') {
            const body = await parseJsonBody(req);
            const cfg = await loadConfig();
            const existingSecret = cfg.minio?.secretKey || '';
            cfg.minio = {
                endPoint: String(body.endPoint || '').trim().replace(/^https?:\/\//, ''),
                port: body.port ? Number(body.port) : undefined,
                useSSL: !!body.useSSL,
                accessKey: String(body.accessKey || '').trim(),
                secretKey: String(body.secretKey || '').trim() || existingSecret,
                bucket: String(body.bucket || 'dbserver-seeds').trim(),
            };
            await saveConfig(cfg);
            minioClient = null; // force reconnect
            return sendJson(res, 200, { ok: true, message: 'MinIO configuration saved.' });
        }
        if (req.method === 'DELETE') {
            await deleteConfigKey('minio');
            minioClient = null;
            return sendJson(res, 200, { ok: true, message: 'MinIO configuration removed.' });
        }
    }

    if (req.method === 'POST' && url.pathname === '/api/config/minio/test') {
        try {
            const client = await getMinioClient();
            if (!client) return sendJson(res, 400, { error: 'MinIO is not configured.' });
            await ensureMinioBucket(client);
            return sendJson(res, 200, { ok: true, message: 'Connection successful.' });
        } catch (err) { return sendJson(res, 500, { error: 'Connection failed: ' + err.message }); }
    }

    // Get MinIO service status + credentials
    if (req.method === 'GET' && url.pathname === '/api/config/minio/service') {
        const composeFile = path.join(PROJECT_DIR, 'docker-compose.minio.yml');
        try {
            await fs.access(composeFile);
        } catch { return sendJson(res, 200, { available: false }); }
        // Read env file if exists
        const envFile = path.join(PROJECT_DIR, '.env.minio');
        let env = {};
        try {
            env = parseEnvFile(await fs.readFile(envFile, 'utf8'));
        } catch {}
        // Check container status
        let running = false;
        try {
            const composePath = USE_WSL ? toWslPath(composeFile) : composeFile;
            const cmd = USE_WSL ? 'wsl' : 'bash';
            const args = USE_WSL
                ? ['bash', '-c', `docker compose -f "${composePath}" -p dbserver-minio ps --format json 2>/dev/null`]
                : ['-c', `docker compose -f "${composePath}" -p dbserver-minio ps --format json 2>/dev/null`];
            const { stdout } = await execFileAsync(cmd, args, { cwd: PROJECT_DIR, timeout: 10000 });
            running = stdout.includes('"running"') || stdout.includes('"Up"');
        } catch {}
        return sendJson(res, 200, {
            available: true,
            running,
            rootUser: env.MINIO_ROOT_USER || 'minioadmin',
            rootPassword: env.MINIO_ROOT_PASSWORD || 'minioadmin',
            apiPort: env.MINIO_API_PORT || '9002',
            consolePort: env.MINIO_CONSOLE_PORT || '9003',
        });
    }

    // Update MinIO service credentials and restart
    if (req.method === 'POST' && url.pathname === '/api/config/minio/service') {
        const body = await parseJsonBody(req);
        const rootUser = String(body.rootUser || '').trim();
        const rootPassword = String(body.rootPassword || '').trim();
        const apiPort = String(body.apiPort || '9002').trim();
        const consolePort = String(body.consolePort || '9003').trim();
        if (!rootUser || !rootPassword) return sendJson(res, 400, { error: 'Root user and password are required.' });
        if (rootUser.length < 3) return sendJson(res, 400, { error: 'Root user must be at least 3 characters.' });
        if (rootPassword.length < 8) return sendJson(res, 400, { error: 'Root password must be at least 8 characters (MinIO requirement).' });

        // Write .env.minio
        const envFile = path.join(PROJECT_DIR, '.env.minio');
        const envContent = `MINIO_ROOT_USER=${rootUser}\nMINIO_ROOT_PASSWORD=${rootPassword}\nMINIO_API_PORT=${apiPort}\nMINIO_CONSOLE_PORT=${consolePort}\n`;
        await fs.writeFile(envFile, envContent, 'utf8');

        // Recreate MinIO container with new creds
        const composeFile = path.join(PROJECT_DIR, 'docker-compose.minio.yml');
        const composePath = USE_WSL ? toWslPath(composeFile) : composeFile;
        const envPath = USE_WSL ? toWslPath(envFile) : envFile;
        try {
            const cmd = USE_WSL ? 'wsl' : 'bash';
            const args = USE_WSL
                ? ['bash', '-c', `docker compose -f "${composePath}" --env-file "${envPath}" -p dbserver-minio up -d --force-recreate 2>&1`]
                : ['-c', `docker compose -f "${composePath}" --env-file "${envPath}" -p dbserver-minio up -d --force-recreate 2>&1`];
            await execFileAsync(cmd, args, { cwd: PROJECT_DIR, timeout: 60000 });
        } catch (err) {
            return sendJson(res, 500, { error: 'Failed to restart MinIO: ' + (err.stderr || err.message) });
        }

        // Auto-update connection config to match new creds
        const cfg = await loadConfig();
        const existing = cfg.minio || {};
        cfg.minio = {
            endPoint: existing.endPoint || PG_HOST,
            port: Number(apiPort),
            useSSL: existing.useSSL || false,
            accessKey: rootUser,
            secretKey: rootPassword,
            bucket: existing.bucket || 'dbserver-seeds',
        };
        await saveConfig(cfg);
        minioClient = null;

        return sendJson(res, 200, { ok: true, message: 'MinIO credentials updated and service restarted.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/minio/files') {
        try {
            const files = await listMinioFiles();
            return sendJson(res, 200, { files });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // Upload local seed file → MinIO
    if (req.method === 'POST' && url.pathname === '/api/minio/upload') {
        const body = await parseJsonBody(req);
        const fileName = body.file;
        if (!fileName) return sendJson(res, 400, { error: 'Missing file name.' });
        const localPath = path.join(SEED_DIR, fileName);
        const resolved = path.resolve(localPath);
        if (!resolved.startsWith(path.resolve(SEED_DIR))) return sendJson(res, 403, { error: 'Forbidden' });
        try {
            const client = await getMinioClient();
            if (!client) return sendJson(res, 400, { error: 'MinIO is not configured.' });
            const bucket = await ensureMinioBucket(client);
            const stat = await fs.stat(resolved);
            await client.fPutObject(bucket, fileName, resolved, { 'Content-Type': 'application/sql' });
            return sendJson(res, 200, { ok: true, message: `${fileName} uploaded to MinIO (${(stat.size / 1048576).toFixed(1)} MB).` });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // Download MinIO file → local seed/
    if (req.method === 'POST' && url.pathname === '/api/minio/download') {
        const body = await parseJsonBody(req);
        const fileName = body.file;
        if (!fileName) return sendJson(res, 400, { error: 'Missing file name.' });
        const baseName = path.basename(fileName); // prevent path traversal
        const localPath = path.join(SEED_DIR, baseName);
        try {
            const client = await getMinioClient();
            if (!client) return sendJson(res, 400, { error: 'MinIO is not configured.' });
            const bucket = await ensureMinioBucket(client);
            await client.fGetObject(bucket, fileName, localPath);
            return sendJson(res, 200, { ok: true, message: `${baseName} downloaded to seed/.` });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // Delete file from MinIO
    if (req.method === 'DELETE' && url.pathname === '/api/minio/files') {
        const body = await parseJsonBody(req);
        const fileName = body.file;
        if (!fileName) return sendJson(res, 400, { error: 'Missing file name.' });
        try {
            const client = await getMinioClient();
            if (!client) return sendJson(res, 400, { error: 'MinIO is not configured.' });
            const bucket = await ensureMinioBucket(client);
            await client.removeObject(bucket, fileName);
            return sendJson(res, 200, { ok: true, message: `${fileName} deleted from MinIO.` });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // Upload file from browser → MinIO (multipart)
    if (req.method === 'POST' && url.pathname === '/api/minio/upload-file') {
        try {
            const client = await getMinioClient();
            if (!client) return sendJson(res, 400, { error: 'MinIO is not configured.' });
            const bucket = await ensureMinioBucket(client);
            const contentType = req.headers['content-type'] || '';
            if (!contentType.startsWith('multipart/form-data')) {
                return sendJson(res, 400, { error: 'Expected multipart/form-data' });
            }
            const boundary = contentType.split('boundary=')[1];
            if (!boundary) return sendJson(res, 400, { error: 'Missing boundary' });

            const raw = await readBodyRaw(req);
            const { fileName, fileData } = parseMultipart(raw, boundary);
            if (!fileName || !fileData) return sendJson(res, 400, { error: 'No file found in upload.' });
            if (!/\.sql(\.gz)?$/i.test(fileName)) return sendJson(res, 400, { error: 'Only .sql and .sql.gz files are allowed.' });

            await client.putObject(bucket, fileName, fileData, fileData.length);
            return sendJson(res, 200, { ok: true, message: `${fileName} uploaded to MinIO (${(fileData.length / 1048576).toFixed(1)} MB).` });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // Upload file from browser → local seed/ (multipart)
    if (req.method === 'POST' && url.pathname === '/api/seed-files/upload') {
        try {
            const contentType = req.headers['content-type'] || '';
            if (!contentType.startsWith('multipart/form-data')) {
                return sendJson(res, 400, { error: 'Expected multipart/form-data' });
            }
            const boundary = contentType.split('boundary=')[1];
            if (!boundary) return sendJson(res, 400, { error: 'Missing boundary' });

            const raw = await readBodyRaw(req);
            const { fileName, fileData } = parseMultipart(raw, boundary);
            if (!fileName || !fileData) return sendJson(res, 400, { error: 'No file found in upload.' });
            if (!/\.sql(\.gz)?$/i.test(fileName)) return sendJson(res, 400, { error: 'Only .sql and .sql.gz files are allowed.' });

            const destPath = path.join(SEED_DIR, path.basename(fileName));
            await fs.mkdir(SEED_DIR, { recursive: true });
            await fs.writeFile(destPath, fileData);
            return sendJson(res, 200, { ok: true, message: `${fileName} saved to seed/ (${(fileData.length / 1048576).toFixed(1)} MB).` });
        } catch (err) { return sendJson(res, 500, { error: err.message }); }
    }

    // ── Port map ─────────────────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/ports') {
        const portMap = await getPortMap();
        // Detect conflicts
        const portCounts = {};
        for (const p of portMap) {
            portCounts[p.port] = (portCounts[p.port] || 0) + 1;
        }
        const conflicts = Object.entries(portCounts).filter(([, c]) => c > 1).map(([p]) => Number(p));
        return sendJson(res, 200, { ports: portMap, conflicts });
    }

    // --- Static files (React build) ---
    if (req.method === 'GET') {
        let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
        const resolved = path.resolve(DIST_DIR, '.' + filePath);
        if (!resolved.startsWith(DIST_DIR)) return send(res, 403, 'Forbidden');

        const serveFile = (res, content, ext) => {
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            if (ext === '.html') {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            } else if (ext === '.js' || ext === '.css') {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            }
            return send(res, 200, content, contentType);
        };

        try {
            const content = await fs.readFile(resolved);
            return serveFile(res, content, path.extname(resolved));
        } catch {
            // SPA fallback: serve index.html for client-side routing
            try {
                const indexContent = await fs.readFile(path.join(DIST_DIR, 'index.html'));
                return serveFile(res, indexContent, '.html');
            } catch {
                return send(res, 404, 'Not found');
            }
        }
    }

    send(res, 404, 'Not found');
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    try {
        await handleRequest(req, res);
    } catch (err) {
        console.error('Request error:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    }
});

server.listen(PORT, async () => {
    try {
        await initDatabase();
        console.log('[dbserver-ui] PostgreSQL connected, admins table ready');
    } catch (err) {
        console.error('[dbserver-ui] WARN: PostgreSQL init failed:', err.message);
        console.error('[dbserver-ui] Auth will not work until database is available.');
    }
    startMetricsCollector();
    console.log('[dbserver-ui] Metrics collector started (30s interval)');
    console.log(`dbserver UI running at http://localhost:${PORT}`);
});
