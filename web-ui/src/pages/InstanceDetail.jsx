import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { api } from '../api';
import { Play, Square, Trash2, Copy, Download, GitBranch, Terminal, Users, Settings, ScrollText, FileUp, ArrowLeft } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';

export default function InstanceDetail() {
  const { name, tab: urlTab } = useParams();
  const navigate = useNavigate();
  const { instances, seedFiles, refresh, toast } = useApp();
  const [tab, setTab] = useState(urlTab || 'overview');
  const [pending, setPending] = useState(null);
  const [backupModal, setBackupModal] = useState(null); // null or { databases: [], selected: [] }

  const inst = instances.find((i) => i.name === name);

  useEffect(() => { if (urlTab) setTab(urlTab); }, [urlTab]);

  const changeTab = (t) => { setTab(t); navigate(`/instance/${name}/${t}`, { replace: true }); };

  if (!inst) return <div className="card card-body text-center text-muted p-4">Instance introuvable</div>;

  const c = inst.config;
  const adminLabel = c.DB_ENGINE === 'postgres' ? 'pgAdmin' : 'phpMyAdmin';
  const connString = c.DB_ENGINE === 'postgres'
    ? `psql -h ${window.location.hostname} -p ${c.DB_PORT} -U ${c.DB_USER || 'postgres'} ${c.DB_DATABASE || ''}`
    : `mysql -h ${window.location.hostname} -P ${c.DB_PORT} -u root -p${c.DB_ROOT_PASSWORD || 'root'} ${c.DB_DATABASE || ''}`;

  const runAction = async (action, body) => {
    setPending(action);
    try {
      const result = await api.instanceAction(name, action, body);
      toast(result.message || `${action} terminé`);
      if (action === 'destroy') { refresh(); navigate('/'); return; }
    } catch (err) { toast(`${action} échoué: ${err.message}`, 'danger'); }
    finally { setPending(null); refresh(); }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/')}><ArrowLeft size={16} /></button>
        <div style={{ flex: 1 }}>
          <div className="flex items-center gap-2">
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>{name}</h2>
            <span className={`badge ${inst.running ? 'badge-success' : 'badge-secondary'}`}>
              {inst.running ? 'actif' : 'arrêté'}
            </span>
          </div>
          <span className="text-sm text-muted">{c.DB_ENGINE}:{c.DB_VERSION} &middot; Port {c.DB_PORT}</span>
        </div>
        <div className="flex gap-2">
          {inst.running ? (
            <button className="btn btn-danger btn-sm" disabled={!!pending} onClick={() => runAction('down')}>
              <Square size={12} /> Arrêter
            </button>
          ) : (
            <button className="btn btn-success btn-sm" disabled={!!pending} onClick={() => runAction('up')}>
              <Play size={12} /> Démarrer
            </button>
          )}
          <button className="btn btn-outline btn-sm" disabled={!!pending || !inst.running} onClick={async () => {
            try {
              const { databases } = await api.listDatabases(name);
              if (databases && databases.length > 1) {
                setBackupModal({ databases, selected: [...databases] });
              } else {
                runAction('backup', databases?.length === 1 ? { databases } : undefined);
              }
            } catch {
              runAction('backup');
            }
          }}>
            <Download size={12} /> Backup
          </button>
          <button className="btn btn-outline btn-sm" disabled={!!pending} onClick={() => {
            const target = prompt("Nom du clone:");
            if (target) runAction('clone', { target });
          }}>
            <GitBranch size={12} /> Cloner
          </button>
          <button className="btn btn-danger btn-sm" disabled={!!pending} onClick={() => {
            if (confirm(`Supprimer '${name}' et toutes ses données ?`)) runAction('destroy');
          }}>
            <Trash2 size={12} />
          </button>
          {pending && <span className="spinner" />}
        </div>
      </div>

      {/* Backup database selection modal */}
      {backupModal && (
        <div className="modal-overlay" onClick={() => setBackupModal(null)}>
          <div className="card card-body" style={{ minWidth: 320, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h4 className="text-sm font-semibold mb-3">Sélectionner les bases à sauvegarder</h4>
            <div className="mb-3">
              <label className="flex items-center gap-2 mb-2" style={{ cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={backupModal.selected.length === backupModal.databases.length}
                  onChange={(e) => setBackupModal(m => ({ ...m, selected: e.target.checked ? [...m.databases] : [] }))}
                />
                <span className="text-sm font-medium">Tout sélectionner</span>
              </label>
              {backupModal.databases.map(db => (
                <label key={db} className="flex items-center gap-2 mb-1" style={{ cursor: 'pointer' }}>
                  <input type="checkbox"
                    checked={backupModal.selected.includes(db)}
                    onChange={(e) => setBackupModal(m => ({
                      ...m,
                      selected: e.target.checked ? [...m.selected, db] : m.selected.filter(d => d !== db)
                    }))}
                  />
                  <span className="font-mono text-sm">{db}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button className="btn btn-ghost btn-sm" onClick={() => setBackupModal(null)}>Annuler</button>
              <button className="btn btn-primary btn-sm" disabled={backupModal.selected.length === 0} onClick={() => {
                const selected = backupModal.selected;
                setBackupModal(null);
                runAction('backup', { databases: selected });
              }}>
                <Download size={12} /> Sauvegarder ({backupModal.selected.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs mb-4">
        {[
          ['overview', 'Vue d\'ensemble'],
          ['credentials', 'Utilisateurs'],
          ['seed', 'Seed / Import'],
          ['config', 'Configuration'],
          ['sql', 'SQL'],
          ['metrics', 'Metrics'],
          ['logs', 'Logs'],
        ].map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => changeTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab inst={inst} connString={connString} adminLabel={adminLabel} toast={toast} />}
      {tab === 'credentials' && <CredentialsTab name={name} inst={inst} toast={toast} refresh={refresh} />}
      {tab === 'seed' && <SeedTab name={name} inst={inst} seedFiles={seedFiles} toast={toast} refresh={refresh} />}
      {tab === 'config' && <ConfigTab name={name} inst={inst} toast={toast} refresh={refresh} />}
      {tab === 'sql' && <SqlTab name={name} inst={inst} toast={toast} />}
      {tab === 'metrics' && <MetricsTab name={name} inst={inst} />}
      {tab === 'logs' && <LogsTab name={name} />}
    </>
  );
}

function OverviewTab({ inst, connString, adminLabel, toast }) {
  const c = inst.config;
  return (
    <div className="grid grid-2 gap-4">
      <div className="card card-body">
        <h4 className="text-sm font-semibold mb-3">Informations</h4>
        <table className="table">
          <tbody>
            <tr><td className="text-muted">Moteur</td><td className="font-medium">{c.DB_ENGINE}:{c.DB_VERSION}</td></tr>
            <tr><td className="text-muted">Port DB</td><td className="font-mono">{c.DB_PORT}</td></tr>
            <tr><td className="text-muted">Port Admin</td><td><a href={`http://${window.location.hostname}:${c.DB_ADMIN_PORT}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{c.DB_ADMIN_PORT} ({adminLabel})</a></td></tr>
            <tr><td className="text-muted">Base</td><td>{c.DB_DATABASE || <span className="text-muted">—</span>}</td></tr>
            <tr><td className="text-muted">Root password</td><td className="font-mono">{c.DB_ROOT_PASSWORD || 'root'}</td></tr>
            {c.DB_USER && <tr><td className="text-muted">Utilisateur</td><td>{c.DB_USER}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card card-body">
        <h4 className="text-sm font-semibold mb-3">Connexion rapide</h4>
        <div className="conn-string mb-3" onClick={() => { navigator.clipboard.writeText(connString); toast('Copié !'); }}>
          {connString}
        </div>
        <p className="text-xs text-muted">Cliquer pour copier</p>

        {inst.seedHistory && inst.seedHistory.length > 0 && (
          <>
            <h4 className="text-sm font-semibold mb-2 mt-4">Historique des imports</h4>
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              <table className="table">
                <thead><tr><th>Fichier</th><th>Base</th><th>Date</th></tr></thead>
                <tbody>
                  {inst.seedHistory.map((s, i) => (
                    <tr key={i}><td>{s.file}</td><td>{s.database}</td><td className="text-xs text-muted">{s.date}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CredentialsTab({ name, inst, toast, refresh }) {
  const [users, setUsers] = useState([]);
  const [rawOutput, setRawOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ user: '', password: '', db: '', privileges: 'ALL' });
  const [showForm, setShowForm] = useState(false);
  const [rootPw, setRootPw] = useState('');
  const [rootPwLoading, setRootPwLoading] = useState(false);

  const loadCreds = async () => {
    setLoading(true);
    try {
      const data = await api.listCreds(name);
      setRawOutput(data.result || '');
      setUsers(data.credentials || []);
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (inst.running) loadCreds(); }, [name, inst.running]);

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await api.createCred(name, form);
      toast(`Utilisateur '${form.user}' créé`);
      setForm({ user: '', password: '', db: '', privileges: 'ALL' });
      setShowForm(false);
      loadCreds();
      refresh();
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
  };

  const handleDrop = async (user) => {
    if (!confirm(`Supprimer l'utilisateur '${user}' ?`)) return;
    try {
      await api.dropCred(name, user);
      toast(`Utilisateur '${user}' supprimé`);
      loadCreds();
      refresh();
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
  };

  const handlePasswd = async (user) => {
    const pw = prompt(`Nouveau mot de passe pour '${user}':`);
    if (!pw) return;
    try {
      await api.changePassword(name, user, pw);
      toast(`Mot de passe modifié pour '${user}'`);
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
  };

  const handleRootPasswd = async (e) => {
    e.preventDefault();
    if (!rootPw.trim()) return;
    setRootPwLoading(true);
    try {
      await api.changeRootPassword(name, rootPw);
      toast('Mot de passe root modifié (DB + .env)');
      setRootPw('');
      refresh();
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
    finally { setRootPwLoading(false); }
  };

  if (!inst.running) {
    return <div className="card card-body text-center text-muted p-4">L'instance doit être démarrée pour gérer les utilisateurs.</div>;
  }

  const c = inst.config;

  return (
    <div className="flex flex-col gap-4">
      {/* Root / Instance credentials */}
      <div className="card card-body">
        <h4 className="text-sm font-semibold mb-3"><Settings size={14} style={{ display: 'inline', verticalAlign: -2 }} /> Identifiants de l'instance</h4>
        <div className="grid grid-2 gap-3 mb-3">
          <div>
            <label className="label">Utilisateur root</label>
            <div className="input input-sm" style={{ background: 'var(--bg)', cursor: 'default' }}>root</div>
          </div>
          <div>
            <label className="label">Mot de passe actuel</label>
            <div className="input input-sm font-mono" style={{ background: 'var(--bg)', cursor: 'default' }}>{c.DB_ROOT_PASSWORD || 'root'}</div>
          </div>
        </div>
        <form onSubmit={handleRootPasswd} className="flex items-center gap-2">
          <input
            className="input input-sm"
            style={{ maxWidth: 260 }}
            type="text"
            value={rootPw}
            onChange={(e) => setRootPw(e.target.value)}
            placeholder="Nouveau mot de passe root"
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={rootPwLoading || !rootPw.trim()}>
            {rootPwLoading ? <span className="spinner" /> : 'Changer le mot de passe root'}
          </button>
        </form>
        {c.DB_USER && (
          <div className="mt-4">
            <div className="grid grid-2 gap-3 mb-2">
              <div>
                <label className="label">Utilisateur instance</label>
                <div className="input input-sm" style={{ background: 'var(--bg)', cursor: 'default' }}>{c.DB_USER}</div>
              </div>
              <div>
                <label className="label">Mot de passe</label>
                <div className="input input-sm font-mono" style={{ background: 'var(--bg)', cursor: 'default' }}>{c.DB_PASSWORD || '—'}</div>
              </div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => handlePasswd(c.DB_USER)}>
              Changer le mot de passe de {c.DB_USER}
            </button>
          </div>
        )}
      </div>

      {/* DB Users management */}
      <div className="card card-body">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold"><Users size={14} style={{ display: 'inline', verticalAlign: -2 }} /> Utilisateurs de la base</h4>
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Annuler' : '+ Nouvel utilisateur'}
          </button>
        </div>

      {showForm && (
        <form onSubmit={handleCreate} className="card p-3 mb-3" style={{ background: 'var(--bg)' }}>
          <div className="grid grid-2 gap-3 mb-3">
            <div>
              <label className="label">Utilisateur</label>
              <input className="input input-sm" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} required />
            </div>
            <div>
              <label className="label">Mot de passe</label>
              <input className="input input-sm" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            </div>
            <div>
              <label className="label">Base (optionnel)</label>
              <input className="input input-sm" value={form.db} onChange={(e) => setForm({ ...form, db: e.target.value })} placeholder={inst.config.DB_DATABASE || '*'} />
            </div>
            <div>
              <label className="label">Privilèges</label>
              <select className="input select input-sm" value={form.privileges} onChange={(e) => setForm({ ...form, privileges: e.target.value })}>
                <option value="ALL">ALL (admin complet)</option>
                <option value="SELECT,INSERT,UPDATE,DELETE">CRUD (lecture/écriture)</option>
                <option value="SELECT">SELECT (lecture seule)</option>
                <option value="SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,ALTER,INDEX">Développeur</option>
              </select>
            </div>
          </div>
          <button type="submit" className="btn btn-primary btn-sm">Créer l'utilisateur</button>
        </form>
      )}

      {loading ? (
        <div className="text-center p-4"><span className="spinner" /></div>
      ) : (
        <>
          {rawOutput && (
            <div className="log-viewer mb-3" style={{ maxHeight: 200 }}>{rawOutput}</div>
          )}
          {users.length > 0 && (
            <>
              <h5 className="text-xs text-muted font-semibold mb-2 mt-4">Utilisateurs créés via dbserver</h5>
              <table className="table">
                <thead><tr><th>Utilisateur</th><th>Base</th><th>Privilèges</th><th>Créé le</th><th></th></tr></thead>
                <tbody>
                  {users.map((u, i) => (
                    <tr key={i}>
                      <td className="font-medium">{u.user}</td>
                      <td>{u.database}</td>
                      <td className="text-xs">{u.privileges}</td>
                      <td className="text-xs text-muted">{u.date}</td>
                      <td>
                        <div className="flex gap-1">
                          <button className="btn btn-ghost btn-sm" onClick={() => handlePasswd(u.user)} title="Changer mot de passe">🔑</button>
                          <button className="btn btn-ghost btn-sm text-danger" onClick={() => handleDrop(u.user)} title="Supprimer">🗑</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
    </div>
  );
}

function SeedTab({ name, inst, seedFiles, toast, refresh }) {
  const [selected, setSelected] = useState({});
  const [loading, setLoading] = useState(false);

  const toggle = (file) => {
    setSelected((prev) => {
      const copy = { ...prev };
      if (copy[file]) delete copy[file];
      else copy[file] = file.replace(/\.sql(\.gz)?$/i, '');
      return copy;
    });
  };

  const handleSeed = async () => {
    const entries = Object.entries(selected);
    if (entries.length === 0) { toast('Sélectionnez au moins un fichier', 'warning'); return; }
    setLoading(true);
    for (const [file, db] of entries) {
      try {
        await api.instanceAction(name, 'seed', { file, db: db || undefined });
        toast(`Import de ${file} lancé en arrière-plan`);
      } catch (err) { toast(`Erreur: ${err.message}`, 'danger'); }
    }
    setSelected({});
    setLoading(false);
  };

  return (
    <div className="card card-body">
      <h4 className="text-sm font-semibold mb-3"><FileUp size={14} style={{ display: 'inline', verticalAlign: -2 }} /> Importer des données SQL</h4>
      {!inst.running && <p className="text-sm text-muted mb-3">L'instance doit être démarrée pour importer des données.</p>}
      <div className="flex flex-col gap-2 mb-3">
        {seedFiles.map((file) => (
          <div key={file} className="flex items-center gap-3 p-2" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-sm)' }}>
            <input type="checkbox" checked={!!selected[file]} onChange={() => toggle(file)} disabled={!inst.running} style={{ accentColor: 'var(--accent)' }} />
            <span className="text-sm font-medium" style={{ minWidth: 160 }}>{file}</span>
            {selected[file] !== undefined && (
              <input className="input input-sm" style={{ maxWidth: 200 }} value={selected[file]} onChange={(e) => setSelected({ ...selected, [file]: e.target.value })} placeholder="Base cible" />
            )}
          </div>
        ))}
      </div>
      <button className="btn btn-primary btn-sm" onClick={handleSeed} disabled={loading || !inst.running || Object.keys(selected).length === 0}>
        {loading ? <span className="spinner" /> : 'Importer la sélection'}
      </button>
    </div>
  );
}

function ConfigTab({ name, inst, toast, refresh }) {
  const [config, setConfig] = useState({ ...inst.config });
  const [saving, setSaving] = useState(false);

  const fields = [
    { key: 'DB_ENGINE', label: 'Moteur', readOnly: true },
    { key: 'DB_VERSION', label: 'Version' },
    { key: 'DB_PORT', label: 'Port DB' },
    { key: 'DB_ADMIN_PORT', label: 'Port Admin' },
    { key: 'DB_DATABASE', label: 'Base par défaut' },
    { key: 'DB_ROOT_PASSWORD', label: 'Root password' },
    { key: 'DB_USER', label: 'Utilisateur' },
    { key: 'DB_PASSWORD', label: 'Mot de passe utilisateur' },
    { key: 'DB_SEED_FILES', label: 'Seed files' },
    { key: 'DB_RESEED_ON_STARTUP', label: 'Re-seed au démarrage' },
  ];

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateInstance(name, config);
      toast('Configuration sauvegardée');
      refresh();
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card card-body">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold"><Settings size={14} style={{ display: 'inline', verticalAlign: -2 }} /> Configuration</h4>
        {inst.running && <span className="badge badge-warning">Redémarrage nécessaire après modification</span>}
      </div>
      <div className="grid grid-2 gap-3">
        {fields.map(({ key, label, readOnly }) => (
          <div key={key}>
            <label className="label">{label}</label>
            <input
              className="input input-sm"
              value={config[key] || ''}
              onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
              readOnly={readOnly}
              style={readOnly ? { opacity: 0.6 } : {}}
            />
          </div>
        ))}
      </div>
      <div className="mt-4">
        <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? <span className="spinner" /> : 'Sauvegarder'}
        </button>
      </div>
    </div>
  );
}

function SqlTab({ name, inst, toast }) {
  const [sql, setSql] = useState('');
  const [db, setDb] = useState(inst.config.DB_DATABASE || '');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  const handleExec = async () => {
    if (!sql.trim()) return;
    setLoading(true);
    try {
      const data = await api.instanceAction(name, 'exec', { sql, db: db || undefined });
      setResult(data.result || 'OK');
    } catch (err) { setResult('ERREUR: ' + err.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="card card-body">
      <h4 className="text-sm font-semibold mb-3"><Terminal size={14} style={{ display: 'inline', verticalAlign: -2 }} /> Exécuter du SQL</h4>
      {!inst.running && <p className="text-sm text-muted mb-3">L'instance doit être démarrée.</p>}
      <div className="flex gap-2 mb-3">
        <input className="input input-sm" style={{ maxWidth: 200 }} value={db} onChange={(e) => setDb(e.target.value)} placeholder="Base de données" />
      </div>
      <textarea
        className="input"
        rows={5}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        placeholder="SELECT 1; ou SHOW DATABASES;"
        style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: '0.8rem' }}
        disabled={!inst.running}
      />
      <div className="mt-2 mb-3">
        <button className="btn btn-primary btn-sm" onClick={handleExec} disabled={loading || !inst.running || !sql.trim()}>
          {loading ? <span className="spinner" /> : 'Exécuter'}
        </button>
      </div>
      {result && <div className="log-viewer">{result}</div>}
    </div>
  );
}

function MetricsTab({ name, inst }) {
  const [metrics, setMetrics] = useState(null);
  const [slowQueries, setSlowQueries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sqLoading, setSqLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [range, setRange] = useState('all'); // 'all', '5m', '10m', '15m'
  const [visibleSeries, setVisibleSeries] = useState({ cpu: true, mem: true, queries: true, connections: true });
  const refreshRef = useRef(null);

  const loadMetrics = async () => {
    try {
      const data = await api.getMetrics(name);
      setMetrics(data);
      setError(null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const loadSlowQueries = async () => {
    setSqLoading(true);
    try {
      const data = await api.getSlowQueries(name);
      setSlowQueries(data.queries);
    } catch { setSlowQueries(null); }
    finally { setSqLoading(false); }
  };

  useEffect(() => {
    setLoading(true);
    loadMetrics();
    loadSlowQueries();
  }, [name]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (autoRefresh) {
      refreshRef.current = setInterval(() => { loadMetrics(); }, 30000);
    }
    return () => { if (refreshRef.current) clearInterval(refreshRef.current); };
  }, [autoRefresh, name]);

  if (loading) return <div className="card card-body text-center"><span className="spinner" /> Chargement des métriques...</div>;
  if (error) return <div className="card card-body text-danger">{error}</div>;
  if (!metrics) return null;

  const formatBytes = (bytes) => {
    if (!bytes) return '—';
    const n = Number(bytes);
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  };

  const formatUptime = (seconds) => {
    const s = Number(seconds);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}j ${Math.floor((s % 86400) / 3600)}h`;
  };

  // Filter time series by range
  const rangeMs = { 'all': Infinity, '5m': 5 * 60000, '10m': 10 * 60000, '15m': 15 * 60000 };
  const now = Date.now();
  const cutoff = now - (rangeMs[range] || Infinity);
  const filteredSeries = (metrics.timeSeries || []).filter(p => p.ts >= cutoff);

  const chartData = filteredSeries.map(p => ({
    time: new Date(p.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    cpu: p.cpu,
    mem: p.mem,
    queries: p.queries,
    connections: p.connections
  }));

  const toggleSeries = (key) => setVisibleSeries(v => ({ ...v, [key]: !v[key] }));

  return (
    <div className="grid grid-1 gap-4">
      {/* Charts Section */}
      <div className="card card-body">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h4 className="text-sm font-semibold">Graphiques temps réel</h4>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Series toggles */}
            <div className="flex gap-1">
              {[
                { key: 'cpu', label: 'CPU', color: '#f59e0b' },
                { key: 'mem', label: 'Mém', color: '#6366f1' },
                { key: 'queries', label: 'Req', color: '#10b981' },
                { key: 'connections', label: 'Conn', color: '#ef4444' },
              ].map(s => (
                <button key={s.key}
                  className={`btn btn-sm ${visibleSeries[s.key] ? '' : 'btn-ghost'}`}
                  style={visibleSeries[s.key] ? { background: s.color + '22', border: `1px solid ${s.color}`, color: s.color } : {}}
                  onClick={() => toggleSeries(s.key)}
                >{s.label}</button>
              ))}
            </div>
            {/* Range selector */}
            <select className="input input-sm" style={{ width: 'auto', padding: '2px 8px' }}
              value={range} onChange={e => setRange(e.target.value)}>
              <option value="all">Tout</option>
              <option value="5m">5 min</option>
              <option value="10m">10 min</option>
              <option value="15m">15 min</option>
            </select>
            {/* Auto-refresh toggle */}
            <label className="flex items-center gap-1 text-xs text-muted" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
              Auto 30s
            </label>
            {/* Manual refresh */}
            <button className="btn btn-ghost btn-sm" onClick={() => { loadMetrics(); loadSlowQueries(); }}>↻</button>
          </div>
        </div>

        {chartData.length > 0 ? (
          <div className="grid grid-2 gap-4">
            {/* CPU & Memory Chart */}
            {(visibleSeries.cpu || visibleSeries.mem) && (
              <div>
                <p className="text-xs text-muted mb-1">CPU & Mémoire (%)</p>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="#888" />
                    <YAxis domain={[0, 'auto']} tick={{ fontSize: 10 }} stroke="#888" unit="%" />
                    <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #444', fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {visibleSeries.cpu && <Area type="monotone" dataKey="cpu" name="CPU" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.15} strokeWidth={2} dot={chartData.length < 10} />}
                    {visibleSeries.mem && <Area type="monotone" dataKey="mem" name="Mémoire" stroke="#6366f1" fill="#6366f1" fillOpacity={0.15} strokeWidth={2} dot={chartData.length < 10} />}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Queries & Connections Chart */}
            {(visibleSeries.queries || visibleSeries.connections) && (
              <div>
                <p className="text-xs text-muted mb-1">Requêtes & Connexions</p>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="#888" />
                    <YAxis tick={{ fontSize: 10 }} stroke="#888" />
                    <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #444', fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {visibleSeries.queries && <Line type="monotone" dataKey="queries" name="Requêtes (cumul)" stroke="#10b981" strokeWidth={2} dot={chartData.length < 10} />}
                    {visibleSeries.connections && <Line type="monotone" dataKey="connections" name="Connexions" stroke="#ef4444" strokeWidth={2} dot={chartData.length < 10} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted text-sm text-center">
            {metrics.container ? `En attente de données... (${(metrics.timeSeries || []).length} point(s) collecté(s), intervalle: 30s)` : 'Instance arrêtée'}
          </p>
        )}
        {chartData.length > 0 && (
          <p className="text-xs text-muted mt-2 text-center">{chartData.length} point(s) affichés — collecte toutes les 30s</p>
        )}
      </div>

      <div className="grid grid-2 gap-4">
        {/* Container Resources */}
        <div className="card card-body">
          <h4 className="text-sm font-semibold mb-3">Ressources conteneur</h4>
          {metrics.container ? (
            <table className="table">
              <tbody>
                <tr><td className="text-muted">CPU</td><td className="font-mono">{metrics.container.cpu}</td></tr>
                <tr><td className="text-muted">Mémoire</td><td className="font-mono">{metrics.container.memory}</td></tr>
                <tr><td className="text-muted">Mém. %</td><td className="font-mono">{metrics.container.memPercent}</td></tr>
                <tr><td className="text-muted">Réseau I/O</td><td className="font-mono">{metrics.container.netIO}</td></tr>
                <tr><td className="text-muted">Disque I/O</td><td className="font-mono">{metrics.container.blockIO}</td></tr>
                <tr><td className="text-muted">PIDs</td><td className="font-mono">{metrics.container.pids}</td></tr>
                {metrics.disk && <tr><td className="text-muted">Données</td><td className="font-mono">{metrics.disk.dataDir}</td></tr>}
              </tbody>
            </table>
          ) : <p className="text-muted text-sm">Instance arrêtée</p>}
        </div>

        {/* DB Engine Stats */}
        <div className="card card-body">
          <h4 className="text-sm font-semibold mb-3">Statistiques {metrics.engine}</h4>
          {metrics.db && !metrics.db.error ? (
            metrics.engine === 'postgres' ? (
              <table className="table">
                <tbody>
                  <tr><td className="text-muted">Uptime</td><td className="font-mono">{formatUptime(metrics.db.uptime)}</td></tr>
                  {metrics.db.connections && <>
                    <tr><td className="text-muted">Connexions actives</td><td className="font-mono">{metrics.db.connections.active}</td></tr>
                    <tr><td className="text-muted">Connexions idle</td><td className="font-mono">{metrics.db.connections.idle}</td></tr>
                    <tr><td className="text-muted">Total / Max</td><td className="font-mono">{metrics.db.connections.total} / {metrics.db.connections.max}</td></tr>
                  </>}
                </tbody>
              </table>
            ) : (
              <table className="table">
                <tbody>
                  <tr><td className="text-muted">Uptime</td><td className="font-mono">{formatUptime(metrics.db.uptime)}</td></tr>
                  <tr><td className="text-muted">Connexions</td><td className="font-mono">{metrics.db.connections} / {metrics.db.maxConnections}</td></tr>
                  <tr><td className="text-muted">Total requêtes</td><td className="font-mono">{Number(metrics.db.totalQueries).toLocaleString()}</td></tr>
                  <tr><td className="text-muted">Slow queries</td><td className="font-mono">{metrics.db.slowQueries}</td></tr>
                  <tr><td className="text-muted">Tables ouvertes</td><td className="font-mono">{metrics.db.openTables}</td></tr>
                  <tr><td className="text-muted">Trafic reçu</td><td className="font-mono">{formatBytes(metrics.db.bytesReceived)}</td></tr>
                  <tr><td className="text-muted">Trafic envoyé</td><td className="font-mono">{formatBytes(metrics.db.bytesSent)}</td></tr>
                  <tr><td className="text-muted">Connexions échouées</td><td className="font-mono">{metrics.db.abortedConnections}</td></tr>
                </tbody>
              </table>
            )
          ) : <p className="text-muted text-sm">{metrics.db?.error || 'Instance arrêtée'}</p>}
        </div>

        {/* Database sizes */}
        {metrics.db && (metrics.db.databases?.length > 0) && (
          <div className="card card-body">
            <h4 className="text-sm font-semibold mb-3">Taille des bases</h4>
            <table className="table">
              <thead><tr><th>Base</th><th>Taille</th>{metrics.engine !== 'postgres' && <th>Tables</th>}</tr></thead>
              <tbody>
                {metrics.db.databases.map(db => (
                  <tr key={db.name}>
                    <td className="font-mono">{db.name}</td>
                    <td className="font-mono">{db.sizeHuman || formatBytes(db.size)}</td>
                    {metrics.engine !== 'postgres' && <td className="font-mono">{db.tables}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Action history */}
        <div className="card card-body">
          <h4 className="text-sm font-semibold mb-3">Historique des actions</h4>
          {metrics.history.totalActions > 0 ? (
            <>
              <div className="flex flex-wrap gap-2 mb-3">
                {Object.entries(metrics.history.summary).map(([action, info]) => (
                  <span key={action} className="badge badge-secondary">
                    {action}: {info.count}×
                  </span>
                ))}
              </div>
              <div style={{ maxHeight: 200, overflow: 'auto' }}>
                <table className="table text-sm">
                  <thead><tr><th>Action</th><th>Date</th></tr></thead>
                  <tbody>
                    {[...metrics.history.actions].reverse().slice(0, 20).map((a, i) => (
                      <tr key={i}>
                        <td><span className="badge badge-secondary">{a.action}</span></td>
                        <td className="text-muted">{new Date(a.at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <p className="text-muted text-sm">Aucune action enregistrée</p>}
        </div>
      </div>

      {/* Slow Queries Section */}
      <div className="card card-body">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold">Requêtes lentes</h4>
          <button className="btn btn-ghost btn-sm" onClick={loadSlowQueries} disabled={sqLoading}>
            {sqLoading ? <span className="spinner" /> : '↻'}
          </button>
        </div>
        {slowQueries && Array.isArray(slowQueries) && slowQueries.length > 0 ? (
          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            <table className="table text-sm">
              <thead>
                <tr>
                  <th style={{ maxWidth: 400 }}>Requête</th>
                  {metrics.engine === 'postgres' ? (
                    <>
                      <th>Appels</th>
                      <th>Total (ms)</th>
                      <th>Moy. (ms)</th>
                      <th>Lignes</th>
                    </>
                  ) : (
                    <>
                      <th>Schéma</th>
                      <th>Appels</th>
                      <th>Total (ms)</th>
                      <th>Moy. (ms)</th>
                      <th>Max (ms)</th>
                      <th>Lignes envoyées</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {slowQueries.map((q, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs" style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.query || q.digest_text}>
                      {q.query || q.digest_text || '—'}
                    </td>
                    {metrics.engine === 'postgres' ? (
                      <>
                        <td className="font-mono">{q.calls ?? '—'}</td>
                        <td className="font-mono">{q.total_ms ?? '—'}</td>
                        <td className="font-mono">{q.mean_ms ?? '—'}</td>
                        <td className="font-mono">{q.rows ?? '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="font-mono">{q.schema || '—'}</td>
                        <td className="font-mono">{q.count ?? '—'}</td>
                        <td className="font-mono">{q.totalTime ?? '—'}</td>
                        <td className="font-mono">{q.avgTime ?? '—'}</td>
                        <td className="font-mono">{q.maxTime ?? '—'}</td>
                        <td className="font-mono">{q.rows_sent ?? '—'}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">
            {slowQueries?.error || (inst.running ? 'Aucune requête lente détectée (performance_schema / pg_stat_statements)' : 'Instance arrêtée')}
          </p>
        )}
      </div>
    </div>
  );
}

function LogsTab({ name }) {
  const [logs, setLogs] = useState('');
  const logRef = useRef(null);
  const sourceRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(`/api/instances/${name}/logs`);
    sourceRef.current = es;
    es.onmessage = (e) => {
      setLogs((prev) => prev + e.data + '\n');
    };
    es.onerror = () => { setLogs((prev) => prev + '\n[connexion perdue]\n'); es.close(); };
    return () => es.close();
  }, [name]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="card card-body">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold"><ScrollText size={14} style={{ display: 'inline', verticalAlign: -2 }} /> Logs en temps réel</h4>
        <button className="btn btn-ghost btn-sm" onClick={() => setLogs('')}>Effacer</button>
      </div>
      <div className="log-viewer" ref={logRef} style={{ minHeight: 300 }}>
        {logs || 'En attente de logs...'}
      </div>
    </div>
  );
}
