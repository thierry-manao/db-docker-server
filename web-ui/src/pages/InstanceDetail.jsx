import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { api } from '../api';
import { Play, Square, Trash2, Copy, Download, GitBranch, Terminal, Users, Settings, ScrollText, FileUp, ArrowLeft } from 'lucide-react';

export default function InstanceDetail() {
  const { name, tab: urlTab } = useParams();
  const navigate = useNavigate();
  const { instances, seedFiles, refresh, toast } = useApp();
  const [tab, setTab] = useState(urlTab || 'overview');
  const [pending, setPending] = useState(null);

  const inst = instances.find((i) => i.name === name);

  useEffect(() => { if (urlTab) setTab(urlTab); }, [urlTab]);

  const changeTab = (t) => { setTab(t); navigate(`/instance/${name}/${t}`, { replace: true }); };

  if (!inst) return <div className="card card-body text-center text-muted p-4">Instance introuvable</div>;

  const c = inst.config;
  const adminLabel = c.DB_ENGINE === 'postgres' ? 'pgAdmin' : 'phpMyAdmin';
  const connString = c.DB_ENGINE === 'postgres'
    ? `psql -h localhost -p ${c.DB_PORT} -U ${c.DB_USER || 'postgres'} ${c.DB_DATABASE || ''}`
    : `mysql -h 127.0.0.1 -P ${c.DB_PORT} -u root -p${c.DB_ROOT_PASSWORD || 'root'} ${c.DB_DATABASE || ''}`;

  const runAction = async (action, body) => {
    setPending(action);
    try {
      const result = await api.instanceAction(name, action, body);
      toast(result.message || `${action} terminé`);
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
          <button className="btn btn-outline btn-sm" disabled={!!pending || !inst.running} onClick={() => runAction('backup')}>
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

      {/* Tabs */}
      <div className="tabs mb-4">
        {[
          ['overview', 'Vue d\'ensemble'],
          ['credentials', 'Utilisateurs'],
          ['seed', 'Seed / Import'],
          ['config', 'Configuration'],
          ['sql', 'SQL'],
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
            <tr><td className="text-muted">Port Admin</td><td><a href={`http://localhost:${c.DB_ADMIN_PORT}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{c.DB_ADMIN_PORT} ({adminLabel})</a></td></tr>
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
        toast(`${file} importé`);
      } catch (err) { toast(`Erreur: ${err.message}`, 'danger'); }
    }
    setSelected({});
    setLoading(false);
    refresh();
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
