const BASE = '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  if (res.status === 401 && !path.includes('/auth/')) {
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  session: () => request('/api/auth/session'),
  changeAdminPassword: (currentPassword, newPassword, username) => request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, username }) }),

  // Instances
  listInstances: () => request('/api/instances'),
  getInstance: (name) => request(`/api/instances/${name}`),
  createInstance: (data) => request('/api/instances', { method: 'POST', body: JSON.stringify(data) }),
  updateInstance: (name, data) => request(`/api/instances/${name}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Actions
  instanceAction: (name, action, body) => request(`/api/instances/${name}/actions/${action}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  listDatabases: (name) => request(`/api/instances/${name}/databases`),

  // Credentials
  listCreds: (name) => request(`/api/instances/${name}/creds`),
  createCred: (name, data) => request(`/api/instances/${name}/creds`, { method: 'POST', body: JSON.stringify(data) }),
  dropCred: (name, user) => request(`/api/instances/${name}/creds`, { method: 'DELETE', body: JSON.stringify({ user }) }),
  changePassword: (name, user, password) => request(`/api/instances/${name}/creds/passwd`, { method: 'POST', body: JSON.stringify({ user, password }) }),
  changeRootPassword: (name, password) => request(`/api/instances/${name}/creds/root-passwd`, { method: 'POST', body: JSON.stringify({ password }) }),
  viewGrants: (name, user) => request(`/api/instances/${name}/creds/grants?user=${encodeURIComponent(user)}`),

  // Seed & Backups
  seedFiles: () => request('/api/seed-files'),
  backups: () => request('/api/backups'),
  uploadSeedFile: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch('/api/seed-files/upload', { method: 'POST', body: form, credentials: 'same-origin' })
      .then(r => r.json().then(d => r.ok ? d : Promise.reject(new Error(d.error || `HTTP ${r.status}`))));
  },

  // MinIO
  getMinioConfig: () => request('/api/config/minio'),
  saveMinioConfig: (cfg) => request('/api/config/minio', { method: 'POST', body: JSON.stringify(cfg) }),
  removeMinioConfig: () => request('/api/config/minio', { method: 'DELETE' }),
  testMinioConnection: () => request('/api/config/minio/test', { method: 'POST' }),
  getMinioService: () => request('/api/config/minio/service'),
  updateMinioService: (data) => request('/api/config/minio/service', { method: 'POST', body: JSON.stringify(data) }),
  listMinioFiles: () => request('/api/minio/files'),
  uploadToMinio: (file) => request('/api/minio/upload', { method: 'POST', body: JSON.stringify({ file }) }),
  downloadFromMinio: (file) => request('/api/minio/download', { method: 'POST', body: JSON.stringify({ file }) }),
  deleteFromMinio: (file) => request('/api/minio/files', { method: 'DELETE', body: JSON.stringify({ file }) }),
  uploadFileToMinio: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch('/api/minio/upload-file', { method: 'POST', body: form, credentials: 'same-origin' })
      .then(r => r.json().then(d => r.ok ? d : Promise.reject(new Error(d.error || `HTTP ${r.status}`))));
  },

  // Admin user management
  listAdmins: () => request('/api/admins'),
  createAdminUser: (username, password, role) => request('/api/admins', { method: 'POST', body: JSON.stringify({ username, password, role }) }),
  deleteAdminUser: (id) => request('/api/admins', { method: 'DELETE', body: JSON.stringify({ id }) }),
  resetAdminPassword: (id, password) => request(`/api/admins/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  updateAdminRole: (id, role) => request(`/api/admins/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),

  // Setup
  completeSetup: () => request('/api/setup/complete', { method: 'POST' }),

  // Tasks
  listTasks: () => request('/api/tasks'),
  getTask: (id) => request(`/api/tasks/${id}`),
  deleteTask: (id) => request(`/api/tasks/${id}`, { method: 'DELETE' }),

  // Ports
  ports: () => request('/api/ports'),
};
