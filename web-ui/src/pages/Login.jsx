import { useState } from 'react';
import { Database, Lock } from 'lucide-react';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="flex items-center gap-3 mb-4">
          <div style={{
            width: 44, height: 44, borderRadius: 'var(--radius-sm)',
            background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Database size={22} color="white" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.15rem', fontWeight: 700 }}>dbserver</h1>
            <p className="text-xs text-muted">Interface d'administration</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="label">Nom d'utilisateur</label>
            <input className="input" type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
          </div>
          <div>
            <label className="label">Mot de passe</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          {error && <div className="badge badge-danger" style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}>{error}</div>}
          <button className="btn btn-primary w-full" type="submit" disabled={loading} style={{ justifyContent: 'center', padding: '0.65rem' }}>
            {loading ? <span className="spinner" /> : <><Lock size={14} /> Connexion</>}
          </button>
        </form>

        <p className="text-xs text-muted text-center mt-4">
          Identifiants dans <code style={{ background: 'var(--bg-secondary)', padding: '0.1rem 0.3rem', borderRadius: 4 }}>.dbserver-ui.auth</code>
        </p>
      </div>
    </div>
  );
}
