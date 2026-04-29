import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { Loader, CheckCircle, XCircle, X, ListTodo } from 'lucide-react';

export default function TaskTracker({ toast }) {
  const [tasks, setTasks] = useState([]);
  const [open, setOpen] = useState(false);
  const notifiedRef = useRef(new Set());

  const poll = useCallback(async () => {
    try {
      const data = await api.listTasks();
      setTasks(data.tasks || []);
    } catch {}
  }, []);

  useEffect(() => {
    poll();
    const iv = setInterval(poll, 3000);
    return () => clearInterval(iv);
  }, [poll]);

  // Auto-toast on task completion
  useEffect(() => {
    for (const t of tasks) {
      if ((t.status === 'done' || t.status === 'error') && !notifiedRef.current.has(t.id)) {
        notifiedRef.current.add(t.id);
        if (t.status === 'done') {
          toast?.(`${t.label} — terminé`);
        } else {
          toast?.(`${t.label} — erreur`, 'danger');
        }
      }
    }
  }, [tasks, toast]);

  const running = tasks.filter(t => t.status === 'running');
  const recent = tasks.filter(t => t.status !== 'running').slice(0, 10);

  const handleDismiss = async (id) => {
    try {
      await api.deleteTask(id);
      setTasks(prev => prev.filter(t => t.id !== id));
    } catch {}
  };

  const elapsed = (t) => {
    const ms = (t.finishedAt || Date.now()) - t.startedAt;
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  };

  if (tasks.length === 0) return null;

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(!open)}
        style={{ position: 'relative' }}
        title="Tâches en cours"
      >
        <ListTodo size={18} />
        {running.length > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--warning)', display: 'block',
            animation: 'pulse 1.5s infinite',
          }} />
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4,
          width: 340, maxHeight: 400, overflowY: 'auto',
          background: 'var(--panel)', border: '1px solid var(--panel-border)',
          borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,.15)', zIndex: 100,
        }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--panel-border)', fontWeight: 600, fontSize: 13 }}>
            Tâches {running.length > 0 && `(${running.length} en cours)`}
          </div>

          {running.map(t => (
            <div key={t.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--panel-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Loader size={14} className="spin" style={{ color: 'var(--warning)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-xs font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</div>
                <div className="text-xs text-muted">{elapsed(t)}</div>
              </div>
            </div>
          ))}

          {recent.map(t => (
            <div key={t.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--panel-border)', display: 'flex', alignItems: 'center', gap: 8, opacity: 0.8 }}>
              {t.status === 'done'
                ? <CheckCircle size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
                : <XCircle size={14} style={{ color: 'var(--danger)', flexShrink: 0 }} />
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-xs font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</div>
                <div className="text-xs text-muted">
                  {elapsed(t)}
                  {t.status === 'error' && t.error && <> — {t.error.slice(0, 60)}</>}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ padding: 2 }} onClick={() => handleDismiss(t.id)}>
                <X size={12} />
              </button>
            </div>
          ))}

          {tasks.length === 0 && (
            <div className="text-xs text-muted" style={{ padding: 12, textAlign: 'center' }}>Aucune tâche</div>
          )}
        </div>
      )}
    </div>
  );
}
