const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PROJECT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INSTANCES_DIR = path.join(PROJECT_DIR, 'instances');
const SEED_DIR = path.join(PROJECT_DIR, 'seed');
const TEMPLATE_PATH = path.join(PROJECT_DIR, '.env.example');
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
        // docker available natively (e.g. Docker Desktop in PATH)
        USE_WSL = false;
    } catch {
        USE_WSL = true;
    }
}
console.log(`[dbserver-ui] Docker mode: ${USE_WSL ? 'WSL' : 'native'}`);

const PORT = Number(process.argv[2]) || Number(process.env.DBSERVER_UI_PORT) || 9090;
const AUTH_USERNAME = String(process.env.DBSERVER_UI_USERNAME || 'admin').trim();
const AUTH_PASSWORD = String(process.env.DBSERVER_UI_PASSWORD || '').trim();
const SESSION_COOKIE = 'dbserver_ui_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
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
    sessions.set(token, {
        username,
        expiresAt: Date.now() + SESSION_TTL_MS,
    });
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

async function runScript(args) {
    const cmd = USE_WSL ? 'wsl' : 'bash';
    const scriptPath = USE_WSL ? toWslPath(SCRIPT_PATH) : SCRIPT_PATH;
    const cmdArgs = USE_WSL ? ['bash', scriptPath, ...args] : [scriptPath, ...args];
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
        cwd: PROJECT_DIR,
        timeout: 300000,
    });
    return { stdout, stderr };
}

// ── Instance helpers ─────────────────────────────────────────────────────────

function parseEnvFile(content) {
    const config = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        config[key] = value;
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
                instances.push({
                    name: entry.name,
                    config,
                    running,
                    seedHistory,
                });
            } catch {
                continue;
            }
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
            return {
                date: (parts[0] || '').trim(),
                file: (parts[1] || '').trim(),
                database: (parts[2] || '').trim(),
            };
        });
    } catch {
        return [];
    }
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
    } catch {
        return false;
    }
}

async function getInstance(name) {
    const envPath = path.join(INSTANCES_DIR, name, '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    const config = parseEnvFile(content);
    const running = await isInstanceRunning(name, config.DB_ENGINE || 'mariadb');
    const seedHistory = await readSeedHistory(name);
    return { name, config, running, seedHistory };
}

async function listSeedFiles() {
    try {
        const entries = await fs.readdir(SEED_DIR, { withFileTypes: true });
        return entries
            .filter((e) => e.isFile() && /\.sql(\.gz)?$/i.test(e.name))
            .map((e) => e.name)
            .sort();
    } catch {
        return [];
    }
}

async function updateInstanceEnv(name, updates) {
    const envPath = path.join(INSTANCES_DIR, name, '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    const lines = content.split('\n');
    const result = [];
    const applied = new Set();

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            result.push(line);
            continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq === -1) {
            result.push(line);
            continue;
        }
        const key = trimmed.slice(0, eq).trim();
        if (key in updates) {
            result.push(`${key}=${updates[key]}`);
            applied.add(key);
        } else {
            result.push(line);
        }
    }

    for (const [key, value] of Object.entries(updates)) {
        if (!applied.has(key)) {
            result.push(`${key}=${value}`);
        }
    }

    await fs.writeFile(envPath, result.join('\n'));
}

// ── Route handling ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // --- Auth API routes (public) ---

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await parseJsonBody(req);
        const username = normalizeValue(body.username);
        const password = normalizeValue(body.password);

        if (!AUTH_PASSWORD) {
            return sendJson(res, 500, { error: 'UI authentication is not configured.' });
        }

        if (!timingSafeEquals(username, AUTH_USERNAME) || !timingSafeEquals(password, AUTH_PASSWORD)) {
            return sendJson(res, 401, { error: 'Invalid username or password.' });
        }

        const token = createSession(username);
        setSessionCookie(res, token);
        return sendJson(res, 200, { ok: true, username });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const session = getSession(req);
        if (session) {
            sessions.delete(session.token);
        }
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
        const session = getSession(req);
        if (!session) {
            return sendJson(res, 401, { error: 'Authentication required.' });
        }
        return sendJson(res, 200, { ok: true, username: session.username });
    }

    // --- Public assets ---
    const isPublicAsset = url.pathname === '/login' || url.pathname === '/login.js' ||
                          url.pathname === '/styles.css' || url.pathname === '/api/auth/login' ||
                          url.pathname === '/api/instances'; // Allow ocompose to fetch instances

    // --- Authentication gate ---
    if (!isPublicAsset) {
        const session = getSession(req);
        if (!session) {
            if (url.pathname.startsWith('/api/')) {
                return sendJson(res, 401, { error: 'Authentication required.' });
            }
            return redirect(res, '/login');
        }
    }

    // Redirect to home if already logged in and trying to access login page
    if (url.pathname === '/login' && getSession(req)) {
        return redirect(res, '/');
    }

    // --- API routes (protected) ---

    // List instances
    if (req.method === 'GET' && url.pathname === '/api/instances') {
        const instances = await listInstances();
        return sendJson(res, 200, { instances });
    }

    // Get single instance
    if (req.method === 'GET' && /^\/api\/instances\/([a-zA-Z0-9_-]+)$/.test(url.pathname)) {
        const name = url.pathname.split('/')[3];
        try {
            const instance = await getInstance(name);
            return sendJson(res, 200, instance);
        } catch {
            return sendJson(res, 404, { error: 'Instance not found' });
        }
    }

    // Create instance
    if (req.method === 'POST' && url.pathname === '/api/instances') {
        const body = await parseJsonBody(req);
        const { name, engine, version, db, seed } = body;
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            return sendJson(res, 400, { error: 'Invalid instance name' });
        }
        const args = [name, 'init'];
        if (engine) args.push('--engine', engine);
        if (version) args.push('--version', version);
        if (db) args.push('--db', db);
        if (seed) args.push('--seed', seed);
        try {
            const { stdout } = await runScript(args);
            return sendJson(res, 201, { message: stdout.trim() });
        } catch (err) {
            return sendJson(res, 500, { error: err.stderr || err.message });
        }
    }

    // Update instance config
    if (req.method === 'PUT' && /^\/api\/instances\/([a-zA-Z0-9_-]+)$/.test(url.pathname)) {
        const name = url.pathname.split('/')[3];
        const body = await parseJsonBody(req);
        try {
            await updateInstanceEnv(name, body);
            const instance = await getInstance(name);
            return sendJson(res, 200, instance);
        } catch {
            return sendJson(res, 404, { error: 'Instance not found' });
        }
    }

    // Instance actions: up, down, destroy
    const actionMatch = url.pathname.match(/^\/api\/instances\/([a-zA-Z0-9_-]+)\/actions\/(up|down|destroy|seed)$/);
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
            } catch (err) {
                return sendJson(res, 500, { error: err.stderr || err.message });
            }
        }

        const destroyFlag = action === 'destroy' ? ['--yes'] : [];
        try {
            const { stdout } = await runScript([name, action, ...destroyFlag]);
            return sendJson(res, 200, { message: stdout.trim() });
        } catch (err) {
            return sendJson(res, 500, { error: err.stderr || err.message });
        }
    }

    // List seed files
    if (req.method === 'GET' && url.pathname === '/api/seed-files') {
        const files = await listSeedFiles();
        return sendJson(res, 200, { files });
    }

    // --- Static files ---

    if (req.method === 'GET') {
        let filePath = url.pathname === '/'
            ? '/index.html'
            : url.pathname === '/login'
                ? '/login.html'
                : url.pathname;
        const resolved = path.resolve(PUBLIC_DIR, '.' + filePath);
        if (!resolved.startsWith(PUBLIC_DIR)) {
            return send(res, 403, 'Forbidden');
        }
        try {
            const content = await fs.readFile(resolved);
            const ext = path.extname(resolved);
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            return send(res, 200, content, contentType);
        } catch {
            return send(res, 404, 'Not found');
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
        if (!res.headersSent) {
            sendJson(res, 500, { error: 'Internal server error' });
        }
    }
});

server.listen(PORT, () => {
    if (!AUTH_PASSWORD) {
        console.warn('dbserver web UI authentication is not configured. Set DBSERVER_UI_PASSWORD before starting the server.');
    }
    console.log(`dbserver UI running at http://localhost:${PORT}`);
});
