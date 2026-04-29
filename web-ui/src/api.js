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

  // Ports
  ports: () => request('/api/ports'),
};
