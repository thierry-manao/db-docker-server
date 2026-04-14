const state = {
    instances: [],
    seedFiles: [],
    pendingActions: {},
};

const createForm = document.querySelector('#create-form');
const instanceList = document.querySelector('#instance-list');
const instanceGrid = document.querySelector('#instance-grid');
const emptyState = document.querySelector('#empty-state');
const refreshButton = document.querySelector('#refresh-button');
const seedForm = document.querySelector('#seed-form');
const statTotal = document.querySelector('#stat-total');
const statRunning = document.querySelector('#stat-running');
const statStopped = document.querySelector('#stat-stopped');
const toastEl = document.querySelector('#message-toast');
const toastBody = document.querySelector('#toast-body');

const ENGINE_ICONS = {
    mariadb: 'bi-database-fill',
    mysql: 'bi-database-fill',
    postgres: 'bi-database',
};

const ENGINE_COLORS = {
    mariadb: '#003545',
    mysql: '#00758f',
    postgres: '#336791',
};

// ── API ──────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, type = 'success') {
    toastEl.className = `toast align-items-center text-bg-${type}`;
    toastBody.textContent = message;
    bootstrap.Toast.getOrCreateInstance(toastEl).show();
}

// ── Seed files ───────────────────────────────────────────────────────────────

async function loadSeedFiles() {
    try {
        const { files } = await api('/api/seed-files');
        state.seedFiles = files;
        populateSeedSelects();
    } catch {
        state.seedFiles = [];
    }
}

function populateSeedSelects() {
    // Create form seed checkboxes
    const createList = document.querySelector('#create-seed-list');
    if (createList) {
        createList.innerHTML = state.seedFiles.map((file) => {
            const baseName = file.replace(/\.sql(\.gz)?$/i, '');
            return `
            <div class="d-flex align-items-center gap-2">
                <input class="form-check-input mt-0" type="checkbox" value="${esc(file)}" id="create-seed-${esc(file)}">
                <label class="form-check-label small flex-shrink-0" for="create-seed-${esc(file)}" style="min-width:120px">
                    ${esc(file)}
                </label>
                <input type="text" class="form-control form-control-sm" placeholder="Base cible"
                       data-create-seed-db="${esc(file)}" value="${esc(baseName)}">
            </div>`;
        }).join('');
    }
}

// ── Render ───────────────────────────────────────────────────────────────────

async function refresh() {
    try {
        const { instances } = await api('/api/instances');
        state.instances = instances;
        render();
    } catch (err) {
        showToast('Erreur de chargement : ' + err.message, 'danger');
    }
}

function render() {
    const { instances } = state;

    // Stats
    const running = instances.filter((i) => i.running).length;
    statTotal.textContent = instances.length;
    statRunning.textContent = running;
    statStopped.textContent = instances.length - running;

    // Empty state
    emptyState.classList.toggle('d-none', instances.length > 0);
    instanceGrid.classList.toggle('d-none', instances.length === 0);

    // Sidebar list
    instanceList.innerHTML = instances.map((inst) => `
        <div class="instance-item d-flex align-items-center justify-content-between mb-2"
             role="button" data-sidebar-select="${inst.name}">
            <div class="d-flex align-items-center gap-2">
                <i class="bi ${ENGINE_ICONS[inst.config.DB_ENGINE] || 'bi-database'}"
                   style="color: ${ENGINE_COLORS[inst.config.DB_ENGINE] || '#666'}"></i>
                <span class="fw-medium">${esc(inst.name)}</span>
            </div>
            <span class="badge ${inst.running ? 'bg-success' : 'bg-secondary'}">${inst.running ? 'actif' : 'arrêté'}</span>
        </div>
    `).join('');

    // Main grid
    instanceGrid.innerHTML = instances.map((inst) => {
        const c = inst.config;
        const pending = state.pendingActions[inst.name];
        const adminLabel = c.DB_ENGINE === 'postgres' ? 'pgAdmin' : 'phpMyAdmin';
        return `
        <div class="col-md-6 col-xl-6">
            <div class="card-shell instance-card ${inst.running ? 'border-start border-success border-3' : ''}">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start mb-3">
                        <div>
                            <h6 class="mb-0">${esc(inst.name)}</h6>
                            <small class="text-muted">${esc(c.DB_ENGINE || 'mariadb')}:${esc(c.DB_VERSION || '?')}</small>
                        </div>
                        <span class="badge ${inst.running ? 'bg-success' : 'bg-secondary'}">
                            ${inst.running ? 'en cours' : 'arrêté'}
                        </span>
                    </div>

                    <div class="mb-3">
                        <div class="d-flex justify-content-between small text-muted mb-1">
                            <span><i class="bi bi-plug"></i> Port DB</span>
                            <span class="fw-medium text-body">${esc(c.DB_PORT || '?')}</span>
                        </div>
                        <div class="d-flex justify-content-between small text-muted mb-1">
                            <span><i class="bi bi-globe"></i> ${adminLabel}</span>
                            <span class="fw-medium text-body">${esc(c.DB_ADMIN_PORT || '?')}</span>
                        </div>
                        ${c.DB_DATABASE ? `
                        <div class="d-flex justify-content-between small text-muted mb-1">
                            <span><i class="bi bi-archive"></i> Base</span>
                            <span class="fw-medium text-body">${esc(c.DB_DATABASE)}</span>
                        </div>` : ''}
                        ${c.DB_SEED_FILES ? `
                        <div class="d-flex justify-content-between small text-muted mb-1">
                            <span><i class="bi bi-file-earmark-code"></i> Seed</span>
                            <span class="fw-medium text-body">${esc(c.DB_SEED_FILES)}</span>
                        </div>` : ''}
                    </div>

                    ${inst.seedHistory && inst.seedHistory.length ? `
                    <div class="mb-3">
                        <div class="small fw-medium mb-1"><i class="bi bi-clock-history"></i> Historique des imports</div>
                        <div class="seed-history-list small" style="max-height:120px;overflow-y:auto">
                            ${inst.seedHistory.map(s => `
                            <div class="d-flex justify-content-between text-muted border-bottom py-1">
                                <span title="${esc(s.file)}">${esc(s.file)}${s.database && s.database !== '<default>' ? ` <i class="bi bi-arrow-right"></i> <span class="text-body">${esc(s.database)}</span>` : ''}</span>
                                <span class="text-nowrap ms-2" style="font-size:.75em">${esc(s.date)}</span>
                            </div>`).join('')}
                        </div>
                    </div>` : ''}

                    <div class="d-flex gap-1 flex-wrap">
                        ${inst.running ? `
                            <button class="btn btn-sm btn-outline-danger" data-action="down" data-instance="${esc(inst.name)}" ${pending ? 'disabled' : ''}>
                                <i class="bi bi-stop-fill"></i> Arrêter
                            </button>
                            <a class="btn btn-sm btn-outline-info" href="http://localhost:${esc(c.DB_ADMIN_PORT)}" target="_blank">
                                <i class="bi bi-box-arrow-up-right"></i> ${adminLabel}
                            </a>
                        ` : `
                            <button class="btn btn-sm btn-outline-success" data-action="up" data-instance="${esc(inst.name)}" ${pending ? 'disabled' : ''}>
                                <i class="bi bi-play-fill"></i> Démarrer
                            </button>
                        `}
                        <button class="btn btn-sm btn-outline-primary" data-action="seed" data-instance="${esc(inst.name)}" ${pending ? 'disabled' : ''}>
                            <i class="bi bi-file-earmark-arrow-up"></i> Seed
                        </button>
                        <button class="btn btn-sm btn-outline-danger" data-action="destroy" data-instance="${esc(inst.name)}" ${pending ? 'disabled' : ''}>
                            <i class="bi bi-trash"></i>
                        </button>
                        ${pending ? '<span class="spinner-border spinner-border-sm ms-1"></span>' : ''}
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function runAction(name, action, body) {
    state.pendingActions[name] = action;
    render();
    try {
        const result = await api(`/api/instances/${name}/actions/${action}`, {
            method: 'POST',
            body: body ? JSON.stringify(body) : undefined,
        });
        showToast(result.message || `${action} terminé`, 'success');
    } catch (err) {
        showToast(`${action} échoué : ${err.message}`, 'danger');
    } finally {
        delete state.pendingActions[name];
        await refresh();
    }
}

// ── Events ───────────────────────────────────────────────────────────────────

refreshButton.addEventListener('click', refresh);

createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(createForm);
    const name = fd.get('name');
    const engine = fd.get('engine');
    const version = fd.get('version') || undefined;
    const db = fd.get('db') || undefined;

    // Collect checked seed files as file:db pairs
    const createList = document.querySelector('#create-seed-list');
    const checked = createList.querySelectorAll('input[type="checkbox"]:checked');
    const seedParts = [];
    for (const cb of checked) {
        const file = cb.value;
        const dbInput = createList.querySelector(`[data-create-seed-db="${file}"]`);
        const targetDb = dbInput ? dbInput.value.trim() : '';
        seedParts.push(targetDb ? `${file}:${targetDb}` : file);
    }
    const seed = seedParts.length > 0 ? seedParts.join(',') : undefined;

    const body = { name, engine, version, db, seed };
    try {
        await api('/api/instances', { method: 'POST', body: JSON.stringify(body) });
        showToast(`Instance '${name}' créée`, 'success');
        createForm.reset();
        populateSeedSelects();
        await refresh();
    } catch (err) {
        showToast('Erreur de création : ' + err.message, 'danger');
    }
});

// Delegate clicks on instance grid
instanceGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const name = btn.dataset.instance;

    if (action === 'destroy') {
        if (!confirm(`Supprimer l'instance '${name}' et toutes ses données ?`)) return;
        runAction(name, 'destroy');
    } else if (action === 'seed') {
        openSeedModal(name);
    } else {
        runAction(name, action);
    }
});

function openSeedModal(name) {
    document.querySelector('#seed-instance').value = name;
    const inst = state.instances.find((i) => i.name === name);
    const defaultDb = (inst && inst.config.DB_DATABASE) || '';

    const container = document.querySelector('#seed-file-list');
    container.innerHTML = state.seedFiles.map((file) => {
        const baseName = file.replace(/\.sql(\.gz)?$/i, '');
        return `
        <div class="seed-row d-flex align-items-center gap-2 p-2 rounded border">
            <input class="form-check-input mt-0" type="checkbox" value="${esc(file)}" id="seed-check-${esc(file)}">
            <label class="form-check-label flex-shrink-0" for="seed-check-${esc(file)}" style="min-width:140px">
                ${esc(file)}
            </label>
            <input type="text" class="form-control form-control-sm" placeholder="Base cible"
                   data-seed-db-for="${esc(file)}" value="${esc(baseName)}">
        </div>`;
    }).join('');

    const modal = new bootstrap.Modal(document.querySelector('#seed-modal'));
    modal.show();
}

seedForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.querySelector('#seed-instance').value;
    const container = document.querySelector('#seed-file-list');
    const checked = container.querySelectorAll('input[type="checkbox"]:checked');

    if (checked.length === 0) {
        showToast('Sélectionnez au moins un fichier', 'warning');
        return;
    }

    bootstrap.Modal.getInstance(document.querySelector('#seed-modal')).hide();

    for (const cb of checked) {
        const file = cb.value;
        const dbInput = container.querySelector(`[data-seed-db-for="${file}"]`);
        const db = dbInput ? dbInput.value.trim() : undefined;
        await runAction(name, 'seed', { file, db: db || undefined });
    }
});

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
    await Promise.all([refresh(), loadSeedFiles()]);
})();
