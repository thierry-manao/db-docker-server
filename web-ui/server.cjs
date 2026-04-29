const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(__dirname, 'dist');
const INSTANCES_DIR = path.join(PROJECT_DIR, 'instances');
const SEED_DIR = path.join(PROJECT_DIR, 'seed');
const BACKUPS_DIR = path.join(PROJECT_DIR, 'backups');
const SCRIPT_PATH = path.join(PROJECT_DIR, 'scripts', 'dbserver.sh');

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
const ADMIN_CREDS_FILE = path.join(PROJECT_DIR, '.admin-credentials.json');
let authUsername = String(process.env.DBSERVER_UI_USERNAME || 'admin').trim();
let authPassword = String(process.env.DBSERVER_UI_PASSWORD || '').trim();
let authPasswordHashed = false;

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.scryptSync(plain, salt, 64).toString('hex');
    return `${salt}:${key}`;
}

function verifyPassword(plain, stored) {
    if (!stored.includes(':')) {
        // Plain-text comparison (env var fallback)
        return timingSafeEquals(plain, stored);
    }
    const [salt, key] = stored.split(':');
    const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
    return timingSafeEquals(derived, key);
}

function loadAdminCreds() {
    try {
        const data = JSON.parse(require('fs').readFileSync(ADMIN_CREDS_FILE, 'utf8'));
        if (data.username) authUsername = data.username;
        if (data.password) { authPassword = data.password; authPasswordHashed = true; }
        console.log('[dbserver-ui] Admin credentials loaded from file');
    } catch {
        // No file yet — use env vars
    }
}

function saveAdminCreds() {
    require('fs').writeFileSync(ADMIN_CREDS_FILE, JSON.stringify({ username: authUsername, password: authPassword }, null, 2), 'utf8');
}

loadAdminCreds();

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

function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
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
        if (!authPassword) return sendJson(res, 500, { error: 'UI authentication is not configured.' });
        if (!timingSafeEquals(username, authUsername) || !verifyPassword(password, authPassword)) {
            return sendJson(res, 401, { error: 'Invalid username or password.' });
        }
        const token = createSession(username);
        setSessionCookie(res, token);
        return sendJson(res, 200, { ok: true, username });
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
        return sendJson(res, 200, { ok: true, username: session.username });
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
        if (!verifyPassword(currentPw, authPassword)) {
            return sendJson(res, 403, { error: 'Current password is incorrect.' });
        }
        if (newUsername && newUsername !== authUsername) authUsername = newUsername;
        authPassword = hashPassword(newPw);
        authPasswordHashed = true;
        saveAdminCreds();
        // Invalidate all sessions so user must re-login with new creds
        sessions.clear();
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true, message: 'Credentials updated. Please log in again.' });
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
        try {
            const { stdout } = await runScript(args);
            return sendJson(res, 201, { message: stdout.trim() });
        } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
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
            try {
                const { stdout } = await runScript(args);
                return sendJson(res, 200, { message: stdout.trim() });
            } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
        }

        if (action === 'backup') {
            const body = await parseJsonBody(req);
            const args = [name, 'backup'];
            if (body.db) args.push(body.db);
            try {
                const { stdout } = await runScript(args);
                return sendJson(res, 200, { message: stdout.trim() });
            } catch (err) { return sendJson(res, 500, { error: err.stderr || err.message }); }
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
        try {
            const content = await fs.readFile(resolved);
            const ext = path.extname(resolved);
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            return send(res, 200, content, contentType);
        } catch {
            // SPA fallback: serve index.html for client-side routing
            try {
                const indexContent = await fs.readFile(path.join(DIST_DIR, 'index.html'));
                return send(res, 200, indexContent, MIME_TYPES['.html']);
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

server.listen(PORT, () => {
    if (!authPassword) {
        console.warn('dbserver web UI authentication is not configured. Set DBSERVER_UI_PASSWORD before starting the server.');
    }
    console.log(`dbserver UI running at http://localhost:${PORT}`);
});
