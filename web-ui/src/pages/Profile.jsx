import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { api } from '../api';
import { Shield, User, Lock } from 'lucide-react';

export default function Profile() {
  const { user, toast, handleLogout } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '', username: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirmPassword) {
      return toast('Les mots de passe ne correspondent pas.', 'danger');
    }
    setLoading(true);
    try {
      await api.changeAdminPassword(form.currentPassword, form.newPassword, form.username || undefined);
      toast('Identifiants mis à jour. Reconnectez-vous.');
      handleLogout();
      navigate('/login');
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 520 }}>
      <div className="card card-body">
        <h3 className="text-sm font-semibold mb-4">
          <Shield size={16} style={{ display: 'inline', verticalAlign: -3, marginRight: 6 }} />
          Profil administrateur
        </h3>

        <div className="mb-4" style={{ padding: '0.75rem', borderRadius: 8, background: 'var(--bg)' }}>
          <div className="flex items-center gap-2">
            <User size={14} className="text-muted" />
            <span className="text-sm">Connecté en tant que <strong>{user}</strong></span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <h4 className="text-xs font-semibold text-muted mb-3" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <Lock size={12} style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
            Changer les identifiants
          </h4>

          <div className="flex flex-col gap-3 mb-4">
            <div>
              <label className="label">Nouveau nom d'utilisateur (optionnel)</label>
              <input
                className="input input-sm"
                type="text"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder={user}
                autoComplete="username"
              />
            </div>
            <div>
              <label className="label">Mot de passe actuel *</label>
              <input
                className="input input-sm"
                type="password"
                value={form.currentPassword}
                onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
                required
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="label">Nouveau mot de passe *</label>
              <input
                className="input input-sm"
                type="password"
                value={form.newPassword}
                onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
                required
                minLength={4}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="label">Confirmer le nouveau mot de passe *</label>
              <input
                className="input input-sm"
                type="password"
                value={form.confirmPassword}
                onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                required
                minLength={4}
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !form.currentPassword || !form.newPassword}>
              {loading ? <span className="spinner" /> : 'Mettre à jour'}
            </button>
            <span className="text-xs text-muted">Vous serez déconnecté après la modification.</span>
          </div>
        </form>
      </div>
    </div>
  );
}
