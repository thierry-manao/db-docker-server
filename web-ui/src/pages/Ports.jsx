import { useState, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { AlertTriangle, CheckCircle } from 'lucide-react';

export default function Ports() {
  const { toast } = useApp();
  const [ports, setPorts] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPorts();
  }, []);

  const loadPorts = async () => {
    setLoading(true);
    try {
      const data = await api.ports();
      setPorts(data.ports);
      setConflicts(data.conflicts);
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
    finally { setLoading(false); }
  };

  return (
    <>
      {conflicts.length > 0 ? (
        <div className="card card-body mb-4" style={{ borderLeft: '3px solid var(--danger)' }}>
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
            <span className="font-semibold text-sm" style={{ color: 'var(--danger)' }}>
              Conflits de ports détectés: {conflicts.join(', ')}
            </span>
          </div>
        </div>
      ) : !loading && (
        <div className="card card-body mb-4" style={{ borderLeft: '3px solid var(--success)' }}>
          <div className="flex items-center gap-2">
            <CheckCircle size={16} style={{ color: 'var(--success)' }} />
            <span className="font-semibold text-sm" style={{ color: 'var(--success)' }}>Aucun conflit de ports</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-body">
          <h4 className="text-sm font-semibold mb-3">Allocation des ports</h4>
          {loading ? (
            <div className="text-center p-4"><span className="spinner" /></div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Port</th>
                  <th>Type</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((p, i) => (
                  <tr key={i}>
                    <td className="font-medium">{p.instance}</td>
                    <td className="font-mono">
                      <span style={conflicts.includes(p.port) ? { color: 'var(--danger)', fontWeight: 600 } : {}}>
                        {p.port}
                      </span>
                      {conflicts.includes(p.port) && <AlertTriangle size={12} style={{ display: 'inline', marginLeft: 4, color: 'var(--danger)', verticalAlign: -1 }} />}
                    </td>
                    <td>
                      <span className={`badge ${p.type === 'db' ? 'badge-secondary' : 'badge-warning'}`}>
                        {p.type === 'db' ? 'Database' : 'Admin UI'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${p.running ? 'badge-success' : 'badge-secondary'}`}>
                        {p.running ? 'actif' : 'arrêté'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
