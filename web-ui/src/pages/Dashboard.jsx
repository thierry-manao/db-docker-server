import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { api } from '../api';
import { Plus, Play, Square, Trash2, Database, Server, Activity } from 'lucide-react';
import CreateInstanceModal from '../components/CreateInstanceModal';

export default function Dashboard() {
  const { instances, seedFiles, refresh, toast } = useApp();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [pending, setPending] = useState({});

  const running = instances.filter((i) => i.running).length;
  const stopped = instances.length - running;
  const engines = [...new Set(instances.map((i) => i.config.DB_ENGINE || 'mariadb'))];

  const runAction = async (name, action, body) => {
    setPending((p) => ({ ...p, [name]: action }));
    try {
      const result = await api.instanceAction(name, action, body);
      toast(result.message || `${action} terminé`);
    } catch (err) {
      toast(`${action} échoué: ${err.message}`, 'danger');
    } finally {
      setPending((p) => { const copy = { ...p }; delete copy[name]; return copy; });
      refresh();
    }
  };

  return (
    <>
      {/* Stats */}
      <div className="grid grid-4 mb-4">
        <div className="card card-body text-center">
          <div className="stat-value">{instances.length}</div>
          <div className="stat-label">Total instances</div>
        </div>
        <div className="card card-body text-center">
          <div className="stat-value text-success">{running}</div>
          <div className="stat-label">En cours</div>
        </div>
        <div className="card card-body text-center">
          <div className="stat-value text-muted">{stopped}</div>
          <div className="stat-label">Arrêtées</div>
        </div>
        <div className="card card-body text-center">
          <div className="stat-value" style={{ color: 'var(--accent)' }}>{engines.length}</div>
          <div className="stat-label">Moteurs</div>
        </div>
      </div>

      {/* Actions bar */}
      <div className="flex items-center justify-between mb-4">
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>Instances</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> Nouvelle instance
        </button>
      </div>

      {/* Instance Grid */}
      {instances.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Database size={48} strokeWidth={1} />
            <p className="mt-2 font-medium">Aucune instance</p>
            <p className="text-sm">Créez votre première instance de base de données.</p>
            <button className="btn btn-primary mt-4" onClick={() => setShowCreate(true)}>
              <Plus size={14} /> Créer
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-2">
          {instances.map((inst) => {
            const c = inst.config;
            const isPending = !!pending[inst.name];
            const adminLabel = c.DB_ENGINE === 'postgres' ? 'pgAdmin' : 'phpMyAdmin';
            const connString = c.DB_ENGINE === 'postgres'
              ? `psql -h localhost -p ${c.DB_PORT} -U ${c.DB_USER || 'postgres'} ${c.DB_DATABASE || ''}`
              : `mysql -h 127.0.0.1 -P ${c.DB_PORT} -u root -p${c.DB_ROOT_PASSWORD || 'root'} ${c.DB_DATABASE || ''}`;

            return (
              <div key={inst.name} className="card" style={inst.running ? { borderLeft: '3px solid var(--success)' } : {}}>
                <div className="card-body">
                  <div className="flex items-center justify-between mb-3">
                    <div style={{ cursor: 'pointer' }} onClick={() => navigate(`/instance/${inst.name}`)}>
                      <h4 style={{ fontSize: '0.95rem', fontWeight: 600 }}>{inst.name}</h4>
                      <span className="text-xs text-muted">{c.DB_ENGINE || 'mariadb'}:{c.DB_VERSION || '?'}</span>
                    </div>
                    <span className={`badge ${inst.running ? 'badge-success' : 'badge-secondary'}`}>
                      {inst.running ? 'actif' : 'arrêté'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1 mb-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted">Port DB</span>
                      <span className="font-medium font-mono">{c.DB_PORT || '?'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">{adminLabel}</span>
                      <span className="font-medium font-mono">{c.DB_ADMIN_PORT || '?'}</span>
                    </div>
                    {c.DB_DATABASE && (
                      <div className="flex justify-between">
                        <span className="text-muted">Base</span>
                        <span className="font-medium">{c.DB_DATABASE}</span>
                      </div>
                    )}
                  </div>

                  <div className="conn-string mb-3" onClick={() => { navigator.clipboard.writeText(connString); toast('Copié !'); }} title="Cliquer pour copier">
                    {connString}
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    {inst.running ? (
                      <>
                        <button className="btn btn-danger btn-sm" disabled={isPending} onClick={() => runAction(inst.name, 'down')}>
                          <Square size={12} /> Arrêter
                        </button>
                        <a className="btn btn-outline btn-sm" href={`http://localhost:${c.DB_ADMIN_PORT}`} target="_blank" rel="noreferrer">
                          {adminLabel}
                        </a>
                      </>
                    ) : (
                      <button className="btn btn-success btn-sm" disabled={isPending} onClick={() => runAction(inst.name, 'up')}>
                        <Play size={12} /> Démarrer
                      </button>
                    )}
                    <button className="btn btn-outline btn-sm" onClick={() => navigate(`/instance/${inst.name}`)}>
                      Détails
                    </button>
                    {isPending && <span className="spinner" />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && <CreateInstanceModal onClose={() => setShowCreate(false)} />}
    </>
  );
}
