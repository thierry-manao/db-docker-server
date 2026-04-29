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
    const { rows } = await pool.query('SELECT id, username, role, created_at, updated_at FROM admins ORDER BY id');
    return rows;
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
        const files = [];
        for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.sql')) continue;
            const stat = await fs.stat(path.join(BACKUPS_DIR, e.name));
            files.push({ name: e.name, size: stat.size, date: stat.mtime.toISOString() });
        }
        return files.sort((a, b) => b.date.localeCompare(a.date));
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

    // ── Instance actions ─────────────────────────────────────────────────────

    const actionMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/actions\/(up|down|destroy|seed|backup|clone|exec)$/);
    if (req.method === 'POST' && actionMatch) {
        const name = actionMatch[1];
        const action = actionMatch[2];

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

        if (action === 'backup') {
            const body = await parseJsonBody(req);
            const args = [name, 'backup'];
            if (body.db) args.push(body.db);
            const task = createTask(`Backup ${name}${body.db ? '/' + body.db : ''}`, name);
            runTaskScript(task, args);
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
                const { stdout } = await runScript(args, { timeout: 30000 });
                return sendJson(res, 200, { result: stdout.trim() });
            } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
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
    console.log(`dbserver UI running at http://localhost:${PORT}`);
});
